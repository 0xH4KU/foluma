"""A folder's book list and independent, ordinary Foluma projects."""

from __future__ import annotations

import copy
import hashlib
import json
import re
import shutil
import tempfile
from contextlib import contextmanager
from datetime import UTC, datetime
from pathlib import Path

from .i18n import t
from .model import (
    INFORMATION_FIELDS,
    EngineError,
    Session,
    information_patch,
    new_id,
    review_page_ids,
    review_unchanged,
)
from .storage import atomic_json, contained, digest, link_or_copy, open_project, owned_files, parse_json, save_project


def path_id(path: str) -> str:
    return hashlib.sha256(path.encode()).hexdigest()


def natural_key(path: str):
    return [int(part) if part.isdigit() else part.casefold() for part in re.split(r"(\d+)", path)]


def project_inputs(paths: list[str], extensions: set[str]) -> tuple[list[Path], int]:
    if not isinstance(paths, list) or not paths or not all(isinstance(path, str) for path in paths):
        raise ValueError(t("Choose a folder or supported book files"))
    inputs, folders_skipped = [], 0
    for name in paths:
        path = Path(name).resolve(strict=True)
        if path.is_dir() and path.suffix != ".mteproj":
            inputs.extend(
                sorted(
                    (p for p in path.iterdir() if p.is_file() and p.suffix.lower() in extensions),
                    key=lambda p: natural_key(p.name),
                )
            )
            folders_skipped += sum(p.is_dir() and not p.name.startswith(".") for p in path.iterdir())
        else:
            inputs.append(path)
    if not inputs:
        raise ValueError(t("No supported book files were found in this folder"))
    return list(dict.fromkeys(inputs)), folders_skipped


def preview_inputs(paths: list[str], extensions=()) -> dict:
    suffixes = {f".{extension}" for extension in extensions}
    inputs, folders_skipped = project_inputs(paths, suffixes)
    books = []
    for path in inputs:
        book = open_project(path) if path.is_dir() and path.suffix == ".mteproj" else None
        if not book and (not path.is_file() or path.suffix.lower() not in suffixes or path.name.startswith(".")):
            raise ValueError(t("Choose supported book files or a .mteproj book folder"))
        if book:
            if not book["sources"]:
                raise ValueError(t("This book project has no source file"))
            primary = next(iter(book["sources"].values()))
            source = Path(primary["path"]).resolve(strict=True)
            if not source.is_file() or digest(source) != primary["sha256"]:
                raise ValueError(t("The file differs from the original source and cannot be relinked"))
        books.append(
            {
                "path": str(path),
                "filename": source.name if book else path.name,
                "title": book["metadata"]["title"] if book else path.stem,
                "metadata": {key: book["metadata"][key] for key in INFORMATION_FIELDS} if book else {},
            }
        )
    return {"books": books, "folders_skipped": folders_skipped}


class Series:
    managed = False

    def __init__(self, data: Path, paths: list[str], extensions=()):
        if not isinstance(paths, list) or not paths or not all(isinstance(p, str) for p in paths):
            raise ValueError(t("Choose a folder or supported book files"))
        self.extensions = {f".{extension}" for extension in extensions}
        roots = sorted({str(Path(p).resolve()) for p in paths})
        self.directory = data / "series" / path_id(json.dumps(roots))
        self.path = self.directory / "series.json"
        files = set()
        for name in roots:
            root = Path(name)
            if not root.exists() and not self.path.exists():
                raise ValueError(t("Folder or file is missing: {0}", name))
            for item in root.iterdir() if root.is_dir() else [root]:
                if item.is_file() and item.suffix.lower() in self.extensions:
                    files.add(str(item.resolve()))
        if not files and not self.path.exists():
            raise ValueError(t("No supported book files were found in this folder"))
        self.state = (
            parse_json(self.path.read_text("utf-8"))
            if self.path.exists()
            else {
                "schema": 1,
                "id": self.directory.name,
                "roots": roots,
                "name": Path(roots[0]).name
                if len(roots) == 1 and Path(roots[0]).is_dir()
                else Path(roots[0]).parent.name,
                "current_id": None,
                "output_directory": "",
                "items": [],
            }
        )
        if self.state.get("schema") != 1 or not isinstance(self.state.get("items"), list):
            raise ValueError(t("Unsupported series format"))
        known = {item["path"]: item for item in self.state["items"]}
        # Keep missing sources in the list so saved edits remain reachable for relinking.
        for name in files:
            known.setdefault(
                name,
                {
                    "id": path_id(name),
                    "path": name,
                    "title": Path(name).stem,
                    "revision": None,
                    "reviewed_revision": None,
                    "exported_revision": None,
                    "document_id": None,
                    "page_count": None,
                    "output": None,
                    "settings": {},
                },
            )
        self.state["items"] = sorted(known.values(), key=lambda item: natural_key(item["path"]))
        self.save()
        atomic_json(data / "series" / "current.json", {"paths": roots})

    def save(self):
        atomic_json(self.path, self.state)

    @property
    def current_id(self) -> str | None:
        return self.state["current_id"]

    def item(self, identifier: str) -> dict:
        for item in self.state["items"]:
            if (
                item["id"] == identifier
                and isinstance(identifier, str)
                and re.fullmatch(r"[A-Za-z0-9_-]{1,80}", identifier)
            ):
                return item
        raise ValueError(t("This book is not in the current series"))

    def project(self, item: dict) -> Path:
        return self.directory / f"{self.item(item['id'])['id']}.mteproj"

    def load(self, item: dict) -> Session | None:
        path = self.project(item)
        if not (path / "project.json").exists():
            if item["document_id"]:
                raise ValueError(t("The saved project is missing: {0}", item["title"]))
            return None
        return Session(open_project(path), str(path))

    def remember(self, item: dict, session: Session, preserve_review=False, persisted=False):
        path = self.project(item)
        reviewed = item["revision"] is not None and item["reviewed_revision"] == item["revision"]
        # ponytail: checkpoint one ordinary project per edit; coalesce writes if large books make this slow.
        if not persisted:
            save_project(session.book, path)
        item.update(
            document_id=session.book["id"],
            revision=session.book["revision"],
            title=session.book["metadata"]["title"],
            page_count=len(session.book["pages"]),
            review_count=len(review_page_ids(session.book)),
            metadata={key: session.book["metadata"][key] for key in INFORMATION_FIELDS},
        )
        if reviewed and preserve_review:
            item["reviewed_revision"] = session.book["revision"]
        self.save()
        session.project_path = str(path)
        session.saved_revision = session.book["revision"]

    def current(self, session: Session | None) -> dict | None:
        if session:
            return next((item for item in self.state["items"] if item["document_id"] == session.book["id"]), None)
        return None

    def open_book(self, item: dict, session: Session, *, imported=False, activate=True, persisted=False):
        if imported and item["settings"]:
            session.apply(session.book["id"], session.book["revision"], {"metadata": item["settings"]})
        if activate:
            self.state["current_id"] = item["id"]
        self.remember(item, session, persisted=persisted)

    def review(self, identifier: str, reviewed: bool, allow_pending=False, current: Session | None = None):
        item = self.item(identifier)
        if type(reviewed) is not bool or item["revision"] is None:
            raise ValueError(t("Open this book before marking it reviewed"))
        session = current if self.current(current) is item else self.load(item)
        marks = len(review_page_ids(session.book)) if session else 0
        if reviewed and marks and allow_pending is not True:
            raise EngineError(
                t("{0} pages still need attention. Confirm before marking this book reviewed.", marks),
                {"kind": "pending_review", "pages": marks},
            )
        item["reviewed_revision"] = item["revision"] if reviewed else None
        self.save()

    def set_output(self, directory: str):
        path = Path(directory).resolve(strict=True)
        if not path.is_dir():
            raise ValueError(t("Choose an output folder"))
        self.state["output_directory"] = str(path)
        self.save()

    def mark_exported(self, book: dict, path: Path) -> bool:
        item = next((item for item in self.state["items"] if item["document_id"] == book["id"]), None)
        if item is None:
            return False
        item.update(exported_revision=book["revision"], output=str(path))
        self.save()
        return True

    def configure(self, p: dict, current: Session | None = None, on_change=lambda *_: None, sessions=None):
        changes = information_patch(p.get("metadata", {}), allow_empty=True)
        identifiers = p.get("ids")
        if not isinstance(identifiers, list) or not identifiers or not all(isinstance(i, str) for i in identifiers):
            raise ValueError(t("Select books first"))
        items = [self.item(i) for i in dict.fromkeys(identifiers)]
        books = p.get("books", [])
        if not isinstance(books, list):
            raise ValueError(t("Invalid book information plan"))
        planned = {}
        for book in books:
            if (
                not isinstance(book, dict)
                or book.get("id") not in identifiers
                or book["id"] in planned
                or "base_revision" in book
                and book["base_revision"] is not None
                and (type(book["base_revision"]) is not int or book["base_revision"] < 0)
            ):
                raise ValueError(t("Invalid book information plan"))
            planned[book["id"]] = {"metadata": information_patch(book.get("metadata", {}), allow_empty=True)}
            if "base_revision" in book:
                planned[book["id"]]["base_revision"] = book["base_revision"]
        patches = {
            item["id"]: information_patch(changes | planned.get(item["id"], {}).get("metadata", {})) for item in items
        }
        results = []
        for item in items:
            session = None
            try:
                patch = patches[item["id"]]
                plan = planned.get(item["id"], {})
                session = current if self.current(current) is item else (sessions or {}).get(item["document_id"]) or self.load(item)
                revision = session.book["revision"] if session else item["revision"]
                if "base_revision" in plan and plan["base_revision"] != revision:
                    raise ValueError(t("Document changed. Please retry with the latest revision."))
                if session:
                    before = session.book
                    session.apply(session.book["id"], session.book["revision"], {"metadata": patch})
                    self.remember(item, session, review_unchanged(before, session.book))
                    on_change(session.snapshot())
                else:
                    item["settings"].update(patch)
                    item.setdefault("metadata", {}).update(patch)
                    if "title" in patch:
                        item["title"] = patch["title"]
                    self.save()
                results.append({"id": item["id"], "error": None})
            except Exception as error:
                if session:
                    on_change(session.snapshot())
                results.append({"id": item["id"], "error": str(error)})
        return results


    def snapshot(self) -> dict:
        for item in self.state["items"]:
            if "review_count" not in item or "metadata" not in item:
                try:
                    saved = self.load(item) if item["document_id"] else None
                    item["review_count"] = len(review_page_ids(saved.book)) if saved else 0
                    item["metadata"] = (
                        {key: saved.book["metadata"][key] for key in INFORMATION_FIELDS}
                        if saved
                        else {"title": item["title"]} | item["settings"]
                    )
                except (OSError, ValueError, KeyError):
                    item["review_count"] = None
                    item.setdefault("metadata", {"title": item["title"]} | item["settings"])
        result = copy.deepcopy(self.state)
        result.update(managed=self.managed, directory=str(self.directory), groups=[], removed=[])
        for item in result["items"]:
            item["reviewed"] = item["revision"] is not None and item["reviewed_revision"] == item["revision"]
            item["exported"] = (
                item["revision"] is not None
                and item["exported_revision"] == item["revision"]
                and bool(item["output"] and Path(item["output"]).is_file())
            )
            item["needs_export"] = item["exported_revision"] is not None and not item["exported"]
            item["missing"] = not Path(item["path"]).is_file()
            item.setdefault("group", "")
            item.setdefault("changed", False)
        return result


def folder_name(value: str) -> str:
    if (
        not isinstance(value, str)
        or not value.strip()
        or value != value.strip()
        or value.startswith(".")
        or len(value) > 120
        or re.search(r'[\x00-\x1f<>:"/\\|?*]', value)
        or value.endswith(".")
        or value.lower().endswith(".mteproj")
        or value.upper().split(".")[0]
        in {"CON", "PRN", "AUX", "NUL", *[f"COM{i}" for i in range(1, 10)], *[f"LPT{i}" for i in range(1, 10)]}
    ):
        raise ValueError(t("Enter a folder name without path separators or reserved characters"))
    return value


class FolderProject(Series):
    """Managed source copies in visible folders; ordinary book projects stay under .foluma."""

    managed = True

    def __init__(self, data: Path, root: str, extensions=()):
        self.data, self.root = data, Path(root).resolve(strict=True)
        self.extensions = {f".{extension}" for extension in extensions}
        self.directory = contained(self.root, ".foluma/books")
        self.path = contained(self.root, ".foluma/project.json")
        self.state = parse_json(self.path.read_text("utf-8"))
        if self.state.get("schema") != 2 or not isinstance(self.state.get("items"), list):
            raise ValueError(t("Unsupported project format"))
        identifiers = set()
        for item in self.state["items"]:
            if (
                not isinstance(item.get("id"), str)
                or not re.fullmatch(r"[A-Za-z0-9_-]{1,80}", item["id"])
                or item["id"] in identifiers
                or not (
                    isinstance(item.get("sha256"), str)
                    and re.fullmatch(r"[a-f0-9]{64}", item["sha256"])
                    or item.get("sha256") is None
                    and item.get("document_id") is None
                    and item.get("revision") is None
                )
            ):
                raise ValueError(t("Invalid project book identity"))
            identifiers.add(item["id"])
            relative = Path(item["path"])
            if (
                not re.fullmatch(r"\.[a-zA-Z0-9]{1,16}", relative.suffix)
                or ".." in relative.parts
                or (item.get("removed") and relative.parts[:3] != (".foluma", "removed", item["id"]))
                or (
                    not item.get("removed")
                    and (len(relative.parts) not in (1, 2) or any(p.startswith(".") for p in relative.parts))
                )
            ):
                raise ValueError(t("Invalid project source path"))
            item["path"] = str(contained(self.root, item["path"]))
            if item.get("restore_path"):
                contained(self.root, item["restore_path"])
        for group in self.state.get("groups", []):
            folder_name(group)
        self.finish_deletions()
        # A process interrupted between moving a PDF to Removed and saving the manifest
        # leaves a deterministic recovery location. Restore that uncommitted move on open.
        for item in self.state["items"]:
            source = Path(item["path"])
            recovery = contained(self.root, f".foluma/removed/{item['id']}/{source.name}")
            if not item.get("removed") and not source.exists() and recovery.is_file():
                source.parent.mkdir(parents=True, exist_ok=True)
                link_or_copy(recovery, source)
                recovery.unlink()
        self.refresh(verify=False)

    @classmethod
    def create(cls, data: Path, parent: str, name: str, extensions=(), paths=None, information=None):
        root = Path(parent).resolve(strict=True) / folder_name(name)
        root.mkdir()  # Never adopt or overwrite an existing directory implicitly.
        try:
            atomic_json(
                root / ".foluma/project.json",
                {
                    "schema": 2,
                    "id": new_id(),
                    "name": name,
                    "roots": [],
                    "groups": [],
                    "current_id": None,
                    "output_directory": "",
                    "items": [],
                },
            )
            project = cls(data, str(root), extensions)
            if paths:
                project.add(paths, information=information)
            return project
        except Exception:
            shutil.rmtree(root)
            raise

    def activate(self):
        atomic_json(self.data / "series/current.json", {"project": str(self.root)})

    def save(self):
        value = copy.deepcopy(self.state)
        for item in value["items"]:
            item["path"] = Path(item["path"]).relative_to(self.root).as_posix()
        output = value["output_directory"]
        if output and Path(output).is_absolute() and Path(output).is_relative_to(self.root):
            value["output_directory"] = Path(output).relative_to(self.root).as_posix()
        atomic_json(self.path, value)

    def item(self, identifier: str) -> dict:
        item = super().item(identifier)
        if item.get("removed"):
            raise ValueError(t("Restore this book before opening it"))
        return item

    def project(self, item: dict) -> Path:
        return contained(self.directory, f"{super().item(item['id'])['id']}.mteproj")

    def synchronize(self, item: dict, session: Session):
        for book in [session.book, *session.undo_stack, *session.redo_stack]:
            for source in book["sources"].values():
                if source["sha256"] == item["sha256"]:
                    source["path"] = item["path"]

    def load(self, item: dict) -> Session | None:
        session = super().load(item)
        if session:
            self.synchronize(item, session)
        return session

    def remember(self, item: dict, session: Session, preserve_review=False, persisted=False):
        self.synchronize(item, session)
        super().remember(item, session, preserve_review, persisted)
        if persisted:
            return
        # Asset files saved by the existing project writer become project-local immediately.
        local = open_project(self.project(item))
        for book in [session.book, *session.undo_stack, *session.redo_stack]:
            for identifier, asset in book["assets"].items():
                if asset["kind"] == "file" and identifier in local["assets"]:
                    asset["path"] = local["assets"][identifier]["path"]

    def ensure_source(self, item: dict):
        path = contained(self.root, Path(item["path"]).relative_to(self.root).as_posix())
        if not path.is_file():
            raise ValueError(t("Source moved. Please relink: {0}", path.name))
        stamp = [path.stat().st_size, path.stat().st_mtime_ns]
        if stamp != item.get("stamp"):
            fingerprint = digest(path)
            if item["sha256"] is None:
                item["sha256"] = fingerprint  # A missing, never-opened legacy entry has no edits to match.
            if fingerprint != item["sha256"]:
                raise ValueError(t("Source changed. Please import again: {0}", path.name))
            item["stamp"] = stamp

    @contextmanager
    def change(self):
        previous, moves, copies, directories = copy.deepcopy(self.state), [], [], []

        def move(source: Path, target: Path):
            if target.exists():
                raise ValueError(t("Destination already exists: {0}", target.name))
            if not target.parent.exists():
                target.parent.mkdir(parents=True)
                directories.append(target.parent)
            if source.is_dir():
                source.rename(target)
            else:
                link_or_copy(source, target)
                try:
                    source.unlink()
                except Exception:
                    target.unlink()
                    raise
            moves.append((source, target))

        try:
            yield move, copies, directories
            self.save()
        except Exception:
            self.state = previous
            for source, target in reversed(moves):
                if target.is_dir():
                    target.rename(source)
                else:
                    link_or_copy(target, source)
                    target.unlink()
            for path in reversed(copies):
                path.unlink(missing_ok=True)
            for path in reversed(directories):
                if path.exists() and not any(path.iterdir()):
                    path.rmdir()
            raise

    def group_path(self, group: str) -> Path:
        if group and group not in self.state["groups"]:
            raise ValueError(t("Choose an existing group"))
        return contained(self.root, folder_name(group)) if group else self.root

    @staticmethod
    def copy_source(source: Path, target: Path):
        target.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile(dir=target.parent, prefix=".import-", delete=False) as temporary:
            staged = Path(temporary.name)
        try:
            shutil.copyfile(source, staged)
            link_or_copy(staged, target)
        finally:
            staged.unlink(missing_ok=True)

    def add(self, paths: list[str], group: str = "", information: dict[str, dict] | None = None):
        destination = self.group_path(group)
        inputs, folders_skipped = project_inputs(paths, self.extensions)
        information = information or {}
        patches = {path: information_patch(value) for path, value in information.items()}
        if set(patches) - {str(path) for path in inputs}:
            raise ValueError(t("Book information does not match the selected files"))
        skipped = 0
        before = len(self.state["items"])
        with self.change() as (_, copies, _directories):
            for source in inputs:
                patch = patches.get(str(source), {})
                book = open_project(source) if source.is_dir() and source.suffix == ".mteproj" else None
                if book:
                    if any(item["document_id"] == book["id"] for item in self.state["items"]):
                        raise ValueError(t("This book project is already in the project"))
                    if not book["sources"]:
                        raise ValueError(t("This book project has no source file"))
                    primary = next(iter(book["sources"].values()))
                    source = Path(primary["path"]).resolve(strict=True)
                if (
                    not source.is_file()
                    or not book
                    and source.suffix.lower() not in self.extensions
                    or source.name.startswith(".")
                ):
                    raise ValueError(t("Choose supported book files or a .mteproj book folder"))
                fingerprint = digest(source)
                if book and fingerprint != primary["sha256"]:
                    raise ValueError(t("The file differs from the original source and cannot be relinked"))
                target = destination / source.name
                known = next(
                    (
                        item
                        for item in self.state["items"]
                        if not item.get("removed")
                        and item.get("imported_from") == str(source)
                        and item["sha256"] == fingerprint
                    ),
                    None,
                )
                if known and not book:
                    skipped += 1
                    continue
                if (
                    any(item["path"] == str(source) and not item.get("removed") for item in self.state["items"])
                    and not book
                ):
                    skipped += 1
                    continue
                number = 2
                while target.exists() or any(item["path"] == str(target) for item in self.state["items"]):
                    target = destination / f"{source.stem} ({number}){source.suffix}"
                    number += 1
                self.copy_source(source, target)
                copies.append(target)
                item = self.new_item(target, fingerprint)
                item["settings"].update(patch)
                if "title" in patch:
                    item["title"] = patch["title"]
                item["metadata"] = {"title": item["title"]} | patch
                item["imported_from"] = str(source)
                self.state["items"].append(item)
                if book:
                    if patch:
                        session = Session(book)
                        session.apply(book["id"], book["revision"], {"metadata": patch})
                        book = session.book
                    # Keep page/document identities and edits; make every referenced source portable.
                    for source_info in book["sources"].values():
                        original = Path(source_info["path"])
                        if digest(original) != source_info["sha256"]:
                            raise ValueError(t("The file differs from the original source and cannot be relinked"))
                        local = (
                            target
                            if source_info["sha256"] == fingerprint
                            else self.directory / item["id"] / f"{source_info['sha256']}{original.suffix}"
                        )
                        if local != target:
                            self.copy_source(original, local)
                            copies.append(local)
                        source_info["path"] = str(local)
                    save_project(book, self.project(item))
                    item.update(
                        document_id=book["id"],
                        revision=book["revision"],
                        title=book["metadata"]["title"],
                        page_count=len(book["pages"]),
                        review_count=len(review_page_ids(book)),
                        metadata={key: book["metadata"][key] for key in INFORMATION_FIELDS},
                    )
        return {"added": len(self.state["items"]) - before, "skipped": skipped, "folders_skipped": folders_skipped}

    def import_series(self, previous: Series):
        """Migrate legacy book layouts and review/export state into this folder project."""
        for item in previous.state["items"]:
            saved = previous.project(item)
            if not Path(item["path"]).is_file():
                self.import_missing(item, saved)
            else:
                self.add([str(saved) if (saved / "project.json").exists() else item["path"]])
            imported = self.state["items"][-1]
            for key in ("settings", "reviewed_revision", "exported_revision", "output"):
                imported[key] = copy.deepcopy(item[key])
            if item["id"] == previous.state["current_id"]:
                self.state["current_id"] = imported["id"]
        self.state["output_directory"] = previous.state["output_directory"]
        self.save()

    def import_missing(self, entry: dict, saved: Path):
        """Keep legacy edits reachable even when their original source is already missing."""
        book = open_project(saved) if (saved / "project.json").exists() else None
        target = self.root / Path(entry["path"]).name
        if target.exists() or any(item["path"] == str(target) for item in self.state["items"]):
            raise ValueError(t("Destination already exists: {0}", target.name))
        source = next(iter(book["sources"].values()), None) if book else None
        item = self.new_item(target, source["sha256"] if source else None)
        for key in ("title", "document_id", "revision", "page_count", "settings"):
            item[key] = copy.deepcopy(entry[key])
        with self.change():
            self.state["items"].append(item)
            if book:
                if source:
                    source["path"] = str(target)
                save_project(book, self.project(item))

    def new_item(self, path: Path, fingerprint: str | None) -> dict:
        return {
            "id": new_id(),
            "path": str(path),
            "title": path.stem,
            "sha256": fingerprint,
            "group": path.parent.name if path.parent != self.root else "",
            "removed": False,
            "revision": None,
            "reviewed_revision": None,
            "exported_revision": None,
            "document_id": None,
            "page_count": None,
            "output": None,
            "settings": {},
        }

    def selected(self, ids: list[str], removed=False) -> list[dict]:
        if not isinstance(ids, list) or not ids or not all(isinstance(i, str) for i in ids):
            raise ValueError(t("Select books first"))
        items = [super(FolderProject, self).item(identifier) for identifier in dict.fromkeys(ids)]
        if any(bool(item.get("removed")) != removed for item in items):
            raise ValueError(t("The selected books are no longer available in this view"))
        return items

    def move_books(self, ids: list[str], group: str, create=False):
        destination = contained(self.root, folder_name(group)) if create else self.group_path(group)
        items = self.selected(ids)
        with self.change() as (move, _, directories):
            if create:
                if destination.exists() or group in self.state["groups"]:
                    raise ValueError(t("Destination already exists: {0}", group))
                destination.mkdir()
                directories.append(destination)
                self.state["groups"].append(group)
            for item in items:
                old, target = Path(item["path"]), destination / Path(item["path"]).name
                if old == target:
                    continue
                self.ensure_source(item)
                move(old, target)
                item.update(path=str(target), group=group)

    def remove(self, ids: list[str]):
        with self.change() as (move, _, _directories):
            for item in self.selected(ids):
                old = Path(item["path"])
                item["restore_path"] = old.relative_to(self.root).as_posix()
                target = contained(self.root, f".foluma/removed/{item['id']}/{old.name}")
                if old.exists():
                    contained(self.root, old.relative_to(self.root).as_posix())
                    move(old, target)
                item.update(path=str(target), removed=True)
                if self.state["current_id"] == item["id"]:
                    self.state["current_id"] = None

    def restore(self, ids: list[str]):
        with self.change() as (move, _, _directories):
            for item in self.selected(ids, removed=True):
                old = Path(item["path"])
                group = item["group"] if item["group"] in self.state["groups"] else ""
                target = self.group_path(group) / Path(item["restore_path"]).name
                number = 2
                while target.exists() or any(
                    other["path"] == str(target) and other is not item for other in self.state["items"]
                ):
                    target = self.group_path(group) / f"{old.stem} ({number}){old.suffix}"
                    number += 1
                if old.exists():
                    move(old, target)
                item.update(path=str(target), group=group, removed=False)
                item.pop("restore_path", None)

    def deletion_paths(self, identifier: str) -> tuple[Path, Path]:
        return self.root / ".foluma/removed" / identifier, self.root / ".foluma/books" / f"{identifier}.mteproj"

    def delete_info(self, ids: list[str]) -> dict:
        items = self.selected(ids, removed=True)
        files = []
        for item in items:
            for path in self.deletion_paths(item["id"]):
                files.extend(owned_files(self.root, path))
                if any(
                    other.get("output") and Path(other["output"]).resolve().is_relative_to(path.resolve())
                    for other in self.state["items"]
                ):
                    raise ValueError(t("Move exported files out of this book's data folder before deleting it"))
        return {"count": len(items), "bytes": sum(path.stat().st_size for path in files)}

    def finish_deletions(self) -> bool:
        directory = self.root / ".foluma/deleted"
        owned_files(self.root, directory)
        pending = False
        for staged in directory.iterdir() if directory.exists() else []:
            if not staged.is_dir() or not re.fullmatch(r"[A-Za-z0-9_-]{1,80}", staged.name):
                raise ValueError(t("Invalid project book identity"))
            item = next((item for item in self.state["items"] if item["id"] == staged.name), None)
            if item:
                if not item.get("removed"):
                    raise ValueError(t("Invalid project book identity"))
                for name, destination in zip(("pdf", "book"), self.deletion_paths(item["id"])):
                    source = staged / name
                    if source.exists():
                        owned_files(self.root, destination)
                        if destination.exists():
                            raise ValueError(t("Destination already exists: {0}", destination.name))
                        destination.parent.mkdir(parents=True, exist_ok=True)
                        source.rename(destination)
            try:
                shutil.rmtree(staged)
            except OSError:
                pending = True
        return pending

    def delete(self, ids: list[str]) -> dict:
        info = self.delete_info(ids)
        items = self.selected(ids, removed=True)
        self.finish_deletions()
        with self.change() as (move, _, _directories):
            for item in items:
                for name, source in zip(("pdf", "book"), self.deletion_paths(item["id"])):
                    if source.exists():
                        move(source, self.root / ".foluma/deleted" / item["id"] / name)
            self.state["items"] = [item for item in self.state["items"] if item not in items]
            if self.state["current_id"] in ids:
                self.state["current_id"] = None
        pending = self.finish_deletions()
        return {"deleted": info["count"], "cleanup_pending": pending}

    def group(self, name: str, previous: str | None = None, ids: list[str] | None = None):
        name = folder_name(name)
        if ids is not None:
            if previous is not None:
                raise ValueError(t("Only a new group can move selected books"))
            return self.move_books(ids, name, create=True)
        if previous is not None:
            source = self.group_path(previous)
            if not previous:
                raise ValueError(t("Ungrouped cannot be renamed"))
            if name == previous:
                return
        target = contained(self.root, name)
        if target.exists() or name in self.state["groups"]:
            raise ValueError(t("Destination already exists: {0}", name))
        with self.change() as (move, _, directories):
            if previous is None:
                target.mkdir()
                directories.append(target)
                self.state["groups"].append(name)
            else:
                move(source, target)
                self.state["groups"][self.state["groups"].index(previous)] = name
                for item in self.state["items"]:
                    if item["group"] == previous:
                        item["group"] = name
                        if not item.get("removed"):
                            item["path"] = str(target / Path(item["path"]).name)

    def delete_group(self, name: str):
        directory = self.group_path(name)
        if not name:
            raise ValueError(t("Ungrouped cannot be removed"))
        items = [item for item in self.state["items"] if item["group"] == name and not item.get("removed")]
        known = {Path(item["path"]) for item in items}
        if directory.exists() and any(path not in known for path in directory.iterdir()):
            raise ValueError(t("This folder contains other files. Move them out before removing the group."))
        with self.change() as (move, _, _directories):
            for item in items:
                old, target = Path(item["path"]), self.root / Path(item["path"]).name
                if target.exists() or any(
                    other is not item and other["path"] == str(target) for other in self.state["items"]
                ):
                    raise ValueError(t("Destination already exists: {0}", target.name))
                if old.exists():
                    self.ensure_source(item)
                    move(old, target)
                item.update(group="", path=str(target))
            self.state["groups"].remove(name)
            # Moving the now-empty directory keeps this operation reversible on a save failure.
            if directory.exists():
                move(directory, contained(self.root, f".foluma/removed-groups/{new_id()}"))

    def relink(self, identifier: str, path: str):
        item = self.item(identifier)
        source = Path(path).resolve(strict=True)
        fingerprint = digest(source)
        if item["sha256"] is not None and fingerprint != item["sha256"]:
            raise ValueError(t("The file differs from the original source and cannot be relinked"))
        target = Path(item["path"])
        if target.is_file():
            raise ValueError(t("The project already has a file at this location. Move it out before relinking."))
        with self.change() as (_, copies, _directories):
            self.copy_source(source, target)
            copies.append(target)
            item["sha256"] = fingerprint
            item["changed"] = False
            item.pop("stamp", None)

    def reorder(self, ids: list[str]):
        active = [item for item in self.state["items"] if not item.get("removed")]
        if (
            not isinstance(ids, list)
            or not all(isinstance(i, str) for i in ids)
            or len(ids) != len(active)
            or set(ids) != {item["id"] for item in active}
        ):
            raise ValueError(t("Order must include every active book exactly once"))
        with self.change():
            self.state["items"] = [self.item(identifier) for identifier in ids] + [
                item for item in self.state["items"] if item.get("removed")
            ]

    def refresh(self, *, verify=True):
        previous = {item["id"]: item["path"] for item in self.state["items"] if not item.get("removed")}
        if self.state["output_directory"] and not Path(self.state["output_directory"]).is_absolute():
            self.state["output_directory"] = str(contained(self.root, self.state["output_directory"]))
        groups = sorted(
            (
                p.name
                for p in self.root.iterdir()
                if p.is_dir() and not p.is_symlink() and not p.name.startswith(".") and p.suffix != ".mteproj"
            ),
            key=natural_key,
        )
        files, stamps = {}, {}
        known = {item["path"]: item for item in self.state["items"] if not item.get("removed")}
        tracked = self.extensions | {Path(item["path"]).suffix.lower() for item in self.state["items"]}
        for directory in [self.root, *(self.root / group for group in groups)]:
            for path in directory.iterdir():
                if path.is_file() and not path.is_symlink() and path.suffix.lower() in tracked:
                    name = str(path)
                    stat = path.stat()
                    stamps[name] = [stat.st_size, stat.st_mtime_ns]
                    item = known.get(name)
                    # ponytail: startup trusts file stamps; explicit refresh detects edits preserving size and time.
                    files[name] = (item["sha256"] if not verify and item and item.get("sha256")
                                   and item.get("stamp") == stamps[name] else digest(path))
        with self.change():
            active = [item for item in self.state["items"] if not item.get("removed")]
            for item in active:
                if item["sha256"] is None and item["path"] in files:
                    item["sha256"] = files[item["path"]]
            claimed = {item["path"] for item in active if files.get(item["path"]) == item["sha256"]}
            for item in active:
                if item["path"] not in claimed:
                    matches = [path for path, sha in files.items() if sha == item["sha256"] and path not in claimed]
                    missing_twins = [
                        other for other in active if other["sha256"] == item["sha256"] and other["path"] not in claimed
                    ]
                    if len(matches) == 1 and len(missing_twins) == 1:
                        item["path"] = matches[0]
                        claimed.add(matches[0])
                item["changed"] = item["path"] in files and files[item["path"]] != item["sha256"]
                parent = Path(item["path"]).parent
                item["group"] = parent.name if parent != self.root else ""
                if not item["changed"] and item["path"] in files:
                    item["stamp"] = stamps[item["path"]]
                else:
                    item.pop("stamp", None)
            known = {item["path"] for item in active}
            for path in sorted(
                (path for path in files.keys() - known if Path(path).suffix.lower() in self.extensions), key=natural_key
            ):
                self.state["items"].append(self.new_item(Path(path), files[path]) | {"stamp": stamps[path]})
            self.state["groups"] = list(dict.fromkeys([*groups, *(item["group"] for item in active if item["group"])]))
            self.state["refreshed_at"] = datetime.now(UTC).isoformat()
        items = [item for item in self.state["items"] if not item.get("removed")]
        return {
            "added": sum(item["id"] not in previous for item in items),
            "renamed": sum(item["id"] in previous and item["path"] != previous[item["id"]] for item in items),
            "missing": sum(not Path(item["path"]).is_file() for item in items),
            "changed": sum(bool(item.get("changed")) for item in items),
        }

    def snapshot(self) -> dict:
        result = super().snapshot()
        result.update(directory=str(self.root), groups=self.state["groups"][:])
        result["removed"] = [item for item in result["items"] if item.get("removed")]
        result["items"] = [item for item in result["items"] if not item.get("removed")]
        return result
