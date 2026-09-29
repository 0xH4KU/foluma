from __future__ import annotations

import argparse
import os
from pathlib import Path


def main() -> None:
    parser = argparse.ArgumentParser(prog="foluma-engine")
    parser.add_argument("--serve", action="store_true")
    parser.add_argument("--worker")
    parser.add_argument("--safe-mode", action="store_true")
    args = parser.parse_args()
    if args.worker:
        from .worker import run

        run(args.worker)
    else:
        from .service import serve

        data = Path(os.environ.get("FOLUMA_DATA", str(Path.home() / ".foluma"))).resolve()
        serve(data, args.safe_mode or os.environ.get("FOLUMA_SAFE_MODE") == "1")


if __name__ == "__main__":
    main()
