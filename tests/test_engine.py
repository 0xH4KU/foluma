import copy
import errno
import io
import json
import subprocess
import sys
import tempfile
import time
import unittest
import zlib
from importlib import import_module
from pathlib import Path
from unittest.mock import patch
from zipfile import ZipFile, ZipInfo

import pymupdf as fitz
from foluma.media import load_asset, preview
from foluma.model import Session, new_id
from foluma.plugins import Plugins, platform_id
from foluma.service import Engine
from foluma.storage import open_project, parse_json, save_project
from PIL import Image

pdf_importer = import_module("plugins.pdf-import.foluma_pdf.importer")
pdf_images = import_module("plugins.pdf-import.foluma_pdf.png")
RenderRequired = pdf_importer.RenderRequired
import_pdf = pdf_importer.import_pdf
export_epub = import_module("plugins.epub-export.foluma_epub.exporter").export_epub
_image_from_xref = pdf_importer._image_from_xref
PdfImageError = import_module("plugins.pdf-import.foluma_pdf.image_types").PdfImageError
image_to_epub_member = pdf_images.image_to_epub_member


class IntegrationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.pdf = self.root / "測試書.pdf"
        buffer = io.BytesIO()
        image = Image.new("RGB", (240, 320), "#aecabc")
        image.paste("#264b40", (0, 0, 120, 320))
        image.save(buffer, "JPEG", quality=95)
        self.jpeg = buffer.getvalue()
        with fitz.open() as doc:
            for _ in range(3):
                page = doc.new_page(width=240, height=320)
                xref = page.insert_image(page.rect, stream=self.jpeg)
                doc.xref_set_key(xref, "ColorSpace", "/DeviceRGB")
            doc.save(self.pdf)
        self.book = import_pdf(str(self.pdf), self.root / "assets")

    def test_epub_export_without_hard_links_preserves_source_images(self):
        path = self.root / "雙頁驗證.epub"
        with patch("foluma.storage.os.link", side_effect=OSError(errno.ENOTSUP, "unsupported")):
            export_epub(self.book, str(path))
        with ZipFile(path) as archive:
            self.assertEqual(archive.read("mimetype"), b"application/epub+zip")
            self.assertIsNone(archive.testzip())
            for asset_id in self.book["assets"]:
                self.assertEqual(archive.read(f"EPUB/images/{asset_id}.jpg"), self.jpeg)
        self.assertFalse(list(self.root.glob(".*.tmp")))

    def test_epub_export_without_hard_links_refuses_a_late_destination(self):
        path = self.root / "雙頁驗證.epub"
        def occupied(_source, target):
            target.write_bytes(b"keep existing output")
            raise OSError(errno.ENOTSUP, "unsupported")
        with patch("foluma.storage.os.link", side_effect=occupied):
            with self.assertRaisesRegex(ValueError, "Refusing to overwrite"):
                export_epub(self.book, str(path))
        self.assertEqual(path.read_bytes(), b"keep existing output")
        self.assertFalse(list(self.root.glob(".*.tmp")))

    def test_lossless_physical_pages_crop_and_validated_epub(self):
        self.assertEqual(len(self.book["pages"]), 3)
        self.assertEqual([p["source_page"] for p in self.book["pages"]], [1, 2, 3])
        for asset_id in self.book["assets"]:
            self.assertEqual(load_asset(self.book, asset_id), self.jpeg)
        page = self.book["pages"][0]
        page["crop"] = [0.5, 0, 0.5, 1]
        self.book["pages"].append({"id": new_id(), "kind": "blank", "width": 240, "height": 320})
        path = self.root / "book.epub"
        export_epub(self.book, str(path))
        with ZipFile(path) as archive:
            self.assertIn('content="width=1750, height=2480"', archive.read("EPUB/pages/000001.xhtml").decode())
            self.assertEqual(archive.read(f"EPUB/images/{page['asset_id']}.jpg"), self.jpeg)
            xhtml = archive.read("EPUB/pages/000001.xhtml").decode()
            self.assertIn('viewBox="0 0 120 320"', xhtml)
            self.assertIn('x="-120"', xhtml)
            with Image.open(io.BytesIO(archive.read("EPUB/images/cover.png"))) as cover:
                self.assertEqual(cover.size, (120, 320))
        rendered = self.root / preview(self.book, page["id"], 320, self.root / "previews")
        with Image.open(rendered) as image:
            self.assertEqual(image.size, (120, 320))
        original = path.read_bytes()
        with self.assertRaises(Exception):
            export_epub(self.book, str(path))
        self.assertEqual(path.read_bytes(), original)

    def test_pdf_extraction_rejects_missing_image_payload(self):
        with fitz.open(self.pdf) as doc:
            xref = doc[0].get_images()[0][0]
            with patch.object(doc, "xref_stream_raw", return_value=None):
                with self.assertRaisesRegex(PdfImageError, "no payload data"):
                    _image_from_xref(doc, xref, 1)

    def test_png_extraction_paths_share_decoding_and_reject_unsupported_payloads(self):
        payload = io.BytesIO()
        Image.new("RGB", (240, 320), "navy").save(payload, "PNG")
        extracted = {"ext": "png", "width": 240, "height": 320, "image": payload.getvalue()}
        with fitz.open(self.pdf) as doc:
            xref = doc[0].get_images()[0][0]
            get_key = doc.xref_get_key
            for filter_value in ("[/DCTDecode /FlateDecode]", "/JBIG2Decode"):
                with patch.object(doc, "xref_get_key", side_effect=lambda ref, key:
                                  ("name", filter_value) if key == "Filter" else get_key(ref, key)):
                    with patch.object(doc, "extract_image", return_value=extracted) as decode:
                        image = _image_from_xref(doc, xref, 1)
                        self.assertEqual(image_to_epub_member(image), ("png", payload.getvalue()))
                        decode.assert_called_once_with(xref)
                    with patch.object(doc, "extract_image", return_value=extracted | {"ext": "webp"}):
                        with self.assertRaises(PdfImageError):
                            _image_from_xref(doc, xref, 1)

    def test_composed_rotated_and_blank_pages_require_consent(self):
        complex_pdf = self.root / "composed.pdf"
        with fitz.open(self.pdf) as doc:
            doc[0].insert_text((20, 40), "overlay")
            doc[1].set_rotation(90)
            doc.new_page(width=240, height=320)
            doc.save(complex_pdf)
        with self.assertRaises(RenderRequired) as error:
            import_pdf(str(complex_pdf), self.root / "assets")
        self.assertEqual(error.exception.data["pages"], [1, 2])
        book = import_pdf(str(complex_pdf), self.root / "assets", render=True, dpi=72)
        self.assertEqual(len(book["pages"]), 4)
        self.assertTrue(all(asset["kind"] == "file" for asset in book["assets"].values()))
        self.assertEqual(book["pages"][-1]["kind"], "blank")

    def test_auto_rendering_tracks_visible_source_pixels_and_caps_large_pages(self):
        path = self.root / "auto.pdf"
        with fitz.open() as doc:
            for width, height in ((24000, 32000), (240, 320), (320, 240), (240, 320)):
                page = doc.new_page(width=width, height=height)
                page.insert_image(page.rect, stream=self.jpeg, rotate=90 if width == 320 else 0)
                page.insert_text((20, 40), "overlay")
            doc[1].set_rotation(90)
            doc[3].set_cropbox(fitz.Rect(60, 80, 180, 240))
            page = doc.new_page(width=72, height=144)
            page.insert_text((5, 20), "Text")
            page = doc.new_page(width=23000, height=46000)
            page.draw_rect(page.rect, fill=(1, 0, 0))
            page = doc.new_page(width=1, height=60000)
            page.draw_rect(page.rect, fill=(0, 0, 1))
            page = doc.new_page(width=72, height=144)
            page.insert_text((5, 20), "Small logo")
            page.insert_image(fitz.Rect(0, 30, 3, 34), stream=self.jpeg)
            doc.save(path)
        with self.assertRaises(RenderRequired):
            import_pdf(str(path), self.root / "assets")
        book = import_pdf(str(path), self.root / "assets", render=True)
        self.assertEqual(
            [(p["width"], p["height"]) for p in book["pages"]],
            [(240, 320), (320, 240), (320, 240), (120, 160), (200, 400), (3000, 6000), (1, 6000), (200, 400)],
        )
        self.assertAlmostEqual(next(iter(book["assets"].values()))["derived_from"]["dpi"], 0.72)
        for asset in book["assets"].values():
            with Image.open(asset["path"]) as image:
                self.assertEqual(image.size, (asset["width"], asset["height"]))
        with patch.object(fitz.Page, "get_pixmap", side_effect=AssertionError("Allocate only after size check")):
            with self.assertRaisesRegex(ValueError, "too large to render"):
                import_pdf(str(path), self.root / "assets", render=True, dpi=300)
        for dpi in (None, True, 0, 601, 150.5, "300", "invalid"):
            with self.subTest(dpi=dpi), self.assertRaisesRegex(ValueError, "Render resolution"):
                import_pdf(str(path), self.root / "assets", render=True, dpi=dpi)

    def test_rendered_png_preserves_gray_levels_tints_and_compositing(self):
        path = self.root / "render-colors.pdf"
        pixels = bytes(v for _ in range(32) for level in range(256) for v in (level, level, level))
        with fitz.open() as doc:
            for tinted in (False, True):
                image = Image.frombytes("RGB", (256, 32), pixels)
                if tinted:
                    image.putpixel((128, 16), (127, 128, 128))
                buffer = io.BytesIO()
                image.save(buffer, "PNG")
                page = doc.new_page(width=256, height=32)
                page.insert_image(page.rect, stream=buffer.getvalue())
                page.insert_text((5, 15), "overlay")
            doc.save(path)
        book = import_pdf(str(path), self.root / "assets", render=True)
        with fitz.open(path) as doc:
            for page, asset, mode in zip(doc, book["assets"].values(), ("L", "RGB")):
                expected = page.get_pixmap(dpi=72, alpha=False, colorspace=fitz.csRGB)
                with Image.open(asset["path"]) as image:
                    self.assertEqual(image.mode, mode)
                    self.assertEqual(image.size, (256, 32))
                    self.assertEqual(image.convert("RGB").tobytes(), expected.samples)
                    self.assertAlmostEqual(image.info["dpi"][0], 72, delta=0.02)
        output = self.root / "rendered.epub"
        export_epub(book, str(output))
        with ZipFile(output) as archive:
            for asset_id, asset in book["assets"].items():
                self.assertEqual(archive.read(f"EPUB/images/{asset_id}.png"), Path(asset["path"]).read_bytes())

    def test_pdf_inspection_uses_drawn_resource_without_pixel_hashing(self):
        path = self.root / "shared-resources.pdf"
        unused = io.BytesIO()
        Image.new("RGB", (240, 320), "blue").save(unused, "JPEG")
        with fitz.open() as doc:
            for name in ("Image", "Im#61ge", "Im#20age", "Im#23age"):
                page = doc.new_page(width=240, height=320)
                used_xref = page.insert_image(page.rect, stream=self.jpeg)
                unused_xref = page.insert_image(page.rect, stream=unused.getvalue())
                doc.xref_set_key(used_xref, "ColorSpace", "/DeviceRGB")
                resources = int(doc.xref_get_key(page.xref, "Resources")[1].split()[0])
                doc.xref_set_key(resources, "XObject", f"<< /Unused {unused_xref} 0 R /{name} {used_xref} 0 R >>")
                content = page.get_contents()[0]
                doc.update_stream(content, f"% /Unused Do\nq 240 0 0 320 0 0 cm /{name} Do Q".encode())
                page.set_contents(content)
            doc.save(path)
        with patch.object(fitz, "Pixmap", side_effect=AssertionError("Inspection must not hash image pixels")):
            book = import_pdf(str(path), self.root / "assets")
        self.assertEqual(len(book["pages"]), 4)
        for asset_id, asset in book["assets"].items():
            self.assertEqual(asset["xref"], used_xref)
            self.assertEqual(load_asset(book, asset_id), self.jpeg)

    def test_flate_pixels_and_core_direction_keep_split_identity(self):
        png = io.BytesIO()
        original = Image.new("RGB", (240, 320), "#bada55")
        original.save(png, "PNG")
        path = self.root / "flate.pdf"
        with fitz.open() as doc:
            page = doc.new_page(width=240, height=320)
            xref = page.insert_image(page.rect, stream=png.getvalue())
            doc.xref_set_key(xref, "ColorSpace", "/DeviceRGB")
            doc.save(path, deflate=True)
        book = import_pdf(str(path), self.root / "assets")
        asset_id = next(iter(book["assets"]))
        self.assertEqual(book["assets"][asset_id]["ext"], "png")
        with Image.open(io.BytesIO(load_asset(book, asset_id))) as decoded:
            self.assertEqual(decoded.tobytes(), original.tobytes())
        page = book["pages"][0]
        right = page | {
            "id": new_id(),
            "crop": [0.5, 0, 0.5, 1],
            "split": {"group": "pair", "side": "right", "original": page},
        }
        left = page | {
            "id": new_id(),
            "crop": [0, 0, 0.5, 1],
            "split": {"group": "pair", "side": "left", "original": page},
        }
        book["pages"] = [right, left]
        session = Session(book)
        session.apply(book["id"], 0, {"metadata": {"direction": "ltr"}})
        self.assertEqual([p["id"] for p in session.book["pages"]], [left["id"], right["id"]])
        self.assertRaises(ValueError, parse_json, '{"extension": NaN}')

    def test_direction_changes_only_reorder_matching_original_split_pages(self):
        engine = Engine(self.root / "direction")
        self.addCleanup(engine.close)
        original = copy.deepcopy(self.book["pages"][0])
        for crop, expected in (([0, 0, 1, 1], ["right", "left"]), ([0, 0, 0.9, 1], ["left", "right"])):
            with self.subTest(original_crop=crop):
                book = copy.deepcopy(self.book)
                book["metadata"].update(direction="ltr", cover_id="left")
                book["pages"] = [
                    original | {"id": "left", "crop": [0, 0, 0.5, 1],
                                "split": {"group": "pair", "side": "left", "original": original}},
                    original | {"id": "right", "crop": [0.5, 0, 0.5, 1],
                                "split": {"group": "pair", "side": "right", "original": original | {"crop": crop}}},
                ]
                engine.session = Session(book)
                result = engine.call("document.apply", {
                    "document_id": book["id"], "base_revision": 0, "changes": {"metadata": {"direction": "rtl"}},
                })
                self.assertEqual([page["id"] for page in result["pages"]], expected)
                self.assertEqual(result["metadata"]["cover_id"], "left")
                restored = engine.call("document.undo", {"document_id": book["id"]})
                self.assertEqual([page["id"] for page in restored["pages"]], ["left", "right"])
                self.assertEqual(restored["metadata"]["direction"], "ltr")

    def test_indexed_flate_import_saves_lossless_images_and_export_preserves_them(self):
        path = self.root / "indexed.pdf"
        raw = bytes(range(256)) * 150  # 240 x 320 pixels, packed two 4-bit indices per byte.
        palette = bytes(value * 17 for value in range(16) for _ in range(3))
        expected = bytes(index * 17 for byte in raw for index in (byte >> 4, byte & 15) for _ in range(3))
        with fitz.open(self.pdf) as doc:
            xref = doc[0].get_images()[0][0]
            doc.update_object(
                xref,
                "<< /Type /XObject /Subtype /Image /Width 240 /Height 320 /BitsPerComponent 4 "
                f"/ColorSpace [/Indexed /DeviceRGB 15 <{palette.hex()}>] >>",
            )
            doc.update_stream(xref, raw, compress=True)
            doc.save(path)
        with patch.object(pdf_images.zlib, "compress", wraps=zlib.compress) as compress:
            book = import_pdf(str(path), self.root / "assets")
            page = book["pages"][0]
            rendered = self.root / preview(book, page["id"], 320, self.root / "previews")
            self.assertEqual({call.kwargs["level"] for call in compress.call_args_list}, {0, 3})
            with Image.open(rendered) as image:
                self.assertEqual(image.convert("RGB").tobytes(), expected)
            compress.reset_mock()
            output = self.root / "indexed.epub"
            export_epub(book, str(output))
            compress.assert_not_called()
        with ZipFile(output) as archive:
            with Image.open(io.BytesIO(archive.read(f"EPUB/images/{page['asset_id']}.png"))) as image:
                self.assertEqual(image.convert("RGB").tobytes(), expected)

    def test_pdf_filter_arrays_and_size_limits_before_decoding(self):
        with fitz.open(self.pdf) as doc:
            xref = doc[0].get_images()[0][0]
            with patch.object(fitz.Document, "extract_image", side_effect=AssertionError("Unexpected PNG conversion")):
                doc.xref_set_key(xref, "Filter", "[/DCTDecode]")
                self.assertEqual(image_to_epub_member(_image_from_xref(doc, xref, 1)), ("jpg", self.jpeg))
                raw = bytes(range(12))
                predicted = b"\0" + raw[:6] + b"\2" + bytes([6] * 6)
                doc.update_object(xref, "<< /Subtype /Image /Width 2 /Height 2 /BitsPerComponent 8 /ColorSpace /DeviceRGB >>")
                doc.update_stream(xref, zlib.compress(predicted), compress=False)
                params = "<< /Predictor 15 /Colors 3 /Columns 2 /BitsPerComponent 8 >>"
                params_xref = doc.get_new_xref()
                doc.update_object(params_xref, params)
                filter_xref = doc.get_new_xref()
                doc.update_object(filter_xref, "[/FlateDecode]")
                for image_filter, decode_parms in (
                    ("/FlateDecode", params), ("[/FlateDecode]", f"[{params}]"),
                    (f"{filter_xref} 0 R", f"[{params_xref} 0 R]"),
                ):
                    doc.xref_set_key(xref, "Filter", image_filter)
                    doc.xref_set_key(xref, "DecodeParms", decode_parms)
                    _, payload = image_to_epub_member(_image_from_xref(doc, xref, 1), compression_level=0)
                    with Image.open(io.BytesIO(payload)) as image:
                        self.assertEqual(image.tobytes(), raw)
                doc.update_stream(xref, zlib.compress(raw), compress=False)
                doc.xref_set_key(xref, "Filter", "[/FlateDecode]")
                doc.xref_set_key(xref, "DecodeParms", "[null]")
                _, payload = image_to_epub_member(_image_from_xref(doc, xref, 1), compression_level=0)
                with Image.open(io.BytesIO(payload)) as image:
                    self.assertEqual(image.tobytes(), raw)
            with (
                patch.object(fitz.Document, "extract_image", side_effect=AssertionError("Decoded oversized image")),
                patch.object(fitz.Document, "xref_stream_raw", side_effect=AssertionError("Read oversized image")),
            ):
                for image_filter in ("/DCTDecode", "[/FlateDecode]", "/JBIG2Decode", "null"):
                    doc.xref_set_key(xref, "Filter", image_filter)
                    for width in (0, -1, 100_000_001):
                        doc.xref_set_key(xref, "Width", str(width))
                        with self.assertRaises(PdfImageError):
                            _image_from_xref(doc, xref, 1)

    def test_worker_records_import_phase_timings(self):
        engine = Engine(self.root / "timing-data")
        self.addCleanup(engine.close)
        with patch("sys.stderr", new=io.StringIO()) as log:
            book = engine.run_worker("import", {"path": str(self.pdf)})
        self.assertEqual(len(book["pages"]), 3)
        timing = json.loads(log.getvalue().strip().removeprefix("[timing] "))
        self.assertEqual(timing["operation"], "import")
        self.assertEqual(set(timing["phases"]), {"Preparing", "Checking PDF pages", "Preparing pages"})
        self.assertTrue(all(value >= 0 for value in timing["phases"].values()))
        self.assertAlmostEqual(sum(timing["phases"].values()), timing["seconds"], delta=0.01)

    def test_atomic_edits_monotonic_history_and_project_roundtrip(self):
        session = Session(self.book)
        identifier = self.book["id"]
        pages = list(reversed(self.book["pages"]))
        session.apply(identifier, 0, {"pages": pages, "extension": {"id": "future.ocr", "data": {"opaque": [1, 2]}}})
        with self.assertRaises(ValueError):
            session.apply(identifier, 0, {"pages": []})
        invalid = copy.deepcopy(pages)
        invalid[0]["crop"] = [-1, 0, 1, 1]
        with self.assertRaises(ValueError):
            session.apply(identifier, 1, {"pages": invalid})
        self.assertEqual(session.book["pages"], pages)
        session.history(identifier)
        self.assertEqual(session.book["revision"], 2)
        self.assertEqual(session.book["pages"], self.book["pages"])
        session.history(identifier, redo=True)
        bundle = self.root / "test.mteproj"
        save_project(session.book, bundle)
        restored = open_project(bundle)
        self.assertEqual(restored | {"assets": session.book["assets"]}, session.book)
        for asset_id in restored["assets"]:
            self.assertEqual(load_asset(restored, asset_id), load_asset(session.book, asset_id))
        self.pdf.rename(self.root / "moved.pdf")
        engine = Engine(self.root / "data")
        self.addCleanup(engine.close)
        engine.call("project.open", {"path": str(bundle)})
        source_id = next(iter(restored["sources"]))
        engine.call(
            "project.relink",
            {
                "document_id": identifier,
                "base_revision": 3,
                "source_id": source_id,
                "path": str(self.root / "moved.pdf"),
            },
        )
        export_epub(engine.session.book, str(self.root / "relinked.epub"))
        self.assertIn("future.ocr", engine.session.book["extensions"])

    def test_plugin_install_restart_safety_and_worker(self):
        directory = self.root / "data"
        directory.mkdir()
        plugins = Plugins(directory)
        package = self.root / "test.mte-plugin"
        manifest = {
            "id": "test.worker",
            "name": "Test",
            "version": "1.0.0",
            "api_version": 1,
            "platforms": ["all"],
            "workers": {platform_id(): "worker"},
        }
        with ZipFile(package, "w") as archive:
            archive.writestr("manifest.json", json.dumps(manifest))
            info = ZipInfo("worker")
            info.external_attr = 0o100755 << 16
            archive.writestr(
                info,
                f"#!{sys.executable}\nimport json,sys\np=json.loads(sys.stdin.readline())\n"
                "print(json.dumps({'result': {'changes': {'metadata': {'title': 'Worker title'}}}}))\n",
            )
        installed = plugins.install(str(package))
        self.assertTrue(installed["restart_required"])
        self.assertFalse(installed["active"])
        self.assertIn("test.worker", Plugins(directory).active)
        self.assertFalse(Plugins(directory, safe=True).active)
        engine = Engine(directory)
        self.addCleanup(engine.close)
        engine.session = Session(self.book)
        job = engine.call(
            "task.start",
            {"operation": "plugin", "plugin_id": "test.worker", "document_id": self.book["id"], "base_revision": 0},
        )
        final = self.wait_job(engine, job["id"])
        self.assertEqual(final["state"], "completed", final)
        self.assertEqual(engine.session.book["metadata"]["title"], "Worker title")
        with ZipFile(self.root / "bad.zip", "w") as archive:
            archive.writestr("../escape", "bad")
        with self.assertRaises(ValueError):
            plugins.install(str(self.root / "bad.zip"))
        with self.assertRaises(ValueError):
            plugins.install(str(package), "0" * 64)
        active_plugins = Plugins(directory)
        active_plugins.remove("test.worker")
        self.assertTrue(active_plugins.list()["restart_required"])
        self.assertNotIn("test.worker", Plugins(directory).active)
        self.assertTrue(Plugins(directory).install(str(package))["restart_required"])

    def test_bundled_editor_installs_once_and_respects_user_choices(self):
        package = self.root / "editor.mte-plugin"
        with ZipFile(package, "w") as archive:
            archive.writestr(
                "manifest.json",
                json.dumps(
                    {
                        "id": "org.foluma.editor",
                        "name": "Editor",
                        "version": "0.1.0",
                        "api_version": 1,
                        "platforms": ["all"],
                        "ui": {"title": "編輯頁面", "entry": "editor.js"},
                    }
                ),
            )
            archive.writestr("editor.js", "export function mount() { return () => {}; }")
        directory = self.root / "fresh"
        first = Plugins(directory, bundled_editor=package)
        self.assertIn("org.foluma.editor", first.active)
        self.assertFalse(first.list()["restart_required"])
        first.set_enabled("org.foluma.editor", False)
        disabled = Plugins(directory, bundled_editor=package)
        self.assertFalse(disabled.active)
        self.assertFalse(disabled.list()["items"][0]["enabled"])
        disabled.set_enabled("org.foluma.editor", True)
        enabled = Plugins(directory, bundled_editor=package)
        self.assertIn("org.foluma.editor", enabled.active)
        enabled.remove("org.foluma.editor")
        removed = Plugins(directory, bundled_editor=package)
        self.assertFalse(removed.active)
        self.assertFalse(removed.list()["items"])
        self.assertFalse(Plugins(directory, bundled_editor=package).list()["items"])
        existing = self.root / "existing"
        Plugins(existing)
        self.assertFalse(Plugins(existing, bundled_editor=package).list()["items"])
        safe = self.root / "safe"
        self.assertFalse(Plugins(safe, safe=True, bundled_editor=package).active)
        self.assertIn("org.foluma.editor", Plugins(safe, bundled_editor=package).active)
        package.write_bytes(b"broken package")
        broken = Plugins(self.root / "broken", bundled_editor=package)
        self.assertFalse(broken.active)
        self.assertTrue(broken.errors)

    def test_catalog_check_keeps_installed_plugins_and_falls_back_on_invalid_metadata(self):
        manager = Plugins(self.root / "catalog-profile")
        installed = manager.config_path.read_bytes()
        entry = {"id": "test.export", "name": "Export", "version": "1.2.3", "api_version": 1,
                 "platforms": ["all"], "sha256": "a" * 64, "url": "https://example.test/export.mte-plugin"}
        catalog = {"schema": 1, "plugins": [entry]}
        with patch("foluma.plugins.download", side_effect=lambda _url, path, _limit: path.write_text(json.dumps(catalog))):
            self.assertFalse(manager.catalog()["offline"])
        for invalid in [None, entry | {"name": None}, entry | {"version": "broken"},
                        entry | {"description": {}}, entry | {"url": 123}, entry | {"api_version": False}]:
            with self.subTest(metadata=invalid), patch("foluma.plugins.download", side_effect=lambda _url, path, _limit:
                                                      path.write_text(json.dumps({"plugins": [invalid]}))):
                result = manager.catalog()
                self.assertTrue(result["offline"])
                self.assertEqual(result["plugins"], [entry])
                self.assertEqual(manager.config_path.read_bytes(), installed)

    def test_completed_export_always_includes_its_result(self):
        engine = Engine(self.root / "complete-result")
        self.addCleanup(engine.close)
        engine.session = Session(self.book)
        observed = []
        original_temp = tempfile.TemporaryDirectory

        class ObserveCleanup(original_temp):
            def __exit__(self, *args):
                if Path(self.name).name.startswith(".foluma-"):
                    observed.extend(job["result"] for job in engine.jobs.values() if job["state"] == "completed")
                return super().__exit__(*args)

        with patch("foluma.service.tempfile.TemporaryDirectory", ObserveCleanup):
            job = engine.call(
                "task.start",
                {
                    "operation": "export",
                    "document_id": self.book["id"],
                    "base_revision": 0,
                    "path": str(self.root / "complete.epub"),
                },
            )
            self.assertEqual(self.wait_job(engine, job["id"])["state"], "completed")
        self.assertTrue(observed)
        self.assertTrue(all(result and result["path"].endswith("complete.epub") for result in observed))

    def test_language_pack_lifecycle_and_validation(self):
        directory = self.root / "languages"
        engine = Engine(directory)
        self.addCleanup(engine.close)
        self.assertEqual(engine.call("app.locale", {})["code"], "en")
        manifest = {
            "id": "test.language.zh-hant",
            "name": "繁體中文",
            "version": "1.0.0",
            "api_version": 1,
            "platforms": ["all"],
            "language": {"locale": "zh-Hant", "name": "繁體中文", "messages": "messages.json"},
        }
        package = self.root / "language.mte-plugin"

        def write_package(messages, extra=None):
            with ZipFile(package, "w") as archive:
                archive.writestr("manifest.json", json.dumps(manifest | (extra or {})))
                archive.writestr("messages.json", json.dumps(messages))
                archive.writestr("evil.js", "throw new Error('must never run');")

        write_package({"Open PDF": "開啟 PDF", "Page {0}": "第 {0} 頁"})
        installed = engine.call("plugins.install", {"path": str(package)})
        self.assertFalse(installed["restart_required"])
        selected = engine.call("app.locale", {"code": "zh-Hant"})
        self.assertEqual(selected["messages"]["Open PDF"], "開啟 PDF")
        self.assertEqual(Plugins(directory).locale()["code"], "zh-Hant")
        self.assertEqual(Plugins(directory, safe=True).locale()["code"], "en")
        engine.call("plugins.set_enabled", {"id": manifest["id"], "enabled": False})
        self.assertEqual(engine.call("app.locale", {})["code"], "en")
        engine.call("plugins.set_enabled", {"id": manifest["id"], "enabled": True})
        engine.call("app.locale", {"code": "zh-Hant"})
        removed = engine.call("plugins.remove", {"id": manifest["id"]})
        self.assertFalse(removed["restart_required"])
        self.assertEqual(engine.call("app.locale", {})["code"], "en")
        self.assertEqual(Plugins(directory).locale()["available"], [{"code": "en", "name": "English"}])
        engine.call("plugins.install", {"path": str(package)})  # Reinstall without restarting.
        with self.assertRaises(ValueError):
            engine.call("app.locale", {"code": "missing"})
        write_package({"Page {0}": "第 {1} 頁"})
        with self.assertRaises(ValueError):
            engine.call("plugins.inspect", {"path": str(package)})
        write_package({"Open PDF": "開啟 PDF"}, {"ui": {"title": "Malicious", "entry": "evil.js"}})
        with self.assertRaises(ValueError):
            engine.call("plugins.inspect", {"path": str(package)})
        write_package(
            {"Open PDF": "開啟 PDF"}, {"language": {"locale": "en", "name": "English", "messages": "messages.json"}}
        )
        with self.assertRaises(ValueError):
            engine.call("plugins.inspect", {"path": str(package)})

    def test_cancel_preserves_destination_and_imported_assets_undo(self):
        engine = Engine(self.root / "data")
        self.addCleanup(engine.close)
        engine.session = Session(self.book)
        target = self.root / "existing.epub"
        target.write_bytes(b"keep me")
        with patch("foluma.workers.worker_command", return_value=[sys.executable, "-c", "import time;time.sleep(10)"]):
            job = engine.call(
                "task.start",
                {
                    "operation": "export",
                    "document_id": self.book["id"],
                    "base_revision": 0,
                    "path": str(target),
                    "overwrite": True,
                },
            )
            deadline = time.monotonic() + 5
            while not engine.workers.processes and time.monotonic() < deadline:
                time.sleep(0.01)
            engine.call("task.cancel", {"id": job["id"]})
            self.assertEqual(self.wait_job(engine, job["id"])["state"], "cancelled")
        self.assertEqual(target.read_bytes(), b"keep me")
        source = self.root / "insert.png"
        Image.new("RGB", (100, 80), "red").save(source)
        job = engine.call(
            "task.start",
            {
                "operation": "images.import",
                "document_id": self.book["id"],
                "base_revision": 0,
                "paths": [str(source)],
                "position": 1,
            },
        )
        self.assertEqual(self.wait_job(engine, job["id"])["state"], "completed")
        self.assertEqual(len(engine.session.book["pages"]), 4)
        engine.session.history(self.book["id"])
        self.assertEqual(len(engine.session.book["pages"]), 3)
        engine.session.history(self.book["id"], True)
        project = self.root / "embedded.mteproj"
        save_project(engine.session.book, project)
        self.assertEqual(len(list((project / "assets").iterdir())), 2)
        source.unlink()
        export_epub(open_project(project), str(self.root / "embedded.epub"))
        asset_id = next(key for key, asset in engine.session.book["assets"].items() if not asset.get("source_page"))
        preset = self.root / "portable.mtepreset"
        reference = {"document_id": self.book["id"], "base_revision": engine.session.book["revision"]}
        engine.call(
            "bundle.write",
            reference
            | {
                "plugin": "test.editor",
                "path": str(preset),
                "payload": {"opaque": [asset_id]},
                "asset_ids": [asset_id],
            },
        )
        imported = engine.call("bundle.read", reference | {"plugin": "test.editor", "path": str(preset)})
        new_asset = imported["asset_ids"][asset_id]
        self.assertNotEqual(new_asset, asset_id)
        self.assertEqual(imported["payload"], {"opaque": [asset_id]})
        self.assertEqual(engine.session.book["assets"][new_asset]["width"], 100)

    def test_stdio_roundtrip_and_shutdown(self):
        import os

        process = subprocess.Popen(
            [sys.executable, "-m", "foluma", "--serve"],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            env=os.environ | {"FOLUMA_DATA": str(self.root / "rpc")},
        )
        stdout, stderr = process.communicate(
            json.dumps({"jsonrpc": "2.0", "id": 1, "method": "app.info"}) + "\n", timeout=10
        )
        self.assertEqual(process.returncode, 0, stderr)
        response = json.loads(stdout)
        self.assertEqual(response["id"], 1)
        self.assertEqual(response["result"]["version"], "0.1.0")

    def test_series_independent_edits_review_export_and_restart(self):
        folder = self.root / "Series"
        folder.mkdir()
        for name in ("Vol.10.pdf", "Vol.2.pdf", "Vol.1.pdf"):
            (folder / name).write_bytes(self.pdf.read_bytes())
        (folder / "notes.txt").write_text("not a book")
        data = self.root / "series-data"
        engine = Engine(data)
        self.addCleanup(engine.close)
        state = engine.call("series.scan", {"paths": [str(folder)]})
        self.assertEqual([item["title"] for item in state["items"]], ["Vol.1", "Vol.2", "Vol.10"])
        self.assertTrue(all(item["revision"] is None for item in state["items"]))
        self.assertIsNone(engine.session)
        one, two, ten = [item["id"] for item in state["items"]]
        results = engine.call("series.configure", {"ids": [one, two], "metadata": {"direction": "ltr", "cover_only": True}})
        self.assertTrue(all(item["error"] is None for item in results))

        def task(operation, **params):
            started = engine.call("task.start", {"operation": operation, **params})
            job = self.wait_job(engine, started["id"])
            self.assertEqual(job["state"], "completed", job)
            return job["result"]

        book = task("series.open", entry_id=one)
        self.assertEqual(book["metadata"]["direction"], "ltr")
        self.assertTrue(book["metadata"]["cover_only"])
        marked = book["pages"][1]["id"]
        blank = {"id": new_id(), "kind": "blank", "width": 240, "height": 320}
        book = engine.call("document.apply", {"document_id": book["id"], "base_revision": book["revision"], "changes": {
            "pages": [*book["pages"], blank], "extension": {"id": "org.foluma.editor", "data": {"review": [marked]}}
        }})
        self.assertFalse(book["dirty"])
        first = copy.deepcopy(book)
        self.assertEqual(engine.call("series.get", {})["items"][0]["review_count"], 1)
        engine.call("series.review", {"id": one, "reviewed": True, "allow_pending": True})
        output = self.root / "exports"
        output.mkdir()
        engine.call("series.output", {"directory": str(output)})
        exported = task("export", document_id=book["id"], base_revision=book["revision"], directory=str(output))
        original_output = Path(exported["path"]).read_bytes()
        self.assertTrue(engine.call("series.get", {})["items"][0]["exported"])

        second = task("series.open", entry_id=two)
        self.assertEqual(len(second["pages"]), 3)
        self.assertNotEqual(second["id"], first["id"])
        restored = task("series.open", entry_id=one)
        self.assertEqual(restored["pages"], first["pages"])
        self.assertEqual(restored["extensions"]["org.foluma.editor"]["review"], [marked])
        restored = engine.call("document.apply", {"document_id": restored["id"], "base_revision": restored["revision"],
                              "changes": {"pages": [*restored["pages"], blank | {"id": new_id()}]}})
        row = engine.call("series.get", {})["items"][0]
        self.assertFalse(row["reviewed"])
        self.assertTrue(row["needs_export"])

        background = task("series.open", entry_id=ten, background=True)
        self.assertEqual(background["metadata"]["direction"], "rtl")
        self.assertEqual(engine.call("document.get", {})["id"], restored["id"])
        engine.call("document.release", {"document_id": background["id"]})
        exported_again = task("export", document_id=restored["id"], base_revision=restored["revision"], directory=str(output))
        self.assertNotEqual(exported_again["path"], exported["path"])
        self.assertEqual(Path(exported["path"]).read_bytes(), original_output)
        with ZipFile(exported_again["path"]) as archive:
            self.assertEqual(len([name for name in archive.namelist() if name.startswith("EPUB/pages/")]), 4)
        engine.close()
        restarted = Engine(data)
        self.addCleanup(restarted.close)
        self.assertEqual(restarted.call("document.get", {})["pages"], restored["pages"])
        self.assertEqual(restarted.call("series.get", {})["output_directory"], str(output.resolve()))
        for path in folder.glob("*.pdf"):
            path.unlink()
        self.assertTrue(all(item["missing"] for item in restarted.call("series.scan", {"paths": [str(folder)]})["items"]))
        self.assertEqual(len(restarted.series.load(restarted.series.item(one)).book["pages"]), 5)

    def test_series_autosave_failure_keeps_previous_project_and_current_dirty_edits(self):
        events = []
        engine = Engine(self.root / "autosave-data", notify=lambda method, value: events.append((method, value)))
        self.addCleanup(engine.close)
        row = engine.call("series.scan", {"paths": [str(self.pdf)]})["items"][0]
        started = engine.call("task.start", {"operation": "series.open", "entry_id": row["id"]})
        book = self.wait_job(engine, started["id"])["result"]
        path = Path(book["project_path"]) / "project.json"
        original = path.read_bytes()
        with patch("foluma.series.save_project", side_effect=OSError("disk full")):
            with self.assertRaisesRegex(OSError, "disk full"):
                engine.call("document.apply", {"document_id": book["id"], "base_revision": book["revision"],
                                                "changes": {"metadata": {"title": "Unsaved recovery"}}})
            self.assertEqual(path.read_bytes(), original)
            self.assertTrue(engine.call("document.get", {})["dirty"])
            self.assertTrue(events[-1][1]["dirty"])
            with self.assertRaisesRegex(OSError, "disk full"):
                engine.call("task.start", {"operation": "series.open", "entry_id": row["id"]})
        started = engine.call("task.start", {"operation": "series.open", "entry_id": row["id"]})
        recovered = self.wait_job(engine, started["id"])["result"]
        self.assertEqual(recovered["metadata"]["title"], "Unsaved recovery")
        self.assertFalse(recovered["dirty"])

    def wait_job(self, engine, identifier):
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            job = engine.call("task.get", {"id": identifier})
            if job["state"] not in ("queued", "running"):
                return job
            time.sleep(0.02)
        self.fail("job did not finish")


if __name__ == "__main__":
    unittest.main()
