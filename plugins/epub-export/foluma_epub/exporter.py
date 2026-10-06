"""Fixed-layout EPUB encoding belongs to the independently installed export plugin."""

from __future__ import annotations

import io
from pathlib import Path

from foluma.i18n import t
from foluma.media import crop_box, load_asset
from foluma.model import validate
from foluma.storage import check_sources
from PIL import Image

from .writer import EpubPage, media_type_for_ext, write_epub_from_pages


def export_epub(book: dict, path: str, progress=lambda *_: None, *, layout: str = "general") -> dict:
    if layout not in ("general", "spread"):
        raise ValueError(t("Unknown EPUB layout"))
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
        with Image.open(io.BytesIO(load_asset(book, cover["asset_id"]))) as image:
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
        layout=layout,
    )



def handle(operation: str, params: dict, book: dict | None, progress):
    if operation != "export":
        raise ValueError(t("Unsupported background task"))
    return export_epub(book, params["path"], progress, layout=params.get("options", {}).get("layout", "general"))
