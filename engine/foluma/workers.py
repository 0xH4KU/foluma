"""Worker subprocess transport and cancellation; independent of document and plugin state."""

from __future__ import annotations

import json
import os
import signal
import subprocess
import sys
import tempfile
import threading
from pathlib import Path

from .i18n import t
from .storage import atomic_json, parse_json
from .worker import EngineError, job_info


def worker_command(request: Path, plugin: Path | None = None) -> list[str]:
    if plugin is not None:
        return [str(plugin)]
    prefix = [sys.executable] if getattr(sys, "frozen", False) else [sys.executable, "-m", "foluma"]
    return [*prefix, "--worker", str(request)]


def terminate(process: subprocess.Popen | None) -> None:
    if process is None or process.poll() is not None:
        return
    try:
        if os.name == "posix":
            os.killpg(process.pid, signal.SIGTERM)
        else:
            process.terminate()
        process.wait(timeout=1)
    except subprocess.TimeoutExpired:
        if os.name == "posix":
            os.killpg(process.pid, signal.SIGKILL)
        else:
            process.kill()
    except ProcessLookupError:
        pass


class Workers:
    def __init__(self, data: Path, notify):
        self.data = data
        self.notify = notify
        self.lock = threading.RLock()
        self.processes: dict[int, subprocess.Popen] = {}
        self.closing = False

    def cancel(self, job: dict):
        with self.lock:
            job["cancelled"] = True
            terminate(job.get("process"))

    def close(self, jobs):
        with self.lock:
            self.closing = True
            for job in jobs:
                job["cancelled"] = True
            for process in list(self.processes.values()):
                terminate(process)

    def run(
        self, operation: str, params: dict, translations: dict, job: dict | None = None, executable: Path | None = None
    ):
        with tempfile.TemporaryDirectory(dir=self.data) as temp:
            request = Path(temp) / "request.json"
            atomic_json(
                request,
                {
                    "operation": operation,
                    "params": params,
                    "data": str(self.data),
                    "messages": translations,
                },
            )
            command = worker_command(request, executable)
            worker_input = json.dumps(params, ensure_ascii=False) + "\n" if executable else None
            with (Path(temp) / "stderr.log").open("w+") as error_log:
                with self.lock:
                    if job and job["cancelled"]:
                        raise EngineError(t("Task cancelled"))
                    if self.closing:
                        raise EngineError(t("Foluma is closing"))
                    process = subprocess.Popen(
                        command,
                        stdin=subprocess.PIPE,
                        stdout=subprocess.PIPE,
                        stderr=error_log,
                        text=True,
                        encoding="utf-8",
                        start_new_session=os.name == "posix",
                    )
                    if job is not None:
                        job["process"] = process
                    self.processes[process.pid] = process
                result, found = None, False
                try:
                    if worker_input:
                        process.stdin.write(worker_input)
                    process.stdin.close()
                    for line in process.stdout:
                        message = parse_json(line)
                        if "timing" in message:
                            print(
                                "[timing] " + json.dumps(message["timing"], ensure_ascii=False),
                                file=sys.stderr,
                                flush=True,
                            )
                        if "progress" in message and job:
                            job["progress"] = message["progress"]
                            self.notify("task.changed", job_info(job))
                        if "error" in message:
                            raise EngineError(message["error"]["message"], message["error"].get("data"))
                        if "result" in message:
                            result, found = message["result"], True
                    process.wait()
                    if process.returncode or not found:
                        error_log.seek(0)
                        raise EngineError(
                            t("Background task ended without a valid result: {0}", error_log.read()[-1500:])
                        )
                    return result
                finally:
                    terminate(process)
                    if not process.stdin.closed:
                        try:
                            process.stdin.close()
                        except BrokenPipeError:
                            pass
                    process.stdout.close()
                    with self.lock:
                        self.processes.pop(process.pid, None)
