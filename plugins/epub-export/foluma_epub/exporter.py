"""Fixed-layout EPUB encoding belongs to the independently installed export plugin."""

from __future__ import annotations

import io
from pathlib import Path

from foluma.i18n import t
from foluma.media import crop_box, load_asset
from foluma.model import validate
from foluma.storage import check_sources
from PIL import Image

from .writer import DEFAULT_VIEWPORT, EpubPage, media_type_for_ext, write_epub_from_pages


def export_epub(book: dict, path: str, progress=lambda *_: None, *,
                viewport: tuple[int, int] = DEFAULT_VIEWPORT) -> dict:
    validate(book)
    if not book["metadata"]["cover_id"]:
        raise ValueError(t("The book needs at least one image for its cover"))
    active = {p["asset_id"] for p in book["pages"] if p["kind"] == "image"}
    check_sources(book, active)
    pages = []
    loaded = 0
    meta = book["metadata"]
    reading = [page for page in book["pages"] if not meta["cover_only"] or page["id"] != meta["cover_id"]]
    positions = {page["id"]: index for index, page in enumerate(reading)}
    review = book["extensions"].get("org.foluma.editor", {})
    marks = review.get("spreads", []) if isinstance(review, dict) else []
    joined = set()
    seen = set()
    for pair in marks if isinstance(marks, list) else []:
        if (not isinstance(pair, list) or len(pair) != 2 or
                not all(isinstance(identifier, str) and identifier for identifier in pair) or pair[0] == pair[1]):
            continue
        key = tuple(sorted(pair))
        if key in seen:
            continue
        seen.add(key)
        indexes = sorted(positions.get(identifier, -1) for identifier in pair)
        start, end = indexes
        if (start < 0 or end != start + 1 or any(identifier in joined for identifier in pair) or
                any(reading[index]["kind"] != "image" for index in indexes)):
            raise ValueError(t("Update or remove invalid spread marks before exporting."))
        if start % 2 != 1:
            raise ValueError(t("Add a blank page to align the marked spread before exporting."))
        joined.update(pair)
    appearance = book["extensions"].get("org.foluma.page-tools", {})
    colors = appearance.get("colors", {}) if isinstance(appearance, dict) else {}
    if not isinstance(colors, dict):
        colors = {}
    no_margins = appearance.get("no_margins", []) if isinstance(appearance, dict) else []
    if not isinstance(no_margins, list):
        no_margins = []

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
                xhtml_href=f"pages/{i:06d}.xhtml",
                item_id=f"page-{page['id']}",
                label=t("Page {0}", i),
                image_data_loader=None if blank else payload(page["asset_id"]),
                is_blank=blank,
                crop_x=left,
                crop_y=top,
                crop_width=right - left,
                crop_height=bottom - top,
                is_spread=page["id"] in joined,
                background="black" if colors.get(page["id"]) == "black" else "white",
                no_margins=page["id"] in no_margins,
            )
        )
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
        viewport=viewport,
    )



def handle(operation: str, params: dict, book: dict | None, progress):
    if operation != "export":
        raise ValueError(t("Unsupported background task"))
    options = params.get("options", {})
    return export_epub(book, params["path"], progress, viewport=options.get("viewport", DEFAULT_VIEWPORT))
