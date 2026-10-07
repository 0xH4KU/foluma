"""Serializable book state. No UI, PDF objects, or EPUB filenames live here."""

from __future__ import annotations

import copy
import math
import re
import uuid

from .i18n import t


class EngineError(ValueError):
    def __init__(self, message: str, data=None):
        super().__init__(message)
        self.data = data


def new_id() -> str:
    return str(uuid.uuid4())


def image_page(asset_id: str, asset: dict, source_page: int | None = None) -> dict:
    return {
        "id": new_id(),
        "kind": "image",
        "asset_id": asset_id,
        "width": asset["width"],
        "height": asset["height"],
        "crop": [0, 0, 1, 1],
        "source_page": source_page,
    }


def validate_crop(crop) -> None:
    if (
        not isinstance(crop, list)
        or len(crop) != 4
        or any(type(n) not in (int, float) or not math.isfinite(n) for n in crop)
    ):
        raise ValueError(t("Invalid crop bounds"))
    x, y, w, h = crop
    if x < 0 or y < 0 or w <= 0 or h <= 0 or x + w > 1.0000001 or y + h > 1.0000001:
        raise ValueError(t("Crop extends outside the image"))


INFORMATION_FIELDS = ("title", "author", "language", "direction", "cover_only")
REVIEW_EXTENSION_ID = "org.foluma.editor"  # Shared API 1 review contract; preserve existing projects and plugins.


def review_page_ids(book: dict) -> set[str]:
    data = book["extensions"].get(REVIEW_EXTENSION_ID, {})
    marks = data.get("review", []) if isinstance(data, dict) else []
    pages = {page["id"] for page in book["pages"]}
    return {mark for mark in marks if isinstance(mark, str) and mark in pages} if isinstance(marks, list) else set()


def validate_metadata(meta: dict) -> None:
    if not isinstance(meta, dict):
        raise ValueError(t("Invalid book metadata"))
    for name in ("title", "author", "language"):
        if not isinstance(meta.get(name), str) or len(meta[name]) > 4096:
            raise ValueError(t("Invalid book metadata: {0}", name))
    if not meta["title"].strip() or not re.fullmatch(r"[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*", meta["language"]):
        raise ValueError(t("Enter a title and a valid language code, such as en or zh-Hant"))
    if meta.get("direction") not in ("rtl", "ltr") or type(meta.get("cover_only")) is not bool:
        raise ValueError(t("Invalid reading settings"))


def information_patch(value, *, allow_empty=False) -> dict:
    if not isinstance(value, dict) or set(value) - set(INFORMATION_FIELDS) or not value and not allow_empty:
        raise ValueError(t("Choose valid book information to change"))
    validate_metadata(
        {"title": "Book", "author": "", "language": "en", "direction": "ltr", "cover_only": False} | value
    )
    return copy.deepcopy(value)


def review_unchanged(before: dict, after: dict) -> bool:
    def content(book):
        return {key: value for key, value in book.items() if key not in ("revision", "metadata")} | {
            "metadata": {
                key: value for key, value in book["metadata"].items() if key not in ("title", "author", "language")
            }
        }

    return content(before) == content(after)


def validate(book: dict) -> None:
    def identifier(value):
        return isinstance(value, str) and re.fullmatch(r"[A-Za-z0-9_-]{1,80}", value)

    if book.get("schema") != 1 or not identifier(book.get("id")):
        raise ValueError(t("Unsupported Foluma document format"))
    if type(book.get("revision")) is not int or book["revision"] < 0:
        raise ValueError(t("Invalid document revision"))
    meta = book.get("metadata", {})
    validate_metadata(meta)
    if not isinstance(book.get("assets"), dict) or not isinstance(book.get("sources"), dict):
        raise ValueError(t("Invalid asset table"))
    if not isinstance(book.get("extensions"), dict) or not isinstance(book.get("pages"), list):
        raise ValueError(t("Invalid page or plugin data"))
    if not all(identifier(key) for key in (*book["sources"], *book["assets"])):
        raise ValueError(t("Invalid asset or source ID"))
    for source in book["sources"].values():
        if not isinstance(source, dict) or not isinstance(source.get("path"), str):
            raise ValueError(t("Invalid source reference"))
        if not re.fullmatch(r"[a-f0-9]{64}", source.get("sha256", "")):
            raise ValueError(t("Invalid source fingerprint"))
    for asset in book["assets"].values():
        if not isinstance(asset, dict) or asset.get("kind") not in ("pdf", "file"):
            raise ValueError(t("Invalid asset type"))
        for name in ("width", "height"):
            if type(asset.get(name)) is not int or not 0 < asset[name] <= 100000:
                raise ValueError(t("Asset dimensions are out of range"))
        if asset["width"] * asset["height"] > 100_000_000:
            raise ValueError(t("Images cannot exceed 100 million pixels"))
        if asset.get("ext") not in ("jpg", "png"):
            raise ValueError(t("Unsupported image format"))
        if asset["kind"] == "pdf":
            if asset.get("source_id") not in book["sources"] or type(asset.get("xref")) is not int:
                raise ValueError(t("Invalid PDF image reference"))
        elif not isinstance(asset.get("path"), str):
            raise ValueError(t("Image path is missing"))
    seen = set()
    for page in book["pages"]:
        if not isinstance(page, dict) or not identifier(page.get("id")) or page["id"] in seen:
            raise ValueError(t("Page ID is missing or duplicated"))
        seen.add(page["id"])
        if page.get("kind") not in ("image", "blank"):
            raise ValueError(t("A compatible plugin is required to process this page"))
        rotation = page.get("rotation", 0)
        if type(rotation) is not int or rotation not in (0, 90, 180, 270) or (rotation and page["kind"] != "image"):
            raise ValueError(t("Rotation must be 0, 90, 180 or 270 degrees for image pages."))
        for name in ("width", "height"):
            if type(page.get(name)) is not int or not 0 < page[name] <= 100000:
                raise ValueError(t("Invalid page size"))
        if page["kind"] == "image":
            if page.get("asset_id") not in book["assets"]:
                raise ValueError(t("Page references a missing asset"))
            asset = book["assets"][page["asset_id"]]
            if (page["width"], page["height"]) != (asset["width"], asset["height"]):
                raise ValueError(t("Page dimensions must match the original asset"))
            validate_crop(page.get("crop"))
            if "split" in page:
                split = page["split"]
                if (
                    not isinstance(split, dict)
                    or not identifier(split.get("group"))
                    or split.get("side") not in ("left", "right")
                ):
                    raise ValueError(t("Invalid split page relationship"))
                original = split.get("original")
                if (
                    not isinstance(original, dict)
                    or not identifier(original.get("id"))
                    or "split" in original
                    or any(original.get(k) != page.get(k) for k in ("kind", "asset_id", "width", "height"))
                ):
                    raise ValueError(t("Split page has no valid original page"))
                validate_crop(original.get("crop"))
                if type(original.get("rotation", 0)) is not int or original.get("rotation", 0) not in (0, 90, 180, 270):
                    raise ValueError(t("Invalid original page rotation"))
    images = [p["id"] for p in book["pages"] if p["kind"] == "image"]
    if meta.get("cover_id") not in images:
        meta["cover_id"] = images[0] if images else None


class Session:
    def __init__(self, book: dict, project_path: str | None = None):
        validate(book)
        self.book = copy.deepcopy(book)
        self.project_path = project_path
        self.saved_revision = book["revision"]
        self.undo_stack: list[dict] = []
        self.redo_stack: list[dict] = []

    def snapshot(self) -> dict:
        return copy.deepcopy(self.book) | {
            "project_path": self.project_path,
            "dirty": self.saved_revision != self.book["revision"],
            "can_undo": bool(self.undo_stack),
            "can_redo": bool(self.redo_stack),
        }

    def check(self, document_id: str, revision: int | None = None) -> None:
        if document_id != self.book["id"]:
            raise ValueError(t("This operation belongs to another document. Please reopen the tool."))
        if revision is not None and revision != self.book["revision"]:
            raise ValueError(t("Document changed. Please retry with the latest revision."))

    def apply(self, document_id: str, base_revision: int, changes: dict) -> dict:
        self.check(document_id, base_revision)
        if not isinstance(changes, dict) or set(changes) - {"pages", "metadata", "extension"}:
            raise ValueError(t("Unsupported document changes"))
        candidate = copy.deepcopy(self.book)
        if "pages" in changes:
            candidate["pages"] = copy.deepcopy(changes["pages"])
        if "metadata" in changes:
            if not isinstance(changes["metadata"], dict):
                raise ValueError(t("Invalid book metadata"))
            candidate["metadata"].update(changes["metadata"])
        if "extension" in changes:
            item = changes["extension"]
            if not isinstance(item, dict) or not re.fullmatch(r"[a-z0-9][a-z0-9.-]{1,79}", item.get("id", "")):
                raise ValueError(t("Invalid plugin ID"))
            candidate["extensions"][item["id"]] = copy.deepcopy(item.get("data"))
        validate(candidate)
        if candidate["metadata"]["direction"] != self.book["metadata"]["direction"]:
            pages = candidate["pages"]
            wanted = "right" if candidate["metadata"]["direction"] == "rtl" else "left"
            index = 0
            while index + 1 < len(pages):
                a, b = pages[index].get("split"), pages[index + 1].get("split")
                if a and b and a["group"] == b["group"] and a["original"] == b["original"] and a["side"] != b["side"]:
                    if a["side"] != wanted:
                        pages[index : index + 2] = [pages[index + 1], pages[index]]
                    index += 2
                else:
                    index += 1
        if candidate != self.book:
            # ponytail: 100 metadata snapshots; use deltas if very large documents require it.
            self.undo_stack = (self.undo_stack + [self.book])[-100:]
            self.redo_stack.clear()
            candidate["revision"] += 1
            self.book = candidate
        return self.snapshot()

    def history(self, document_id: str, redo: bool = False) -> dict:
        self.check(document_id)
        source, target = (self.redo_stack, self.undo_stack) if redo else (self.undo_stack, self.redo_stack)
        if source:
            previous = copy.deepcopy(source.pop())
            previous["assets"].update(self.book["assets"])
            previous["revision"] = self.book["revision"] + 1
            target.append(self.book)
            self.book = previous
        return self.snapshot()
