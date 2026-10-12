import sys

from foluma.storage import parse_json
from foluma.worker import execute
from foluma_page_layout import handle

if __name__ == "__main__":
    request = parse_json(sys.stdin.readline())
    params = request.get("input", {})
    if isinstance(params, dict) and "asset_directory" in request:
        params = params | {"asset_directory": request["asset_directory"]}
    execute(request["operation"],
            lambda progress: handle(request["operation"], params, request.get("book"), progress),
            request.get("messages", {}))
