from __future__ import annotations

import copy
import json
import os
import re
import signal
import subprocess
import sys
import tempfile
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile

from . import __version__
from .i18n import messages, t
from .model import Session, new_id, validate
from .plugins import Plugins, platform_id, unpack
from .series import FolderProject, Series, pending_review_count
from .storage import atomic_json, digest, open_project, owned_files, parse_json, preview_path, save_project


class EngineError(ValueError):
    def __init__(self, message: str, data=None):
        super().__init__(message)
        self.data = data


def worker_command(request: Path) -> list[str]:
    prefix = [sys.executable] if getattr(sys, "frozen", False) else [sys.executable, "-m", "foluma"]
    return [*prefix, "--worker", str(request)]


def terminate(process: subprocess.Popen | None) -> None:
    if process is None or process.poll() is not None:
        return
    try:
        if os.name == "posix":
            os.killpg(process.pid, signal.SIGTERM)
        else:
            process.terminate()
        process.wait(timeout=1)
    except subprocess.TimeoutExpired:
        if os.name == "posix":
            os.killpg(process.pid, signal.SIGKILL)
        else:
            process.kill()
    except ProcessLookupError:
        pass


def publish(staged: Path, target: Path, overwrite: bool) -> None:
    if overwrite:
        os.replace(staged, target)
    else:
        os.link(staged, target)  # Atomic no-clobber, even if the destination appeared during export.
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
        self.preview_slots = threading.Semaphore(2)
        self.jobs: dict[str, dict] = {}
        self.processes: dict[int, subprocess.Popen] = {}
        self.closing = False
        self.previewing: dict[Path, int] = {}
        self.cache_timer: threading.Timer | None = None
        self.cache_checked = 0.0
        self.notify = notify
        self.series: Series | None = None
        self.series_error = None
        current = data / "series" / "current.json"
        if current.exists():
            try:
                location = parse_json(current.read_text("utf-8"))
                self.series = FolderProject(data, location["project"]) if "project" in location else Series(data, location["paths"])
                identifier = self.series.state["current_id"]
                if identifier:
                    self.session = self.series.load(self.series.item(identifier))
            except (OSError, ValueError, KeyError, TypeError) as error:
                self.series_error = str(error)
        self.maintain_cache()

    def cache_limit(self) -> int:
        value = self.plugins.config.get("preview_cache_limit", 5_000_000_000)
        return value if type(value) is int and 1_000_000_000 <= value <= 1_000_000_000_000 else 5_000_000_000

    def cache_storage(self, clear=False) -> dict:
        # ponytail: periodic scans hold the engine lock; index sizes if large caches make scans slow.
        directory = self.data / "previews"
        entries = [(path, path.stat()) for path in owned_files(self.data, directory) if path.suffix == ".png"]
        used = sum(stat.st_size for _, stat in entries)
        before, limit, now = used, self.cache_limit(), time.time()
        for path, stat in sorted(entries, key=lambda entry: entry[1].st_mtime):
            if not clear and used <= limit:
                break
            if path in self.previewing or not clear and now - stat.st_mtime < 60:
                continue
            path.unlink()
            used -= stat.st_size
        return {"used": used, "limit": limit, "freed": before - used}

    def maintain_cache(self):
        with self.lock:
            if self.closing:
                return
            self.cache_checked = time.monotonic()
            if self.cache_timer:
                self.cache_timer.cancel()
                self.cache_timer = None
            try:
                state = self.cache_storage()
                if state["used"] > state["limit"]:
                    self.cache_timer = threading.Timer(60, self.maintain_cache)
                    self.cache_timer.daemon = True
                    self.cache_timer.start()
            except (OSError, ValueError):
                pass

    def document(self, params: dict, revision: bool = False) -> Session:
        session = self.session if self.session and self.session.book["id"] == params.get("document_id") else self.background_sessions.get(params.get("document_id"), self.session)
        if not session:
            raise ValueError(t("Open a book first"))
        session.check(params["document_id"], params["base_revision"] if revision else None)
        return session

    def changed(self, session: Session | None = None) -> dict:
        session = session or self.session
        item = self.series.current(session) if self.series else None
        if item and session.saved_revision != session.book["revision"]:
            try:
                self.series.remember(item, session)
                self.series_changed()
            except Exception:
                if session is self.session:
                    self.notify("document.changed", session.snapshot())
                raise
        snapshot = session.snapshot()
        if session is self.session:
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
                session = self.document(p)
                item = self.series.current(session) if self.series else None
                if item and self.series.managed:
                    self.series.ensure_source(item)
                book = copy.deepcopy(session.book)
                output = preview_path(book, p["page_id"], p.get("size", 320), self.data / "previews")
                if output.is_file():
                    output.touch()
                    if time.monotonic() - self.cache_checked >= 30:
                        self.maintain_cache()
                    return f"previews/{output.name}"
                self.previewing[output] = self.previewing.get(output, 0) + 1
            try:
                with self.preview_slots:
                    return self.run_worker("preview", {"book": book, "page_id": p["page_id"], "size": p.get("size", 320)})
            finally:
                with self.lock:
                    self.previewing[output] -= 1
                    if not self.previewing[output]:
                        del self.previewing[output]
                    if time.monotonic() - self.cache_checked >= 30:
                        self.maintain_cache()
                    elif self.cache_timer is None and not self.closing:
                        self.cache_timer = threading.Timer(30, self.maintain_cache)
                        self.cache_timer.daemon = True
                        self.cache_timer.start()
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
                }
            if method == "app.locale":
                return self.plugins.set_locale(p["code"]) if "code" in p else self.plugins.locale()
            if method in ("storage.info", "storage.configure", "storage.clear"):
                if method != "storage.info" and any(job["state"] == "running" for job in self.jobs.values()):
                    raise ValueError(t("Complete or cancel the current background task first"))
                if method == "storage.configure":
                    limit = p.get("limit")
                    if type(limit) is not int or not 1_000_000_000 <= limit <= 1_000_000_000_000:
                        raise ValueError(t("Enter a cache limit between 1 and 1000 GB"))
                    config = self.plugins.config | {"preview_cache_limit": limit}
                    atomic_json(self.plugins.config_path, config)
                    self.plugins.config = config
                result = self.cache_storage(clear=method == "storage.clear")
                self.maintain_cache()
                return result
            if method == "app.safe_mode":
                self.plugins.config["safe_next_start"] = True
                atomic_json(self.plugins.config_path, self.plugins.config)
                return True
            if method == "document.get":
                return self.session.snapshot() if self.session else None
            if method.startswith("series."):
                return self.series_call(method, p)
            if method == "document.apply":
                session = self.document(p, True)
                session.apply(p["document_id"], p["base_revision"], p["changes"])
                return self.changed(session)
            if method in ("document.undo", "document.redo"):
                session = self.document(p)
                session.history(p["document_id"], method.endswith("redo"))
                return self.changed(session)
            if method == "document.release":
                self.background_sessions.pop(p["document_id"], None)
                return True
            if method == "project.open":
                if (Path(p["path"]) / ".foluma/project.json").is_file():
                    return self.series_call("series.open_project", p)
                self.session = Session(open_project(Path(p["path"])), p["path"])
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
                    raise ValueError(t("The file differs from the original PDF and cannot be relinked"))
                source["path"] = str(path)
                # Source locations are identity-preserving maintenance, not an undoable edit.
                for snapshot in session.undo_stack + session.redo_stack:
                    snapshot["sources"][p["source_id"]]["path"] = str(path)
                session.book["revision"] += 1
                return self.changed(session)
            if method == "task.start":
                return self.start(p)
            if method == "task.cancel":
                job = self.jobs[p["id"]]
                if job["state"] == "running":
                    job["cancelled"] = True
                    terminate(job.get("process"))
                return True
            if method == "task.get":
                return self.job_info(self.jobs[p["id"]])
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
            if method in ("bundle.write", "bundle.read"):
                return self.bundle(method, p)
            raise ValueError(t("Unsupported operation: {0}", method))

    def series_call(self, method: str, p: dict):
        if method == "series.get":
            return self.series.snapshot() if self.series else None
        if any(job["state"] == "running" for job in self.jobs.values()):
            raise ValueError(t("Complete or cancel the current background task first"))
        if method == "series.close":
            if self.session and self.session.snapshot()["dirty"] and p.get("discard") is not True:
                raise ValueError(t("Save your changes before continuing?"))
            (self.data / "series/current.json").unlink(missing_ok=True)
            self.series, self.session, self.series_error = None, None, None
            self.background_sessions.clear()
            self.notify("document.changed", None)
            return self.series_changed()
        if method in ("series.create", "series.open_project", "series.migrate"):
            if self.session:
                self.changed()
            if method == "series.open_project":
                project = FolderProject(self.data, p["path"])
            else:
                previous = self.series if method == "series.migrate" else None
                if method == "series.migrate" and (not previous or previous.managed):
                    raise ValueError(t("Open a legacy series to migrate it"))
                project = FolderProject.create(self.data, p["parent"], p["name"])
                if previous:
                    for item in previous.state["items"]:
                        saved = previous.project(item)
                        if not Path(item["path"]).is_file():
                            project.import_missing(item, saved)
                        else:
                            project.add([str(saved) if (saved / "project.json").exists() else item["path"]])
                        imported = project.state["items"][-1]
                        for key in ("settings", "reviewed_revision", "exported_revision", "output"):
                            imported[key] = copy.deepcopy(item[key])
                        if item["id"] == previous.state["current_id"]:
                            project.state["current_id"] = imported["id"]
                    project.state["output_directory"] = previous.state["output_directory"]
                    project.save()
            current = project.state["current_id"]
            session = project.load(project.item(current)) if current else None
            project.activate()
            self.series, self.session, self.series_error = project, session, None
            self.background_sessions.clear()
            self.notify("document.changed", session.snapshot() if session else None)
            return self.series_changed()
        if method == "series.scan":
            if self.session:
                self.changed()
            self.series = Series(self.data, p["paths"])
            self.series_error = None
            return self.series_changed()
        if not self.series:
            raise ValueError(t("Open a series folder first"))
        if method == "series.delete_info":
            if not self.series.managed:
                raise ValueError(t("Save this series as a folder project first"))
            return self.series.delete_info(p["ids"])
        if method in ("series.add", "series.move", "series.remove", "series.restore", "series.delete", "series.group",
                      "series.delete_group", "series.refresh", "series.relink", "series.reorder"):
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
            self.background_sessions.clear()
            if self.session:
                item = self.series.current(self.session)
                if item:
                    if item.get("removed"):
                        self.session = None
                    else:
                        self.series.synchronize(item, self.session)
                    self.notify("document.changed", self.session.snapshot() if self.session else None)
            state = self.series_changed()
            return state | {"summary": summary} if summary is not None else state
        if method == "series.review":
            item = self.series.item(p["id"])
            if type(p.get("reviewed")) is not bool or item["revision"] is None:
                raise ValueError(t("Open this book before marking it reviewed"))
            session = self.session if self.series.current(self.session) is item else self.series.load(item)
            marks = pending_review_count(session.book) if session else 0
            if p["reviewed"] and marks and p.get("allow_pending") is not True:
                raise EngineError(t("{0} pages still need attention. Confirm before marking this book reviewed.",marks),
                                  {"kind": "pending_review", "pages": marks})
            item["reviewed_revision"] = item["revision"] if p["reviewed"] else None
        elif method == "series.output":
            directory = Path(p["directory"]).resolve(strict=True)
            if not directory.is_dir():
                raise ValueError(t("Choose an output folder"))
            self.series.state["output_directory"] = str(directory)
        elif method == "series.configure":
            changes = p.get("metadata")
            if (not isinstance(changes, dict) or not changes or set(changes) - {"direction", "cover_only"}
                    or "direction" in changes and changes["direction"] not in ("rtl", "ltr")
                    or "cover_only" in changes and type(changes["cover_only"]) is not bool):
                raise ValueError(t("Invalid shared reading settings"))
            identifiers = p.get("ids")
            if not isinstance(identifiers, list) or not identifiers or not all(isinstance(i, str) for i in identifiers):
                raise ValueError(t("Select books first"))
            items = [self.series.item(i) for i in dict.fromkeys(identifiers)]
            results = []
            for item in items:
                try:
                    session = self.session if self.series.current(self.session) is item else self.series.load(item)
                    if session:
                        session.apply(session.book["id"], session.book["revision"], {"metadata": changes})
                        self.series.remember(item, session)
                        if session is self.session:
                            self.notify("document.changed", session.snapshot())
                    else:
                        item["settings"].update(changes)
                        self.series.save()
                    results.append({"id": item["id"], "error": None})
                except Exception as error:
                    if self.session and self.series.current(self.session) is item:
                        self.notify("document.changed", self.session.snapshot())
                    results.append({"id": item["id"], "error": str(error)})
            self.series_changed()
            return results
        else:
            raise ValueError(t("Unsupported operation: {0}", method))
        self.series.save()
        return self.series_changed()

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
            from .storage import contained

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
        if any(j["state"] == "running" for j in self.jobs.values()):
            raise ValueError(t("Complete or cancel the current background task first"))
        operation = p["operation"]
        if operation not in ("import", "series.open", "export", "images.import", "images.export", "plugin"):
            raise ValueError(t("Unsupported background task"))
        book = None
        if operation == "series.open":
            if not self.series:
                raise ValueError(t("Open a series folder first"))
            item = self.series.item(p["entry_id"])
            if self.series.managed:
                self.series.ensure_source(item)
            if self.session:
                self.changed()
        elif operation != "import":
            book = copy.deepcopy(self.document(p, True).book)
        job = {
            "id": new_id(),
            "operation": operation,
            "state": "running",
            "cancelled": False,
            "document_id": book["id"] if book else None,
            "revision": book["revision"] if book else None,
            "progress": {"done": 0, "total": 1, "message": t("Preparing")},
            "result": None,
            "error": None,
        }
        job["opening_over"] = (self.session.book["id"], self.session.book["revision"]) if self.session else None
        self.jobs = {key: value for key, value in list(self.jobs.items())[-19:]}
        self.jobs[job["id"]] = job
        threading.Thread(target=self.execute, args=(job, p, book), daemon=True).start()
        return self.job_info(job)

    @staticmethod
    def job_info(job: dict) -> dict:
        return {key: value for key, value in job.items() if key not in ("process", "cancelled", "opening_over")}

    def run_worker(self, operation: str, params: dict, job: dict | None = None):
        with tempfile.TemporaryDirectory(dir=self.data) as temp:
            request = Path(temp) / "request.json"
            atomic_json(
                request,
                {
                    "operation": operation,
                    "params": params,
                    "data": str(self.data),
                    "messages": self.plugins.locale()["messages"],
                },
            )
            command = worker_command(request)
            worker_input = None
            if operation == "plugin":
                manifest = self.plugins.active.get(params["plugin_id"])
                if not manifest:
                    raise ValueError(t("Plugin is not active. Please restart."))
                from .storage import contained

                worker = manifest.get("workers", {}).get(platform_id())
                if not worker:
                    raise ValueError(t("Plugin has no worker for this platform"))
                command = [str(contained(self.plugins.directory(manifest["id"], manifest["version"]), worker))]
                worker_input = json.dumps(params, ensure_ascii=False) + "\n"
            with (Path(temp) / "stderr.log").open("w+") as error_log:
                with self.lock:
                    if job and job["cancelled"]:
                        raise EngineError(t("Task cancelled"))
                    if self.closing:
                        raise EngineError(t("Foluma is closing"))
                    process = subprocess.Popen(
                        command,
                        stdin=subprocess.PIPE,
                        stdout=subprocess.PIPE,
                        stderr=error_log,
                        text=True,
                        encoding="utf-8",
                        start_new_session=os.name == "posix",
                    )
                    if job is not None:
                        job["process"] = process
                    self.processes[process.pid] = process
                if worker_input:
                    process.stdin.write(worker_input)
                process.stdin.close()
                result, found = None, False
                try:
                    for line in process.stdout:
                        message = parse_json(line)
                        if "timing" in message:
                            print("[timing] " + json.dumps(message["timing"], ensure_ascii=False), file=sys.stderr, flush=True)
                        if "progress" in message and job:
                            job["progress"] = message["progress"]
                            self.notify("task.changed", self.job_info(job))
                        if "error" in message:
                            raise EngineError(message["error"]["message"], message["error"].get("data"))
                        if "result" in message:
                            result, found = message["result"], True
                    process.wait()
                    if process.returncode or not found:
                        error_log.seek(0)
                        raise EngineError(
                            t("Background task ended without a valid result: {0}", error_log.read()[-1500:])
                        )
                    return result
                finally:
                    terminate(process)
                    process.stdout.close()
                    with self.lock:
                        self.processes.pop(process.pid, None)

    def execute(self, job: dict, p: dict, book: dict | None) -> None:
        messages.set(self.plugins.locale()["messages"])
        try:
            operation = job["operation"]
            if operation in ("export", "images.export"):
                overwrite = bool(p.get("overwrite")) and "directory" not in p
                expected = ".epub" if operation == "export" else ".zip"
                if "directory" in p:
                    directory = Path(p["directory"]).resolve(strict=True)
                    if not directory.is_dir():
                        raise ValueError(t("Choose an output folder"))
                    stem = (
                        re.sub(r'[\x00-\x1f<>:"/\\|?*]', "_", book["metadata"]["title"]).strip().rstrip(". ")[:120]
                        or "book"
                    )
                    if stem.upper().split(".")[0] in {
                        "CON",
                        "PRN",
                        "AUX",
                        "NUL",
                        *[f"COM{i}" for i in range(1, 10)],
                        *[f"LPT{i}" for i in range(1, 10)],
                    }:
                        stem = f"book-{stem}"
                    target = directory / f"{stem}{expected}"
                    number = 2
                    while target.exists():
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
                if target.exists() and not overwrite:
                    raise ValueError(t("Destination exists. Choose another name or confirm overwriting."))
                with tempfile.TemporaryDirectory(prefix=".foluma-", dir=target.parent) as temp:
                    staged = Path(temp) / target.name
                    args = {"book": book, "path": str(staged)}
                    if operation == "images.export":
                        args["page_ids"] = p["page_ids"]
                    result = self.run_worker(operation, args, job)
                    with self.lock:
                        if job["cancelled"]:
                            raise EngineError(t("Task cancelled"))
                        publish(staged, target, overwrite)
                        result["path"] = str(target)
                        if operation == "export" and self.series:
                            item = next((item for item in self.series.state["items"] if item["document_id"] == book["id"]), None)
                            if item:
                                item.update(exported_revision=book["revision"], output=str(target))
                                self.series.save()
                                self.series_changed()
                        job.update(state="completed", result=result)
            else:
                saved = None
                entry = None
                if operation == "series.open":
                    entry = self.series.item(p["entry_id"])
                    saved = self.series.load(entry)
                args = (
                    {"path": entry["path"] if entry else p["path"], "render": p.get("render", False), "dpi": p.get("dpi", "auto")}
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
                with self.lock:
                    if job["cancelled"]:
                        raise EngineError(t("Task cancelled"))
                    if operation in ("import", "series.open"):
                        current = (self.session.book["id"], self.session.book["revision"]) if self.session else None
                        if not p.get("background") and current != job["opening_over"]:
                            raise ValueError(
                                t("Document changed during import. Please try again; your current work was preserved.")
                            )
                        session = saved or Session(result)
                        if entry:
                            if p.get("background") and self.series.current(self.session) is entry:
                                session = self.session
                            if not saved and entry["settings"]:
                                session.apply(session.book["id"], session.book["revision"], {"metadata": entry["settings"]})
                            if not p.get("background"):
                                self.series.state["current_id"] = entry["id"]
                            self.series.remember(entry, session)
                            self.series_changed()
                        if p.get("background"):
                            if session is not self.session:
                                self.background_sessions[session.book["id"]] = session
                        else:
                            self.background_sessions.pop(session.book["id"], None)
                            self.session = session
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
            with self.lock:
                job.pop("process", None)
                self.notify("task.changed", self.job_info(job))

    def close(self) -> None:
        with self.lock:
            self.closing = True
            if self.cache_timer:
                self.cache_timer.cancel()
            for job in self.jobs.values():
                job["cancelled"] = True
            for process in list(self.processes.values()):
                terminate(process)


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
