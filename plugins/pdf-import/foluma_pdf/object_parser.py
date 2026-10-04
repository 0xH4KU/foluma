from __future__ import annotations

import re

from .image_types import PdfImageError


def extract_int(dictionary: bytes, key: bytes) -> int | None:
    match = re.search(rb"/" + re.escape(key) + rb"\s+(\d+)", dictionary)
    return int(match.group(1)) if match else None


def _extract_object(dictionary: bytes, key: bytes) -> bytes | None:
    match = re.search(rb"/" + re.escape(key) + rb"\s*", dictionary)
    if not match:
        return None
    pos = match.end()
    return _read_pdf_object(dictionary, pos)


def _read_pdf_object(data: bytes, pos: int) -> bytes:
    while pos < len(data) and data[pos] in b" \t\r\n":
        pos += 1
    if data[pos : pos + 2] == b"<<":
        return data[pos : _matching_double_angle(data, pos) + 2]
    if data[pos : pos + 1] == b"[":
        return data[pos : _matching_bracket(data, pos) + 1]
    if data[pos : pos + 1] == b"(":
        return data[pos : _matching_paren(data, pos) + 1]
    match = re.match(rb"/[A-Za-z0-9]+|\d+|[^\s<>\[\]()]+", data[pos:])
    if not match:
        raise PdfImageError(f"Cannot parse PDF object near offset {pos}")
    return match.group(0)


def _matching_double_angle(data: bytes, start: int) -> int:
    depth = 0
    pos = start
    while pos < len(data) - 1:
        token = data[pos : pos + 2]
        if token == b"<<":
            depth += 1
            pos += 2
            continue
        if token == b">>":
            depth -= 1
            if depth == 0:
                return pos
            pos += 2
            continue
        if data[pos : pos + 1] == b"(":
            pos = _matching_paren(data, pos) + 1
            continue
        if data[pos : pos + 1] == b"<":
            end = data.find(b">", pos + 1)
            if end < 0:
                raise PdfImageError("Unterminated PDF hex string")
            pos = end + 1
            continue
        pos += 1
    raise PdfImageError("Unterminated PDF dictionary")


def _matching_bracket(data: bytes, start: int) -> int:
    depth = 0
    pos = start
    while pos < len(data):
        char = data[pos : pos + 1]
        if char == b"(":
            pos = _matching_paren(data, pos) + 1
            continue
        if char == b"[":
            depth += 1
        elif char == b"]":
            depth -= 1
            if depth == 0:
                return pos
        pos += 1
    raise PdfImageError("Unterminated PDF array")


def _matching_paren(data: bytes, start: int) -> int:
    depth = 0
    pos = start
    while pos < len(data):
        char = data[pos : pos + 1]
        if char == b"\\":
            pos += 2
            continue
        if char == b"(":
            depth += 1
        elif char == b")":
            depth -= 1
            if depth == 0:
                return pos
        pos += 1
    raise PdfImageError("Unterminated PDF string")


def decode_pdf_literal_string(obj: bytes) -> bytes:
    if not (obj.startswith(b"(") and obj.endswith(b")")):
        raise PdfImageError("Not a PDF literal string")
    out = bytearray()
    pos = 1
    end = len(obj) - 1
    escapes = {
        ord("n"): ord("\n"),
        ord("r"): ord("\r"),
        ord("t"): ord("\t"),
        ord("b"): ord("\b"),
        ord("f"): ord("\f"),
        ord("("): ord("("),
        ord(")"): ord(")"),
        ord("\\"): ord("\\"),
    }
    while pos < end:
        byte = obj[pos]
        if byte != ord("\\"):
            out.append(byte)
            pos += 1
            continue
        pos += 1
        if pos >= end:
            break
        esc = obj[pos]
        if esc in b"\r\n":
            if esc == ord("\r") and pos + 1 < end and obj[pos + 1] == ord("\n"):
                pos += 2
            else:
                pos += 1
            continue
        if ord("0") <= esc <= ord("7"):
            octal = bytes([esc])
            pos += 1
            for _ in range(2):
                if pos < end and ord("0") <= obj[pos] <= ord("7"):
                    octal += bytes([obj[pos]])
                    pos += 1
                else:
                    break
            out.append(int(octal, 8))
            continue
        out.append(escapes.get(esc, esc))
        pos += 1
    return bytes(out)
