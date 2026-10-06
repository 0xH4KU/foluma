"""Generic image resources and previews; no document-format codecs live here."""

from __future__ import annotations

import io
from pathlib import Path
from zipfile import ZIP_STORED, ZipFile

from PIL import Image, ImageOps

from .i18n import t
from .model import image_page, new_id
from .storage import check_sources, copy_asset, preview_path


def load_asset(book: dict, asset_id: str) -> bytes:
    asset = book["assets"][asset_id]
    if asset["kind"] != "file":
        raise ValueError(t("Open this legacy project with its import plugin enabled to save its images first"))
    return Path(asset["path"]).read_bytes()


def crop_box(page: dict) -> tuple[int, int, int, int]:
    x, y, w, h = page["crop"]
    width, height = page["width"], page["height"]
    left, top = round(x * width), round(y * height)
    return left, top, max(left + 1, round((x + w) * width)), max(top + 1, round((y + h) * height))


def preview(book: dict, page_id: str, size: int, directory: Path) -> str:
    output = preview_path(book, page_id, size, directory)
    page = next(p for p in book["pages"] if p["id"] == page_id)
    directory.mkdir(parents=True, exist_ok=True)
    if not output.exists():
        if page["kind"] == "blank":
            scale = size / max(page["width"], page["height"])
            image = Image.new(
                "RGB", (max(1, round(page["width"] * scale)), max(1, round(page["height"] * scale))), "white"
            )
        else:
            with Image.open(io.BytesIO(load_asset(book, page["asset_id"]))) as original:
                if original.size != (page["width"], page["height"]):
                    raise ValueError(t("Asset dimensions do not match the project. Please import again."))
                image = original.crop(crop_box(page))
        if image.mode == "CMYK":
            image = image.convert("RGB")
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
                frame.convert("RGBA" if "A" in frame.getbands() or "transparency" in frame.info else "RGB").save(dest, "PNG")
                ext = "png"
            asset = {"kind": "file", "path": str(dest), "width": frame.width, "height": frame.height, "ext": ext}
        asset_id = new_id()
        assets[asset_id] = asset
        pages.append(image_page(asset_id, asset))
    return {"assets": assets, "pages": pages}


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
