"""PDF decoding belongs to the independently installed import plugin."""

from __future__ import annotations

import copy
import io
import math
import re
from pathlib import Path

import pymupdf as fitz
from foluma.i18n import t
from foluma.model import image_page, new_id, validate
from foluma.storage import check_sources, copy_asset, digest, write_asset
from PIL import Image

from .image_extraction import _image_from_xref
from .png import image_to_epub_member


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
                    rendered = asset_dir / f".render-{new_id()}.png"
                    image = pix.pil_image()
                    colors = image.getcolors(256)
                    # Exact gray detection: all 256 gray levels fit, and even a slight tint keeps RGB.
                    if colors is not None and all(r == g == b for _, (r, g, b) in colors):
                        image = image.convert("L")
                    try:
                        image.save(rendered, "PNG", compress_level=3, dpi=(pix.xres, pix.yres))
                        stored = copy_asset(rendered, asset_dir, "png")
                    finally:
                        image.close()
                        rendered.unlink(missing_ok=True)
                    asset = {
                        "kind": "file",
                        "path": str(stored),
                        "width": pix.width,
                        "height": pix.height,
                        "ext": "png",
                        "derived_from": {"source_id": source_id, "page": i + 1, "dpi": scale * 72},
                    }
                else:
                    payload = image_to_epub_member(_image_from_xref(doc, asset["xref"], 1), compression_level=3)[1]
                    asset.update(kind="file", path=str(write_asset(payload, asset_dir, asset["ext"])), source_id=source_id)
                asset["source_page"] = i + 1
                asset_id = new_id()
                book["assets"][asset_id] = asset
                book["pages"].append(image_page(asset_id, asset, i + 1))
            progress(i + 1, len(doc), t("Preparing pages"))
    if digest(source) != fingerprint:
        raise ValueError(t("PDF changed during import. Please try again."))
    validate(book)
    return book



def materialize(book: dict, directory: Path, progress=lambda *_: None) -> dict:
    check_sources(book)
    result = copy.deepcopy(book)
    legacy = [asset for asset in result["assets"].values() if asset["kind"] == "pdf"]
    done = 0
    for source_id in dict.fromkeys(asset["source_id"] for asset in legacy):
        source = result["sources"][source_id]
        with fitz.open(source["path"]) as doc:
            for asset in legacy:
                if asset["source_id"] != source_id:
                    continue
                extension, payload = image_to_epub_member(_image_from_xref(doc, asset["xref"], 1), compression_level=3)
                if extension != asset["ext"]:
                    raise ValueError(t("Source image format changed"))
                asset.update(kind="file", path=str(write_asset(payload, directory, extension)))
                done += 1
                progress(done, len(legacy), t("Saving project images"))
        if digest(Path(source["path"])) != source["sha256"]:
            raise ValueError(t("Source changed. Please import again: {0}", Path(source["path"]).name))
    validate(result)
    return result


def handle(operation: str, params: dict, book: dict | None, progress):
    directory = Path(params["asset_directory"])
    if operation == "materialize":
        return materialize(book, directory, progress)
    if operation != "import":
        raise ValueError(t("Unsupported background task"))
    options = params.get("options", {})
    return import_pdf(params["path"], directory, render=options.get("render", False),
                      dpi=options.get("dpi", "auto"), progress=progress)
