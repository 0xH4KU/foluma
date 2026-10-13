import json
import runpy
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from foluma.plugins import manifest_at, platform_id, unpack


class PackagingTests(unittest.TestCase):
    def test_optional_ui_package_uses_its_own_built_workspace(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            script = root / "scripts/package_plugin.py"
            script.parent.mkdir()
            shutil.copyfile(Path(__file__).resolve().parents[1] / "scripts/package_plugin.py", script)
            (root / "src-tauri").mkdir()
            (root / "src-tauri/tauri.conf.json").write_text('{"version":"1.0.0"}')
            source = root / "plugins/tool"
            source.mkdir(parents=True)
            (source / "manifest.json").write_text(json.dumps({
                "id": "test.tool", "name": "Test tool", "version": "1.0.0", "api_version": 1, "platforms": ["all"],
                "ui": {"entry": "tool.js", "style": "tool.css", "title": "Test tool"},
            }))
            (source / "source-only.txt").write_text("not shipped")
            content = root / "build/tool"
            content.mkdir(parents=True)
            (content / "tool.js").write_text("export function mount() {}")
            (content / "tool.css").write_text(":host {color: black}")
            with patch.object(sys, "argv", [str(script), "--development"]):
                runpy.run_path(str(script), run_name="__main__")
            installed = root / "installed"
            unpack(root / "build/tool.mte-plugin", installed)
            self.assertEqual(manifest_at(installed)["id"], "test.tool")
            self.assertEqual((installed / "tool.js").read_text(), "export function mount() {}")
            self.assertFalse((installed / "source-only.txt").exists())
            (content / "tool.js").unlink()
            with patch.object(sys, "argv", [str(script), "--development"]), self.assertRaisesRegex(ValueError, "Build the tool"):
                runpy.run_path(str(script), run_name="__main__")

    def test_engine_bundle_excludes_packages_without_a_source_manifest(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            script = root / "scripts/build_engine.py"
            script.parent.mkdir()
            shutil.copyfile(Path(__file__).resolve().parents[1] / "scripts/build_engine.py", script)
            content = root / "plugins/editor"
            content.mkdir(parents=True)
            (content / "manifest.json").write_text("{}")
            build = root / "build"
            runtime = build / "pyinstaller/foluma-engine"
            runtime.mkdir(parents=True)
            (runtime / "foluma-engine").write_text("engine")
            (build / "editor.mte-plugin").write_bytes(b"current package")
            (build / "retired.mte-plugin").write_bytes(b"stale package")
            with patch("subprocess.run"):
                runpy.run_path(str(script), run_name="__main__")
            self.assertEqual((build / "engine/editor.mte-plugin").read_bytes(), b"current package")
            self.assertFalse((build / "engine/retired.mte-plugin").exists())

    def test_native_package_keeps_runtime_paths_and_flattens_framework_symlinks(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            script = root / "scripts/package_plugin.py"
            script.parent.mkdir()
            shutil.copyfile(Path(__file__).resolve().parents[1] / "scripts/package_plugin.py", script)
            (root / "src-tauri").mkdir()
            (root / "src-tauri/tauri.conf.json").write_text('{"version":"1.0.0"}')
            content = root / "plugins/sample"
            content.mkdir(parents=True)
            (content / "manifest.json").write_text(json.dumps({
                "id": "test.format", "name": "Test format", "version": "1.0.0", "api_version": 1,
                "format": {"direction": "import", "name": "Test", "extensions": ["test"]},
            }))

            def freeze(command, **_options):
                name = command[command.index("--name") + 1]
                bundle = Path(command[command.index("--distpath") + 1]) / name
                runtime = bundle / "_internal"
                (runtime / "version").mkdir(parents=True)
                (runtime / "version/data.txt").write_text("runtime ready")
                (runtime / "current").symlink_to("version", target_is_directory=True)
                (bundle / "library.txt").symlink_to("_internal/current/data.txt")
                worker = bundle / (name + (".exe" if sys.platform == "win32" else ""))
                worker.write_text("from pathlib import Path\nprint(Path(__file__).with_name('library.txt').read_text())\n")
                worker.chmod(0o755)

            with patch.object(sys, "argv", [str(script), "--formats-only"]), patch("subprocess.run", freeze):
                runpy.run_path(str(script), run_name="__main__")
            installed = root / "installed"
            unpack(root / "build/sample.mte-plugin", installed)
            manifest = manifest_at(installed)
            self.assertFalse(any(path.is_symlink() for path in installed.rglob("*")))
            self.assertEqual((installed / "workers/_internal/current/data.txt").read_text(), "runtime ready")
            worker = installed / manifest["workers"][platform_id()]
            self.assertTrue(worker.stat().st_mode & 0o111)
            completed = subprocess.run([sys.executable, str(worker)], capture_output=True, text=True, check=True)
            self.assertEqual(completed.stdout.strip(), "runtime ready")
