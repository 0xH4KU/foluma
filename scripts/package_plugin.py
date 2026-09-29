import hashlib
import json
import shutil
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile

root = Path(__file__).resolve().parents[1]
artifacts = root / "artifacts"
artifacts.mkdir(exist_ok=True)
catalog = {"schema": 1, "plugins": []}
for folder in ("editor", "language-zh-Hant"):
    manifest_path = root / "plugins" / folder / "manifest.json"
    manifest = json.loads(manifest_path.read_text())
    content = root / "build/editor" if folder == "editor" else manifest_path.parent
    name = f"{manifest['id']}-{manifest['version']}.mte-plugin"
    output = artifacts / name
    with ZipFile(output, "w", ZIP_DEFLATED) as archive:
        archive.write(manifest_path, "manifest.json")
        for source in sorted(content.rglob("*")):
            if source.is_file() and source != manifest_path:
                archive.write(source, source.relative_to(content).as_posix())
    shutil.copyfile(output, root / "build" / f"{folder}.mte-plugin")
    sha256 = hashlib.sha256(output.read_bytes()).hexdigest()
    catalog["plugins"].append(
        manifest
        | {
            "sha256": sha256,
            "url": f"https://github.com/0xH4KU/foluma/releases/download/v{manifest['version']}/{name}",
        }
    )
    print(f"{output}\nSHA-256: {sha256}")
(artifacts / "catalog.json").write_text(json.dumps(catalog, ensure_ascii=False, indent=2) + "\n")
