"""Preview and imported-image cache lifecycle, generation limits and cleanup."""

from __future__ import annotations

import threading
import time
from pathlib import Path

from .i18n import t
from .storage import owned_files, preview_path

DEFAULT_LIMIT = 5_000_000_000


class PreviewCache:
    def __init__(self, data: Path, limit=DEFAULT_LIMIT, *, lock, protected_assets):
        self.data = data
        self.directory = data / "previews"
        self.limit = limit if type(limit) is int and 1_000_000_000 <= limit <= 1_000_000_000_000 else DEFAULT_LIMIT
        self.lock = lock
        self.protected_assets = protected_assets
        self.slots = threading.Semaphore(2)
        self.active: dict[Path, int] = {}
        self.timer: threading.Timer | None = None
        self.checked = 0.0
        self.closed = False
        self.maintain()

    def info(self, clear=False) -> dict:
        # shortcut: scans hold the document lock; index sizes if large caches make scans slow.
        with self.lock:
            entries = []
            sizes = {"previews": 0, "assets": 0}
            for kind in sizes:
                for path in owned_files(self.data, self.data / kind):
                    if kind == "previews" and path.suffix != ".png":
                        continue
                    try:
                        stat = path.stat()
                    except FileNotFoundError:
                        continue
                    entries.append((path, stat, kind))
            protected = self.protected_assets()
            kept = set(self.active)
            for path, stat, kind in entries:
                sizes[kind] += stat.st_size
                if kind == "assets" and (protected is None or self.active or path.resolve() in protected):
                    kept.add(path)
            used = sum(sizes.values())
            before, now = used, time.time()
            for path, stat, kind in sorted(entries, key=lambda entry: entry[1].st_mtime):
                if not clear and used <= self.limit:
                    break
                if path in kept or not clear and now - stat.st_mtime < 60:
                    continue
                path.unlink()
                used -= stat.st_size
                sizes[kind] -= stat.st_size
            return {"used": used, "limit": self.limit, "freed": before - used, **sizes,
                    "in_use": sum(stat.st_size for path, stat, _ in entries if path in kept)}

    def schedule(self, delay: int):
        if self.closed or self.timer is not None:
            return
        self.timer = threading.Timer(delay, self.maintain)
        self.timer.daemon = True
        self.timer.start()

    def maintain(self):
        with self.lock:
            if self.closed:
                return
            self.checked = time.monotonic()
            if self.timer:
                self.timer.cancel()
                self.timer = None
            try:
                state = self.info()
                if state["used"] > state["limit"]:
                    self.schedule(60)
            except (OSError, ValueError):
                pass

    def preview(self, snapshot, page_id: str, size: int, load) -> str:
        with self.lock:
            if self.closed:
                raise ValueError(t("Foluma is closing"))
            book = snapshot()
            output = preview_path(book, page_id, size, self.directory)
            if output.is_file():
                output.touch()
                if time.monotonic() - self.checked >= 30:
                    self.maintain()
                return f"previews/{output.name}"
            self.active[output] = self.active.get(output, 0) + 1
        try:
            with self.slots:
                return load(book)
        finally:
            with self.lock:
                self.active[output] -= 1
                if not self.active[output]:
                    del self.active[output]
                if time.monotonic() - self.checked >= 30:
                    self.maintain()
                else:
                    self.schedule(30)

    def close(self):
        with self.lock:
            self.closed = True
            if self.timer:
                self.timer.cancel()
                self.timer = None
