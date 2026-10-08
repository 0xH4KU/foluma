from __future__ import annotations

import copy
import json
import os
import re
import sys
import tempfile
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile

from . import __version__
from .cache import PreviewCache
from .i18n import messages, t
from .model import EngineError, Session, information_patch, new_id, review_unchanged, validate
from .plugins import Plugins, platform_id, unpack
from .series import FolderProject, Series, preview_inputs
from .storage import atomic_json, contained, copy_asset, digest, link_or_copy, open_project, parse_json, save_project
from .worker import job_info
from .workers import Workers

PROCESSING_DEFAULTS = {"preparse": True, "parse_concurrency": 2, "parallel_export": True, "export_concurrency": 2}


def publish(staged: Path, target: Path, overwrite: bool) -> None:
    if overwrite:
        os.replace(staged, target)
    else:
        link_or_copy(staged, target)
        staged.unlink()


class Engine:
    def __init__(self, data: Path, safe: bool = False, notify=lambda *_: None):
        data.mkdir(parents=True, exist_ok=True)
        self.data = data
        bundled_editor = (
            Path(sys.executable).with_name("editor.mte-plugin")
            if getattr(sys, "frozen", False)
            else Path(__file__).resolve().parents[2] / "build" / "editor.mte-plugin"
        )
        self.plugins = Plugins(data, safe, bundled_editor)
        self.session: Session | None = None
        self.background_sessions: dict[str, Session] = {}
        self.lock = threading.RLock()
        self.jobs: dict[str, dict] = {}
        self.pending: list[tuple[dict, dict, dict | None]] = []
        self.threads: set[threading.Thread] = set()
        self.document_windows: dict[str, str] = {}
        self.preparse_attempted: set[str] = set()
        self.export_targets: set[Path] = set()
        self.closing = False
        self.workers = Workers(data, notify)
        self.cache = PreviewCache(data, self.plugins.config.get("preview_cache_limit"))
        self.notify = notify
        self.series: Series | None = None
        self.series_error = None
        current = data / "series" / "current.json"
        if current.exists():
            try:
                location = parse_json(current.read_text("utf-8"))
                extensions = self.plugins.extensions("import")
                self.series = (
                    FolderProject(data, location["project"], extensions)
                    if "project" in location
                    else Series(data, location["paths"], extensions)
                )
                identifier = self.series.current_id
                if identifier:
                    session = self.series.load(self.series.item(identifier))
                    if session:
                        self.prepare_session(session)
                    self.session = session
            except (OSError, ValueError, KeyError, TypeError) as error:
                self.series_error = str(error)
        with self.lock:
            self.schedule_preparse()

    def processing(self) -> dict:
        stored = self.plugins.config.get("processing", {})
        if not isinstance(stored, dict):
            return dict(PROCESSING_DEFAULTS)
        return {key: stored[key] if key in stored and type(stored[key]) is type(default)
                and (type(default) is bool or 1 <= stored[key] <= 8) else default
                for key, default in PROCESSING_DEFAULTS.items()}

    def configure_processing(self, params: dict) -> dict:
        settings = self.processing() | params
        if (set(params) - PROCESSING_DEFAULTS.keys()
                or any(type(settings[key]) is not bool for key in ("preparse", "parallel_export"))
                or any(type(settings[key]) is not int or not 1 <= settings[key] <= 8
                       for key in ("parse_concurrency", "export_concurrency"))):
            raise ValueError(t("Choose a concurrency between 1 and 8"))
        config = self.plugins.config | {"processing": settings}
        atomic_json(self.plugins.config_path, config)
        self.plugins.config = config
        if not settings["preparse"]:
            self.cancel_preparse()
        else:
            self.schedule_preparse()
        self.dispatch()
        self.notify("processing.changed", settings)
        return settings

    def epub_canvas(self, params: dict | None = None) -> list[int]:
        size = params.get("size") if params is not None else self.plugins.config.get("epub_canvas", [1750, 2480])
        if (not isinstance(size, list) or len(size) != 2
                or any(type(value) is not int or not 1 <= value <= 10000 for value in size)):
            if params is None:
                return [1750, 2480]
            raise ValueError(t("EPUB page dimensions must be whole numbers between 1 and 10000"))
        if params is not None:
            config = self.plugins.config | {"epub_canvas": list(size)}
            atomic_json(self.plugins.config_path, config)
            self.plugins.config = config
        return list(size)

    def cancel(self, job: dict) -> None:
        if job["state"] not in ("queued", "running"):
            return
        self.workers.cancel(job)
        if job["state"] == "queued":
            job.update(state="cancelled", error={"message": t("Task cancelled"), "data": None})
            self.notify("task.changed", job_info(job))

    def cancel_preparse(self) -> None:
        for job in self.jobs.values():
            if job.get("preparse") and not job.get("_retain"):
                self.cancel(job)
        self.pending = [item for item in self.pending if item[0]["state"] == "queued"]
        self.preparse_attempted.clear()

    def schedule_preparse(self) -> None:
        if self.closing or not self.series or not self.series.managed or not self.processing()["preparse"]:
            return
        for entry in self.series.state["items"]:
            if (entry.get("removed") or entry.get("changed") or entry["id"] in self.preparse_attempted
                    or (self.series.project(entry) / "project.json").is_file() or not Path(entry["path"]).is_file()):
                continue
            self.preparse_attempted.add(entry["id"])
            try:
                self.start({"operation": "series.open", "entry_id": entry["id"], "background": True,
                            "preparse": True, "render": True, "dpi": "auto"})
            except (OSError, ValueError):
                # A disabled importer must not prevent opening the rest of the project.
                continue

    def dispatch(self) -> None:
        if self.closing:
            return
        settings = self.processing()
        limits = {"parse": settings["parse_concurrency"], "foreground": 1,
                  "export": settings["export_concurrency"] if settings["parallel_export"] else 1}
        running = {lane: sum(job["state"] == "running" and job.get("_lane") == lane
                             for job in self.jobs.values()) for lane in limits}
        # ponytail: scan the local queue; use a priority heap if projects have thousands of books.
        self.pending.sort(key=lambda item: bool(item[0].get("preparse") and not item[0].get("_retain")))
        for item in self.pending[:]:
            job, params, book = item
            if job["state"] != "queued":
                self.pending.remove(item)
                continue
            lane = job["_lane"]
            if running[lane] >= limits[lane]:
                continue
            if job.get("entry_id") and any(other["state"] == "running" and other.get("entry_id") == job["entry_id"]
                                           and other.get("_series") is job["_series"] for other in self.jobs.values()):
                continue
            self.pending.remove(item)
            job["state"] = "running"
            running[lane] += 1
            self.notify("task.changed", job_info(job))
            thread = threading.Thread(target=self.execute, args=(job, params, book), daemon=True)
            self.threads.add(thread)
            thread.start()

    def session_for_entry(self, entry: dict) -> Session | None:
        identifier = entry.get("document_id")
        return (self.session if self.session and self.session.book["id"] == identifier
                else self.background_sessions.get(identifier))

    def release_document(self, identifier: str) -> None:
        if identifier not in self.document_windows.values():
            self.background_sessions.pop(identifier, None)

    def document(self, params: dict, revision: bool = False) -> Session:
        session = (
            self.session
            if self.session and self.session.book["id"] == params.get("document_id")
            else self.background_sessions.get(params.get("document_id"), self.session)
        )
        if not session:
            raise ValueError(t("Open a book first"))
        session.check(params["document_id"], params["base_revision"] if revision else None)
        self.prepare_session(session)
        return session

    def adopt_import(self, book: dict) -> dict:
        validate(book)
        if any(asset["kind"] != "file" for asset in book["assets"].values()):
            raise ValueError(t("Import plugins must save page images as project-independent files"))
        for asset in book["assets"].values():
            asset["path"] = str(
                copy_asset(Path(asset["path"]).resolve(strict=True), self.data / "assets", asset["ext"])
            )
        return book

    def prepare_session(self, session: Session, job: dict | None = None) -> None:
        legacy = next((asset for asset in session.book["assets"].values() if asset["kind"] != "file"), None)
        if legacy is None:
            return
        source = session.book["sources"][legacy["source_id"]]
        candidate = self.run_worker("materialize", {"path": source["path"], "book": session.book}, job)
        if candidate | {"assets": session.book["assets"]} != session.book:
            raise ValueError(t("Project migration must preserve pages, metadata and document identity"))
        candidate = self.adopt_import(candidate)
        if job and job["cancelled"]:
            raise EngineError(t("Task cancelled"))
        if session.project_path:
            save_project(candidate, Path(session.project_path))
            candidate = open_project(Path(session.project_path))
        session.book = candidate
        for snapshot in session.undo_stack + session.redo_stack:
            for identifier, asset in candidate["assets"].items():
                if identifier in snapshot["assets"]:
                    snapshot["assets"][identifier] = copy.deepcopy(asset)

    def changed(self, session: Session | None = None, preserve_review=False) -> dict:
        session = session or self.session
        item = self.series.current(session) if self.series else None
        if item and session.saved_revision != session.book["revision"]:
            try:
                self.series.remember(item, session, preserve_review)
                self.series_changed()
            except Exception:
                self.notify("document.changed", session.snapshot())
                raise
        snapshot = session.snapshot()
        self.notify("document.changed", snapshot)
        return snapshot

    def series_changed(self) -> dict | None:
        snapshot = self.series.snapshot() if self.series else None
        self.notify("series.changed", snapshot)
        return snapshot

    def call(self, method: str, p: dict):
        messages.set(self.plugins.locale()["messages"])
        if self.closing:
            raise ValueError(t("Foluma is closing"))
        if not isinstance(p, dict):
            raise ValueError(t("Parameters must be an object"))
        if method == "document.preview":
            with self.lock:
                book = copy.deepcopy(self.document(p).book)
            size = p.get("size", 320)
            return self.cache.preview(
                book,
                p["page_id"],
                size,
                lambda: self.run_worker("preview", {"book": book, "page_id": p["page_id"], "size": size}),
            )
        if method == "plugins.catalog":
            return self.plugins.catalog()
        if method == "plugins.install_official":
            with self.lock:
                return self.plugins.install_official(p["id"])
        with self.lock:
            if method == "app.info":
                return {
                    "version": __version__,
                    "platform": platform_id(),
                    "plugins": self.plugins.list(),
                    "document": self.session.snapshot() if self.session else None,
                    "locale": self.plugins.locale(),
                    "series": self.series.snapshot() if self.series else None,
                    "series_error": self.series_error,
                    "processing": self.processing(),
                    "tasks": [job_info(job) | {"result": None} for job in self.jobs.values()],
                }
            if method == "processing.get":
                return self.processing()
            if method == "processing.configure":
                return self.configure_processing(p)
            if method == "epub.canvas.get":
                return self.epub_canvas()
            if method == "epub.canvas.configure":
                return self.epub_canvas(p)
            if method == "app.locale":
                return self.plugins.set_locale(p["code"]) if "code" in p else self.plugins.locale()
            if method in ("storage.info", "storage.configure", "storage.clear"):
                return self.storage_call(method, p)
            if method == "app.safe_mode":
                self.plugins.config["safe_next_start"] = True
                atomic_json(self.plugins.config_path, self.plugins.config)
                return True
            if method.startswith(("document.", "project.")):
                return self.document_call(method, p)
            if method.startswith("series."):
                return self.series_call(method, p)
            if method == "task.start":
                return self.start(p)
            if method == "task.cancel":
                job = self.jobs[p["id"]]
                self.cancel(job)
                self.dispatch()
                return True
            if method == "task.list":
                return [job_info(job) | {"result": None} for job in self.jobs.values()]
            if method == "task.get":
                return job_info(self.jobs[p["id"]])
            if method.startswith("plugins."):
                return self.plugin_call(method, p)
            if method in ("bundle.write", "bundle.read"):
                return self.bundle(method, p)
            raise ValueError(t("Unsupported operation: {0}", method))

    def document_call(self, method: str, p: dict):
        if method == "document.get":
            return self.document(p).snapshot() if p.get("document_id") else self.session.snapshot() if self.session else None
        if method == "document.retain":
            window = p.get("window_id")
            if not isinstance(window, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,256}", window):
                raise ValueError(t("Invalid window ID"))
            identifier = p.get("document_id")
            if (self.series and identifier not in self.background_sessions
                    and (not self.session or self.session.book["id"] != identifier)):
                entry = next((item for item in self.series.state["items"]
                              if item["document_id"] == identifier and not item.get("removed")), None)
                if entry:
                    loaded = self.series.load(entry)
                    if loaded:
                        self.background_sessions[identifier] = loaded
            session = self.document(p)
            self.document_windows[window] = session.book["id"]
            return session.snapshot()
        if method == "document.release_window":
            identifier = self.document_windows.pop(p["window_id"], None)
            if identifier:
                self.release_document(identifier)
            return True
        if method == "document.apply":
            session = self.document(p, True)
            before = session.book
            session.apply(p["document_id"], p["base_revision"], p["changes"])
            return self.changed(session, review_unchanged(before, session.book))
        if method in ("document.undo", "document.redo"):
            session = self.document(p)
            before = session.book
            session.history(p["document_id"], method.endswith("redo"))
            return self.changed(session, review_unchanged(before, session.book))
        if method == "document.release":
            if p.get("window_id"):
                self.document_windows.pop(p["window_id"], None)
            self.release_document(p["document_id"])
            return True
        if method == "project.open":
            if (Path(p["path"]) / ".foluma/project.json").is_file():
                return self.series_call("series.open_project", p)
            session = Session(open_project(Path(p["path"])), p["path"])
            self.prepare_session(session)
            if self.session and self.session.book["id"] in self.document_windows.values():
                self.background_sessions[self.session.book["id"]] = self.session
            self.session = session
            self.notify("document.activated", session.snapshot())
            return self.changed()
        if method == "project.save":
            session = self.document(p, True)
            path = Path(p["path"]).resolve()
            save_project(session.book, path)
            session.project_path = str(path)
            session.saved_revision = session.book["revision"]
            return self.changed(session)
        if method == "project.relink":
            session = self.document(p, True)
            item = self.series.current(session) if self.series else None
            if item and self.series.managed:
                return self.series_call("series.relink", {"id": item["id"], "path": p["path"]})
            source = session.book["sources"][p["source_id"]]
            path = Path(p["path"]).resolve(strict=True)
            if digest(path) != source["sha256"]:
                raise ValueError(t("The file differs from the original source and cannot be relinked"))
            source["path"] = str(path)
            # Source locations are identity-preserving maintenance, not an undoable edit.
            for snapshot in session.undo_stack + session.redo_stack:
                snapshot["sources"][p["source_id"]]["path"] = str(path)
            session.book["revision"] += 1
            return self.changed(session)
        raise ValueError(t("Unsupported operation: {0}", method))

    def storage_call(self, method: str, p: dict) -> dict:
        if method == "storage.configure":
            limit = p.get("limit")
            if type(limit) is not int or not 1_000_000_000 <= limit <= 1_000_000_000_000:
                raise ValueError(t("Enter a cache limit between 1 and 1000 GB"))
            config = self.plugins.config | {"preview_cache_limit": limit}
            atomic_json(self.plugins.config_path, config)
            self.plugins.config = config
            self.cache.limit = limit
        result = self.cache.info(clear=method == "storage.clear")
        self.cache.maintain()
        return result

    def plugin_call(self, method: str, p: dict):
        if method == "plugins.list":
            return self.plugins.list()
        if method == "plugins.bundled":
            return self.plugins.bundled()
        if method == "plugins.install_bundled":
            return self.plugins.install_bundled(p["id"])
        if method == "plugins.inspect":
            return self.plugins.inspect(p["path"])
        if method == "plugins.install":
            return self.plugins.install(p["path"])
        if method == "plugins.set_enabled":
            return self.plugins.set_enabled(p["id"], p["enabled"])
        if method == "plugins.remove":
            return self.plugins.remove(p["id"])
        raise ValueError(t("Unsupported operation: {0}", method))

    def series_call(self, method: str, p: dict):
        if method == "series.get":
            return self.series.snapshot() if self.series else None
        if method not in ("series.preview", "series.review", "series.output", "series.configure"):
            if any(job["state"] in ("queued", "running") and not job.get("cancelled")
                   and (not job.get("preparse") or job.get("_retain"))
                   for job in self.jobs.values()):
                raise ValueError(t("Complete or cancel the current background task first"))
            if self.document_windows and method in ("series.close", "series.create", "series.open_project",
                                                    "series.scan", "series.migrate"):
                raise ValueError(t("Close book windows before switching projects"))
            if self.series and method in ("series.remove", "series.delete", "series.relink"):
                ids = p.get("ids", [p.get("id")])
                if any(item["id"] in ids and item["document_id"] in self.document_windows.values()
                       for item in self.series.state["items"]):
                    raise ValueError(t("Close this book's windows before removing or relinking it"))
            self.cancel_preparse()
        if method == "series.preview":
            return preview_inputs(p["paths"], self.plugins.extensions("import"))
        if method == "series.close":
            if self.session and self.session.snapshot()["dirty"] and p.get("discard") is not True:
                raise ValueError(t("Save your changes before continuing?"))
            (self.data / "series/current.json").unlink(missing_ok=True)
            self.series, self.session, self.series_error = None, None, None
            self.background_sessions.clear()
            self.notify("document.activated", None)
            return self.series_changed()
        if method in ("series.create", "series.open_project", "series.migrate"):
            return self.open_series(method, p)
        if method == "series.scan":
            if self.session:
                self.changed()
            self.series = Series(self.data, p["paths"], self.plugins.extensions("import"))
            self.series_error = None
            return self.series_changed()
        if not self.series:
            raise ValueError(t("Open a series folder first"))
        if method == "series.delete_info":
            if not self.series.managed:
                raise ValueError(t("Save this series as a folder project first"))
            return self.series.delete_info(p["ids"])
        if method in (
            "series.add",
            "series.move",
            "series.remove",
            "series.restore",
            "series.delete",
            "series.group",
            "series.delete_group",
            "series.refresh",
            "series.relink",
            "series.reorder",
        ):
            return self.modify_series(method, p)
        if method == "series.review":
            self.series.review(p["id"], p.get("reviewed"), p.get("allow_pending"), self.session)
        elif method == "series.output":
            self.series.set_output(p["directory"])
        elif method == "series.configure":
            results = self.series.configure(p, self.session, lambda book: self.notify("document.changed", book),
                                            self.background_sessions)
            self.series_changed()
            return results
        else:
            raise ValueError(t("Unsupported operation: {0}", method))
        return self.series_changed()

    def open_series(self, method: str, p: dict):
        if self.session:
            self.changed()
        if method == "series.open_project":
            project = FolderProject(self.data, p["path"], self.plugins.extensions("import"))
        else:
            previous = self.series if method == "series.migrate" else None
            if method == "series.migrate" and (not previous or previous.managed):
                raise ValueError(t("Open a legacy series to migrate it"))
            paths, information = p.get("paths", []), {}
            if method == "series.create" and (
                not isinstance(paths, list)
                or not all(isinstance(path, str) for path in paths)
                or not isinstance(p.get("books", []), list)
            ):
                raise ValueError(t("Invalid initial book information"))
            if method == "series.create" and paths:
                preview = preview_inputs(paths, self.plugins.extensions("import"))
                paths = [book["path"] for book in preview["books"]]
                books = p.get("books", [])
                if not isinstance(books, list):
                    raise ValueError(t("Invalid initial book information"))
                for book in books:
                    if not isinstance(book, dict) or book.get("path") not in paths or book["path"] in information:
                        raise ValueError(t("Book information does not match the selected files"))
                    information[book["path"]] = information_patch(book.get("metadata"))
            elif method == "series.create" and p.get("books"):
                raise ValueError(t("Choose book files before applying information"))
            project = FolderProject.create(
                self.data,
                p["parent"],
                p["name"],
                self.plugins.extensions("import"),
                paths=paths if method == "series.create" else None,
                information=information,
            )
            if previous:
                project.import_series(previous)
        current = project.current_id
        session = project.load(project.item(current)) if current else None
        if session:
            self.prepare_session(session)
        project.activate()
        self.series, self.session, self.series_error = project, session, None
        self.background_sessions.clear()
        self.jobs = {key: job for key, job in self.jobs.items()
                     if not job.get("preparse") or job["state"] in ("queued", "running")}
        self.notify("document.activated", session.snapshot() if session else None)
        snapshot = self.series_changed()
        self.schedule_preparse()
        return snapshot

    def modify_series(self, method: str, p: dict):
        if not self.series.managed:
            raise ValueError(t("Save this series as a folder project first"))
        if self.session:
            self.changed()
        summary = None
        if method == "series.add":
            summary = self.series.add(p["paths"], p.get("group", ""))
        elif method == "series.move":
            self.series.move_books(p["ids"], p["group"])
        elif method == "series.remove":
            self.series.remove(p["ids"])
        elif method == "series.restore":
            self.series.restore(p["ids"])
        elif method == "series.delete":
            summary = self.series.delete(p["ids"])
        elif method == "series.group":
            self.series.group(p["name"], p.get("previous"), p.get("ids"))
        elif method == "series.delete_group":
            self.series.delete_group(p["name"])
        elif method == "series.refresh":
            summary = self.series.refresh()
        elif method == "series.relink":
            self.series.relink(p["id"], p["path"])
        elif method == "series.reorder":
            self.series.reorder(p["ids"])
        for session in [*self.background_sessions.values(), *([self.session] if self.session else [])]:
            item = self.series.current(session)
            if item:
                if item.get("removed"):
                    self.release_document(session.book["id"])
                    if session is self.session:
                        self.session = None
                        self.notify("document.activated", None)
                else:
                    self.series.synchronize(item, session)
                    self.notify("document.changed", session.snapshot())
        state = self.series_changed()
        self.schedule_preparse()
        return state | {"summary": summary} if summary is not None else state

    def bundle(self, method: str, p: dict) -> dict:
        """Opaque plugin JSON plus embedded file assets; interpretation belongs to the plugin."""
        session = self.document(p, True)
        target = Path(p["path"]).resolve()
        if method == "bundle.write":
            assets = {key: copy.deepcopy(session.book["assets"][key]) for key in p.get("asset_ids", [])}
            with tempfile.TemporaryDirectory(dir=target.parent) as temp:
                staged = Path(temp) / "bundle.zip"
                with ZipFile(staged, "w", ZIP_DEFLATED) as archive:
                    for key, asset in assets.items():
                        if asset["kind"] != "file":
                            raise ValueError(
                                t("Presets can only embed inserted images; use source page numbers for PDF pages")
                            )
                        member = f"assets/{key}.{asset['ext']}"
                        archive.write(asset["path"], member)
                        asset["path"] = member
                    archive.writestr(
                        "bundle.json",
                        json.dumps(
                            {"schema": 1, "plugin": p["plugin"], "payload": p["payload"], "assets": assets},
                            ensure_ascii=False,
                            allow_nan=False,
                        ),
                    )
                publish(staged, target, bool(p.get("overwrite")))
            return {"path": str(target)}
        with tempfile.TemporaryDirectory(dir=self.data) as temp:
            root = Path(temp)
            unpack(target, root)
            value = parse_json((root / "bundle.json").read_text("utf-8"))
            if value.get("schema") != 1 or value.get("plugin") != p["plugin"]:
                raise ValueError(t("Preset belongs to another plugin or has an incompatible version"))
            paths, keys = [], []
            for key, asset in value.get("assets", {}).items():
                if asset["kind"] != "file":
                    raise ValueError(t("Preset contains unsupported assets"))
                source = contained(root, asset["path"])
                if asset["ext"] not in ("png", "jpg"):
                    raise ValueError(t("Unsupported preset image format"))
                keys.append(key)
                paths.append(str(source))
            imported = self.run_worker("images.import", {"paths": paths}) if paths else {"assets": {}, "pages": []}
            remap = {key: page["asset_id"] for key, page in zip(keys, imported["pages"])}
            candidate = copy.deepcopy(session.book)
            candidate["assets"].update(imported["assets"])
            validate(candidate)
            session.book = candidate
            # Importing unused immutable assets does not alter page state or its revision.
            return {"payload": value["payload"], "asset_ids": remap, "document": self.changed(session)}

    def start(self, p: dict) -> dict:
        p = dict(p)
        operation = p["operation"]
        if operation not in ("import", "series.open", "export", "images.import", "images.export", "plugin"):
            raise ValueError(t("Unsupported background task"))
        book = None
        if operation == "import":
            self.plugins.format("import", p["path"], p.get("plugin_id"))
        elif operation == "export":
            provider = self.plugins.format("export", p.get("path"), p.get("plugin_id"))
            if provider["id"] == "org.foluma.export.epub":
                options = p.get("options", {})
                if not isinstance(options, dict):
                    raise ValueError(t("Format options must be an object"))
                p["options"] = {"viewport": self.epub_canvas()} | options
        if operation == "series.open":
            if not self.series:
                raise ValueError(t("Open a series folder first"))
            item = self.series.item(p["entry_id"])
            if not (self.series.project(item) / "project.json").is_file():
                self.plugins.format("import", item["path"], p.get("plugin_id"))
            if self.session and not p.get("background"):
                self.changed()
            for existing in self.jobs.values():
                if (existing["state"] in ("queued", "running") and not existing.get("cancelled")
                        and existing.get("entry_id") == item["id"] and existing.get("_series") is self.series
                        and (not p.get("render") or existing.get("_render"))):
                    if not p.get("preparse"):
                        existing["_retain"] = True
                    if not p.get("background"):
                        existing["_activate"] = True
                        existing["opening_over"] = (self.session.book["id"], self.session.book["revision"]) if self.session else None
                        if existing["state"] == "queued":
                            existing["_lane"] = "foreground"
                    self.dispatch()
                    return job_info(existing)
            p["_entry"] = item
            p["_series"] = self.series
        elif operation != "import":
            book = copy.deepcopy(self.document(p, True).book)
        job = {
            "id": new_id(),
            "operation": operation,
            "state": "queued",
            "cancelled": False,
            "document_id": book["id"] if book else None,
            "revision": book["revision"] if book else None,
            "progress": {"done": 0, "total": 1, "message": t("Preparing")},
            "result": None,
            "error": None,
            "entry_id": p.get("entry_id"),
            "title": p.get("_entry", {}).get("title") or (book["metadata"]["title"] if book else Path(p.get("path", "")).name),
            "preparse": bool(p.get("preparse")),
            "_retain": not p.get("preparse"),
            "_render": bool(p.get("render")),
            "_activate": operation in ("import", "series.open") and not p.get("background"),
            "_series": self.series,
            "_lane": "export" if operation in ("export", "images.export") else "parse" if p.get("background") else "foreground",
        }
        job["opening_over"] = (self.session.book["id"], self.session.book["revision"]) if self.session else None
        completed = [key for key, value in self.jobs.items()
                     if value["state"] not in ("queued", "running") and (not value.get("preparse") or value.get("_retain"))]
        for key in completed[:-19]:
            if self.jobs[key].get("preparse"):
                self.jobs[key]["result"] = None
            else:
                del self.jobs[key]
        self.jobs[job["id"]] = job
        self.pending.append((job, p, book))
        self.notify("task.changed", job_info(job))
        self.dispatch()
        return job_info(job)

    def run_worker(self, operation: str, params: dict, job: dict | None = None):
        if operation in ("import", "export", "materialize"):
            plugin = self.plugins.format(
                "export" if operation == "export" else "import", params.get("path"), params.get("plugin_id")
            )
            options = params.get("options", {})
            if not isinstance(options, dict):
                raise ValueError(t("Format options must be an object"))
            options = options | {key: params[key] for key in ("render", "dpi") if key in params}
            params = {
                "plugin_id": plugin["id"],
                "operation": operation,
                "input": {"path": params.get("path"), "asset_directory": str(self.data / "assets"), "options": options},
                "book": params.get("book"),
                "messages": self.plugins.locale()["messages"],
            }
            operation = "plugin"
        executable = None
        if operation == "plugin":
            manifest = self.plugins.active.get(params["plugin_id"])
            if not manifest:
                raise ValueError(t("Plugin is not active. Please restart."))
            worker = manifest.get("workers", {}).get(platform_id())
            if not worker:
                raise ValueError(t("Plugin has no worker for this platform"))
            executable = contained(self.plugins.directory(manifest["id"], manifest["version"]), worker)
        return self.workers.run(operation, params, self.plugins.locale()["messages"], job, executable)

    def export_job(self, job: dict, p: dict, book: dict) -> dict:
        operation = job["operation"]
        overwrite = bool(p.get("overwrite")) and "directory" not in p
        provider = self.plugins.format("export", p.get("path"), p.get("plugin_id")) if operation == "export" else None
        expected = (
            (Path(p["path"]).suffix.lower() if p.get("path") else f".{provider['format']['extensions'][0]}")
            if provider
            else ".zip"
        )
        with self.lock:
            if "directory" in p:
                directory = Path(p["directory"]).resolve(strict=True)
                if not directory.is_dir():
                    raise ValueError(t("Choose an output folder"))
                stem = re.sub(r'[\x00-\x1f<>:"/\\|?*]', "_", book["metadata"]["title"]).strip().rstrip(". ")[:120] or "book"
                if stem.upper().split(".")[0] in {
                    "CON", "PRN", "AUX", "NUL", *[f"COM{i}" for i in range(1, 10)], *[f"LPT{i}" for i in range(1, 10)],
                }:
                    stem = f"book-{stem}"
                target = directory / f"{stem}{expected}"
                number = 2
                while target.exists() or target in self.export_targets:
                    target = directory / f"{stem} ({number}){expected}"
                    number += 1
            else:
                target = Path(p["path"]).resolve()
            if target.suffix.lower() != expected:
                raise ValueError(t("Output file must use the {0} extension", expected))
            protected = {Path(s["path"]).resolve() for s in book["sources"].values()}
            protected.update(Path(a["path"]).resolve() for a in book["assets"].values() if a["kind"] == "file")
            if target in protected:
                raise ValueError(t("Source files cannot be overwritten"))
            if target in self.export_targets or target.exists() and not overwrite:
                raise ValueError(t("Destination exists. Choose another name or confirm overwriting."))
            self.export_targets.add(target)
        try:
            with tempfile.TemporaryDirectory(prefix=".foluma-", dir=target.parent) as temp:
                staged = Path(temp) / target.name
                args = {"book": book, "path": str(staged)}
                if operation == "export" and any(page.get("rotation") for page in book["pages"]):
                    args["book"] = self.run_worker("images.prepare_export", {"book": book, "directory": str(Path(temp) / "rotated")}, job)
                if provider:
                    args.update(plugin_id=provider["id"], options=p.get("options", {}))
                if operation == "images.export":
                    args["page_ids"] = p["page_ids"]
                result = self.run_worker(operation, args, job)
                with self.lock:
                    if job["cancelled"]:
                        raise EngineError(t("Task cancelled"))
                    publish(staged, target, overwrite)
                    result["path"] = str(target)
                    if operation == "export" and self.series is job["_series"] and self.series and self.series.mark_exported(book, target):
                        self.series_changed()
                    job.update(state="completed", result=result)
            return result
        finally:
            with self.lock:
                self.export_targets.discard(target)

    def execute(self, job: dict, p: dict, book: dict | None) -> None:
        messages.set(self.plugins.locale()["messages"])
        temporary = None
        try:
            operation = job["operation"]
            if operation in ("export", "images.export"):
                result = self.export_job(job, p, book)
            else:
                saved = None
                entry, series = p.get("_entry"), p.get("_series")
                if operation == "series.open":
                    with self.lock:
                        saved = self.session_for_entry(entry)
                    saved = saved or series.load(entry)
                    if saved:
                        self.prepare_session(saved, job)
                    elif series.managed:
                        series.ensure_source(copy.deepcopy(entry))
                args = (
                    {
                        "path": entry["path"] if entry else p["path"],
                        "plugin_id": p.get("plugin_id"),
                        "options": p.get("options", {}),
                        "render": p.get("render", False),
                        "dpi": p.get("dpi", "auto"),
                    }
                    if operation in ("import", "series.open")
                    else (
                        {"paths": p["paths"]}
                        if operation == "images.import"
                        else {
                            "plugin_id": p["plugin_id"],
                            "input": p.get("input"),
                            "book": book,
                        }
                    )
                )
                result = saved.book if saved else self.run_worker("import" if entry else operation, args, job)
                if operation in ("import", "series.open"):
                    session = saved or Session(self.adopt_import(result))
                    if entry and not saved:
                        with self.lock:
                            if job["cancelled"] or self.series is not series:
                                raise EngineError(t("Task cancelled"))
                            settings = dict(entry["settings"])
                        if settings:
                            session.apply(session.book["id"], session.book["revision"], {"metadata": settings})
                        # Copy extracted images and checkpoint away from the document lock.
                        path = series.project(entry)
                        path.parent.mkdir(parents=True, exist_ok=True)
                        temporary = tempfile.TemporaryDirectory(prefix=".parse-", dir=path.parent, ignore_cleanup_errors=True)
                        staged = Path(temporary.name) / "book.mteproj"
                        save_project(session.book, staged, relative_to=path)
                with self.lock:
                    if job["cancelled"]:
                        raise EngineError(t("Task cancelled"))
                    if operation in ("import", "series.open"):
                        current = (self.session.book["id"], self.session.book["revision"]) if self.session else None
                        if job["_activate"] and current != job["opening_over"]:
                            raise ValueError(
                                t("Document changed during import. Please try again; your current work was preserved.")
                            )
                        if entry:
                            if self.series is not series:
                                raise EngineError(t("Task cancelled"))
                            latest = self.session_for_entry(entry)
                            if latest:
                                session = latest
                            elif saved and entry["revision"] != session.book["revision"]:
                                session = series.load(entry)
                            elif not saved:
                                staged.rename(path)
                                session.book = open_project(path)
                                session.project_path = str(path)
                                session.saved_revision = session.book["revision"]
                            if not saved and settings != entry["settings"]:
                                session.apply(session.book["id"], session.book["revision"], {"metadata": entry["settings"]})
                            series.open_book(entry, session, activate=job["_activate"],
                                             persisted=session.saved_revision == session.book["revision"])
                            self.series_changed()
                        if not job["_activate"]:
                            if job["_retain"] and session is not self.session:
                                self.background_sessions[session.book["id"]] = session
                        else:
                            if self.session and self.session.book["id"] in self.document_windows.values():
                                self.background_sessions[self.session.book["id"]] = self.session
                            self.background_sessions.pop(session.book["id"], None)
                            self.session = session
                            self.notify("document.activated", session.snapshot())
                    elif operation == "images.import":
                        session = self.document(p, True)
                        candidate = copy.deepcopy(session.book)
                        candidate["assets"].update(result["assets"])
                        position = p.get("position", len(candidate["pages"]))
                        if type(position) is not int or not 0 <= position <= len(candidate["pages"]):
                            raise ValueError(t("Insert position is out of range"))
                        candidate["pages"][position:position] = result["pages"]
                        validate(candidate)
                        session.book["assets"].update(result["assets"])
                        session.apply(p["document_id"], p["base_revision"], {"pages": candidate["pages"]})
                    else:
                        session = self.document(p, True)
                        session.apply(p["document_id"], p["base_revision"], result["changes"])
                    if job.get("preparse") and not job["_retain"]:
                        result = None
                    else:
                        result = self.changed(session)
            with self.lock:
                job.update(state="completed", result=result)
        except Exception as exc:
            with self.lock:
                job.update(
                    state="cancelled" if job["cancelled"] else "failed",
                    error={"message": str(exc), "data": getattr(exc, "data", None)},
                )
        finally:
            if temporary:
                temporary.cleanup()
            with self.lock:
                job.pop("process", None)
                self.notify("task.changed", job_info(job))
                self.threads.discard(threading.current_thread())
                self.dispatch()

    def close(self) -> None:
        with self.lock:
            self.closing = True
            self.cache.close()
            for job in self.jobs.values():
                if job["state"] == "queued":
                    self.cancel(job)
            self.pending.clear()
            self.workers.close(self.jobs.values())
            threads = list(self.threads)
        for thread in threads:
            thread.join(timeout=5)


def serve(data: Path, safe: bool) -> None:
    output_lock = threading.Lock()

    def send(value):
        with output_lock:
            print(json.dumps(value, ensure_ascii=False, allow_nan=False), flush=True)

    engine = Engine(data, safe, lambda method, params: send({"jsonrpc": "2.0", "method": method, "params": params}))

    def handle(request):
        identifier = request.get("id")
        try:
            if request.get("jsonrpc") != "2.0":
                raise ValueError(t("Invalid JSON-RPC version"))
            result = engine.call(request["method"], request.get("params", {}))
            send({"jsonrpc": "2.0", "id": identifier, "result": result})
        except Exception as exc:
            send(
                {
                    "jsonrpc": "2.0",
                    "id": identifier,
                    "error": {
                        "code": -32000,
                        "message": str(exc),
                        "data": getattr(exc, "data", None),
                    },
                }
            )

    with ThreadPoolExecutor(max_workers=4) as pool:
        previews = ThreadPoolExecutor(max_workers=2)
        try:
            while line := sys.stdin.buffer.readline(16 * 1024 * 1024 + 1):
                if len(line) > 16 * 1024 * 1024:
                    raise ValueError(t("RPC message exceeds the 16 MB limit"))
                try:
                    request = parse_json(line)
                    if not isinstance(request, dict):
                        raise ValueError(t("RPC messages must be objects"))
                    if request.get("method") == "app.shutdown":
                        engine.close()
                        break
                    (previews if request.get("method") == "document.preview" else pool).submit(handle, request)
                except ValueError as exc:
                    send({"jsonrpc": "2.0", "id": None, "error": {"code": -32700, "message": str(exc)}})
        finally:
            pool.shutdown(wait=True)
            engine.close()
            previews.shutdown(wait=True, cancel_futures=True)
