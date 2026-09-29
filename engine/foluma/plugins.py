from __future__ import annotations

import os
import platform
import re
import shutil
import stat
import tempfile
import urllib.error
import urllib.request
from pathlib import Path
from zipfile import BadZipFile, ZipFile

from .i18n import t
from .storage import atomic_json, contained, digest, parse_json

CATALOG_URL = "https://github.com/0xH4KU/foluma/releases/latest/download/catalog.json"
MAX_PACKAGE = 256 * 1024 * 1024


def platform_id() -> str:
    system = {"Darwin": "macos", "Windows": "windows", "Linux": "linux"}[platform.system()]
    machine = {"aarch64": "arm64", "AMD64": "x86_64"}.get(platform.machine(), platform.machine())
    return f"{system}-{machine}"


def unpack(path: Path, directory: Path) -> None:
    with ZipFile(path) as archive:
        members = archive.infolist()
        if len(members) > 5000 or sum(m.file_size for m in members) > MAX_PACKAGE:
            raise ValueError(t("Package is too large (limit: 256 MB / 5000 files)"))
        names = set()
        for member in members:
            target = contained(directory, member.filename)
            if target in names or stat.S_ISLNK(member.external_attr >> 16) or member.flag_bits & 1:
                raise ValueError(t("Package contains duplicate paths, symbolic links or encrypted files"))
            names.add(target)
            if member.is_dir():
                target.mkdir(parents=True, exist_ok=True)
                continue
            target.parent.mkdir(parents=True, exist_ok=True)
            with archive.open(member) as src, target.open("xb") as dst:
                shutil.copyfileobj(src, dst)
            if member.external_attr >> 16 & 0o111:
                target.chmod(0o755)


def manifest_at(root: Path) -> dict:
    manifest = parse_json((root / "manifest.json").read_text("utf-8"))
    if (
        not isinstance(manifest, dict)
        or not isinstance(manifest.get("id"), str)
        or not re.fullmatch(r"[a-z0-9][a-z0-9.-]{1,79}", manifest["id"])
    ):
        raise ValueError(t("Invalid plugin ID"))
    if (
        not isinstance(manifest.get("version"), str)
        or not re.fullmatch(r"\d+\.\d+\.\d+", manifest["version"])
        or type(manifest.get("api_version")) is not int
        or manifest["api_version"] != 1
    ):
        raise ValueError(t("Incompatible plugin version or API version"))
    if not isinstance(manifest.get("name"), str) or not 0 < len(manifest["name"]) <= 120:
        raise ValueError(t("Invalid plugin name"))
    platforms = manifest.get("platforms", [])
    if (
        not isinstance(platforms, list)
        or not all(isinstance(p, str) for p in platforms)
        or not ({"all", platform_id()} & set(platforms))
    ):
        raise ValueError(t("Plugin does not support this operating system or CPU"))
    ui = manifest.get("ui", {})
    if not isinstance(ui, dict) or (ui and (not isinstance(ui.get("title"), str) or not ui.get("entry"))):
        raise ValueError(t("Invalid plugin workspace configuration"))
    for key in ("entry", "style"):
        if key in ui and not contained(root, ui[key]).is_file():
            raise ValueError(t("Plugin file is missing: {0}", key))
    workers = manifest.get("workers", {})
    if not isinstance(workers, dict):
        raise ValueError(t("Invalid worker configuration"))
    for worker in workers.values():
        if not contained(root, worker).is_file():
            raise ValueError(t("Plugin worker file is missing"))
    language = manifest.get("language")
    if language is not None:
        if (
            not isinstance(language, dict)
            or not isinstance(language.get("locale"), str)
            or not re.fullmatch(r"[a-z]{2,8}(?:-[A-Za-z0-9]{1,8})*", language["locale"])
            or language["locale"] == "en"
            or not isinstance(language.get("name"), str)
            or not 0 < len(language["name"]) <= 120
            or not isinstance(language.get("messages"), str)
            or ui
            or workers
        ):
            raise ValueError(t("Invalid language pack"))
        translations = parse_json(contained(root, language["messages"]).read_text("utf-8"))
        if (
            not isinstance(translations, dict)
            or len(translations) > 5000
            or any(
                not isinstance(value, str)
                or len(key) > 8192
                or len(value) > 8192
                or set(re.findall(r"\{\d+\}", key)) != set(re.findall(r"\{\d+\}", value))
                for key, value in translations.items()
            )
        ):
            raise ValueError(t("Invalid translations or mismatched placeholders"))
    if not ui.get("entry") and not workers and not language:
        raise ValueError(t("Plugins need a workspace, worker or language pack"))
    return manifest


def download(url: str, target: Path, limit: int = MAX_PACKAGE) -> None:
    if not isinstance(url, str) or not url.startswith("https://"):
        raise ValueError(t("Downloads must use HTTPS"))
    request = urllib.request.Request(url, headers={"User-Agent": "Foluma/0.1"})
    with urllib.request.urlopen(request, timeout=20) as response, target.open("wb") as out:
        if not response.geturl().startswith("https://"):
            raise ValueError(t("Insecure download redirect"))
        count = 0
        while chunk := response.read(1024 * 1024):
            count += len(chunk)
            if count > limit:
                raise ValueError(t("Download exceeds the size limit"))
            out.write(chunk)


class Plugins:
    def __init__(self, data: Path, safe: bool = False, bundled_editor: Path | None = None):
        self.data = data
        self.bundled_directory = bundled_editor.parent if bundled_editor else None
        self.root = data / "plugins"
        self.root.mkdir(parents=True, exist_ok=True)
        self.config_path = data / "plugins.json"
        first_start = not self.config_path.exists()
        self.errors: list[str] = []
        try:
            self.config = parse_json(self.config_path.read_text("utf-8")) if self.config_path.exists() else {}
            if not isinstance(self.config, dict) or not isinstance(self.config.get("installed", {}), dict):
                raise ValueError(t("Invalid plugin settings"))
            for plugin_id, item in self.config.get("installed", {}).items():
                if not isinstance(item, dict) or type(item.get("enabled")) is not bool:
                    raise ValueError(t("Invalid plugin settings"))
                self.directory(plugin_id, item.get("version", ""))
        except (OSError, ValueError):
            self.config = {}
            self.errors.append(
                t("Plugin settings are damaged. No plugins were loaded; please reinstall the packages you need.")
            )
        next_safe = bool(self.config.pop("safe_next_start", False))
        self.safe = safe or next_safe
        self.active: dict[str, dict] = {}
        # An existing config records the user's choice, including removing every plugin.
        if first_start and bundled_editor is not None and bundled_editor.is_file():
            try:
                self.install(str(bundled_editor), expected_id="org.foluma.editor")
            except (OSError, ValueError, BadZipFile) as exc:
                self.errors.append(t("Bundled editor could not be installed: {0}", exc))
        atomic_json(self.config_path, self.config)
        for plugin_id, item in self.config.get("installed", {}).items():
            try:
                if item.get("enabled") and not self.safe:
                    root = self.directory(plugin_id, item["version"])
                    self.active[plugin_id] = manifest_at(root)
            except (ValueError, OSError, KeyError) as exc:
                self.errors.append(f"{plugin_id}: {exc}")
        for directory in self.root.iterdir():
            if self.errors:
                break
            if (
                not directory.is_dir()
                or directory.is_symlink()
                or not re.fullmatch(r"[a-z0-9][a-z0-9.-]{1,79}", directory.name)
            ):
                continue
            keep = self.config.get("installed", {}).get(directory.name, {}).get("version")
            for version in directory.iterdir():
                if (
                    version.is_dir()
                    and not version.is_symlink()
                    and re.fullmatch(r"\d+\.\d+\.\d+", version.name)
                    and version.name != keep
                ):
                    shutil.rmtree(version)

    def directory(self, plugin_id: str, version: str) -> Path:
        if (
            not isinstance(plugin_id, str)
            or not isinstance(version, str)
            or not re.fullmatch(r"[a-z0-9][a-z0-9.-]{1,79}", plugin_id)
            or not re.fullmatch(r"\d+\.\d+\.\d+", version)
        ):
            raise ValueError(t("Invalid plugin location"))
        return contained(self.root, f"{plugin_id}/{version}")

    def list(self) -> dict:
        items = []
        for plugin_id, item in self.config.get("installed", {}).items():
            try:
                manifest = manifest_at(self.directory(plugin_id, item["version"]))
                active = self.active.get(plugin_id)
                items.append(
                    manifest
                    | {
                        "enabled": item["enabled"],
                        "active": bool(active),
                        "active_version": active["version"] if active else None,
                        "pending": bool(active) != item["enabled"]
                        or bool(active and active["version"] != item["version"]),
                    }
                )
            except (ValueError, OSError) as exc:
                self.errors.append(str(exc))
        return {
            "items": items,
            "active": list(self.active.values()),
            "safe_mode": self.safe,
            "errors": list(dict.fromkeys(self.errors)),
            "restart_required": any(i["pending"] for i in items)
            or any(key not in self.config.get("installed", {}) for key in self.active),
        }

    def locale(self) -> dict:
        available = [{"code": "en", "name": "English"}]
        selected = self.config.get("locale", "en")
        result = {"code": "en", "name": "English", "messages": {}, "available": available}
        for plugin in self.active.values():
            language = plugin.get("language")
            if not language:
                continue
            available.append({"code": language["locale"], "name": language["name"]})
            if language["locale"] == selected:
                path = contained(self.directory(plugin["id"], plugin["version"]), language["messages"])
                result.update(code=selected, name=language["name"], messages=parse_json(path.read_text("utf-8")))
        return result

    def bundled(self) -> list[dict]:
        if not self.bundled_directory:
            return []
        return [self.inspect(str(path)) for path in sorted(self.bundled_directory.glob("*.mte-plugin"))]

    def install_bundled(self, plugin_id: str) -> dict:
        if self.bundled_directory:
            for path in self.bundled_directory.glob("*.mte-plugin"):
                if self.inspect(str(path))["id"] == plugin_id:
                    return self.install(str(path), expected_id=plugin_id)
        raise ValueError(t("Bundled package not found"))

    def set_locale(self, code: str) -> dict:
        if code not in {item["code"] for item in self.locale()["available"]}:
            raise ValueError(t("Install and enable this language pack first"))
        self.config["locale"] = code
        atomic_json(self.config_path, self.config)
        return self.locale()

    def inspect(self, path: str) -> dict:
        with tempfile.TemporaryDirectory(dir=self.data) as temp:
            unpack(Path(path), Path(temp))
            return manifest_at(Path(temp))

    def install(self, path: str, sha256: str | None = None, expected_id: str | None = None) -> dict:
        source = Path(path)
        if sha256 is not None and digest(source) != sha256:
            raise ValueError(t("Plugin SHA-256 verification failed"))
        with tempfile.TemporaryDirectory(dir=self.root) as temp:
            stage = Path(temp) / "package"
            stage.mkdir()
            unpack(source, stage)
            manifest = manifest_at(stage)
            if expected_id and manifest["id"] != expected_id:
                raise ValueError(t("Downloaded plugin ID does not match the catalog"))
            if manifest.get("language"):
                for plugin_id, item in self.config.get("installed", {}).items():
                    if plugin_id != manifest["id"]:
                        other = manifest_at(self.directory(plugin_id, item["version"]))
                        if other.get("language", {}).get("locale") == manifest["language"]["locale"]:
                            raise ValueError(t("A pack for this language is already installed"))
            dest = self.directory(manifest["id"], manifest["version"])
            if dest.exists():
                if manifest.get("language") and manifest["id"] not in self.config.get("installed", {}):
                    shutil.rmtree(dest)
                else:
                    raise ValueError(t("This version is already installed; use a new version number for a new package"))
            dest.parent.mkdir(parents=True, exist_ok=True)
            os.replace(stage, dest)
        self.config.setdefault("installed", {})[manifest["id"]] = {"version": manifest["version"], "enabled": True}
        if manifest.get("language") and not self.safe:
            self.active[manifest["id"]] = manifest
        atomic_json(self.config_path, self.config)
        return self.list()

    def set_enabled(self, plugin_id: str, enabled: bool) -> dict:
        if type(enabled) is not bool:
            raise ValueError(t("Enabled must be a boolean"))
        self.config["installed"][plugin_id]["enabled"] = enabled
        manifest = manifest_at(self.directory(plugin_id, self.config["installed"][plugin_id]["version"]))
        if manifest.get("language"):
            if enabled and not self.safe:
                self.active[plugin_id] = manifest
            else:
                self.active.pop(plugin_id, None)
                if self.config.get("locale") == manifest["language"]["locale"]:
                    self.config["locale"] = "en"
        atomic_json(self.config_path, self.config)
        return self.list()

    def remove(self, plugin_id: str) -> dict:
        installed = self.config.get("installed", {}).get(plugin_id)
        manifest = self.active.get(plugin_id, {})
        if installed and not manifest:
            try:
                manifest = manifest_at(self.directory(plugin_id, installed["version"]))
            except (OSError, ValueError):
                pass  # Damaged plugins must still be removable.
        self.config.get("installed", {}).pop(plugin_id, None)
        if manifest.get("language"):
            self.active.pop(plugin_id, None)
            if self.config.get("locale") == manifest["language"]["locale"]:
                self.config["locale"] = "en"
        # Keep running code intact until restart; orphaned versions are harmless local files.
        atomic_json(self.config_path, self.config)
        return self.list()

    def catalog(self) -> dict:
        cached = self.data / "catalog.json"
        error = None
        try:
            with tempfile.TemporaryDirectory(dir=self.data) as temp:
                path = Path(temp) / "catalog.json"
                download(CATALOG_URL, path, 1024 * 1024)
                value = parse_json(path.read_text("utf-8"))
                self.validate_catalog(value)
                atomic_json(cached, value)
        except (OSError, ValueError, urllib.error.URLError) as exc:
            error = t("Official catalog is unavailable. You can still install local packages. {0}", exc)
        value = parse_json(cached.read_text("utf-8")) if cached.exists() else {"plugins": []}
        self.validate_catalog(value)
        return value | {"offline": bool(error), "message": error}

    @staticmethod
    def validate_catalog(value: dict) -> None:
        if not isinstance(value, dict) or not isinstance(value.get("plugins"), list):
            raise ValueError(t("Invalid official catalog"))
        for item in value["plugins"]:
            if not re.fullmatch(r"[a-f0-9]{64}", item.get("sha256", "")) or not item.get("url", "").startswith(
                "https://"
            ):
                raise ValueError(t("Official package is missing verification data"))

    def install_official(self, plugin_id: str) -> dict:
        item = next(i for i in self.catalog()["plugins"] if i["id"] == plugin_id)
        with tempfile.TemporaryDirectory(dir=self.data) as temp:
            package = Path(temp) / "download.mte-plugin"
            download(item["url"], package)
            return self.install(str(package), item["sha256"], plugin_id)
