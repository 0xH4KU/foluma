import shutil
import subprocess
import sys
from pathlib import Path

root = Path(__file__).resolve().parents[1]
build = root / "build"
build.mkdir(exist_ok=True)
entry = build / "engine_entry.py"
entry.write_text("from foluma.__main__ import main\nmain()\n")
subprocess.run(
    [
        sys.executable,
        "-m",
        "PyInstaller",
        "--noconfirm",
        "--clean",
        "--onedir",
        "--name",
        "foluma-engine",
        "--distpath",
        str(build / "pyinstaller"),
        "--workpath",
        str(build / "pyinstaller-work"),
        "--specpath",
        str(build),
        "--paths",
        str(root / "engine"),
        "--exclude-module",
        "pymupdf",
        "--exclude-module",
        "fitz",
        str(entry),
    ],
    cwd=root,
    check=True,
)
destination = build / "engine"
if destination.exists():
    shutil.rmtree(destination)
shutil.copytree(build / "pyinstaller" / "foluma-engine", destination, symlinks=True)
for package in build.glob("*.mte-plugin"):
    shutil.copyfile(package, destination / package.name)
print(f"Bundled engine: {destination}")
