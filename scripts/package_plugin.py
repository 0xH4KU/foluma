import argparse
import hashlib
import json
import shutil
import subprocess
import sys
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile

from foluma.plugins import platform_id

root = Path(__file__).resolve().parents[1]
release_version = json.loads((root / "src-tauri/tauri.conf.json").read_text())["version"]
parser = argparse.ArgumentParser()
parser.add_argument("--development", action="store_true", help="Use local Python for development packages in build/ only")
parser.add_argument("--formats-only", action="store_true")
arguments = parser.parse_args()
artifacts = root / "artifacts"
artifacts.mkdir(exist_ok=True)
build = root / "build"
build.mkdir(exist_ok=True)
catalog = {"schema": 1, "plugins": []}
for manifest_path in sorted((root / "plugins").glob("*/manifest.json")):
    manifest = json.loads(manifest_path.read_text())
    if arguments.formats_only and not manifest.get("format"):
        continue
    folder = manifest_path.parent.name
    content = root / "build/editor" if folder == "editor" else manifest_path.parent
    worker = None
    if manifest.get("format"):
        worker_name = f"{folder}-worker" + (".exe" if sys.platform == "win32" else "")
        worker = build / "plugin-workers" / worker_name
        worker.parent.mkdir(exist_ok=True)
        if arguments.development:
            worker.write_text(f'#!{sys.executable}\nimport runpy, sys\nfrom pathlib import Path\n'
                              f'sys.path[:0] = [str(Path(__file__).resolve().parents[1]), {str(root / "engine")!r}]\n'
                              'runpy.run_path(str(Path(__file__).resolve().parents[1] / "worker.py"), run_name="__main__")\n')
            worker.chmod(0o755)
        else:
            subprocess.run([sys.executable, "-m", "PyInstaller", "--noconfirm", "--clean", "--onefile",
                            "--name", worker_name.removesuffix(".exe"), "--distpath", str(worker.parent),
                            "--workpath", str(build / "plugin-work" / folder), "--specpath", str(build),
                            "--paths", str(root / "engine"), "--paths", str(root / "plugins"),
                            "--paths", str(content), str(content / "worker.py")],
                           cwd=root, check=True)
        manifest["workers"] = {platform_id(): f"workers/{worker_name}"}
        manifest["platforms"] = [platform_id()]
    name = f"{manifest['id']}-{manifest['version']}.mte-plugin"
    output = build / f"{folder}.mte-plugin" if arguments.development else artifacts / name
    with ZipFile(output, "w", ZIP_DEFLATED) as archive:
        archive.writestr("manifest.json", json.dumps(manifest, ensure_ascii=False, indent=2))
        if worker:
            archive.write(worker, manifest["workers"][platform_id()])
        if not worker or arguments.development:
            if folder in ("cbz-import", "zip-import", "epub-import"):
                archive.write(root / "plugins/image_archive.py", "image_archive.py")
            for source in sorted(content.rglob("*")):
                if source.is_file() and source != manifest_path and "__pycache__" not in source.parts:
                    archive.write(source, source.relative_to(content).as_posix())
    if arguments.development:
        print(f"Development package: {output}")
        continue
    shutil.copyfile(output, build / f"{folder}.mte-plugin")
    sha256 = hashlib.sha256(output.read_bytes()).hexdigest()
    catalog["plugins"].append(
        manifest
        | {
            "sha256": sha256,
            "url": f"https://github.com/0xH4KU/foluma/releases/download/v{release_version}/{name}",
        }
    )
    print(f"{output}\nSHA-256: {sha256}")
if not arguments.development:
    (artifacts / "catalog.json").write_text(json.dumps(catalog, ensure_ascii=False, indent=2) + "\n")
