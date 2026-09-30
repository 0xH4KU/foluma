"""Image work runs in a child process; the document service never imports MuPDF."""

from __future__ import annotations

import hashlib
import io
import json
import math
import re
from pathlib import Path
from zipfile import ZIP_STORED, ZipFile

import pymupdf as fitz
from PIL import Image, ImageOps

from .epub.writer import EpubPage, media_type_for_ext, write_epub_from_pages
from .i18n import t
from .model import image_page, new_id, validate
from .pdf.image_extraction import _image_from_xref
from .pdf.png import image_to_epub_member
from .storage import check_sources, copy_asset, digest


class RenderRequired(ValueError):
    def __init__(self, pages: list[int]):
        super().__init__(
            t("{0} pages contain text, compositing, rotation or other content that requires rendering.", len(pages))
        )
        self.data = {"kind": "render_required", "pages": pages}


def direct_image(doc, page):
    """Only accept a full-page, upright image drawn without other PDF operations."""
    images = page.get_image_info()
    if not page.get_bboxlog() and not list(page.annots() or ()) and not list(page.widgets() or ()):
        return "blank", None
    if len(images) != 1 or page.rotation or list(page.annots() or ()) or list(page.widgets() or ()):
        return "render", None
    info = images[0]
    if page.get_xobjects():
        return "render", None
    a, b, c, d, x, y = info["transform"]
    rect = page.rect
    if (
        a <= 0
        or d <= 0
        or abs(b) > 0.01
        or abs(c) > 0.01
        or any(abs(u - v) > 0.05 for u, v in zip((x, y, a, d), (rect.x0, rect.y0, rect.width, rect.height)))
    ):
        return "render", None
    # ponytail: conservative PDF operator allowlist; unfamiliar compositions ask for rendering.
    stream = re.sub(rb"%[^\r\n]*", b"", page.read_contents())
    number = rb"[+-]?(?:\d+(?:\.\d*)?|\.\d+)\s+"
    operation = rb"(?:[qQ]\s*|(?:" + number + rb"){6}cm\s*|/[\w.#-]+\s+Do\s*)"
    if not re.fullmatch(rb"\s*(?:" + operation + rb")*", stream):
        return "render", None
    # Resolve the drawn resource directly: xrefs=True decodes and hashes every resource image.
    names = re.findall(rb"/([\w.#-]+)\s+Do\b", stream)
    if len(names) != 1:
        return "render", None
    name = re.sub(rb"#([0-9a-fA-F]{2})", lambda m: bytes([int(m[1], 16)]), names[0]).decode("latin1")
    xrefs = {image[0] for image in page.get_images() if image[7] == name}
    if len(xrefs) != 1:
        return "render", None
    xref = xrefs.pop()
    if any(doc.xref_get_key(xref, key)[0] != "null" for key in ("SMask", "Mask", "Decode")):
        return "render", None
    try:
        image = _image_from_xref(doc, xref, 1)
        if image.width * image.height > 100_000_000 or abs((a / d) / (image.width / image.height) - 1) > 0.001:
            return "render", None
        if image.color_space not in (b"/DeviceRGB", b"/DeviceGray") and not (
            image.filter_name != "DCTDecode" and (image.color_space or b"").startswith(b"[/Indexed")
        ):
            return "render", None
        # Inspection decodes this temporary PNG immediately; compression only helps exports.
        ext, payload = image_to_epub_member(image, compression_level=0)
        with Image.open(io.BytesIO(payload)) as decoded:
            if decoded.size != (image.width, image.height) or decoded.getexif().get(274, 1) != 1:
                return "render", None
            decoded.load()
        return "image", {"kind": "pdf", "xref": xref, "width": image.width, "height": image.height, "ext": ext}
    except (ValueError, RuntimeError, OSError, AttributeError):
        return "render", None


def auto_render_scale(page) -> float:
    """Follow a scan's displayed pixel density, with a 6000-pixel longest edge."""
    bounds = page.rect * page.derotation_matrix
    scale, largest = 200 / 72, 0
    for image in page.get_image_info():
        area = (fitz.Rect(image["bbox"]) & bounds).get_area()
        a, b, c, d, _, _ = image["transform"]
        width, height = math.hypot(a, b), math.hypot(c, d)
        if area > largest and width > 0 and height > 0 and a * d != b * c:
            largest = area
            # ponytail: a dominant scan sets density; mixed layouts with only small images use 200 DPI.
            scale = max(image["width"] / width, image["height"] / height) if area >= bounds.get_area() / 2 else 200 / 72
    return min(scale, 6000 / max(page.rect.width, page.rect.height))


def import_pdf(path: str, asset_dir: Path, render: bool = False, dpi: int | str = "auto", progress=lambda *_: None) -> dict:
    source = Path(path).resolve(strict=True)
    if dpi != "auto" and (type(dpi) is not int or not 72 <= dpi <= 600):
        raise ValueError(t("Render resolution must be Auto or between 72 and 600 DPI"))
    fingerprint = digest(source)
    with fitz.open(source) as doc:
        if not doc.is_pdf or doc.needs_pass:
            raise ValueError(t("Choose an unencrypted PDF"))
        if not len(doc):
            raise ValueError(t("The PDF has no pages"))
        inspected = []
        progress(0, len(doc), t("Checking PDF pages"))
        for i, page in enumerate(doc):
            inspected.append(direct_image(doc, page))
            progress(i + 1, len(doc), t("Checking PDF pages"))
        complex_pages = [i + 1 for i, (kind, _) in enumerate(inspected) if kind == "render"]
        if complex_pages and not render:
            raise RenderRequired(complex_pages)
        source_id = new_id()
        book = {
            "schema": 1,
            "id": new_id(),
            "revision": 0,
            "metadata": {
                "title": source.stem,
                "author": "",
                "language": "zh-Hant",
                "direction": "rtl",
                "cover_id": None,
                "cover_only": False,
            },
            "sources": {source_id: {"path": str(source), "sha256": fingerprint, "page_count": len(doc)}},
            "assets": {},
            "pages": [],
            "extensions": {},
        }
        asset_dir.mkdir(parents=True, exist_ok=True)
        progress(0, len(doc), t("Preparing pages"))
        for i, (kind, asset) in enumerate(inspected):
            page = doc[i]
            if kind == "blank":
                book["pages"].append(
                    {
                        "id": new_id(),
                        "kind": "blank",
                        "source_page": i + 1,
                        "width": max(1, round(page.rect.width)),
                        "height": max(1, round(page.rect.height)),
                    }
                )
            else:
                if kind == "render":
                    scale = auto_render_scale(page) if dpi == "auto" else dpi / 72
                    bounds = (page.rect * fitz.Matrix(scale, scale)).irect
                    if bounds.width * bounds.height > 100_000_000:
                        raise ValueError(t("Page {0} is too large to render. Lower the DPI.", i + 1))
                    pix = page.get_pixmap(matrix=fitz.Matrix(scale, scale), alpha=False, colorspace=fitz.csRGB)
                    pix.set_dpi(max(1, round(scale * 72)), max(1, round(scale * 72)))
                    rendered = asset_dir / f"{fingerprint}-{i + 1}-{dpi}.png"
                    image = pix.pil_image()
                    colors = image.getcolors(256)
                    # Exact gray detection: all 256 gray levels fit, and even a slight tint keeps RGB.
                    if colors is not None and all(r == g == b for _, (r, g, b) in colors):
                        image = image.convert("L")
                    image.save(rendered, "PNG", compress_level=3, dpi=(pix.xres, pix.yres))
                    image.close()
                    asset = {
                        "kind": "file",
                        "path": str(rendered),
                        "width": pix.width,
                        "height": pix.height,
                        "ext": "png",
                        "derived_from": {"source_id": source_id, "page": i + 1, "dpi": scale * 72},
                    }
                else:
                    asset["source_id"] = source_id
                asset["source_page"] = i + 1
                asset_id = new_id()
                book["assets"][asset_id] = asset
                book["pages"].append(image_page(asset_id, asset, i + 1))
            progress(i + 1, len(doc), t("Preparing pages"))
    if digest(source) != fingerprint:
        raise ValueError(t("PDF changed during import. Please try again."))
    validate(book)
    return book


def load_asset(book: dict, asset_id: str, *, compression_level: int = 6) -> bytes:
    asset = book["assets"][asset_id]
    if asset["kind"] == "file":
        return Path(asset["path"]).read_bytes()
    source = book["sources"][asset["source_id"]]
    with fitz.open(source["path"]) as doc:
        ext, data = image_to_epub_member(_image_from_xref(doc, asset["xref"], 1), compression_level=compression_level)
        if ext != asset["ext"]:
            raise ValueError(t("Source image format changed"))
        return data


def crop_box(page: dict) -> tuple[int, int, int, int]:
    x, y, w, h = page["crop"]
    width, height = page["width"], page["height"]
    left, top = round(x * width), round(y * height)
    return left, top, max(left + 1, round((x + w) * width)), max(top + 1, round((y + h) * height))


def preview(book: dict, page_id: str, size: int, directory: Path) -> str:
    if type(size) is not int or not 64 <= size <= 2048:
        raise ValueError(t("Preview size is out of range"))
    page = next(p for p in book["pages"] if p["id"] == page_id)
    key = hashlib.sha256(json.dumps([book["id"], page, size], sort_keys=True).encode()).hexdigest()
    directory.mkdir(parents=True, exist_ok=True)
    output = directory / f"{key}.png"
    if not output.exists():
        if page["kind"] == "blank":
            scale = size / max(page["width"], page["height"])
            image = Image.new(
                "RGB", (max(1, round(page["width"] * scale)), max(1, round(page["height"] * scale))), "white"
            )
        else:
            with Image.open(io.BytesIO(load_asset(book, page["asset_id"], compression_level=0))) as original:
                if original.size != (page["width"], page["height"]):
                    raise ValueError(t("Asset dimensions do not match the project. Please import again."))
                image = original.crop(crop_box(page))
        image.thumbnail((size, size), Image.Resampling.LANCZOS)
        image.save(output, "PNG")
    return f"previews/{output.name}"


def import_images(paths: list[str], directory: Path) -> dict:
    assets, pages = {}, []
    for path in paths:
        source = Path(path).resolve(strict=True)
        with Image.open(source) as image:
            if image.width * image.height > 100_000_000:
                raise ValueError(t("Images cannot exceed 100 million pixels"))
            image.load()
            frame = ImageOps.exif_transpose(image)
            if image.format in ("JPEG", "PNG") and image.getexif().get(274, 1) == 1:
                ext = "jpg" if image.format == "JPEG" else "png"
                dest = copy_asset(source, directory, ext)
            else:
                directory.mkdir(parents=True, exist_ok=True)
                dest = directory / f"{new_id()}.png"
                frame.convert("RGBA" if "A" in frame.getbands() else "RGB").save(dest, "PNG")
                ext = "png"
            asset = {"kind": "file", "path": str(dest), "width": frame.width, "height": frame.height, "ext": ext}
        asset_id = new_id()
        assets[asset_id] = asset
        pages.append(image_page(asset_id, asset))
    return {"assets": assets, "pages": pages}


def export_epub(book: dict, path: str, progress=lambda *_: None) -> dict:
    validate(book)
    if not book["metadata"]["cover_id"]:
        raise ValueError(t("The book needs at least one image for its cover"))
    active = {p["asset_id"] for p in book["pages"] if p["kind"] == "image"}
    check_sources(book, active)
    pages = []
    loaded = 0

    def payload(asset_id):
        def load():
            nonlocal loaded
            data = load_asset(book, asset_id)
            loaded += 1
            progress(loaded, len(active), t("Writing EPUB images"))
            return data

        return load

    for i, page in enumerate(book["pages"], 1):
        blank = page["kind"] == "blank"
        asset = book["assets"].get(page.get("asset_id"), {})
        left, top, right, bottom = (0, 0, page["width"], page["height"]) if blank else crop_box(page)
        pages.append(
            EpubPage(
                index=i,
                width=page["width"],
                height=page["height"],
                image_href=None if blank else f"images/{page['asset_id']}.{asset['ext']}",
                image_media_type=None if blank else media_type_for_ext(asset["ext"]),
                image_data=None,
                xhtml_href=f"pages/{i:06d}.xhtml",
                item_id=f"page-{page['id']}",
                label=t("Page {0}", i),
                image_data_loader=None if blank else payload(page["asset_id"]),
                is_blank=blank,
                crop_x=left,
                crop_y=top,
                crop_width=right - left,
                crop_height=bottom - top,
            )
        )
    meta = book["metadata"]
    cover = next(p for p in book["pages"] if p["id"] == meta["cover_id"])
    cover_png = None
    if cover["crop"] != [0, 0, 1, 1]:
        with Image.open(io.BytesIO(load_asset(book, cover["asset_id"], compression_level=0))) as image:
            buffer = io.BytesIO()
            image.crop(crop_box(cover)).save(buffer, "PNG")
            cover_png = buffer.getvalue()
    progress(0, len(active), t("Writing EPUB images"))
    return write_epub_from_pages(
        pages,
        Path(path),
        Path(book["id"]),
        meta["title"],
        meta["author"],
        meta["language"],
        cover_item_id=f"page-{meta['cover_id']}",
        exclude_cover_from_reading=meta["cover_only"],
        reading_direction=meta["direction"],
        cover_png=cover_png,
    )


def export_images(book: dict, page_ids: list[str], path: str, progress=lambda *_: None) -> dict:
    selected = [p for p in book["pages"] if p["id"] in page_ids and p["kind"] == "image"]
    if not selected:
        raise ValueError(t("Select at least one image"))
    check_sources(book, {p["asset_id"] for p in selected})
    with ZipFile(path, "x", compression=ZIP_STORED) as archive:
        for i, page in enumerate(selected, 1):
            asset = book["assets"][page["asset_id"]]
            archive.writestr(f"{i:05d}.{asset['ext']}", load_asset(book, page["asset_id"]))
            progress(i, len(selected), t("Exporting original images"))
    return {"total": len(selected)}
