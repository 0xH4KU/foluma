from __future__ import annotations

import json
import sys
import time
from pathlib import Path

from .i18n import messages, t
from .storage import parse_json


def emit(value: dict) -> None:
    print(json.dumps(value, ensure_ascii=False, allow_nan=False), flush=True)


def run(path: str) -> None:
    started = time.perf_counter()
    from . import media

    request = parse_json(Path(path).read_text("utf-8"))
    messages.set(request.get("messages", {}))
    operation, params = request["operation"], request["params"]
    data = Path(request["data"])
    phase, phase_started, timings = t("Preparing"), started, {}

    def progress(done, total, message):
        nonlocal phase, phase_started
        if message != phase:
            now = time.perf_counter()
            timings[phase] = timings.get(phase, 0) + now - phase_started
            phase, phase_started = message, now
        emit({"progress": {"done": done, "total": total, "message": message}})

    def report_timing():
        now = time.perf_counter()
        timings[phase] = timings.get(phase, 0) + now - phase_started
        if operation != "preview" or now - started >= 0.25:
            emit({"timing": {"operation": operation, "seconds": round(now - started, 3),
                             "phases": {key: round(value, 3) for key, value in timings.items()}}})

    try:
        if operation == "import":
            result = media.import_pdf(**params, asset_dir=data / "assets", progress=progress)
        elif operation == "preview":
            result = media.preview(**params, directory=data / "previews")
        elif operation == "images.import":
            result = media.import_images(**params, directory=data / "assets")
        elif operation == "export":
            result = media.export_epub(**params, progress=progress)
        elif operation == "images.export":
            result = media.export_images(**params, progress=progress)
        else:
            raise ValueError(t("Unsupported background task"))
        report_timing()
        emit({"result": result})
    except Exception as exc:
        report_timing()
        emit({"error": {"message": str(exc), "data": getattr(exc, "data", None)}})
        sys.exit(1)
