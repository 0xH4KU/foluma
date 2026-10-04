from __future__ import annotations

import re
import shutil
import stat
import tempfile
import xml.etree.ElementTree as ET
from pathlib import Path, PurePosixPath
from xml.parsers import expat
from zipfile import ZipFile

from foluma.i18n import t
from foluma.media import import_images
from foluma.model import new_id, validate
from foluma.series import natural_key
from foluma.storage import digest
from PIL import Image


def validate_archive(archive):
    entries = archive.infolist()
    if len(entries) > 10_000 or sum(entry.file_size for entry in entries) > 2_000_000_000:
        raise ValueError(t("Image archives cannot exceed 10000 entries or 2 GB of uncompressed data"))
    names = set()
    for entry in entries:
        member = PurePosixPath(entry.filename)
        if (member.is_absolute() or ".." in member.parts or "\\" in entry.filename
                or re.match(r"^[A-Za-z]:", entry.filename) or stat.S_ISLNK(entry.external_attr >> 16)
                or str(member) != entry.filename.rstrip("/") or "\x00" in entry.filename):
            raise ValueError(t("Unsafe path in package"))
        if entry.flag_bits & 1:
            raise ValueError(t("Encrypted archives are not supported"))
        name = entry.filename.casefold()
        if name in names:
            raise ValueError(t("Image archive contains duplicate filenames"))
        names.add(name)
    return entries


def handle(operation: str, params: dict, book: dict | None, progress):
    if operation != "import":
        raise ValueError(t("Unsupported background task"))
    source = Path(params["path"]).resolve(strict=True)
    fingerprint = digest(source)
    source_id = new_id()
    book = {"schema": 1, "id": new_id(), "revision": 0,
            "metadata": {"title": source.stem, "author": "", "language": "zh-Hant", "direction": "ltr",
                         "cover_id": None, "cover_only": False},
            "sources": {}, "assets": {}, "pages": [], "extensions": {}}
    with ZipFile(source) as archive, tempfile.TemporaryDirectory() as temporary:
        entries = validate_archive(archive)
        images = sorted((entry for entry in entries if not entry.is_dir()
                         and PurePosixPath(entry.filename).suffix.lower() in (".jpg", ".jpeg", ".png", ".webp")
                         and not any(part.startswith(".") or part == "__MACOSX"
                                     for part in PurePosixPath(entry.filename).parts)),
                        key=lambda entry: (natural_key(entry.filename), entry.filename))
        if not images:
            raise ValueError(t("The image archive contains no supported images"))
        if any(entry.file_size > 128_000_000 for entry in images):
            raise ValueError(t("Archived images cannot exceed 128 MB each"))
        comic_info = ET.Element("ComicInfo")
        metadata = next((entry for entry in entries if entry.filename.casefold() == "comicinfo.xml"), None)
        if metadata:
            if metadata.file_size > 1_000_000:
                raise ValueError(t("ComicInfo metadata cannot exceed 1 MB"))
            payload = archive.read(metadata)
            def reject_doctype(*_arguments):
                raise ValueError(t("ComicInfo metadata cannot contain document types or entities"))

            parser = expat.ParserCreate()
            parser.StartDoctypeDeclHandler = reject_doctype
            try:
                parser.Parse(payload, True)
                comic_info = ET.fromstring(payload)
            except (ET.ParseError, expat.ExpatError) as error:
                raise ValueError(t("Invalid ComicInfo metadata")) from error
            if comic_info.tag != "ComicInfo":
                raise ValueError(t("Invalid ComicInfo metadata"))
            book["metadata"].update(title=(comic_info.findtext("Title") or source.stem).strip() or source.stem,
                                    author=(comic_info.findtext("Writer") or "").strip(),
                                    language=(comic_info.findtext("LanguageISO") or "zh-Hant").strip(),
                                    direction="rtl" if (comic_info.findtext("Manga") or "").strip() == "YesAndRightToLeft" else "ltr")
        progress(0, len(images), t("Importing archived pages"))
        for number, entry in enumerate(images, 1):
            extracted = Path(temporary) / f"{number}{PurePosixPath(entry.filename).suffix.lower()}"
            with archive.open(entry) as incoming, extracted.open("xb") as outgoing:
                shutil.copyfileobj(incoming, outgoing)
            with Image.open(extracted) as image:
                if image.format not in ("JPEG", "PNG", "WEBP"):
                    raise ValueError(t("Unsupported image format"))
                if getattr(image, "n_frames", 1) != 1:
                    raise ValueError(t("Animated images are not supported in image archives"))
            imported = import_images([str(extracted)], Path(params["asset_directory"]))
            page = imported["pages"][0]
            page["source_page"] = number
            imported["assets"][page["asset_id"]].update(source_id=source_id, source_page=number, member=entry.filename)
            book["assets"].update(imported["assets"])
            book["pages"].append(page)
            extracted.unlink()
            progress(number, len(images), t("Importing archived pages"))
        for cover in comic_info.findall("Pages/Page"):
            if cover.get("Type") == "FrontCover":
                index = cover.get("Image", "")
                if not index.isdecimal() or not 0 <= int(index) < len(images):
                    raise ValueError(t("Invalid ComicInfo cover page"))
                book["metadata"]["cover_id"] = book["pages"][int(index)]["id"]
                break
    if digest(source) != fingerprint:
        raise ValueError(t("Source changed during import. Please import again."))
    book["sources"][source_id] = {"path": str(source), "sha256": fingerprint, "page_count": len(book["pages"])}
    validate(book)
    return book
