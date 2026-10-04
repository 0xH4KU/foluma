from __future__ import annotations

import copy
import math
import posixpath
import re
import shutil
import tempfile
import xml.etree.ElementTree as ET
from pathlib import Path
from urllib.parse import unquote, urlsplit
from xml.parsers import expat
from zipfile import ZipFile

from foluma.i18n import t
from foluma.media import import_images
from foluma.model import new_id, validate
from foluma.storage import digest
from foluma.worker import run_plugin
from image_archive import validate_archive
from PIL import Image

OPF = "{http://www.idpf.org/2007/opf}"
DC = "{http://purl.org/dc/elements/1.1/}"
EPUB_TYPE = "{http://www.idpf.org/2007/ops}type"
SVG = "{http://www.w3.org/2000/svg}"
IMAGE_TYPES = {"image/jpeg": "JPEG", "image/png": "PNG", "image/webp": "WEBP"}


def unsupported(member):
    return ValueError(t("EPUB page requires text or complex layout rendering: {0}. Only simple image pages are supported.", member))


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
    return archive.read(entry)


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


def check_style(style, member):
    allowed = {
        "width": {"100%", "100vw", "auto"}, "height": {"100%", "100vh", "auto"},
        "max-width": {"100%", "100vw", "none"}, "max-height": {"100%", "100vh", "none"},
        "display": {"block", "inline", "inline-block"}, "overflow": {"hidden", "visible"},
        "background": {"#000", "#000000", "black", "#fff", "#ffffff", "white", "transparent"},
        "background-color": {"#000", "#000000", "black", "#fff", "#ffffff", "white", "transparent"},
        "object-fit": {"contain"}, "text-align": {"center", "left", "right"},
        "vertical-align": {"middle", "top", "bottom"}, "box-sizing": {"border-box", "content-box"},
        "page-break-before": {"always", "auto", "avoid"}, "page-break-after": {"always", "auto", "avoid"},
    }
    for declaration in style.split(";"):
        if not declaration.strip():
            continue
        if ":" not in declaration:
            raise unsupported(member)
        property_name, value = declaration.split(":", 1)
        property_name = property_name.strip().lower()
        value = re.sub(r"\s*!important\s*$", "", value.strip().lower())
        if property_name in ("margin", "padding", "border", "border-width"):
            if value == "none" and property_name == "border":
                continue
            if value.split() and all(re.fullmatch(r"0(?:\.0+)?(?:px|pt|em|rem|%)?", part) for part in value.split()):
                continue
        if value not in allowed.get(property_name, set()):
            raise unsupported(member)


def check_css(payload, member):
    try:
        css = re.sub(r"/\*.*?\*/", "", payload.decode("utf-8-sig"), flags=re.DOTALL)
    except UnicodeError as error:
        raise unsupported(member) from error
    end, targets = 0, set()
    for match in re.finditer(r"([^{}]+)\{([^{}]*)\}", css):
        if css[end:match.start()].strip() or not re.fullmatch(r"[\w\s.#,*>-]+", match[1].strip()):
            raise unsupported(member)
        check_style(match[2], member)
        if ("*" in match[1] or re.search(r"(?<![\w.#-])(?:image|rect)(?![\w-])", match[1])) and re.search(
                r"(?:^|;)\s*(?:width|height|max-width|max-height)\s*:", match[2], flags=re.IGNORECASE):
            raise unsupported(member)
        targets.update(re.findall(r"[.#][\w-]+", match[1]))
        end = match.end()
    if css[end:].strip():
        raise unsupported(member)
    return targets


def number(value, member):
    try:
        result = float(value.removesuffix("px"))
    except (ValueError, AttributeError) as error:
        raise unsupported(member) from error
    if not math.isfinite(result) or abs(result) > 1_000_000_000:
        raise unsupported(member)
    return result


def page(archive, member, resources, load_image):
    media_type = resources.get(member, {}).get("media-type")
    if media_type in IMAGE_TYPES:
        return load_image(member)
    if media_type not in ("application/xhtml+xml", "image/svg+xml"):
        raise unsupported(member)
    root = xml(archive, member, html=media_type == "application/xhtml+xml")
    if root.tag not in ("{http://www.w3.org/1999/xhtml}html", "html", f"{SVG}svg"):
        raise unsupported(member)
    if any(node.tag.rsplit("}", 1)[-1] in ("script", "base") or
           any(attribute.startswith("on") or attribute == "{http://www.w3.org/XML/1998/namespace}base"
               for attribute in node.attrib) for node in root.iter()):
        raise unsupported(member)
    for node in root.iter():
        if node.get("style"):
            check_style(node.get("style"), member)
    targets = set()
    for link in root.findall(".//{*}link"):
        if "stylesheet" in link.get("rel", "").split():
            css_member = reference(member, link.get("href", ""))
            if resources.get(css_member, {}).get("media-type") != "text/css":
                raise unsupported(member)
            targets.update(check_css(read(archive, css_member), member))
    for style in root.findall(".//{*}style"):
        targets.update(check_css((style.text or "").encode(), member))
    body = root if root.tag == f"{SVG}svg" else root.find("{*}body")
    if body is None:
        raise unsupported(member)
    allowed_tags = {"body", "div", "p", "span", "a", "img", "svg", "image", "rect", "title", "desc"}
    allowed_attributes = {"id", "class", "style", "lang", "dir", "role", "aria-label", "aria-hidden", "alt", "title",
                          "src", "href", "{http://www.w3.org/1999/xlink}href", "width", "height", "x", "y", "viewBox",
                          "preserveAspectRatio", "overflow", "version", "fill", "loading", "decoding", EPUB_TYPE,
                          "{http://www.w3.org/XML/1998/namespace}lang"}
    for node in body.iter():
        tag = node.tag.rsplit("}", 1)[-1]
        if (tag not in allowed_tags or any(attribute not in allowed_attributes for attribute in node.attrib)
                or node.tail and node.tail.strip() or tag not in ("title", "desc") and node.text and node.text.strip()):
            raise unsupported(member)
    images = [node for node in body.iter() if node.tag in ("img", "{http://www.w3.org/1999/xhtml}img", f"{SVG}image")]
    svgs = [node for node in body.iter() if node.tag == f"{SVG}svg"]
    rectangles = [node for node in body.iter() if node.tag == f"{SVG}rect"]
    for shape in images + rectangles:
        if shape.tag in (f"{SVG}image", f"{SVG}rect") and (shape.get("style") or f"#{shape.get('id')}" in targets
                or {f".{name}" for name in shape.get("class", "").split()} & targets):
            raise unsupported(member)
    if len(images) > 1 or len(svgs) > 1:
        raise unsupported(member)
    if svgs:
        svg = svgs[0]
        bounds = [number(value, member) for value in re.split(r"[\s,]+", svg.get("viewBox", "").strip())]
        if len(bounds) != 4 or min(bounds[2:]) <= 0:
            raise unsupported(member)
        left, top, width, height = bounds
        if svg.get("preserveAspectRatio", "xMidYMid meet") not in ("xMidYMid meet", "none"):
            raise unsupported(member)
        if not images and len(rectangles) == 1:
            rectangle = rectangles[0]
            rectangle_width = width if rectangle.get("width") == "100%" else number(rectangle.get("width"), member)
            rectangle_height = height if rectangle.get("height") == "100%" else number(rectangle.get("height"), member)
            if (rectangle not in list(svg) or rectangle.get("fill", "").lower() not in ("white", "#fff", "#ffffff")
                    or number(rectangle.get("x", "0"), member) != left or number(rectangle.get("y", "0"), member) != top
                    or (rectangle_width, rectangle_height) != (width, height) or not width.is_integer() or not height.is_integer()):
                raise unsupported(member)
            return {"id": new_id(), "kind": "blank", "width": int(width), "height": int(height)}
        if len(images) != 1 or rectangles or images[0].tag != f"{SVG}image" or images[0] not in list(svg):
            raise unsupported(member)
        image = images[0]
        result = load_image(reference(member, image.get("href") or image.get("{http://www.w3.org/1999/xlink}href", "")))
        image_width = width if image.get("width") == "100%" else number(image.get("width"), member)
        image_height = height if image.get("height") == "100%" else number(image.get("height"), member)
        if min(image_width, image_height) <= 0 or image.get("preserveAspectRatio", "xMidYMid meet") not in ("none", "xMidYMid meet"):
            raise unsupported(member)
        if not math.isclose(image_width / image_height, result["width"] / result["height"], rel_tol=1e-7):
            raise unsupported(member)
        result["crop"] = [(left - number(image.get("x", "0"), member)) / image_width,
                          (top - number(image.get("y", "0"), member)) / image_height, width / image_width, height / image_height]
        return result
    if len(images) != 1 or rectangles:
        raise unsupported(member)
    result = load_image(reference(member, images[0].get("src", "")))
    declared_width, declared_height = images[0].get("width"), images[0].get("height")
    if declared_width and declared_height and "%" not in declared_width + declared_height:
        width, height = number(declared_width, member), number(declared_height, member)
        if min(width, height) <= 0 or not math.isclose(width / height, result["width"] / result["height"], rel_tol=1e-7):
            raise unsupported(member)
    return result


def handle(operation: str, params: dict, book: dict | None, progress):
    if operation != "import":
        raise ValueError(t("Unsupported background task"))
    source = Path(params["path"]).resolve(strict=True)
    fingerprint, source_id = digest(source), new_id()
    book = {"schema": 1, "id": new_id(), "revision": 0, "metadata": {},
            "sources": {}, "assets": {}, "pages": [], "extensions": {}}
    with ZipFile(source) as archive, tempfile.TemporaryDirectory() as temporary:
        entries = validate_archive(archive)
        if read(archive, "mimetype", 128) != b"application/epub+zip":
            raise ValueError(t("Invalid EPUB container"))
        container = xml(archive, "META-INF/container.xml")
        rootfile = container.find("{*}rootfiles/{*}rootfile[@media-type='application/oebps-package+xml']")
        if container.tag != "{urn:oasis:names:tc:opendocument:xmlns:container}container" or rootfile is None:
            raise ValueError(t("Invalid EPUB container"))
        package_member = reference("", rootfile.get("full-path", ""))
        package = xml(archive, package_member)
        if package.tag != f"{OPF}package" or package.get("version") not in ("2.0", "3.0"):
            raise ValueError(t("Invalid EPUB package"))
        manifest, resources = {}, {}
        for item in package.findall(f"{OPF}manifest/{OPF}item"):
            identifier = item.get("id")
            member = reference(package_member, item.get("href", ""))
            if not identifier or identifier in manifest or member in resources:
                raise ValueError(t("Invalid EPUB manifest"))
            manifest[identifier] = member
            resources[member] = item.attrib
        if any(entry.filename == "META-INF/encryption.xml" for entry in entries):
            encryption = xml(archive, "META-INF/encryption.xml")
            for encrypted in encryption.findall(".//{*}EncryptedData"):
                method = encrypted.find("{*}EncryptionMethod")
                target = encrypted.find("{*}CipherData/{*}CipherReference")
                target_member = reference("", target.get("URI", "")) if target is not None else ""
                if (method is None or method.get("Algorithm") not in ("http://www.idpf.org/2008/embedding", "http://ns.adobe.com/pdf/enc#RC")
                        or not resources.get(target_member, {}).get("media-type", "").startswith(("font/", "application/vnd.ms-opentype"))):
                    raise ValueError(t("Encrypted EPUB content is not supported"))
        metadata = package.find(f"{OPF}metadata")
        spine = package.find(f"{OPF}spine")
        if metadata is None or spine is None or spine.get("page-progression-direction", "default") not in ("default", "ltr", "rtl"):
            raise ValueError(t("Invalid EPUB package"))
        book["metadata"] = {"title": (metadata.findtext(f"{DC}title") or source.stem).strip() or source.stem,
                            "author": ", ".join((creator.text or "").strip() for creator in metadata.findall(f"{DC}creator")),
                            "language": (metadata.findtext(f"{DC}language") or "zh-Hant").strip(),
                            "direction": "rtl" if spine.get("page-progression-direction") == "rtl" else "ltr",
                            "cover_id": None, "cover_only": False}
        members = []
        for item in spine.findall(f"{OPF}itemref"):
            if item.get("idref") not in manifest or item.get("linear", "yes") not in ("yes", "no"):
                raise ValueError(t("Invalid EPUB spine"))
            if item.get("linear", "yes") == "yes":
                members.append(manifest[item.get("idref")])
        if not members or len(members) > 10_000:
            raise ValueError(t("EPUB must contain 1 to 10000 reading pages"))
        cached = {}

        def load_image(member):
            if resources.get(member, {}).get("media-type") not in IMAGE_TYPES:
                raise ValueError(t("EPUB image is missing or unsupported: {0}", member))
            if member not in cached:
                try:
                    entry = archive.getinfo(member)
                except KeyError as error:
                    raise ValueError(t("EPUB resource is missing: {0}", member)) from error
                if entry.is_dir() or entry.file_size > 128_000_000:
                    raise ValueError(t("Archived images cannot exceed 128 MB each"))
                extracted = Path(temporary) / f"image-{len(cached)}"
                with archive.open(entry) as incoming, extracted.open("xb") as outgoing:
                    shutil.copyfileobj(incoming, outgoing)
                with Image.open(extracted) as image:
                    if image.format != IMAGE_TYPES[resources[member]["media-type"]]:
                        raise ValueError(t("Unsupported image format"))
                    if getattr(image, "n_frames", 1) != 1:
                        raise ValueError(t("Animated images are not supported in image archives"))
                imported = import_images([str(extracted)], Path(params["asset_directory"]))
                result = imported["pages"][0]
                imported["assets"][result["asset_id"]].update(source_id=source_id, member=member)
                book["assets"].update(imported["assets"])
                cached[member] = result
                extracted.unlink()
            return copy.deepcopy(cached[member]) | {"id": new_id()}

        progress(0, len(members), t("Importing EPUB pages"))
        for number, member in enumerate(members, 1):
            book["pages"].append(page(archive, member, resources, load_image) | {"source_page": number})
            progress(number, len(members), t("Importing EPUB pages"))
        cover_document = next((reference(package_member, item.get("href", "")) for item in
                               package.findall(f"{OPF}guide/{OPF}reference") if item.get("type") == "cover"), None)
        for member, item in resources.items():
            if "nav" in item.get("properties", "").split() and not cover_document:
                navigation = xml(archive, member, html=True)
                cover_document = next((reference(member, link.get("href", "")) for navigation_list in
                                       navigation.findall(".//{*}nav") if "landmarks" in navigation_list.get(EPUB_TYPE, "").split()
                                       for link in navigation_list.findall(".//{*}a") if "cover" in link.get(EPUB_TYPE, "").split()), None)
        cover_image = next((member for member, item in resources.items() if "cover-image" in item.get("properties", "").split()), None)
        legacy_cover = metadata.find(f"{OPF}meta[@name='cover']")
        if not cover_image and legacy_cover is not None:
            if legacy_cover.get("content") not in manifest:
                raise ValueError(t("Invalid EPUB manifest"))
            cover_image = manifest.get(legacy_cover.get("content"))
        if not cover_document and resources.get(cover_image, {}).get("media-type") == "image/svg+xml":
            cover_document = cover_image
        cover_page = None
        if cover_document in members:
            cover_page = book["pages"][members.index(cover_document)]
        elif cover_document:
            cover_page = page(archive, cover_document, resources, load_image)
        elif cover_image:
            cover_page = next((candidate for candidate in book["pages"] if candidate["kind"] == "image"
                               and book["assets"][candidate["asset_id"]]["member"] == cover_image
                               and candidate["crop"] == [0, 0, 1, 1]), None) or load_image(cover_image)
        if cover_page:
            if cover_page["kind"] != "image":
                raise ValueError(t("The EPUB cover must be an image page"))
            if cover_page not in book["pages"]:
                book["pages"].insert(0, cover_page)
                book["metadata"]["cover_only"] = True
            book["metadata"]["cover_id"] = cover_page["id"]
        for number, candidate in enumerate(book["pages"], 1):
            candidate["source_page"] = number
            if candidate["kind"] == "image":
                book["assets"][candidate["asset_id"]].setdefault("source_page", number)
    if not any(candidate["kind"] == "image" for candidate in book["pages"]):
        raise ValueError(t("The EPUB contains no supported image pages"))
    if digest(source) != fingerprint:
        raise ValueError(t("Source changed during import. Please import again."))
    book["sources"][source_id] = {"path": str(source), "sha256": fingerprint, "page_count": len(book["pages"])}
    validate(book)
    return book


if __name__ == "__main__":
    run_plugin(handle)
