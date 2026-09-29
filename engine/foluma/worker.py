from __future__ import annotations

import json
import sys
from pathlib import Path

from .i18n import messages, t
from .storage import parse_json


def emit(value: dict) -> None:
    print(json.dumps(value, ensure_ascii=False, allow_nan=False), flush=True)


def run(path: str) -> None:
    from . import media

    request = parse_json(Path(path).read_text("utf-8"))
    messages.set(request.get("messages", {}))
    operation, params = request["operation"], request["params"]
    data = Path(request["data"])

    def progress(done, total, message):
        emit({"progress": {"done": done, "total": total, "message": message}})

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
        emit({"result": result})
    except Exception as exc:
        emit({"error": {"message": str(exc), "data": getattr(exc, "data", None)}})
        sys.exit(1)
