"""Bounded XML and source hints shared by EPUB import and saved-project migration."""

from __future__ import annotations

import posixpath
import re
import xml.etree.ElementTree as ET
from urllib.parse import unquote, urlsplit
from xml.parsers import expat

from .i18n import t


def reference(base, href):
    try:
        parsed = urlsplit(href)
        path = unquote(parsed.path, errors="strict")
    except ValueError as error:
        raise ValueError(t("EPUB references must stay inside the archive")) from error
    if parsed.scheme or parsed.netloc or parsed.query or path.startswith("/") or "\\" in path or "\x00" in path:
        raise ValueError(t("EPUB references must stay inside the archive"))
    resolved = posixpath.normpath(posixpath.join(posixpath.dirname(base), path)) if path else base
    if not resolved or resolved == ".." or resolved.startswith("../") or re.match(r"^[A-Za-z]:", resolved):
        raise ValueError(t("EPUB references must stay inside the archive"))
    return resolved


def read(archive, member, limit=1_000_000):
    try:
        entry = archive.getinfo(member)
    except KeyError as error:
        raise ValueError(t("EPUB resource is missing: {0}", member)) from error
    if entry.is_dir() or entry.file_size > limit:
        raise ValueError(t("EPUB XML and CSS resources cannot exceed 1 MB each"))
    with archive.open(entry) as incoming:
        payload = incoming.read(limit + 1)
    if len(payload) > limit:
        raise ValueError(t("EPUB XML and CSS resources cannot exceed 1 MB each"))
    return payload


def xml(archive, member, html=False):
    payload = read(archive, member)
    parser = expat.ParserCreate()

    def reject(*_arguments):
        raise ValueError(t("EPUB XML cannot contain entities or internal document types"))

    def doctype(name, _system, _public, internal):
        if not html or name.lower() != "html" or internal:
            reject()

    parser.StartDoctypeDeclHandler = doctype
    parser.EntityDeclHandler = reject
    parser.ExternalEntityRefHandler = reject
    try:
        parser.Parse(payload, True)
        return ET.fromstring(payload)
    except (ET.ParseError, expat.ExpatError) as error:
        raise ValueError(t("Invalid EPUB XML: {0}", member)) from error


def is_rotated_image(image):
    return image.get("kmoetag") == "rotate:1" or "twoPage" in image.get("class", "").split()
