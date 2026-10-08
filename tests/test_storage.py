import errno
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from foluma.storage import link_or_copy


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
