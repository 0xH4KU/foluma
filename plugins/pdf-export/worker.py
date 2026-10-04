from __future__ import annotations

import io

import pymupdf as fitz
from foluma.i18n import t
from foluma.media import crop_box, load_asset
from foluma.model import validate
from foluma.worker import run_plugin
from PIL import Image


def handle(operation: str, params: dict, book: dict | None, progress):
    if operation != "export":
        raise ValueError(t("Unsupported background task"))
    validate(book)
    if not book["pages"]:
        raise ValueError(t("The book has no pages"))
    references = {}
    progress(0, len(book["pages"]), t("Writing PDF pages"))
    with fitz.open() as document:
        metadata = book["metadata"]
        document.set_metadata({"title": metadata["title"], "author": metadata["author"], "creator": "Foluma"})
        document.xref_set_key(document.pdf_catalog(), "Lang", fitz.get_pdf_str(metadata["language"]))
        document.xref_set_key(document.pdf_catalog(), "ViewerPreferences/Direction",
                              "/R2L" if metadata["direction"] == "rtl" else "/L2R")
        for number, page in enumerate(book["pages"], 1):
            bounds = (0, 0, page["width"], page["height"]) if page["kind"] == "blank" else crop_box(page)
            left, top, right, bottom = bounds
            scale = min(1, 14_400 / max(right - left, bottom - top))
            output = document.new_page(width=(right - left) * scale, height=(bottom - top) * scale)
            if page["kind"] == "image":
                asset_id = page["asset_id"]
                reference = references.get(asset_id, 0)
                payload = None
                if not reference:
                    payload = load_asset(book, asset_id)
                    with Image.open(io.BytesIO(payload)) as image:
                        if image.size != (page["width"], page["height"]):
                            raise ValueError(t("Asset dimensions do not match the project. Please import again."))
                        image.load()
                placement = fitz.Rect(-left, -top, page["width"] - left, page["height"] - top) * scale
                references[asset_id] = output.insert_image(placement, stream=payload, xref=reference, keep_proportion=False)
            progress(number, len(book["pages"]), t("Writing PDF pages"))
        document.save(params["path"], garbage=4, deflate=True)
    return {"total": len(book["pages"])}


if __name__ == "__main__":
    run_plugin(handle)
