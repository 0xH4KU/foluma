"""Page-local frame anchors and reversible rendered images; no book-format codecs."""

from __future__ import annotations

import base64
import copy
import io
import math
from pathlib import Path

from foluma.i18n import t
from foluma.media import page_image
from foluma.model import EngineError, new_id, validate, validate_crop
from foluma.storage import write_asset
from PIL import Image, ImageChops

PLUGIN_ID = "org.foluma.page-layout"
DEFAULT_SETTINGS = {"frame": [0, 0, 1, 1], "angle": 0, "height": 81, "inner": 4, "offset_x": 0, "offset_y": 0}


def settings(value):
    if not isinstance(value, dict) or set(value) != set(DEFAULT_SETTINGS):
        raise ValueError(t("Invalid page adjustment"))
    validate_crop(value["frame"])
    for key, minimum, maximum in (("angle", -5, 5), ("height", 20, 100), ("inner", 0, 40),
                                  ("offset_x", -30, 30), ("offset_y", -30, 30)):
        number = value[key]
        if type(number) not in (int, float) or not math.isfinite(number) or not minimum <= number <= maximum:
            raise ValueError(t("Invalid page adjustment: {0}", key))
    return copy.deepcopy(value)


def canvas_size(value):
    if (not isinstance(value, list) or len(value) != 2
            or any(type(number) is not int or not 64 <= number <= 10000 for number in value)
            or value[0] * value[1] > 100_000_000):
        raise ValueError(t("Page canvas must be between 64 and 10000 pixels per side"))
    return value


def layout_data(book):
    data = copy.deepcopy(book["extensions"].get(PLUGIN_ID, {"schema": 1, "pages": {}}))
    if not isinstance(data, dict) or data.get("schema") != 1 or not isinstance(data.get("pages"), dict):
        raise ValueError(t("Unsupported page adjustment data"))
    return data


def source_page(book, page, record=None):
    if page["kind"] != "image":
        raise ValueError(t("Choose an image page to adjust"))
    if record is not None:
        if not isinstance(record, dict) or page != record.get("rendered"):
            raise ValueError(t("This page was changed in another editor. Undo those changes or restore its source first."))
        original = record.get("source")
    else:
        original = page
    if (not isinstance(original, dict) or original.get("id") != page["id"] or original.get("kind") != "image"
            or not isinstance(original.get("asset_id"), str) or original["asset_id"] not in book["assets"]):
        raise ValueError(t("Invalid saved source page"))
    candidate = book | {"pages": [original], "metadata": dict(book["metadata"]),
                        "assets": {original["asset_id"]: book["assets"][original["asset_id"]]}}
    validate(candidate)
    return original


def source_image(book, page):
    with page_image(book, page) as image:
        if image.mode == "RGBA" or "transparency" in image.info:
            with image.convert("RGBA") as rgba, Image.new("RGBA", image.size, "white") as background:
                return Image.alpha_composite(background, rgba).convert("RGB")
        return image.convert("RGB")


def placement(width, height, canvas, adjustment, side):
    radians = math.radians(adjustment["angle"])
    cosine, sine = math.cos(radians), math.sin(radians)
    rotated_width = math.ceil(abs(width * cosine) + abs(height * sine))
    rotated_height = math.ceil(abs(width * sine) + abs(height * cosine))
    x, y, frame_width, frame_height = adjustment["frame"]
    frame_x, frame_y = (x + frame_width / 2) * rotated_width, (y + frame_height / 2) * rotated_height
    cw, ch = canvas
    inner = adjustment["inner"] / 100 * cw
    scale = min(ch * adjustment["height"] / 100 / (frame_height * rotated_height),
                (cw - 2 * inner) / (frame_width * rotated_width))
    target_width = frame_width * rotated_width * scale
    center_x = (cw - inner - target_width / 2 if side == "left" else
                inner + target_width / 2 if side == "right" else cw / 2)
    center_x += cw * adjustment["offset_x"] / 100
    center_y = ch * (0.5 + adjustment["offset_y"] / 100)
    a, b = scale * cosine, scale * sine
    tx = center_x + scale * (rotated_width / 2 - frame_x) - a * width / 2 + b * height / 2
    ty = center_y + scale * (rotated_height / 2 - frame_y) - b * width / 2 - a * height / 2
    return a, b, -b, a, tx, ty


def page_side(book, identifier):
    if book["metadata"]["cover_only"] and identifier == book["metadata"]["cover_id"]:
        return "center"
    reading = [page for page in book["pages"]
               if not book["metadata"]["cover_only"] or page["id"] != book["metadata"]["cover_id"]]
    index = next(index for index, page in enumerate(reading) if page["id"] == identifier)
    left = index % 2 == (0 if book["metadata"]["direction"] == "rtl" else 1)
    return "left" if left else "right"


def clips_ink(image, matrix, canvas):
    with Image.new("RGB", image.size, "white") as white, ImageChops.difference(image, white) as difference:
        with difference.convert("L") as grayscale, grayscale.point(lambda value: 255 if value > 12 else 0) as ink:
            bounds = ink.getbbox()
    if bounds is None:
        return False
    a, b, c, d, tx, ty = matrix
    left, top, right, bottom = bounds
    corners = [(a * x + c * y + tx, b * x + d * y + ty) for x in (left, right) for y in (top, bottom)]
    # shortcut: a conservative ink rectangle can flag empty corners; verify the preview before permitting clipping.
    return any(x < -0.5 or y < -0.5 or x > canvas[0] + 0.5 or y > canvas[1] + 0.5 for x, y in corners)


def render(image, matrix, canvas):
    a, b, c, d, tx, ty = matrix
    determinant = a * d - b * c
    inverse = (d / determinant, -c / determinant, (c * ty - d * tx) / determinant,
               -b / determinant, a / determinant, (b * tx - a * ty) / determinant)
    return image.transform(tuple(canvas), Image.Transform.AFFINE, inverse,
                           resample=Image.Resampling.BICUBIC, fillcolor="white")


def handle(operation, params, book, progress):
    if operation != "plugin" or not isinstance(params, dict):
        raise ValueError(t("Unsupported background task"))
    validate(book)
    data = layout_data(book)
    pages = {page["id"]: page for page in book["pages"]}
    action = params.get("action")
    if action == "inspect":
        identifiers = params.get("page_ids")
        if (not isinstance(identifiers, list) or not 0 < len(identifiers) <= 4
                or any(not isinstance(identifier, str) or identifier not in pages for identifier in identifiers)):
            raise ValueError(t("Choose valid pages to preview"))
        result = {}
        for identifier in dict.fromkeys(identifiers):
            page = pages[identifier]
            if page["kind"] == "blank":
                continue
            original = source_page(book, page, data["pages"].get(identifier))
            with source_image(book, original) as image:
                size = image.size
                image.thumbnail((1600, 1600), Image.Resampling.LANCZOS)
                buffer = io.BytesIO()
                image.save(buffer, "PNG", compress_level=3)
                result[identifier] = {"width": size[0], "height": size[1],
                                      "url": "data:image/png;base64," + base64.b64encode(buffer.getvalue()).decode()}
        return {"result": result}
    if action == "reset":
        identifiers = params.get("page_ids")
        if not isinstance(identifiers, list) or any(not isinstance(key, str) or key not in pages for key in identifiers):
            raise ValueError(t("Choose valid pages to restore"))
        restored = {}
        for identifier in identifiers:
            record = data["pages"].get(identifier)
            if record is not None:
                if not isinstance(record, dict) or not isinstance(record.get("rendered"), dict) or record["rendered"].get("id") != identifier:
                    raise ValueError(t("Invalid saved source page"))
                # The UI explicitly confirms discarding subsequent crop/rotation edits when restoring a source.
                original = source_page(book, record["rendered"], record)
                restored[identifier] = copy.deepcopy(original)
                del data["pages"][identifier]
        return {"changes": {"pages": [restored.get(page["id"], page) for page in book["pages"]],
                            "extension": {"id": PLUGIN_ID, "data": data}}}
    if action not in ("check", "apply"):
        raise ValueError(t("Unsupported background task"))
    canvas = canvas_size(params.get("canvas"))
    edits = params.get("edits")
    if (not isinstance(edits, dict) or not edits or len(edits) > 10000
            or any(identifier not in pages for identifier in edits)):
        raise ValueError(t("Choose valid image pages to adjust"))
    adjustments = {identifier: settings(value) for identifier, value in edits.items()}
    originals = {identifier: source_page(book, pages[identifier], data["pages"].get(identifier)) for identifier in edits}
    warnings, assets, updated = [], {}, {}
    allow_clipping = params.get("allow_clipping", False)
    if type(allow_clipping) is not bool:
        raise ValueError(t("Invalid clipping confirmation"))
    progress(0, len(edits), t("Preparing page adjustments"))
    for number, (identifier, adjustment) in enumerate(adjustments.items(), 1):
        original = originals[identifier]
        with source_image(book, original) as image:
            side = page_side(book, identifier)
            matrix = placement(*image.size, canvas, adjustment, side)
            clipped = clips_ink(image, matrix, canvas)
            if clipped:
                warnings.append(identifier)
            if action == "apply":
                if clipped and not allow_clipping:
                    raise EngineError(t("Some content extends beyond the page canvas. Review the preview before clipping."),
                                      {"kind": "page_layout_clipping", "page_ids": warnings})
                with render(image, matrix, canvas) as output:
                    buffer = io.BytesIO()
                    output.save(buffer, "PNG", compress_level=3)
                    path = write_asset(buffer.getvalue(), Path(params["asset_directory"]), "png")
                asset_id = new_id()
                assets[asset_id] = {"kind": "file", "path": str(path), "width": canvas[0], "height": canvas[1], "ext": "png"}
                page = {key: value for key, value in original.items() if key not in ("rotation", "split")}
                page.update(asset_id=asset_id, width=canvas[0], height=canvas[1], crop=[0, 0, 1, 1])
                updated[identifier] = page
                data["pages"][identifier] = {"source": copy.deepcopy(original), "rendered": copy.deepcopy(page),
                                             "settings": adjustment, "canvas": list(canvas), "side": side}
        progress(number, len(edits), t("Preparing page adjustments"))
    if action == "check":
        return {"result": {"clipped": warnings}}
    data["canvas"] = list(canvas)
    reference = params.get("reference_id")
    if reference is not None:
        if not isinstance(reference, str) or reference not in adjustments:
            raise ValueError(t("Choose an adjusted page as the reference"))
        data["reference"] = {"page_id": reference, "settings": adjustments[reference], "canvas": list(canvas)}
    return {"assets": assets, "changes": {
        "pages": [updated.get(page["id"], page) for page in book["pages"]],
        "extension": {"id": PLUGIN_ID, "data": data},
    }}
