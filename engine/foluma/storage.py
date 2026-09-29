from __future__ import annotations

import copy
import hashlib
import json
import os
import shutil
import tempfile
from pathlib import Path

from .i18n import t
from .model import validate


def parse_json(text: str | bytes):
    def invalid_constant(value):
        raise ValueError(t("JSON does not accept non-finite numbers: {0}", value))

    return json.loads(text, parse_constant=invalid_constant)


def digest(path: Path) -> str:
    with path.open("rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()


def atomic_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    temp = Path(name)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as out:
            json.dump(value, out, ensure_ascii=False, indent=2, allow_nan=False)
            out.flush()
            os.fsync(out.fileno())
        os.replace(temp, path)
    finally:
        temp.unlink(missing_ok=True)


def contained(root: Path, relative: str) -> Path:
    if not isinstance(relative, str) or "\\" in relative or Path(relative).is_absolute():
        raise ValueError(t("Unsafe path in package"))
    path = (root / relative).resolve()
    if not path.is_relative_to(root.resolve()):
        raise ValueError(t("Path escapes the package directory"))
    return path


def copy_asset(source: Path, directory: Path, extension: str) -> Path:
    directory.mkdir(parents=True, exist_ok=True)
    destination = directory / f"{digest(source)}.{extension}"
    if destination != source.resolve() and not destination.exists():
        with tempfile.NamedTemporaryFile(dir=directory, delete=False) as temp:
            staged = Path(temp.name)
        try:
            shutil.copyfile(source, staged)
            os.replace(staged, destination)
        finally:
            staged.unlink(missing_ok=True)
    return destination


def save_project(book: dict, directory: Path) -> None:
    directory = directory.resolve()
    if directory.suffix != ".mteproj":
        raise ValueError(t("Use a .mteproj project name"))
    if directory.exists() and not (directory / "project.json").exists() and any(directory.iterdir()):
        raise ValueError(t("Destination folder is not a Foluma project"))
    directory.mkdir(parents=True, exist_ok=True)
    data = copy.deepcopy(book)
    for source in data["sources"].values():
        try:
            source["path"] = os.path.relpath(source["path"], directory)
        except ValueError:
            pass
    for asset in data["assets"].values():
        if asset["kind"] == "file":
            path = copy_asset(Path(asset["path"]), directory / "assets", asset["ext"])
            asset["path"] = path.relative_to(directory).as_posix()
    atomic_json(directory / "project.json", data)


def open_project(directory: Path) -> dict:
    directory = directory.resolve()
    data = parse_json((directory / "project.json").read_text(encoding="utf-8"))
    validate(data)
    for source in data["sources"].values():
        source["path"] = str((directory / source["path"]).resolve())
    for asset in data["assets"].values():
        if asset["kind"] == "file":
            asset["path"] = str(contained(directory, asset["path"]))
    return data


def check_sources(book: dict, asset_ids: set[str] | None = None) -> None:
    assets = [a for key, a in book["assets"].items() if asset_ids is None or key in asset_ids]
    for source_id in {a["source_id"] for a in assets if a["kind"] == "pdf"}:
        source = book["sources"][source_id]
        path = Path(source["path"])
        if not path.is_file():
            raise ValueError(t("Source moved. Please relink: {0}", path.name))
        if digest(path) != source["sha256"]:
            raise ValueError(t("Source changed. Please import again: {0}", path.name))
    for asset in assets:
        if asset["kind"] == "file" and not Path(asset["path"]).is_file():
            raise ValueError(t("Project asset is missing: {0}", Path(asset["path"]).name))
