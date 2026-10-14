import copy
import io
import json
import shutil
import tempfile
import threading
import tracemalloc
import unittest
import zlib
from importlib import import_module
from pathlib import Path
from unittest.mock import patch
from zipfile import ZIP_DEFLATED, ZipFile

from foluma.model import Session
from foluma.plugins import Plugins
from foluma.service import Engine
from foluma.storage import digest
from PIL import Image

png = import_module("plugins.pdf-import.foluma_pdf.png")
image_types = import_module("plugins.pdf-import.foluma_pdf.image_types")
images = import_module("plugins.pdf-import.foluma_pdf.image_extraction")


class MaintenanceTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)

    def engine(self):
        engine = Engine(self.root / "profile")
        self.addCleanup(engine.close)
        return engine

    def package(self, version="1.0.0", directory=None):
        path = (directory or self.root) / f"tool-{version}.mte-plugin"
        manifest = {"id": "test.tool", "name": "Tool", "version": version, "api_version": 1,
                    "platforms": ["all"], "ui": {"entry": "tool.js", "title": "Tool"}}
        with ZipFile(path, "w", ZIP_DEFLATED) as archive:
            archive.writestr("manifest.json", json.dumps(manifest))
            archive.writestr("tool.js", b"x" * 2_000_000)
        return path, manifest

    def test_page_and_multiple_extension_edits_commit_and_undo_atomically(self):
        path = self.root / "image.png"
        Image.new("RGB", (2, 2), "white").save(path)
        book = {"schema": 1, "id": "book", "revision": 0,
                "metadata": {"title": "Book", "author": "", "language": "en", "direction": "ltr",
                             "cover_only": False, "cover_id": "page"},
                "sources": {}, "assets": {"asset": {"kind": "file", "path": str(path), "ext": "png", "width": 2, "height": 2}},
                "pages": [{"id": "page", "kind": "image", "asset_id": "asset", "width": 2, "height": 2, "crop": [0, 0, 1, 1]}],
                "extensions": {"test.unknown": {"keep": True}}}
        session = Session(book)
        pages = book["pages"] + [book["pages"][0] | {"id": "second"}]
        changes = {"pages": pages, "extensions": {
            "org.foluma.editor": {"review": ["second"]},
            "org.foluma.page-tools": {"colors": {"second": "black"}, "no_margins": ["second"]}}}
        for invalid in [None, [], changes["extensions"] | {"../bad": {}}]:
            with self.subTest(extension=invalid), self.assertRaises(ValueError):
                session.apply("book", 0, changes | {"extensions": invalid})
            self.assertEqual(session.book, book)
            self.assertFalse(session.undo_stack)
        session.apply("book", 0, changes)
        self.assertEqual(session.book["revision"], 1)
        self.assertEqual(session.book["extensions"]["test.unknown"], {"keep": True})
        self.assertEqual(session.book["extensions"]["org.foluma.editor"], {"review": ["second"]})
        session.history("book")
        self.assertEqual(session.book | {"revision": 0}, book)
        session.history("book", redo=True)
        self.assertEqual(session.book["extensions"]["org.foluma.page-tools"]["no_margins"], ["second"])

    def test_pdf_image_and_palette_decompression_are_bounded_before_rejection(self):
        payload = zlib.compress(b"\0" * 8_388_608)
        image = image_types.ImageStream(1, 8, 8, 8, b"/DeviceRGB", "FlateDecode", None, payload)
        tracemalloc.start()
        try:
            with self.assertRaises(image_types.PdfImageError):
                png.flate_image_to_png(image)
            self.assertLess(tracemalloc.get_traced_memory()[1], 1_000_000)
        finally:
            tracemalloc.stop()
        raw = bytes(range(192))
        image = image_types.ImageStream(1, 8, 8, 8, b"/DeviceRGB", "FlateDecode", None, zlib.compress(raw))
        with Image.open(io.BytesIO(png.flate_image_to_png(image))) as decoded:
            self.assertEqual(decoded.tobytes(), raw)
        for data in [zlib.compress(raw)[:-2], zlib.compress(raw + b"extra")]:
            with self.assertRaises(image_types.PdfImageError):
                png.flate_image_to_png(image_types.ImageStream(1, 8, 8, 8, b"/DeviceRGB", "FlateDecode", None, data))
        class Palette:
            def xref_get_key(self, _xref, key):
                return ("int", str(len(payload))) if key == "Length" else ("name", "/FlateDecode")

            def xref_stream_raw(self, _xref):
                return payload

        with self.assertRaises(image_types.PdfImageError):
            images._normalize_xref_color_space(Palette(), b"[/Indexed /DeviceRGB 1 5 0 R]")

    def test_bundled_metadata_does_not_read_payloads_and_refreshes_changed_packages(self):
        directory = self.root / "bundled"
        directory.mkdir()
        path, manifest = self.package(directory=directory)
        manager = Plugins(self.root / "plugins")
        manager.bundled_directory = directory
        original = ZipFile.open

        def metadata_only(archive, member, *args, **kwargs):
            name = member.filename if hasattr(member, "filename") else member
            mode = kwargs.get("mode", args[0] if args else "r")
            if mode == "r" and name != "manifest.json":
                raise AssertionError("Listing plugins must not read their executable payloads")
            return original(archive, member, *args, **kwargs)

        with patch.object(ZipFile, "open", metadata_only):
            self.assertEqual(manager.bundled(), [manifest])
            manager.bundled()[0]["name"] = "changed by caller"
            self.assertEqual(manager.bundled()[0]["name"], "Tool")
            path.unlink()
            _, second = self.package("2.0.0", directory)
            self.assertEqual(manager.bundled(), [second])
        self.assertEqual(manager.install_bundled("test.tool")["items"][0]["version"], "2.0.0")

    def test_failed_install_preserves_settings_and_allows_retry(self):
        manager = Plugins(self.root / "plugins")
        path, _manifest = self.package()
        before, config = manager.config_path.read_bytes(), copy.deepcopy(manager.config)
        with patch("foluma.plugins.atomic_json", side_effect=OSError("disk full")), self.assertRaises(OSError):
            manager.install(str(path))
        self.assertEqual(manager.config, config)
        self.assertEqual(manager.config_path.read_bytes(), before)
        self.assertFalse(manager.directory("test.tool", "1.0.0").exists())
        self.assertEqual(manager.install(str(path))["items"][0]["version"], "1.0.0")

    def official_install(self, engine, path, mutate):
        started, release, responded = threading.Event(), threading.Event(), threading.Event()
        results, errors = [], []
        with ZipFile(path) as archive:
            manifest = json.loads(archive.read("manifest.json"))

        def download(_url, target):
            started.set()
            if not release.wait(3):
                raise AssertionError("Download was not released")
            shutil.copyfile(path, target)

        def install():
            try:
                results.append(engine.call("plugins.install_official", {"id": "test.tool"}))
            except Exception as error:
                errors.append(error)

        def read():
            engine.call("document.get", {})
            mutate()
            responded.set()

        catalog = {"plugins": [manifest | {"sha256": digest(path), "url": "https://example.test/tool"}]}
        with patch.object(engine.plugins, "catalog", return_value=catalog), patch("foluma.plugins.download", download):
            installer = threading.Thread(target=install)
            installer.start()
            reader = None
            try:
                self.assertTrue(started.wait(1))
                reader = threading.Thread(target=read)
                reader.start()
                self.assertTrue(responded.wait(1), "File operations and settings must stay available during downloads")
            finally:
                release.set()
                installer.join(3)
                if reader:
                    reader.join(3)
        self.assertFalse(installer.is_alive())
        return results, errors

    def test_official_download_releases_document_lock_and_preserves_concurrent_preferences(self):
        engine = self.engine()
        path, _manifest = self.package()
        results, errors = self.official_install(engine, path, lambda: engine.call("processing.configure", {"preparse": False}))
        self.assertFalse(errors)
        self.assertTrue(results)
        self.assertFalse(engine.processing()["preparse"])
        self.assertEqual(engine.plugins.config["installed"]["test.tool"]["version"], "1.0.0")

    def test_download_cannot_restore_a_plugin_removed_while_it_was_running(self):
        engine = self.engine()
        original, _manifest = self.package()
        engine.plugins.install(str(original))
        updated, _manifest = self.package("2.0.0")
        results, errors = self.official_install(engine, updated, lambda: engine.call("plugins.remove", {"id": "test.tool"}))
        self.assertFalse(results)
        self.assertEqual(len(errors), 1)
        self.assertIn("settings changed", str(errors[0]))
        self.assertNotIn("test.tool", engine.plugins.config["installed"])
        self.assertFalse(engine.plugins.directory("test.tool", "2.0.0").exists())
