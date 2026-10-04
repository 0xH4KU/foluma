from __future__ import annotations

import html
import os
import tempfile
import uuid
from collections import Counter
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from io import BytesIO
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZIP_STORED, ZipFile, ZipInfo

from PIL import Image, ImageOps, UnidentifiedImageError

from .validation import validate_epub_structure


@dataclass(frozen=True)
class EpubPage:
    index: int
    width: int
    height: int
    image_href: str | None
    image_media_type: str | None
    image_data: bytes | None
    xhtml_href: str
    item_id: str
    label: str
    image_data_loader: Callable[[], bytes] | None = None
    is_blank: bool = False
    crop_x: int = 0
    crop_width: int | None = None
    crop_y: int = 0
    crop_height: int | None = None

    def load_image_data(self) -> bytes:
        if self.image_data is not None:
            return self.image_data
        if self.image_data_loader is not None:
            return self.image_data_loader()
        raise ValueError(f"Page {self.label} has no image payload")


def media_type_for_ext(ext: str) -> str:
    ext = ext.lower()
    if ext in {"jpg", "jpeg"}:
        return "image/jpeg"
    if ext == "png":
        return "image/png"
    raise ValueError(f"Unsupported image extension for EPUB: {ext}")


def write_epub_from_pages(
    pages: list[EpubPage],
    epub_path: Path,
    source_path: Path,
    title: str,
    author: str | None = None,
    language: str = "zh-Hant",
    overwrite: bool = False,
    apple_books: bool = False,
    pair_first_two_pages: bool = False,
    cover_item_id: str | None = None,
    exclude_cover_from_reading: bool = False,
    counts: dict[str, int] | None = None,
    reading_direction: str = "rtl",
    cover_png: bytes | None = None,
) -> dict[str, int]:
    if reading_direction not in {"rtl", "ltr"}:
        raise ValueError("Reading direction must be 'rtl' or 'ltr'")
    if epub_path.exists() and not overwrite:
        raise ValueError(f"Refusing to overwrite existing file: {epub_path}")
    identifier = f"urn:uuid:{uuid.uuid5(uuid.NAMESPACE_URL, source_path.resolve().as_uri())}"

    cover_id = cover_item_id or _first_image_item_id(pages)
    _validate_cover_item_id(pages, cover_id)
    reading_pages = _reading_pages(pages, cover_id, exclude_cover_from_reading)
    if not reading_pages:
        raise ValueError("Cover-only export would leave no reading pages")

    temp_path = _temporary_epub_path(epub_path)
    try:
        _write_epub_zip(
            temp_path,
            title,
            identifier,
            pages,
            reading_pages,
            apple_books,
            pair_first_two_pages,
            author,
            language,
            cover_id,
            reading_direction,
            cover_png,
        )
        validate_epub_structure(temp_path)
        _publish_epub(temp_path, epub_path, overwrite=overwrite)
    except Exception:
        temp_path.unlink(missing_ok=True)
        raise

    result = dict(counts or {})
    result["total"] = len(reading_pages)
    return result


def _temporary_epub_path(epub_path: Path) -> Path:
    with tempfile.NamedTemporaryFile(
        prefix=f".{epub_path.name}.", suffix=".tmp", dir=epub_path.parent, delete=False
    ) as temp:
        return Path(temp.name)


def _write_epub_zip(
    epub_path: Path,
    title: str,
    identifier: str,
    pages: list[EpubPage],
    reading_pages: list[EpubPage],
    apple_books: bool,
    pair_first_two_pages: bool,
    author: str | None,
    language: str,
    cover_id: str | None,
    reading_direction: str,
    cover_png: bytes | None = None,
) -> None:
    page_sizes = [
        (page.crop_width or page.width, page.crop_height or page.height) for page in reading_pages if not page.is_blank
    ]
    viewport = Counter(page_sizes or [(reading_pages[0].width, reading_pages[0].height)]).most_common(1)[0][0]
    cover_href = (
        "images/cover.png"
        if cover_png
        else next(
            (page.image_href for page in pages if not page.is_blank and page.item_id == cover_id),
            None,
        )
    )
    with ZipFile(epub_path, "w") as archive:
        _write_stored(archive, "mimetype", b"application/epub+zip")
        _write_deflated(archive, "META-INF/container.xml", _container_xml())
        _write_deflated(
            archive,
            "EPUB/content.opf",
            _content_opf(
                title,
                identifier,
                pages,
                reading_pages,
                apple_books,
                pair_first_two_pages,
                author,
                language,
                cover_id,
                reading_direction,
                cover_png is not None,
            ),
        )
        _write_deflated(archive, "EPUB/nav.xhtml", _nav_xhtml(title, reading_pages, language, cover_id))
        _write_deflated(archive, "EPUB/styles/page.css", _page_css())
        if cover_png is not None:
            _write_stored(archive, "EPUB/images/cover.png", cover_png)
            _write_deflated(archive, "iTunesArtwork", _itunes_artwork(cover_png, "image/png"))
        for page in reading_pages:
            if page.is_blank:
                _write_deflated(archive, f"EPUB/{page.xhtml_href}", _blank_page_xhtml(title, page, language, viewport))
            else:
                _write_deflated(archive, f"EPUB/{page.xhtml_href}", _page_xhtml(title, page, language, viewport))
        for page in _unique_image_pages(pages):
            image_data = page.load_image_data()
            _write_stored(archive, f"EPUB/{page.image_href}", image_data)
            if page.image_href == cover_href:
                _write_deflated(archive, "iTunesArtwork", _itunes_artwork(image_data, page.image_media_type))


def _itunes_artwork(image_data: bytes, media_type: str | None) -> bytes:
    try:
        with Image.open(BytesIO(image_data)) as image:
            frame = ImageOps.exif_transpose(image)
            has_alpha = "A" in frame.getbands() or (frame.mode == "P" and "transparency" in frame.info)
            if has_alpha:
                rgba = frame.convert("RGBA")
                artwork = Image.new("RGB", rgba.size, "white")
                artwork.paste(rgba, mask=rgba.getchannel("A"))
            else:
                artwork = frame.convert("RGB")
            output = BytesIO()
            artwork.save(output, format="JPEG", quality=95, optimize=True, dpi=(72, 72))
            return output.getvalue()
    except UnidentifiedImageError:
        if media_type == "image/jpeg":
            return image_data
        raise ValueError("Cannot create Apple Books cover artwork")
    except OSError as exc:
        raise ValueError("Cannot create Apple Books cover artwork") from exc


def _publish_epub(temp_path: Path, epub_path: Path, overwrite: bool) -> None:
    os.chmod(temp_path, 0o644)
    if overwrite:
        os.replace(temp_path, epub_path)
        return
    try:
        os.link(temp_path, epub_path)
    except FileExistsError as exc:
        raise ValueError(f"Refusing to overwrite existing file: {epub_path}") from exc
    finally:
        temp_path.unlink(missing_ok=True)


def _write_stored(archive: ZipFile, filename: str, payload: bytes) -> None:
    info = ZipInfo(filename)
    info.compress_type = ZIP_STORED
    archive.writestr(info, payload)


def _write_deflated(archive: ZipFile, filename: str, payload: str | bytes) -> None:
    info = ZipInfo(filename)
    info.compress_type = ZIP_DEFLATED
    if isinstance(payload, str):
        payload = payload.encode("utf-8")
    archive.writestr(info, payload)


def _container_xml() -> str:
    return """<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="EPUB/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>
"""


def _modified_timestamp() -> str:
    return datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def _content_opf(
    title: str,
    identifier: str,
    pages: list[EpubPage],
    reading_pages: list[EpubPage],
    apple_books: bool = False,
    pair_first_two_pages: bool = False,
    author: str | None = None,
    language: str = "zh-Hant",
    cover_item_id: str | None = None,
    reading_direction: str = "rtl",
    separate_cover: bool = False,
) -> str:
    title_xml = html.escape(title, quote=True)
    language_xml = html.escape(language or "zh-Hant", quote=True)
    creator_xml = html.escape(author, quote=True) if author else None
    language_lower = (language or "zh-Hant").lower()
    if language_lower.startswith("zh-hans"):
        accessibility_summary = (
            "本出版物为固定版面图像出版物，阅读内容需要视觉辨识；未提供完整的图像替代文字或长篇图像描述。"
        )
    elif language_lower.startswith("zh"):
        accessibility_summary = (
            "本出版品為固定版面圖像出版品，閱讀內容需要視覺辨識；未提供完整的圖像替代文字或長篇圖像描述。"
        )
    else:
        accessibility_summary = "This fixed-layout image publication requires visual perception; complete alternative text and long image descriptions are not provided."
    cover_id = cover_item_id or _first_image_item_id(pages)
    cover_href = (
        "images/cover.png"
        if separate_cover
        else next(
            (page.image_href for page in pages if not page.is_blank and page.item_id == cover_id),
            None,
        )
    )
    image_items = "\n".join(_image_manifest_item(page, cover_href) for page in _unique_image_pages(pages))
    if separate_cover:
        image_items += (
            '\n    <item id="cover-art" href="images/cover.png" media-type="image/png" properties="cover-image"/>'
        )
    xhtml_items = "\n".join(_xhtml_manifest_item(page) for page in reading_pages)
    spread = "none" if apple_books else "auto"
    if apple_books:
        spine_items = "\n".join(
            f'    <itemref idref="{page.item_id}" properties="rendition:page-spread-center"/>' for page in reading_pages
        )
    else:
        spine_items = "\n".join(_spine_itemref(page, pair_first_two_pages, reading_direction) for page in reading_pages)
    return f"""<?xml version="1.0" encoding="UTF-8"?>
<package version="3.0" unique-identifier="bookid" prefix="rendition: http://www.idpf.org/vocab/rendition/#" xmlns="http://www.idpf.org/2007/opf">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="bookid">{html.escape(identifier, quote=True)}</dc:identifier>
    <dc:title>{title_xml}</dc:title>
{f"    <dc:creator>{creator_xml}</dc:creator>" if creator_xml else ""}
    <dc:language>{language_xml}</dc:language>
    <meta property="dcterms:modified">{_modified_timestamp()}</meta>
    <meta property="schema:accessibilitySummary">{html.escape(accessibility_summary, quote=True)}</meta>
    <meta property="schema:accessibilityHazard">none</meta>
    <meta property="schema:accessibilityFeature">tableOfContents</meta>
    <meta property="schema:accessModeSufficient">visual</meta>
    <meta property="schema:accessMode">visual</meta>
    <meta property="rendition:layout">pre-paginated</meta>
    <meta property="rendition:orientation">auto</meta>
    <meta property="rendition:spread">{spread}</meta>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="css-page" href="styles/page.css" media-type="text/css"/>
{image_items}
{xhtml_items}
  </manifest>
  <spine page-progression-direction="{reading_direction}">
{spine_items}
  </spine>
</package>
"""


def _image_manifest_item(page: EpubPage, cover_href: str | None) -> str:
    properties = ' properties="cover-image"' if page.image_href == cover_href else ""
    return f'    <item id="img-{page.index:04d}" href="{page.image_href}" media-type="{page.image_media_type}"{properties}/>'


def _unique_image_pages(pages: list[EpubPage]) -> list[EpubPage]:
    unique: dict[str, EpubPage] = {}
    for page in pages:
        if not page.is_blank and page.image_href is not None:
            unique.setdefault(page.image_href, page)
    return list(unique.values())


def _xhtml_manifest_item(page: EpubPage) -> str:
    properties = ' properties="svg"'
    return f'    <item id="{page.item_id}" href="{page.xhtml_href}" media-type="application/xhtml+xml"{properties}/>'


def _first_image_item_id(pages: list[EpubPage]) -> str | None:
    for page in pages:
        if not page.is_blank:
            return page.item_id
    return None


def _validate_cover_item_id(pages: list[EpubPage], cover_item_id: str | None) -> None:
    if cover_item_id is None:
        return
    if any(not page.is_blank and page.item_id == cover_item_id for page in pages):
        return
    raise ValueError(f"Invalid cover item ID: {cover_item_id}")


def _reading_pages(
    pages: list[EpubPage], cover_item_id: str | None, exclude_cover_from_reading: bool
) -> list[EpubPage]:
    if not exclude_cover_from_reading or cover_item_id is None:
        return pages
    return [page for page in pages if page.item_id != cover_item_id]


def _spine_itemref(page: EpubPage, pair_first_two_pages: bool, reading_direction: str) -> str:
    if pair_first_two_pages and not page.is_blank and page.index in {1, 2}:
        sides = ("right", "left") if reading_direction == "rtl" else ("left", "right")
        side = sides[page.index - 1]
        return f'    <itemref idref="{page.item_id}" properties="rendition:page-spread-{side}"/>'
    return f'    <itemref idref="{page.item_id}"/>'


def _nav_xhtml(
    title: str,
    pages: list[EpubPage],
    language: str = "zh-Hant",
    cover_item_id: str | None = None,
) -> str:
    title_xml = html.escape(title, quote=True)
    language_xml = html.escape(language or "zh-Hant", quote=True)
    language_lower = (language or "zh-Hant").lower()
    if language_lower.startswith("zh-hans"):
        start_label, navigation_label, cover_label, body_label = "开始", "导航", "封面", "正文"
    elif language_lower.startswith("zh"):
        start_label, navigation_label, cover_label, body_label = "開始", "導覽", "封面", "正文"
    else:
        start_label, navigation_label, cover_label, body_label = "Start", "Navigation", "Cover", "Body"
    first_page = pages[0]
    cover_page = next((page for page in pages if page.item_id == cover_item_id), None)
    body_page = next((page for page in pages if page.item_id != cover_item_id), first_page)
    landmarks = []
    if cover_page is not None:
        landmarks.append(f'        <li><a epub:type="cover" href="{cover_page.xhtml_href}">{cover_label}</a></li>')
    landmarks.append(f'        <li><a epub:type="bodymatter" href="{body_page.xhtml_href}">{body_label}</a></li>')
    return f"""<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="{language_xml}" xml:lang="{language_xml}">
  <head>
    <title>{title_xml}</title>
  </head>
  <body>
    <nav epub:type="toc" id="toc">
      <h1>{title_xml}</h1>
      <ol>
        <li><a href="{first_page.xhtml_href}">{start_label}</a></li>
      </ol>
    </nav>
    <nav epub:type="landmarks" hidden="hidden">
      <h2>{navigation_label}</h2>
      <ol>
{chr(10).join(landmarks)}
      </ol>
    </nav>
  </body>
</html>
"""


def _page_css() -> str:
    return """html, body {
  margin: 0;
  padding: 0;
  width: 100%;
  height: 100%;
  background: #000;
}

svg {
  display: block;
  width: 100vw;
  height: 100vh;
}
"""


def _page_xhtml(title: str, page: EpubPage, language: str, viewport: tuple[int, int]) -> str:
    page_title = html.escape(f"{title} - Page {page.index}", quote=True)
    language_xml = html.escape(language or "zh-Hant", quote=True)
    href = html.escape(f"../{page.image_href}", quote=True)
    viewport_width, viewport_height = viewport
    page_width = page.crop_width or page.width
    page_height = page.crop_height or page.height
    image_x = -page.crop_x
    return f"""<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="{language_xml}" xml:lang="{language_xml}">
  <head>
    <title>{page_title}</title>
    <meta name="viewport" content="width={viewport_width}, height={viewport_height}"/>
    <link rel="stylesheet" type="text/css" href="../styles/page.css"/>
  </head>
  <body>
    <svg xmlns="http://www.w3.org/2000/svg" version="1.1" width="{viewport_width}" height="{viewport_height}" viewBox="0 0 {page_width} {page_height}" preserveAspectRatio="xMidYMid meet" overflow="hidden" role="img" aria-label="Page {page.index}">
      <image x="{image_x}" y="{-page.crop_y}" width="{page.width}" height="{page.height}" href="{href}"/>
    </svg>
  </body>
</html>
"""


def _blank_page_xhtml(title: str, page: EpubPage, language: str, viewport: tuple[int, int]) -> str:
    page_title = html.escape(f"{title} - {page.label}", quote=True)
    language_xml = html.escape(language or "zh-Hant", quote=True)
    viewport_width, viewport_height = viewport
    return f"""<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="{language_xml}" xml:lang="{language_xml}">
  <head>
    <title>{page_title}</title>
    <meta name="viewport" content="width={viewport_width}, height={viewport_height}"/>
    <link rel="stylesheet" type="text/css" href="../styles/page.css"/>
  </head>
  <body>
    <svg xmlns="http://www.w3.org/2000/svg" version="1.1" width="{viewport_width}" height="{viewport_height}" viewBox="0 0 {viewport_width} {viewport_height}" preserveAspectRatio="xMidYMid meet" role="presentation" aria-label="{html.escape(page.label, quote=True)}">
      <rect width="{viewport_width}" height="{viewport_height}" fill="#ffffff"/>
    </svg>
  </body>
</html>
"""
