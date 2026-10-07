from __future__ import annotations

import json
import sys
import time
from pathlib import Path

from .i18n import messages, t
from .model import EngineError as EngineError
from .storage import parse_json


def job_info(job: dict) -> dict:
    return {key: value for key, value in job.items()
            if not key.startswith("_") and key not in ("process", "cancelled", "opening_over")}


def emit(value: dict) -> None:
    print(json.dumps(value, ensure_ascii=False, allow_nan=False), flush=True)


def execute(operation: str, handler, translations: dict) -> None:
    started = time.perf_counter()
    messages.set(translations)
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
            emit(
                {
                    "timing": {
                        "operation": operation,
                        "seconds": round(now - started, 3),
                        "phases": {key: round(value, 3) for key, value in timings.items()},
                    }
                }
            )

    try:
        result = handler(progress)
        report_timing()
        emit({"result": result})
    except Exception as exc:
        report_timing()
        emit({"error": {"message": str(exc), "data": getattr(exc, "data", None)}})
        sys.exit(1)


def run(path: str) -> None:
    from . import media

    request = parse_json(Path(path).read_text("utf-8"))
    operation, params = request["operation"], request["params"]
    data = Path(request["data"])

    def handle(progress):
        if operation == "preview":
            return media.preview(**params, directory=data / "previews")
        if operation == "images.import":
            return media.import_images(**params, directory=data / "assets")
        if operation == "images.export":
            return media.export_images(**params, progress=progress)
        if operation == "images.prepare_export":
            return media.export_snapshot(**params, progress=progress)
        raise ValueError(t("Unsupported background task"))

    execute(operation, handle, request.get("messages", {}))


def run_plugin(handler) -> None:
    request = parse_json(sys.stdin.readline())
    operation = request["operation"]
    execute(
        operation,
        lambda progress: handler(operation, request.get("input", {}), request.get("book"), progress),
        request.get("messages", {}),
    )
