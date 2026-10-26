import errno
import tempfile
import unittest
import zlib
from pathlib import Path
from unittest.mock import patch
from zipfile import ZIP_DEFLATED, BadZipFile, ZipFile, ZipInfo

from foluma.model import image_page
from foluma.storage import copy_asset, digest, link_or_copy, open_project, save_project
from PIL import Image


class ExclusiveCopyTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.source, self.target = self.root / "source", self.root / "target"
        self.source.write_bytes(b"original file")

    def test_unsupported_links_copy_and_refuse_existing_targets(self):
        for code in (errno.ENOTSUP, errno.EOPNOTSUPP):
            with self.subTest(errno=code), patch("foluma.storage.os.link", side_effect=OSError(code, "unsupported")):
                link_or_copy(self.source, self.target)
                self.assertEqual(self.target.read_bytes(), b"original file")
                self.source.write_bytes(b"keep source")
                with self.assertRaises(FileExistsError):
                    link_or_copy(self.source, self.target)
                self.assertEqual(self.target.read_bytes(), b"original file")
                self.assertEqual(self.source.read_bytes(), b"keep source")
                self.target.unlink()
                self.source.write_bytes(b"original file")

    def test_failed_copy_removes_partial_target_and_preserves_source(self):
        def fail(incoming, outgoing):
            outgoing.write(incoming.read(1))
            raise OSError(errno.ENOSPC, "disk full")

        with patch("foluma.storage.os.link", side_effect=OSError(errno.ENOTSUP, "unsupported")), \
                patch("foluma.storage.shutil.copyfileobj", side_effect=fail):
            with self.assertRaisesRegex(OSError, "disk full"):
                link_or_copy(self.source, self.target)
        self.assertFalse(self.target.exists())
        self.assertEqual(self.source.read_bytes(), b"original file")

    def test_missing_source_does_not_create_target(self):
        self.source.unlink()
        with patch("foluma.storage.os.link", side_effect=OSError(errno.ENOTSUP, "unsupported")):
            with self.assertRaises(FileNotFoundError):
                link_or_copy(self.source, self.target)
        self.assertFalse(self.target.exists())

    def test_other_link_errors_are_propagated(self):
        for code in (errno.EACCES, errno.EIO):
            with self.subTest(errno=code), patch("foluma.storage.os.link", side_effect=OSError(code, "link failed")):
                with self.assertRaises(OSError) as caught:
                    link_or_copy(self.source, self.target)
                self.assertEqual(caught.exception.errno, code)
                self.assertFalse(self.target.exists())
                self.assertEqual(self.source.read_bytes(), b"original file")

    def test_copy_asset_skips_rehashing_in_place_and_supports_linked_project_saves(self):
        assets = self.root / "assets"
        stored = copy_asset(self.source, assets, "bin")
        with patch("foluma.storage.digest", side_effect=AssertionError("In-place asset should not be rehashed")):
            self.assertEqual(copy_asset(stored, assets, "bin"), stored)
        project_assets = self.root / "project/assets"
        with patch("foluma.storage.digest", side_effect=AssertionError("Content-addressed link should not be rehashed")):
            linked = copy_asset(stored, project_assets, "bin", link=True)
        self.assertEqual(linked.read_bytes(), b"original file")
        for code in (errno.EXDEV, errno.ENOTSUP):
            fallback_dir = self.root / f"fallback-{code}"
            with patch("foluma.storage.os.link", side_effect=OSError(code, "cross-device")):
                copied = copy_asset(stored, fallback_dir, "bin", link=True)
            self.assertEqual(copied.read_bytes(), b"original file")


class EpubSpreadBackfillTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.source = self.root / "source.epub"
        self.project = self.root / "saved.mteproj"
        image = self.root / "scan.png"
        Image.new("RGB", (8, 12), "navy").save(image)
        assets = {name: {"kind": "file", "path": str(image), "width": 8, "height": 12, "ext": "png",
                         "source_id": "source", "member": f"images/{name}.png"}
                  for name in ("rotated", "paired", "plain")}
        self.book = {"schema": 1, "id": "book", "revision": 0,
                     "metadata": {"title": "Book", "author": "", "language": "en", "direction": "ltr",
                                  "cover_id": None, "cover_only": False},
                     "sources": {"source": {"path": str(self.source), "page_count": 3}},
                     "assets": assets, "pages": [image_page(key, asset) for key, asset in assets.items()],
                     "extensions": {}}

    def save(self, members):
        with ZipFile(self.source, "w", ZIP_DEFLATED) as archive:
            for name, payload in members.items():
                archive.writestr(name, payload)
        self.book["sources"]["source"]["sha256"] = digest(self.source)
        save_project(self.book, self.project)

    def test_xml_attributes_uri_paths_and_negative_results_survive_reopening(self):
        self.book["assets"]["rotated"]["member"] = "images/rotated scan.png"
        self.save({
            "pages/1.xhtml": "<html><body><img src='../images/rotated%20scan.png' kmoetag='rotate:1'/></body></html>",
            "pages/2.xhtml": '<html><body><img src="../images/paired.png" class="other twoPage"/></body></html>',
            "pages/3.xhtml": '<html><body><img src="../images/plain.png" class="twoPageOther"/>'
                             '<!-- <img src="../images/plain.png" class="twoPage"/> --></body></html>',
        })
        book = open_project(self.project)
        self.assertEqual({key: asset.get("rotated_spread") for key, asset in book["assets"].items()},
                         {"rotated": True, "paired": True, "plain": False})
        save_project(book, self.project)
        with patch("foluma.storage.ZipFile", side_effect=AssertionError("Already checked assets must not rescan")):
            reopened = open_project(self.project)
        self.assertEqual(reopened, book)

    def test_oversized_and_invalid_xml_are_skipped_before_decompression(self):
        self.save({
            "oversized.xhtml": b" " * 1_000_001,
            "malformed.xhtml": b"<html>",
            "entities.xhtml": ('<!DOCTYPE html [<!ENTITY tag "twoPage">]><html><body>'
                               '<img src="images/plain.png" class="&tag;"/></body></html>').encode("utf-16"),
            "valid.xhtml": '<html><body><img src="images/rotated.png" kmoetag="rotate:1"/></body></html>',
        })
        original = ZipFile.open

        def bounded(archive, member, *args, **kwargs):
            entry = member if isinstance(member, ZipInfo) else archive.getinfo(member)
            self.assertLessEqual(entry.file_size, 1_000_000)
            return original(archive, member, *args, **kwargs)

        with patch.object(ZipFile, "open", bounded):
            book = open_project(self.project)
        self.assertTrue(book["assets"]["rotated"].get("rotated_spread"))
        self.assertFalse(book["assets"]["plain"].get("rotated_spread"))

    def test_unreadable_optional_entries_do_not_block_opening_or_other_hints(self):
        self.save({
            "unreadable.xhtml": "unreadable",
            "valid.xhtml": '<html><body><img src="images/rotated.png" class="twoPage"/></body></html>',
        })
        original = ZipFile.open
        for kind in (NotImplementedError, RuntimeError, BadZipFile, EOFError, OSError, zlib.error):
            def unreadable(archive, member, *args, **kwargs):
                name = member.filename if isinstance(member, ZipInfo) else member
                if name == "unreadable.xhtml":
                    raise kind("Unreadable optional entry")
                return original(archive, member, *args, **kwargs)

            with self.subTest(error=kind), patch.object(ZipFile, "open", unreadable):
                book = open_project(self.project)
            self.assertTrue(book["assets"]["rotated"].get("rotated_spread"))
            self.assertTrue(all(Path(asset["path"]).is_file() for asset in book["assets"].values()))

    def test_changed_or_missing_sources_do_not_change_saved_image_hints(self):
        self.save({"page.xhtml": '<html><body><img src="images/plain.png"/></body></html>'})
        with ZipFile(self.source, "w") as archive:
            archive.writestr("page.xhtml", '<html><body><img src="images/plain.png" class="twoPage"/></body></html>')
        book = open_project(self.project)
        self.assertNotIn("rotated_spread", book["assets"]["plain"])
        self.source.unlink()
        self.assertEqual(open_project(self.project), book)

    def test_archive_entry_count_and_total_size_are_bounded(self):
        self.save({"page.xhtml": '<html><body><img src="images/rotated.png" class="twoPage"/></body></html>'})
        oversized = ZipInfo("large.png")
        oversized.file_size = 2_000_000_001
        for entries in ([oversized], [ZipInfo(f"{index}.html") for index in range(10_001)]):
            with self.subTest(entries=len(entries)), patch.object(ZipFile, "infolist", return_value=entries), \
                    patch.object(ZipFile, "open", side_effect=AssertionError("Oversized archives must not be read")):
                book = open_project(self.project)
            self.assertNotIn("rotated_spread", book["assets"]["rotated"])
