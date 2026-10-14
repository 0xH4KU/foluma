from __future__ import annotations

import binascii
import re
import struct
import zlib

from .image_types import ImageStream, PdfImageError
from .object_parser import decode_pdf_literal_string, extract_int


def image_to_epub_member(image: ImageStream, *, compression_level: int = 6) -> tuple[str, bytes]:
    if image.filter_name == "PNG":
        return "png", image.data
    if image.filter_name == "DCTDecode":
        return "jpg", image.data
    if image.filter_name == "FlateDecode":
        return "png", flate_image_to_png(image, compression_level=compression_level)
    raise PdfImageError(f"Unsupported image filter: {image.filter_name}")


def flate_image_to_png(image: ImageStream, *, compression_level: int = 6) -> bytes:
    if not 0 < image.width <= 100000 or not 0 < image.height <= 100000 or image.width * image.height > 100_000_000:
        raise PdfImageError("Image dimensions are out of range")
    predictor = _decode_parm_int(image.decode_parms, b"Predictor", 1)
    columns = _decode_parm_int(image.decode_parms, b"Columns", image.width)
    colors = _decode_parm_int(image.decode_parms, b"Colors", _png_channel_count(image.color_space))
    bpc = _decode_parm_int(image.decode_parms, b"BitsPerComponent", image.bits_per_component)

    if columns != image.width:
        raise PdfImageError(f"Unsupported Columns {columns}; expected image width {image.width}")
    if bpc != image.bits_per_component:
        raise PdfImageError(f"DecodeParms BitsPerComponent {bpc} does not match image")
    if colors != _png_channel_count(image.color_space) or bpc not in (1, 2, 4, 8, 16):
        raise PdfImageError("Unsupported image channels or bit depth")

    color_type, palette = _png_color(image.color_space, bpc)
    if 10 <= predictor <= 15:
        return make_png_from_compressed_rows(image.width, image.height, bpc, color_type, image.data, palette)

    if predictor != 1:
        raise PdfImageError(f"Unsupported Flate predictor: {predictor}")
    expected = _png_row_length(image.width, bpc, color_type) * image.height
    scanlines = decompress_bounded(image.data, expected)
    if len(scanlines) != expected:
        raise PdfImageError(f"Unexpected raw image length {len(scanlines)}; expected {expected}")
    return make_png_from_scanlines(
        image.width, image.height, bpc, color_type, scanlines, palette, compression_level=compression_level
    )


def decompress_bounded(data: bytes, limit: int) -> bytes:
    decoder = zlib.decompressobj()
    raw = decoder.decompress(data, limit + 1)
    if len(raw) > limit or not decoder.eof:
        raise PdfImageError("Compressed image exceeds its size limit or is incomplete")
    return raw


def _decode_parm_int(decode_parms: bytes | None, key: bytes, default: int) -> int:
    if decode_parms is None:
        return default
    value = extract_int(decode_parms, key)
    return value if value is not None else default


def _png_channel_count(color_space: bytes | None) -> int:
    if color_space in (None, b"/DeviceGray"):
        return 1
    if color_space == b"/DeviceRGB":
        return 3
    if color_space.startswith(b"[/Indexed"):
        return 1
    raise PdfImageError(f"Unsupported ColorSpace: {color_space!r}")


def _png_color(color_space: bytes | None, bits_per_component: int) -> tuple[int, bytes | None]:
    if color_space in (None, b"/DeviceGray"):
        return 0, None
    if color_space == b"/DeviceRGB":
        if bits_per_component != 8:
            raise PdfImageError("DeviceRGB PNG output supports 8 bits per component only")
        return 2, None
    if color_space.startswith(b"[/Indexed"):
        if bits_per_component == 16:
            raise PdfImageError("Indexed PNG output supports up to 8 bits per component")
        return 3, _indexed_palette(color_space)
    raise PdfImageError(f"Unsupported ColorSpace: {color_space!r}")


def _indexed_palette(color_space: bytes) -> bytes:
    match = re.match(rb"\[\s*/Indexed\s*/DeviceRGB\s+(\d+)\s*(.*)\s*\]\s*$", color_space, re.S)
    if not match:
        raise PdfImageError(f"Unsupported indexed ColorSpace: {color_space!r}")
    highest_index = int(match.group(1))
    if highest_index > 255:
        raise PdfImageError("Indexed palettes cannot exceed 256 colors")
    palette_obj = match.group(2).strip()
    if palette_obj.startswith(b"("):
        palette = decode_pdf_literal_string(palette_obj)
    elif palette_obj.startswith(b"<") and palette_obj.endswith(b">") and not palette_obj.startswith(b"<<"):
        palette = bytes.fromhex(re.sub(rb"\s+", b"", palette_obj[1:-1]).decode("ascii"))
    else:
        raise PdfImageError(f"Unsupported indexed palette object: {palette_obj!r}")

    expected = (highest_index + 1) * 3
    if len(palette) < expected:
        raise PdfImageError(f"Indexed palette is too short: {len(palette)} < {expected}")
    return palette[:expected]


def _png_chunk(kind: bytes, payload: bytes) -> bytes:
    body = kind + payload
    return struct.pack(">I", len(payload)) + body + struct.pack(">I", binascii.crc32(body) & 0xFFFFFFFF)


def make_png_from_compressed_rows(
    width: int,
    height: int,
    bit_depth: int,
    color_type: int,
    compressed_rows: bytes,
    palette: bytes | None = None,
) -> bytes:
    ihdr = struct.pack(">IIBBBBB", width, height, bit_depth, color_type, 0, 0, 0)
    parts = [b"\x89PNG\r\n\x1a\n", _png_chunk(b"IHDR", ihdr)]
    if palette is not None:
        parts.append(_png_chunk(b"PLTE", palette))
    parts.append(_png_chunk(b"IDAT", compressed_rows))
    parts.append(_png_chunk(b"IEND", b""))
    return b"".join(parts)


def make_png_from_scanlines(
    width: int,
    height: int,
    bit_depth: int,
    color_type: int,
    scanlines: bytes,
    palette: bytes | None = None,
    *,
    compression_level: int = 6,
) -> bytes:
    row_length = _png_row_length(width, bit_depth, color_type)
    expected = row_length * height
    if len(scanlines) != expected:
        raise PdfImageError(f"PNG payload length {len(scanlines)}; expected {expected}")

    filtered = bytearray()
    for row in range(height):
        start = row * row_length
        filtered.append(0)
        filtered.extend(scanlines[start : start + row_length])
    return make_png_from_compressed_rows(
        width,
        height,
        bit_depth,
        color_type,
        zlib.compress(bytes(filtered), level=compression_level),
        palette,
    )


def _png_row_length(width: int, bit_depth: int, color_type: int) -> int:
    channels = {0: 1, 2: 3, 3: 1}[color_type]
    return (width * channels * bit_depth + 7) // 8
