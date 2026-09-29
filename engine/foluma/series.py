"""A folder's book list and independent, ordinary Foluma projects."""

from __future__ import annotations

import copy
import hashlib
import json
import re
from pathlib import Path

from .i18n import t
from .model import Session
from .storage import atomic_json, open_project, parse_json, save_project


def path_id(path: str) -> str:
    return hashlib.sha256(path.encode()).hexdigest()


def natural_key(path: str):
    return [int(part) if part.isdigit() else part.casefold() for part in re.split(r"(\d+)", path)]


class Series:
    def __init__(self, data: Path, paths: list[str]):
        if not isinstance(paths, list) or not paths or not all(isinstance(p, str) for p in paths):
            raise ValueError(t("Choose a folder or PDF files"))
        roots = sorted({str(Path(p).resolve()) for p in paths})
        self.directory = data / "series" / path_id(json.dumps(roots))
        self.path = self.directory / "series.json"
        files = set()
        for name in roots:
            root = Path(name)
            if not root.exists() and not self.path.exists():
                raise ValueError(t("Folder or file is missing: {0}", name))
            for item in root.iterdir() if root.is_dir() else [root]:
                if item.is_file() and item.suffix.lower() == ".pdf":
                    files.add(str(item.resolve()))
        if not files and not self.path.exists():
            raise ValueError(t("No PDF files were found in this folder"))
        self.state = parse_json(self.path.read_text("utf-8")) if self.path.exists() else {
            "schema": 1, "id": self.directory.name, "roots": roots,
            "name": Path(roots[0]).name if len(roots) == 1 and Path(roots[0]).is_dir() else Path(roots[0]).parent.name,
            "current_id": None, "output_directory": "", "items": [],
        }
        if self.state.get("schema") != 1 or not isinstance(self.state.get("items"), list):
            raise ValueError(t("Unsupported series format"))
        known = {item["path"]: item for item in self.state["items"]}
        # Keep missing sources in the list so saved edits remain reachable for relinking.
        for name in files:
            known.setdefault(name, {"id": path_id(name), "path": name, "title": Path(name).stem,
                                    "revision": None, "reviewed_revision": None, "exported_revision": None,
                                    "document_id": None, "page_count": None, "output": None, "settings": {}})
        self.state["items"] = sorted(known.values(), key=lambda item: natural_key(item["path"]))
        self.save()
        atomic_json(data / "series" / "current.json", {"paths": roots})

    def save(self):
        atomic_json(self.path, self.state)

    def item(self, identifier: str) -> dict:
        for item in self.state["items"]:
            if item["id"] == identifier and re.fullmatch(r"[a-f0-9]{64}", identifier):
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

    def remember(self, item: dict, session: Session):
        path = self.project(item)
        # ponytail: checkpoint one ordinary project per edit; coalesce writes if large books make this slow.
        save_project(session.book, path)
        item.update(document_id=session.book["id"], revision=session.book["revision"],
                    title=session.book["metadata"]["title"], page_count=len(session.book["pages"]))
        self.save()
        session.project_path = str(path)
        session.saved_revision = session.book["revision"]

    def current(self, session: Session | None) -> dict | None:
        if session:
            return next((item for item in self.state["items"] if item["document_id"] == session.book["id"]), None)
        return None

    def snapshot(self) -> dict:
        result = copy.deepcopy(self.state)
        for item in result["items"]:
            item["reviewed"] = item["revision"] is not None and item["reviewed_revision"] == item["revision"]
            item["exported"] = (item["revision"] is not None and item["exported_revision"] == item["revision"]
                                and bool(item["output"] and Path(item["output"]).is_file()))
            item["needs_export"] = item["exported_revision"] is not None and not item["exported"]
            item["missing"] = not Path(item["path"]).is_file()
        return result
