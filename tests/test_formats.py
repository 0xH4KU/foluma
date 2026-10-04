import copy
import io
import json
import subprocess
import sys
import tempfile
import time
import unittest
import xml.etree.ElementTree as ET
from importlib import import_module
from pathlib import Path
from unittest.mock import patch
from zipfile import ZipFile, ZipInfo

import pymupdf as fitz
from foluma.model import new_id
from foluma.plugins import Plugins, platform_id
from foluma.service import Engine
from foluma.storage import digest, open_project, save_project
from PIL import Image


class FormatPluginTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        self.profile = self.root / "profile"
        self.pdf = self.root / "book.pdf"
        image = io.BytesIO()
        Image.new("RGB", (80, 120), "navy").save(image, "JPEG")
        with fitz.open() as document:
            page = document.new_page(width=80, height=120)
            xref = page.insert_image(page.rect, stream=image.getvalue())
            document.xref_set_key(xref, "ColorSpace", "/DeviceRGB")
            document.save(self.pdf)
        self.engine = self.restart()

    def restart(self):
        if hasattr(self, "engine"):
            self.engine.close()
        self.engine = Engine(self.profile)
        self.addCleanup(self.engine.close)
        return self.engine

    def task(self, operation, expected_state="completed", **params):
        job = self.engine.call("task.start", {"operation": operation, **params})
        deadline = time.monotonic() + 15
        while job["state"] == "running" and time.monotonic() < deadline:
            time.sleep(0.01)
            job = self.engine.call("task.get", {"id": job["id"]})
        self.assertEqual(job["state"], expected_state, job)
        return job["result"] if expected_state == "completed" else job

    def package(self, identifier, direction, extensions, program):
        path = self.root / f"{identifier}.mte-plugin"
        manifest = {"id": identifier, "name": identifier, "version": "0.1.0", "api_version": 1,
                    "platforms": ["all"], "format": {"direction": direction, "name": identifier, "extensions": extensions},
                    "workers": {platform_id(): "worker"}}
        with ZipFile(path, "w") as archive:
            archive.writestr("manifest.json", json.dumps(manifest))
            worker = ZipInfo("worker")
            worker.external_attr = 0o100755 << 16
            archive.writestr(worker, f"#!{sys.executable}\nimport json,sys\nfrom pathlib import Path\n"
                             "request=json.loads(sys.stdin.readline())\n" + program)
        return path

    def test_cbz_and_pdf_plugins_are_optional_independent_and_preserve_edited_pages(self):
        identifiers = {"org.foluma.import.cbz", "org.foluma.export.cbz", "org.foluma.export.pdf"}
        self.assertTrue(identifiers <= {plugin["id"] for plugin in self.engine.plugins.bundled()})
        self.assertFalse(identifiers & set(self.engine.plugins.active))
        for identifier in sorted(identifiers):
            self.engine.plugins.install_bundled(identifier)
        self.restart()
        self.assertEqual(self.engine.plugins.extensions("import"), ["cbz", "pdf"])
        self.assertEqual(self.engine.plugins.extensions("export"), ["cbz", "epub", "pdf"])
        encoded = {}
        for name, mode, size, color, format_name in (
                ("pages/10.png", "RGB", (20, 12), "blue", "PNG"),
                ("pages/2.jpg", "RGB", (16, 10), "red", "JPEG"),
                ("pages/1.webp", "RGBA", (12, 8), (0, 200, 0, 128), "WEBP")):
            output = io.BytesIO()
            image = Image.new(mode, size, color)
            if name.endswith("2.jpg"):
                image.paste("lime", (8, 0, 16, 10))
            image.save(output, format_name, lossless=True)
            encoded[name] = output.getvalue()
        source = self.root / "comic.cbz"
        with ZipFile(source, "w") as archive:
            for name, payload in encoded.items():
                archive.writestr(name, payload)
            archive.writestr("__MACOSX/._cover.png", b"ignored resource fork")
            archive.writestr("ComicInfo.xml", '<ComicInfo><Title>A &amp; B</Title><Writer>Author</Writer>'
                             '<LanguageISO>ja</LanguageISO><Manga>YesAndRightToLeft</Manga>'
                             '<Pages><Page Image="1" Type="FrontCover"/></Pages></ComicInfo>')
        book = self.task("import", path=str(source))
        self.assertEqual([book["assets"][page["asset_id"]]["member"] for page in book["pages"]],
                         ["pages/1.webp", "pages/2.jpg", "pages/10.png"])
        self.assertEqual([page["source_page"] for page in book["pages"]], [1, 2, 3])
        self.assertEqual(book["metadata"]["title"], "A & B")
        self.assertEqual(book["metadata"]["author"], "Author")
        self.assertEqual(book["metadata"]["language"], "ja")
        self.assertEqual(book["metadata"]["direction"], "rtl")
        self.assertEqual(book["metadata"]["cover_id"], book["pages"][1]["id"])
        original = copy.deepcopy(book["pages"][1])
        original["id"] = new_id()
        pages = copy.deepcopy(book["pages"])
        pages[1]["crop"] = [0.5, 0, 0.5, 1]
        blank = {"id": new_id(), "kind": "blank", "width": 7, "height": 9}
        book = self.engine.call("document.apply", {"document_id": book["id"], "base_revision": book["revision"],
                                                   "changes": {"pages": [pages[2], pages[1], original, pages[0], blank]}})
        project = self.root / "comic.mteproj"
        save_project(self.engine.session.book, project)
        self.engine.plugins.remove("org.foluma.import.pdf")
        self.engine.plugins.remove("org.foluma.import.cbz")
        source.unlink()
        self.restart()
        book = self.engine.call("project.open", {"path": str(project)})
        self.assertFalse(self.engine.plugins.formats("import"))
        collision = self.root / "A & B.cbz"
        collision.write_bytes(b"keep existing output")
        comic = self.task("export", document_id=book["id"], base_revision=book["revision"],
                          directory=str(self.root), plugin_id="org.foluma.export.cbz")
        self.assertEqual(Path(comic["path"]).name, "A & B (2).cbz")
        self.assertEqual(collision.read_bytes(), b"keep existing output")
        with ZipFile(comic["path"]) as archive:
            self.assertIsNone(archive.testzip())
            self.assertEqual(archive.namelist(), ["00001.png", "00002.png", "00003.jpg", "00004.png",
                                                 "00005.png", "ComicInfo.xml"])
            self.assertEqual(archive.read("00003.jpg"), encoded["pages/2.jpg"])
            with Image.open(io.BytesIO(archive.read("00002.png"))) as image:
                self.assertEqual(image.size, (8, 10))
                with Image.open(io.BytesIO(encoded["pages/2.jpg"])) as original_image:
                    self.assertEqual(image.tobytes(), original_image.crop((8, 0, 16, 10)).tobytes())
            with Image.open(io.BytesIO(archive.read("00005.png"))) as image:
                self.assertEqual(image.size, (7, 9))
                self.assertEqual(image.getextrema(), ((255, 255),) * 3)
            metadata = ET.fromstring(archive.read("ComicInfo.xml"))
            self.assertEqual(metadata.findtext("Title"), "A & B")
            self.assertEqual(metadata.findtext("Manga"), "YesAndRightToLeft")
            self.assertEqual(metadata.find("Pages/Page").get("Image"), "1")
        pdf = self.task("export", document_id=book["id"], base_revision=book["revision"],
                        path=str(self.root / "edited.pdf"), plugin_id="org.foluma.export.pdf")
        with fitz.open(pdf["path"]) as document:
            self.assertEqual(len(document), 5)
            self.assertEqual([(round(page.rect.width), round(page.rect.height)) for page in document],
                             [(20, 12), (8, 10), (16, 10), (12, 8), (7, 9)])
            self.assertEqual(document.metadata["title"], "A & B")
            self.assertEqual(document.xref_get_key(document.pdf_catalog(), "Lang"), ("string", "ja"))
            self.assertEqual(document.xref_get_key(document.pdf_catalog(), "ViewerPreferences/Direction"), ("name", "/R2L"))
            reference = document[1].get_images()[0][0]
            self.assertEqual(document[2].get_images()[0][0], reference)
            self.assertEqual(document.extract_image(reference)["image"], encoded["pages/2.jpg"])
            crop_pixel = document[1].get_pixmap(alpha=False).pixel(4, 5)
            self.assertGreater(crop_pixel[1], 200)
            self.assertLess(crop_pixel[0], 40)
            self.assertEqual(set(document[4].get_pixmap(alpha=False).samples), {255})
            with Image.frombytes("RGB", (12, 8), document[3].get_pixmap(alpha=False).samples) as image:
                pixel = image.getpixel((6, 4))
                self.assertTrue(all(abs(actual - expected) <= 2 for actual, expected in zip(pixel, (127, 227, 127))), pixel)
        roundtrip = import_module("plugins.image_archive").handle(
            "import", {"path": comic["path"], "asset_directory": str(self.root / "roundtrip")}, None,
            lambda *_arguments: None)
        self.assertEqual([(page["width"], page["height"]) for page in roundtrip["pages"]],
                         [(20, 12), (8, 10), (16, 10), (12, 8), (7, 9)])
        self.assertEqual(roundtrip["metadata"]["title"], "A & B")
        self.assertEqual(roundtrip["metadata"]["cover_id"], roundtrip["pages"][1]["id"])
        bad_metadata = book["metadata"] | {"title": "Invalid\x00title"}
        invalid = self.engine.call("document.apply", {"document_id": book["id"], "base_revision": book["revision"],
                                                      "changes": {"metadata": bad_metadata}})
        failure = self.task("export", expected_state="failed", document_id=invalid["id"], base_revision=invalid["revision"],
                            path=str(collision), overwrite=True, plugin_id="org.foluma.export.cbz")
        self.assertIn("ComicInfo", str(failure["error"]))
        self.assertEqual(collision.read_bytes(), b"keep existing output")
        self.engine.call("document.undo", {"document_id": invalid["id"], "base_revision": invalid["revision"]})
        self.engine.plugins.remove("org.foluma.export.cbz")
        self.restart()
        book = self.engine.call("project.open", {"path": str(project)})
        with self.assertRaises(ValueError):
            self.engine.call("task.start", {"operation": "export", "document_id": book["id"],
                                           "base_revision": book["revision"], "path": str(self.root / "missing.cbz")})
        self.assertIn("org.foluma.export.pdf", self.engine.plugins.active)

    def test_image_archive_rejects_unsafe_oversized_animated_and_invalid_inputs(self):
        worker = import_module("plugins.image_archive")
        encoded = io.BytesIO()
        Image.new("RGB", (4, 6), "blue").save(encoded, "PNG")
        source = self.root / "bad.cbz"
        def progress(*_arguments):
            return None
        for members, message in (
                ({"../page.png": encoded.getvalue()}, "Unsafe"),
                ({"/page.png": encoded.getvalue()}, "Unsafe"),
                ({"C:/page.png": encoded.getvalue()}, "Unsafe"),
                ({"folder\\page.png": encoded.getvalue()}, "Unsafe"),
                ({"page.PNG": encoded.getvalue(), "page.png": encoded.getvalue()}, "duplicate"),
                ({"readme.txt": b"no images"}, "no supported images"),
                ({"page.png": encoded.getvalue(), "ComicInfo.xml": b"<broken>"}, "Invalid ComicInfo"),
                ({"page.png": encoded.getvalue(), "ComicInfo.xml":
                  '<!DOCTYPE ComicInfo [<!ENTITY bomb "boom">]><ComicInfo><Title>&bomb;</Title></ComicInfo>'.encode("utf-16")},
                 "document types"),
                ({"page.png": encoded.getvalue(), "ComicInfo.xml":
                  b'<ComicInfo><Pages><Page Image="8" Type="FrontCover"/></Pages></ComicInfo>'}, "cover page")):
            with self.subTest(message=message, members=list(members)):
                with ZipFile(source, "w") as archive:
                    for name, payload in members.items():
                        archive.writestr(name, payload)
                with self.assertRaisesRegex(ValueError, message):
                    worker.handle("import", {"path": str(source), "asset_directory": str(self.profile / "assets")}, None, progress)
        link = ZipInfo("page.png")
        link.external_attr = 0o120777 << 16
        with ZipFile(source, "w") as archive:
            archive.writestr(link, b"/some/other/file.png")
        with self.assertRaisesRegex(ValueError, "Unsafe"):
            worker.handle("import", {"path": str(source), "asset_directory": str(self.profile / "assets")}, None, progress)
        with ZipFile(source, "w") as archive:
            archive.writestr("page.png", encoded.getvalue())
        huge = ZipInfo("page.png")
        huge.file_size = 128_000_001
        for entries, message in (([huge], "128 MB"), ([huge] * 10_001, "10000 entries")):
            with patch.object(worker.ZipFile, "infolist", return_value=entries):
                with self.assertRaisesRegex(ValueError, message):
                    worker.handle("import", {"path": str(source), "asset_directory": str(self.profile / "assets")}, None, progress)
        animated = io.BytesIO()
        Image.new("RGB", (4, 6), "blue").save(animated, "PNG", save_all=True,
                                             append_images=[Image.new("RGB", (4, 6), "red")])
        with ZipFile(source, "w") as archive:
            archive.writestr("page.png", animated.getvalue())
        with self.assertRaisesRegex(ValueError, "Animated"):
            worker.handle("import", {"path": str(source), "asset_directory": str(self.profile / "assets")}, None, progress)

    def test_zip_import_normalizes_exif_without_changing_current_book_on_failure(self):
        self.engine.plugins.install_bundled("org.foluma.import.zip")
        self.restart()
        source = self.root / "rotated.zip"
        encoded = io.BytesIO()
        image = Image.new("RGB", (8, 12), "navy")
        orientation = Image.Exif()
        orientation[274] = 6
        image.save(encoded, "JPEG", exif=orientation)
        palette = Image.new("P", (8, 12), 0)
        palette.putpalette([255, 0, 0, 0, 255, 0] + [0] * 762)
        palette.paste(1, (0, 0, 4, 12))
        transparent = io.BytesIO()
        palette.save(transparent, "PNG", transparency=0, exif=orientation)
        cmyk = io.BytesIO()
        Image.new("CMYK", (8, 12), (0, 255, 255, 0)).save(cmyk, "JPEG")
        with ZipFile(source, "w") as archive:
            archive.writestr("1.jpg", encoded.getvalue())
            archive.writestr("2.png", transparent.getvalue())
            archive.writestr("3.jpg", cmyk.getvalue())
        book = self.task("import", path=str(source))
        asset = book["assets"][book["pages"][0]["asset_id"]]
        self.assertEqual((asset["width"], asset["height"], asset["ext"]), (12, 8, "png"))
        with Image.open(asset["path"]) as normalized:
            self.assertEqual(normalized.getexif().get(274, 1), 1)
        alpha_asset = book["assets"][book["pages"][1]["asset_id"]]
        with Image.open(alpha_asset["path"]) as normalized:
            self.assertEqual(normalized.size, (12, 8))
            self.assertEqual(normalized.mode, "RGBA")
            self.assertEqual(normalized.getchannel("A").getextrema(), (0, 255))
            self.assertEqual(normalized.getpixel((0, 7))[3], 0)
        pages = copy.deepcopy(book["pages"])
        pages[-1]["crop"] = [0.5, 0, 0.5, 1]
        book = self.engine.call("document.apply", {"document_id": book["id"], "base_revision": book["revision"],
                                                   "changes": {"pages": pages}})
        preview = self.engine.call("document.preview", {"document_id": book["id"], "page_id": pages[-1]["id"]})
        with Image.open(self.profile / preview) as image:
            self.assertEqual(image.mode, "RGB")
            self.assertEqual(image.size, (4, 12))
        comic = self.root / "cmyk.cbz"
        import_module("plugins.cbz-export.worker").handle("export", {"path": str(comic)}, book, lambda *_arguments: None)
        with ZipFile(comic) as archive:
            with Image.open(io.BytesIO(archive.read("00003.png"))) as image:
                self.assertEqual(image.mode, "RGB")
                self.assertEqual(image.size, (4, 12))
        pdf = self.root / "cmyk.pdf"
        import_module("plugins.pdf-export.worker").handle("export", {"path": str(pdf)}, book, lambda *_arguments: None)
        with fitz.open(pdf) as document:
            self.assertEqual(len(document), 3)
            self.assertEqual(tuple(document[2].rect), (0, 0, 4, 12))
        before = copy.deepcopy(self.engine.session.book)
        with ZipFile(source, "w") as archive:
            archive.writestr("broken.png", b"not an image")
        self.task("import", expected_state="failed", path=str(source))
        self.assertEqual(self.engine.session.book, before)

    def test_zip_import_is_independent_and_folder_projects_survive_its_removal(self):
        identifier = "org.foluma.import.zip"
        self.assertIn(identifier, {plugin["id"] for plugin in self.engine.plugins.bundled()})
        self.assertNotIn(identifier, self.engine.plugins.active)
        self.engine.plugins.install_bundled(identifier)
        self.assertNotIn("zip", self.engine.plugins.extensions("import"))
        self.restart()
        self.assertNotIn("org.foluma.import.cbz", self.engine.plugins.active)
        incoming = self.root / "incoming"
        incoming.mkdir()
        source = incoming / "Comic.ZIP"
        encoded = {}
        with ZipFile(source, "w") as archive:
            for name, format_name in (("pages/10.webp", "WEBP"), ("pages/2.png", "PNG"), ("pages/1.jpg", "JPEG")):
                output = io.BytesIO()
                Image.new("RGB", (8, 12), "navy").save(output, format_name)
                encoded[name] = output.getvalue()
                archive.writestr(name, encoded[name])
            archive.writestr("__MACOSX/._1.jpg", b"ignored")
        self.assertEqual(self.engine.plugins.format("import", str(source))["id"], identifier)
        self.engine.call("series.create", {"parent": str(self.root), "name": "ZIP books"})
        state = self.engine.call("series.add", {"paths": [str(incoming)]})
        self.assertEqual(len(state["items"]), 1)
        entry = state["items"][0]
        book = self.task("series.open", entry_id=entry["id"])
        self.assertEqual(book["metadata"]["title"], "Comic")
        self.assertEqual([book["assets"][page["asset_id"]]["member"] for page in book["pages"]],
                         ["pages/1.jpg", "pages/2.png", "pages/10.webp"])
        self.assertEqual(Path(book["assets"][book["pages"][0]["asset_id"]]["path"]).read_bytes(), encoded["pages/1.jpg"])
        self.engine.plugins.install_bundled("org.foluma.import.cbz")
        self.restart()
        self.assertEqual(self.engine.plugins.format("import", str(source))["id"], identifier)
        self.assertEqual(self.engine.plugins.format("import", "comic.cbz")["id"], "org.foluma.import.cbz")
        self.engine.plugins.set_enabled(identifier, False)
        self.assertEqual(self.engine.plugins.format("import", str(source))["id"], identifier)
        self.restart()
        self.assertEqual(self.engine.plugins.extensions("import"), ["cbz", "pdf"])
        with self.assertRaises(ValueError):
            self.engine.call("task.start", {"operation": "import", "path": str(source)})
        self.engine.plugins.remove(identifier)
        source.unlink()
        Path(entry["path"]).unlink()
        self.restart()
        self.assertNotIn(identifier, {plugin["id"] for plugin in self.engine.plugins.list()["items"]})
        self.engine.call("series.open_project", {"path": state["directory"]})
        book = self.task("series.open", entry_id=entry["id"])
        self.assertEqual(len(book["pages"]), 3)
        preview = self.engine.call("document.preview", {"document_id": book["id"], "page_id": book["pages"][0]["id"]})
        self.assertTrue((self.profile / preview).is_file())
        result = self.task("export", document_id=book["id"], base_revision=book["revision"],
                           path=str(self.root / "saved.epub"))
        self.assertEqual(result["total"], 3)

    def test_defaults_are_independent_removable_and_never_silently_restored(self):
        importer, exporter = "org.foluma.import.pdf", "org.foluma.export.epub"
        self.assertEqual([plugin["id"] for plugin in self.engine.plugins.formats("import")], [importer])
        self.assertEqual([plugin["id"] for plugin in self.engine.plugins.formats("export")], [exporter])
        book = self.task("import", path=str(self.pdf))
        self.assertTrue(all(asset["kind"] == "file" for asset in book["assets"].values()))
        project = self.root / "saved.mteproj"
        save_project(self.engine.session.book, project)
        self.engine.plugins.set_enabled(importer, False)
        self.restart()
        self.assertFalse(self.engine.plugins.formats("import"))
        with self.assertRaises(ValueError) as missing:
            self.engine.call("task.start", {"operation": "import", "path": str(self.pdf)})
        self.assertEqual(missing.exception.data["kind"], "format_plugin_required")
        self.engine.plugins.remove(importer)
        self.pdf.unlink()
        self.restart()
        reopened = self.engine.call("project.open", {"path": str(project)})
        preview = self.engine.call("document.preview", {"document_id": reopened["id"], "page_id": reopened["pages"][0]["id"]})
        self.assertTrue((self.profile / preview).is_file())
        output = self.task("export", document_id=reopened["id"], base_revision=reopened["revision"], path=str(self.root / "book.epub"))
        self.assertTrue(Path(output["path"]).is_file())
        self.engine.plugins.remove(exporter)
        self.restart()
        self.restart()
        self.assertFalse(self.engine.plugins.formats("import"))
        self.assertFalse(self.engine.plugins.formats("export"))
        reopened = self.engine.call("project.open", {"path": str(project)})
        with self.assertRaises(ValueError):
            self.engine.call("task.start", {"operation": "export", "document_id": reopened["id"],
                                           "base_revision": reopened["revision"], "path": str(self.root / "missing.epub")})
        self.engine.plugins.install_bundled(exporter)
        self.restart()
        self.assertEqual(self.engine.plugins.formats("export")[0]["id"], exporter)
        self.assertFalse(self.engine.plugins.formats("import"))

    def test_legacy_migration_preserves_identity_edits_and_survives_plugin_removal(self):
        book = self.task("import", path=str(self.pdf))
        legacy = copy.deepcopy(self.engine.session.book)
        legacy["revision"] = 7
        legacy["pages"][0]["crop"] = [0.25, 0, 0.75, 1]
        legacy["extensions"] = {"test.editor": {"opaque": [1, 2, 3]}}
        for asset in legacy["assets"].values():
            asset["kind"] = "pdf"
            asset.pop("path")
        project = self.root / "legacy.mteproj"
        save_project(legacy, project)
        original = (project / "project.json").read_bytes()
        invalid = copy.deepcopy(legacy)
        invalid["metadata"]["title"] = "Changed by migration"
        with patch.object(self.engine, "run_worker", return_value=invalid):
            with self.assertRaisesRegex(ValueError, "migration"):
                self.engine.call("project.open", {"path": str(project)})
        self.assertEqual((project / "project.json").read_bytes(), original)
        restored = self.engine.call("project.open", {"path": str(project)})
        self.assertEqual(restored["id"], book["id"])
        self.assertEqual(restored["revision"], 7)
        self.assertEqual(restored["pages"], legacy["pages"])
        self.assertEqual(restored["extensions"], legacy["extensions"])
        self.assertTrue(all(asset["kind"] == "file" for asset in open_project(project)["assets"].values()))
        self.engine.plugins.remove("org.foluma.import.pdf")
        self.restart()
        self.pdf.unlink()
        restored = self.engine.call("project.open", {"path": str(project)})
        self.task("export", document_id=restored["id"], base_revision=7, path=str(self.root / "migrated.epub"))

    def test_other_formats_use_the_same_project_batch_and_atomic_export_paths(self):
        imported = self.task("import", path=str(self.pdf))
        source = self.root / "volume.scan"
        source.write_bytes(b"scan source")
        book = copy.deepcopy(self.engine.session.book)
        book["id"] = new_id()
        book["metadata"]["title"] = "Generic book"
        for record in book["sources"].values():
            record.update(path=str(source), sha256=digest(source))
        importer = self.package("test.import.scan", "import", ["scan"], f"print(json.dumps({{'result': {book!r}}}))\n")
        exporter = self.package("test.export.pages", "export", ["pages"],
                                "Path(request['input']['path']).write_text(request['book']['metadata']['title'] + request['input']['options'].get('suffix',''))\n"
                                "print(json.dumps({'result': {'total': len(request['book']['pages'])}}))\n")
        self.engine.plugins.install(str(importer))
        self.engine.plugins.install(str(exporter))
        self.restart()
        state = self.engine.call("series.create", {"parent": str(self.root), "name": "Collection"})
        state = self.engine.call("series.add", {"paths": [str(source)]})
        opened = self.task("series.open", entry_id=state["items"][0]["id"])
        self.assertEqual(opened["metadata"]["title"], "Generic book")
        output = self.root / "output"
        output.mkdir()
        (output / "Generic book.pages").write_text("keep")
        result = self.task("export", document_id=opened["id"], base_revision=opened["revision"],
                           plugin_id="test.export.pages", directory=str(output), options={"suffix": "!"})
        self.assertEqual(Path(result["path"]).name, "Generic book (2).pages")
        self.assertEqual(Path(result["path"]).read_text(), "Generic book!")
        self.assertEqual((output / "Generic book.pages").read_text(), "keep")
        self.assertEqual(imported["pages"][0]["width"], opened["pages"][0]["width"])
        self.engine.plugins.remove("test.import.scan")
        self.restart()
        self.assertTrue(self.task("series.open", entry_id=state["items"][0]["id"])["pages"])
        self.engine.plugins.set_enabled("org.foluma.import.pdf", False)
        self.restart()
        root = Path(state["directory"])
        (root / "volume.scan").rename(root / "renamed.scan")
        (root / "new.scan").write_bytes(b"another source")
        state = self.engine.call("series.refresh", {})
        self.assertEqual(len(state["items"]), 1)
        self.assertTrue(state["items"][0]["path"].endswith("renamed.scan"))

    def test_manifest_validation_and_core_without_document_codecs(self):
        package = self.package("test.bad.format", "import", ["../pdf"], "print('{}')\n")
        with self.assertRaisesRegex(ValueError, "Invalid format"):
            self.engine.plugins.install(str(package))
        package = self.package("test.duplicate.pdf", "import", ["pdf"], "print('{}')\n")
        self.engine.plugins.install(str(package))
        self.restart()
        with self.assertRaises(ValueError):
            self.engine.plugins.format("import", str(self.pdf))
        self.assertEqual(self.engine.plugins.format("import", str(self.pdf), "org.foluma.import.pdf")["id"], "org.foluma.import.pdf")
        self.assertFalse(Plugins(self.profile, safe=True).formats("import"))
        result = subprocess.check_output([sys.executable, "-c", "import sys,foluma.service,foluma.media; print('pymupdf' in sys.modules)"], text=True)
        self.assertEqual(result.strip(), "False")
