import unittest
from unittest.mock import patch

from foluma.worker import execute


class ProgressTests(unittest.TestCase):
    def test_progress_coalesces_bursts_and_preserves_phases_completion_and_failures(self):
        for fail in (False, True):
            with self.subTest(fail=fail):
                now, emitted = [0.0], []

                def handle(progress):
                    progress(0, 100, "Reading")
                    for number in range(1, 101):
                        now[0] = number / 1000
                        progress(number, 100, "Reading")
                    now[0] = 0.101
                    progress(0, 50, "Writing")
                    now[0] = 0.105
                    progress(25, 50, "Writing")
                    if fail:
                        raise ValueError("disk full")
                    now[0] = 0.106
                    progress(50, 50, "Writing")
                    return {"total": 100}

                with patch("foluma.worker.time.perf_counter", side_effect=lambda: now[0]), \
                        patch("foluma.worker.emit", side_effect=emitted.append):
                    if fail:
                        with self.assertRaises(SystemExit) as stopped:
                            execute("import", handle, {})
                        self.assertEqual(stopped.exception.code, 1)
                    else:
                        execute("import", handle, {})
                progress = [message["progress"] for message in emitted if "progress" in message]
                self.assertEqual([(value["message"], value["done"]) for value in progress],
                                 [("Reading", 0), ("Reading", 100), ("Writing", 0), ("Writing", 25 if fail else 50)])
                if fail:
                    self.assertEqual(emitted[-1]["error"]["message"], "disk full")
                else:
                    self.assertEqual(emitted[-1]["result"], {"total": 100})
