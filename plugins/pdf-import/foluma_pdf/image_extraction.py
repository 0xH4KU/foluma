from __future__ import annotations

import re

from .image_types import ImageStream, PdfImageError
from .object_parser import _read_pdf_object


def _image_from_xref(doc, xref: int, index: int) -> ImageStream | None:
    subtype = doc.xref_get_key(xref, "Subtype")
    if subtype[1] != "/Image":
        return None

    # Check the dictionary before extract_image can allocate decoded pixels.
    width = _xref_required_int(doc, xref, "Width")
    height = _xref_required_int(doc, xref, "Height")
    if width <= 0 or height <= 0 or width * height > 100_000_000:
        raise PdfImageError("Image dimensions must be positive and cannot exceed 100 million pixels")

    image_filter = _xref_object(doc, xref, "Filter") or b""
    single_filter = re.fullmatch(rb"/(\w+)|\[\s*/(\w+)\s*\]", image_filter)
    if single_filter:
        filter_name = (single_filter[1] or single_filter[2]).decode("ascii")
    else:
        extracted = doc.extract_image(xref)
        ext = extracted["ext"]
        if ext == "jpeg":
            filter_name = "DCTDecode"
        elif ext == "png":
            return ImageStream(
                index=index,
                width=extracted["width"],
                height=extracted["height"],
                bits_per_component=8,
                color_space=b"/DeviceRGB",
                filter_name="PNG",
                decode_parms=None,
                data=extracted["image"],
                xref=xref,
            )
        else:
            raise PdfImageError(f"Unsupported extracted image extension for xref {xref}: {ext}")

    if filter_name in ("DCTDecode", "FlateDecode"):
        color_space = _xref_object(doc, xref, "ColorSpace")
        if filter_name == "FlateDecode":
            color_space = _normalize_xref_color_space(doc, color_space)
        return ImageStream(
            index=index,
            width=width,
            height=height,
            bits_per_component=_xref_required_int(doc, xref, "BitsPerComponent"),
            color_space=color_space,
            filter_name=filter_name,
            decode_parms=_image_decode_parms(doc, xref),
            data=doc.xref_stream_raw(xref),
            xref=xref,
        )

    if filter_name in {"JBIG2Decode"}:
        return _decoded_image_from_xref(doc, xref, index)

    raise PdfImageError(f"Unsupported image filter for xref {xref}: {filter_name}")


def _decoded_image_from_xref(doc, xref: int, index: int) -> ImageStream:
    extracted = doc.extract_image(xref)
    ext = extracted["ext"]
    if ext != "png":
        raise PdfImageError(f"Unsupported extracted image extension for xref {xref}: {ext}")
    return ImageStream(
        index=index,
        width=extracted["width"],
        height=extracted["height"],
        bits_per_component=8,
        color_space=b"/DeviceRGB",
        filter_name="PNG",
        decode_parms=None,
        data=extracted["image"],
        xref=xref,
    )


def _xref_required_int(doc, xref: int, key: str) -> int:
    kind, value = doc.xref_get_key(xref, key)
    if kind != "int":
        raise PdfImageError(f"xref {xref} image dictionary missing /{key}")
    return int(value)


def _xref_object(doc, xref: int, key: str) -> bytes | None:
    kind, value = doc.xref_get_key(xref, key)
    if kind == "null":
        return None
    if kind == "xref":
        value = doc.xref_object(int(value.split()[0]), compressed=True)
    return value.encode("latin1")


def _normalize_pdf_object(obj: bytes | None) -> bytes | None:
    if obj is None:
        return None
    return obj.strip()


def _image_decode_parms(doc, xref: int) -> bytes | None:
    value = _xref_object(doc, xref, "DecodeParms")
    if value and value.startswith(b"["):
        value = value[1:-1].strip()
        reference = re.fullmatch(rb"(\d+)\s+\d+\s+R", value)
        if reference:
            value = doc.xref_object(int(reference[1]), compressed=True).encode("latin1")
    if value in (None, b"null"):
        return None
    if not value.startswith(b"<<") or _read_pdf_object(value, 0) != value:
        raise PdfImageError("Expected one image DecodeParms dictionary")
    return value


def _normalize_xref_color_space(doc, color_space: bytes | None) -> bytes | None:
    color_space = _normalize_pdf_object(color_space)
    if color_space is None:
        return None
    match = re.match(rb"\[\s*/Indexed\s*/DeviceRGB\s+(\d+)\s+(\d+)\s+(\d+)\s+R\s*\]", color_space)
    if not match:
        return color_space
    highest_index = int(match.group(1))
    palette_xref = int(match.group(2))
    generation = int(match.group(3))
    if generation != 0:
        return color_space
    expected = (highest_index + 1) * 3
    palette = doc.xref_stream(palette_xref)
    if not palette or len(palette) < expected:
        return color_space
    return (
        b"[/Indexed /DeviceRGB "
        + str(highest_index).encode("ascii")
        + b" <"
        + palette[:expected].hex().encode("ascii")
        + b">]"
    )
