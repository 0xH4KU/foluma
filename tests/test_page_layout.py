import copy
import io
import json
import subprocess
import sys
import tempfile
import time
import unittest
from importlib import import_module
from pathlib import Path
from unittest.mock import patch
from zipfile import ZipFile, ZipInfo

import pymupdf as fitz
from foluma.media import import_images, load_asset, page_image
from foluma.model import Session, new_id
from foluma.plugins import platform_id
from foluma.service import Engine
from foluma.storage import open_project, save_project
from PIL import Image, ImageChops, ImageDraw

layout = import_module("plugins.page-layout.foluma_page_layout")


class PageLayoutTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        paths = []
        self.frames = [[0.2, 0.1, 0.6, 0.8], [0.2, 0.1, 0.6, 0.8], [0.1, 0.1, 0.75, 0.8]]
        for index, (width, height) in enumerate([(200, 300), (200, 300), (160, 240)]):
            path = self.root / f"source-{index}.png"
            with Image.new("RGB", (width, height), "white") as image:
                frame = self.frames[index]
                left, top = round(frame[0] * width), round(frame[1] * height)
                right, bottom = round((frame[0] + frame[2]) * width) - 1, round((frame[1] + frame[3]) * height) - 1
                draw = ImageDraw.Draw(image)
                draw.rectangle((left, top, right, bottom), outline="black", width=2)
                draw.line((left, top, right, bottom), fill="navy", width=2)
                draw.ellipse((left + 15, top + 15, left + 35, top + 30), outline="black")
                image.save(path)
            paths.append(str(path))
        imported = import_images(paths, self.root / "assets")
        self.book = {"schema": 1, "id": new_id(), "revision": 0, **imported, "sources": {}, "extensions": {},
                     "metadata": {"title": "Comic", "author": "", "language": "ja", "direction": "rtl",
                                  "cover_id": imported["pages"][0]["id"], "cover_only": False}}
        self.original = copy.deepcopy(self.book)
        self.progress = lambda *_: None

    def adjustment(self, index=1, **changes):
        return copy.deepcopy(layout.DEFAULT_SETTINGS) | {"frame": self.frames[index], "height": 80} | changes

    def run_layout(self, book, action="apply", **params):
        return layout.handle("plugin", {"action": action, "asset_directory": str(self.root / "generated"), **params},
                             book, self.progress)

    def install_tool(self):
        repository = Path(__file__).resolve().parents[1]
        package = self.root / "tool.mte-plugin"
        worker = ZipInfo("worker")
        worker.external_attr = 0o100755 << 16
        with ZipFile(package, "w") as archive:
            archive.writestr("manifest.json", json.dumps({
                "id": layout.PLUGIN_ID, "name": "Advanced page editor", "version": "0.1.0", "api_version": 1,
                "platforms": [platform_id()], "workers": {platform_id(): "worker"},
            }))
            archive.writestr(worker, f"#!{sys.executable}\nimport runpy, sys\n"
                             f"sys.path[:0] = [{str(repository / 'engine')!r}, {str(repository / 'plugins/page-layout')!r}]\n"
                             f"runpy.run_path({str(repository / 'plugins/page-layout/worker.py')!r}, run_name='__main__')\n")
        profile = self.root / "profile"
        initial = Engine(profile)
        initial.plugins.install(str(package))
        initial.close()
        self.engine = Engine(profile)
        self.addCleanup(self.engine.close)
        self.engine.session = Session(self.book)
        return self.engine

    def task(self, action, expected="completed", **params):
        reference = {"document_id": self.engine.session.book["id"], "base_revision": self.engine.session.book["revision"]}
        job = self.engine.call("task.start", {"operation": "plugin", "plugin_id": layout.PLUGIN_ID, **reference,
                                              "input": {"action": action, **params}})
        deadline = time.monotonic() + 15
        while job["state"] in ("queued", "running") and time.monotonic() < deadline:
            time.sleep(0.01)
            job = self.engine.call("task.get", {"id": job["id"]})
        self.assertEqual(job["state"], expected, job)
        return job["result"] if expected == "completed" else job

    def test_individual_frames_align_equally_and_originals_survive_history_save_and_plugin_removal(self):
        engine = self.install_tool()
        ids = [page["id"] for page in self.book["pages"]]
        inspected = self.task("inspect", page_ids=ids[1:])
        self.assertEqual(inspected[ids[1]]["width"], 200)
        self.assertEqual(inspected[ids[2]]["height"], 240)
        self.assertEqual(engine.session.book, self.original)
        self.assertFalse(engine.session.undo_stack, "inspection must not create edits or invalidate review")
        edits = {ids[index]: self.adjustment(index) for index in (1, 2)}
        self.assertEqual(self.task("check", canvas=[200, 300], edits=edits), {"clipped": []})
        adjusted = self.task("apply", canvas=[200, 300], edits=edits, reference_id=ids[1])
        self.assertEqual([page["id"] for page in adjusted["pages"]], ids)
        self.assertEqual(adjusted["extensions"][layout.PLUGIN_ID]["reference"]["page_id"], ids[1])
        bounds = []
        for index in (1, 2):
            with page_image(adjusted, adjusted["pages"][index]) as image, Image.new("RGB", image.size, "white") as white:
                self.assertEqual(image.size, (200, 300))
                with ImageChops.difference(image, white) as difference, difference.convert("L") as grayscale:
                    with grayscale.point(lambda value: 255 if value > 64 else 0) as ink:
                        bounds.append(ink.getbbox())
            self.assertEqual(load_asset(adjusted, self.original["pages"][index]["asset_id"]),
                             load_asset(self.original, self.original["pages"][index]["asset_id"]))
        self.assertAlmostEqual(bounds[0][3] - bounds[0][1], bounds[1][3] - bounds[1][1], delta=2)
        self.assertLess(bounds[0][0], 10, "right page leaves its inner edge near the spine")
        self.assertGreater(bounds[1][0], 30, "left page leaves spare space at its outer edge")
        undo = engine.call("document.undo", {"document_id": self.book["id"]})
        self.assertEqual(undo["pages"], self.original["pages"])
        redo = engine.call("document.redo", {"document_id": self.book["id"]})
        self.assertEqual(redo["pages"], adjusted["pages"])
        project = self.root / "layout.mteproj"
        save_project(engine.session.book, project)
        engine.plugins.remove(layout.PLUGIN_ID)
        engine.close()
        engine = Engine(self.root / "profile")
        self.addCleanup(engine.close)
        reopened = engine.call("project.open", {"path": str(project)})
        self.assertNotIn(layout.PLUGIN_ID, engine.plugins.active)
        with page_image(reopened, reopened["pages"][1]) as image:
            self.assertEqual(image.size, (200, 300))
        self.assertEqual(open_project(project)["extensions"][layout.PLUGIN_ID], redo["extensions"][layout.PLUGIN_ID])

    def test_repeated_adjustments_render_from_the_source_and_reset_keeps_page_order(self):
        page = self.book["pages"][1]
        session = Session(self.book)
        parameters = {"canvas": [200, 300], "edits": {page["id"]: self.adjustment()}}
        first = self.run_layout(session.book, **parameters)
        session.apply(self.book["id"], 0, first["changes"], assets=first["assets"])
        first_bytes = load_asset(session.book, session.book["pages"][1]["asset_id"])
        tilted = self.run_layout(session.book, canvas=[200, 300], edits={page["id"]: self.adjustment(angle=2)})
        session.apply(self.book["id"], session.book["revision"], tilted["changes"], assets=tilted["assets"])
        again = self.run_layout(session.book, **parameters)
        session.apply(self.book["id"], session.book["revision"], again["changes"], assets=again["assets"])
        self.assertEqual(load_asset(session.book, session.book["pages"][1]["asset_id"]), first_bytes)
        externally_edited = copy.deepcopy(session.book["pages"])
        externally_edited[1]["rotation"] = 90
        session.apply(self.book["id"], session.book["revision"], {"pages": externally_edited})
        with self.assertRaisesRegex(ValueError, "changed in another editor"):
            self.run_layout(session.book, "inspect", page_ids=[page["id"]])
        session.apply(self.book["id"], session.book["revision"], {"pages": list(reversed(session.book["pages"]))})
        restored = self.run_layout(session.book, "reset", page_ids=[page["id"]])
        session.apply(self.book["id"], session.book["revision"], restored["changes"])
        self.assertEqual(session.book["pages"][1], self.original["pages"][1])
        self.assertEqual([page["id"] for page in session.book["pages"]], [page["id"] for page in reversed(self.original["pages"])])

    def test_clipping_requires_confirmation_and_frame_bounds_are_not_content_crop_bounds(self):
        page = self.book["pages"][1]
        asset = self.book["assets"][page["asset_id"]]
        with Image.open(asset["path"]) as image:
            draw = ImageDraw.Draw(image)
            draw.rectangle((165, 80, 178, 95), fill="black")
            image.save(asset["path"])
        parameters = {"canvas": [200, 300], "edits": {page["id"]: self.adjustment()}}
        result = self.run_layout(self.book, "check", **parameters)
        self.assertEqual(result["result"]["clipped"], [])
        applied = self.run_layout(self.book, **parameters)
        candidate = copy.deepcopy(self.book)
        candidate["assets"].update(applied["assets"])
        candidate["pages"] = applied["changes"]["pages"]
        with page_image(candidate, candidate["pages"][1]) as image:
            self.assertEqual(image.getpixel((135, 85)), (0, 0, 0), "the balloon outside the frame survives")
        bad = {"canvas": [200, 300], "edits": {page["id"]: self.adjustment(offset_x=-30)}}
        self.assertEqual(self.run_layout(self.book, "check", **bad)["result"]["clipped"], [page["id"]])
        with self.assertRaisesRegex(ValueError, "content extends"):
            self.run_layout(self.book, **bad)
        self.run_layout(self.book, allow_clipping=True, **bad)

    def test_stale_or_invalid_worker_results_leave_assets_pages_and_history_untouched(self):
        engine = self.install_tool()
        page = self.book["pages"][1]
        result = self.run_layout(self.book, canvas=[200, 300], edits={page["id"]: self.adjustment()})
        overwrite = copy.deepcopy(result)
        overwrite["assets"][page["asset_id"]] = next(iter(result["assets"].values()))
        with patch.object(engine, "run_worker", return_value=overwrite):
            self.task("apply", expected="failed")
        self.assertEqual(engine.session.book, self.original)
        self.assertFalse(engine.session.undo_stack)
        malformed = copy.deepcopy(result)
        malformed["changes"]["pages"][1]["crop"] = [-1, 0, 1, 1]
        with patch.object(engine, "run_worker", return_value=malformed):
            self.task("apply", expected="failed")
        self.assertEqual(engine.session.book, self.original)

        def changed_during_work(*_args, **_kwargs):
            engine.session.apply(self.book["id"], 0, {"metadata": {"title": "New title"}})
            return result

        with patch.object(engine, "run_worker", side_effect=changed_during_work):
            self.task("apply", expected="failed")
        self.assertEqual(engine.session.book["pages"], self.original["pages"])
        self.assertEqual(engine.session.book["assets"], self.original["assets"])
        self.assertEqual(engine.session.book["metadata"]["title"], "New title")

        def cancelled_before_publication(_operation, _params, job):
            engine.cancel(job)
            return result

        before_cancel = copy.deepcopy(engine.session.book)
        with patch.object(engine, "run_worker", side_effect=cancelled_before_publication):
            self.task("apply", expected="cancelled")
        self.assertEqual(engine.session.book, before_cancel)

    def test_normalized_pages_export_through_each_independent_format(self):
        engine = self.install_tool()
        for identifier in ("org.foluma.export.pdf", "org.foluma.export.cbz"):
            engine.plugins.install_bundled(identifier)
        engine.close()
        engine = self.engine = Engine(self.root / "profile")
        self.addCleanup(engine.close)
        engine.session = Session(self.book)
        page = self.book["pages"][1]
        adjusted = self.task("apply", canvas=[200, 300], edits={page["id"]: self.adjustment(angle=-2)})
        asset_id = adjusted["pages"][1]["asset_id"]
        expected = load_asset(adjusted, asset_id)
        for extension in ("epub", "cbz", "pdf"):
            destination = self.root / f"adjusted.{extension}"
            job = engine.call("task.start", {"operation": "export", "document_id": adjusted["id"],
                                               "base_revision": adjusted["revision"], "path": str(destination),
                                               "plugin_id": f"org.foluma.export.{extension}"})
            deadline = time.monotonic() + 15
            while job["state"] in ("queued", "running") and time.monotonic() < deadline:
                time.sleep(0.01)
                job = engine.call("task.get", {"id": job["id"]})
            self.assertEqual(job["state"], "completed", job)
            if extension == "pdf":
                with fitz.open(destination) as document:
                    pixmap = document[1].get_pixmap(alpha=False)
                    self.assertEqual((pixmap.width, pixmap.height), (200, 300))
                    with Image.open(io.BytesIO(expected)) as image:
                        self.assertEqual(pixmap.samples, image.tobytes())
            else:
                with ZipFile(destination) as archive:
                    self.assertIsNone(archive.testzip())
                    member = f"EPUB/images/{asset_id}.png" if extension == "epub" else "00002.png"
                    self.assertEqual(archive.read(member), expected)

    def test_worker_protocol_and_numeric_validation(self):
        repository = Path(__file__).resolve().parents[1]
        request = {"operation": "plugin", "input": {"action": "inspect", "page_ids": [self.book["pages"][1]["id"]]},
                   "book": self.book}
        completed = subprocess.run([sys.executable, str(repository / "plugins/page-layout/worker.py")],
                                   input=json.dumps(request), capture_output=True, text=True, check=True, cwd=repository)
        self.assertIn("result", json.loads(completed.stdout.splitlines()[-1]))
        for invalid in (True, "2", float("nan"), 6):
            with self.subTest(angle=invalid), self.assertRaises(ValueError):
                layout.settings(self.adjustment(angle=invalid))
        for invalid in ([True, 300], [200, 0], [200, 10001], [200.5, 300]):
            with self.subTest(canvas=invalid), self.assertRaises(ValueError):
                layout.canvas_size(invalid)
        with self.assertRaises(ValueError):
            layout.settings(self.adjustment(frame=[0.5, 0, 0.6, 1]))

    def test_legacy_tool_input_stays_opaque_and_separate_from_host_generated_image_storage(self):
        engine = self.install_tool()
        input_value = {"action": "legacy", "asset_directory": "custom tool destination", "options": {"level": 1}}

        def legacy_worker(_operation, request, _job):
            self.assertEqual(request["input"], input_value)
            self.assertEqual(request["asset_directory"], str(engine.data / "assets"))
            return {"changes": {"extension": {"id": "org.example.legacy", "data": request["input"]}}}

        with patch.object(engine, "run_worker", side_effect=legacy_worker):
            result = self.task("legacy", asset_directory=input_value["asset_directory"], options=input_value["options"])
        self.assertEqual(result["extensions"]["org.example.legacy"], input_value)
