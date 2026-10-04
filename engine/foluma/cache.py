"""Preview cache lifecycle, generation limits and cleanup."""

from __future__ import annotations

import threading
import time
from pathlib import Path

from .i18n import t
from .storage import owned_files, preview_path

DEFAULT_LIMIT = 5_000_000_000


class PreviewCache:
    def __init__(self, data: Path, limit=DEFAULT_LIMIT):
        self.data = data
        self.directory = data / "previews"
        self.limit = limit if type(limit) is int and 1_000_000_000 <= limit <= 1_000_000_000_000 else DEFAULT_LIMIT
        self.lock = threading.RLock()
        self.slots = threading.Semaphore(2)
        self.active: dict[Path, int] = {}
        self.timer: threading.Timer | None = None
        self.checked = 0.0
        self.closed = False
        self.maintain()

    def info(self, clear=False) -> dict:
        # ponytail: scans hold the cache lock; index sizes if large caches make scans slow.
        with self.lock:
            entries = [(path, path.stat()) for path in owned_files(self.data, self.directory) if path.suffix == ".png"]
            used = sum(stat.st_size for _, stat in entries)
            before, now = used, time.time()
            for path, stat in sorted(entries, key=lambda entry: entry[1].st_mtime):
                if not clear and used <= self.limit:
                    break
                if path in self.active or not clear and now - stat.st_mtime < 60:
                    continue
                path.unlink()
                used -= stat.st_size
            return {"used": used, "limit": self.limit, "freed": before - used}

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

    def preview(self, book: dict, page_id: str, size: int, load) -> str:
        output = preview_path(book, page_id, size, self.directory)
        with self.lock:
            if self.closed:
                raise ValueError(t("Foluma is closing"))
            if output.is_file():
                output.touch()
                if time.monotonic() - self.checked >= 30:
                    self.maintain()
                return f"previews/{output.name}"
            self.active[output] = self.active.get(output, 0) + 1
        try:
            with self.slots:
                return load()
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
