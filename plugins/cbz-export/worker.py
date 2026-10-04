from __future__ import annotations

import io
import xml.etree.ElementTree as ET
from zipfile import ZIP_STORED, ZipFile

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
    metadata = book["metadata"]
    comic_info = ET.Element("ComicInfo")
    for name, value in (("Title", metadata["title"]), ("Writer", metadata["author"]),
                        ("LanguageISO", metadata["language"]), ("PageCount", str(len(book["pages"]))),
                        ("Manga", "YesAndRightToLeft" if metadata["direction"] == "rtl" else "No")):
        ET.SubElement(comic_info, name).text = value
    cover_pages = ET.SubElement(comic_info, "Pages")
    progress(0, len(book["pages"]), t("Writing CBZ pages"))
    with ZipFile(params["path"], "x", compression=ZIP_STORED) as archive:
        for number, page in enumerate(book["pages"], 1):
            extension = "png"
            if page["kind"] == "blank":
                if page["width"] * page["height"] > 100_000_000:
                    raise ValueError(t("Images cannot exceed 100 million pixels"))
                with Image.new("RGB", (page["width"], page["height"]), "white") as image:
                    output = io.BytesIO()
                    image.save(output, "PNG")
                    payload = output.getvalue()
            else:
                payload = load_asset(book, page["asset_id"])
                with Image.open(io.BytesIO(payload)) as image:
                    if image.size != (page["width"], page["height"]):
                        raise ValueError(t("Asset dimensions do not match the project. Please import again."))
                    if getattr(image, "n_frames", 1) != 1:
                        raise ValueError(t("Animated images are not supported in CBZ books"))
                    image.load()
                    if page["crop"] == [0, 0, 1, 1]:
                        extension = book["assets"][page["asset_id"]]["ext"]
                    else:
                        with image.crop(crop_box(page)) as cropped:
                            output = io.BytesIO()
                            if cropped.mode == "CMYK":
                                cropped = cropped.convert("RGB")
                            cropped.save(output, "PNG")
                            payload = output.getvalue()
            archive.writestr(f"{number:05d}.{extension}", payload)
            if page["id"] == metadata["cover_id"]:
                ET.SubElement(cover_pages, "Page", Image=str(number - 1), Type="FrontCover")
            progress(number, len(book["pages"]), t("Writing CBZ pages"))
        payload = ET.tostring(comic_info, encoding="utf-8", xml_declaration=True)
        try:
            ET.fromstring(payload)
        except ET.ParseError as error:
            raise ValueError(t("Book metadata contains characters that cannot be written to ComicInfo")) from error
        archive.writestr("ComicInfo.xml", payload)
    return {"total": len(book["pages"])}


if __name__ == "__main__":
    run_plugin(handle)
