import copy
import io
import json
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch
from zipfile import ZipFile, ZipInfo

import pymupdf as fitz
from foluma.media import RenderRequired, export_epub, import_pdf, load_asset, preview
from foluma.model import Session, new_id
from foluma.plugins import Plugins, platform_id
from foluma.service import Engine
from foluma.storage import open_project, parse_json, save_project
from PIL import Image


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
        self.assertEqual([a["kind"] for a in book["assets"].values()], ["file", "file", "pdf"])
        self.assertEqual(book["pages"][-1]["kind"], "blank")

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
        self.assertEqual(restored, session.book)
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
        self.assertFalse(Plugins(directory).active)
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
        with patch("foluma.service.worker_command", return_value=[sys.executable, "-c", "import time;time.sleep(10)"]):
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
            while not engine.processes and time.monotonic() < deadline:
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
        self.assertEqual(len(list((project / "assets").iterdir())), 1)
        source.unlink()
        export_epub(open_project(project), str(self.root / "embedded.epub"))
        asset_id = next(key for key, asset in engine.session.book["assets"].items() if asset["kind"] == "file")
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
        engine.call("series.review", {"id": one, "reviewed": True})
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
            if job["state"] != "running":
                return job
            time.sleep(0.02)
        self.fail("job did not finish")


if __name__ == "__main__":
    unittest.main()
