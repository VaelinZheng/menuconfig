#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Drive Kconfiglib's curses UI (python/kconfig_ui.py --ui curses) in a PTY.

This is an optional end-to-end check: it boots the real ncurses interface,
toggles the first menu entry, saves, and verifies that .config and the
generated header reflect the change.

Requirements:
  Windows : pip install pywinpty   (plus windows-curses for the UI itself)
  POSIX   : standard library pty
  Any     : tkinter for the Tk fallback is not needed here

Run:  python test/drive_curses_ui.py
"""

from __future__ import annotations

import os
import re
import subprocess
import sys
import threading
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FIXTURE = ROOT / "test" / "fixture"
HEADER = FIXTURE / "rts_cfg.h"
CONFIG = FIXTURE / ".config"

ANSI = re.compile(r"\x1b\[[0-9;?&]*[a-zA-Z]|\x1b[()][A-B0-9]|\x1b[=>]")
CTRL = re.compile(r"[\x00-\x08\x0b-\x1f]")


class PtySession:
    """Minimal wrapper exposing write/read/exitstatus for both platforms."""

    def __init__(self, argv, cwd):
        self._chunks = []
        self._child = None
        if os.name == "nt":
            from winpty import PtyProcess  # noqa: WPS433 (optional dependency)
            self._child = PtyProcess.spawn(argv, dimensions=(30, 110), cwd=cwd,
                                           env=dict(os.environ))
        else:  # pragma: no cover - exercised on POSIX only
            import pty
            import subprocess
            master, slave = pty.openpty()
            self._master = master
            self._child = subprocess.Popen(argv, cwd=cwd, stdin=slave,
                                           stdout=slave, stderr=slave,
                                           env=dict(os.environ))
            os.close(slave)

        threading.Thread(target=self._reader, daemon=True).start()

    def _reader(self):
        while True:
            try:
                if os.name == "nt":
                    data = self._child.read(65536)
                else:  # pragma: no cover
                    data = os.read(self._master, 65536).decode("utf-8", "replace")
            except Exception:
                return
            if not data:
                return
            self._chunks.append(data)

    @property
    def text(self):
        return "".join(self._chunks)

    @property
    def alive(self):
        if os.name == "nt":
            return self._child.isalive()
        return self._child.poll() is None  # pragma: no cover

    @property
    def exitstatus(self):
        return self._child.exitstatus if os.name == "nt" else self._child.returncode

    def write(self, keys):
        if os.name == "nt":
            self._child.write(keys)
        else:  # pragma: no cover
            os.write(self._master, keys.encode())

    def wait_for(self, needle, timeout):
        deadline = time.time() + timeout
        while time.time() < deadline:
            if needle in self.text:
                return True
            if not self.alive and needle not in self.text:
                return False
            time.sleep(0.1)
        return False

    def kill(self):
        try:
            if os.name == "nt":
                self._child.terminate(force=True)
            else:  # pragma: no cover
                self._child.kill()
        except Exception:
            pass


def clean(text):
    return CTRL.sub("", ANSI.sub("", text))


def main() -> int:
    try:
        if os.name == "nt":
            import winpty  # noqa: F401
        else:  # pragma: no cover
            import pty  # noqa: F401
    except Exception:
        print("SKIP: pywinpty is required on Windows (pip install pywinpty)")
        return 0

    # MENUCONFIG_PYTHON lets you drive the UI with a different interpreter than
    # the one running this script (e.g. a venv that only has pywinpty).
    python = os.environ.get("MENUCONFIG_PYTHON") or sys.executable

    probe = subprocess.run([python, "-c", "import curses"], capture_output=True)
    if probe.returncode != 0:
        print("SKIP: the curses UI is unavailable for {} (pip install windows-curses)".format(python))
        return 0

    for stale in (CONFIG, HEADER, FIXTURE / "Kconfig.projbuild"):
        if stale.exists():
            stale.unlink()

    argv = [
        python, "-u", str(ROOT / "python" / "kconfig_ui.py"),
        "--root", str(FIXTURE),
        "--header", str(HEADER),
        "--config", str(CONFIG),
        "--ui", "curses",
    ]
    session = PtySession(argv, cwd=str(FIXTURE))
    failures = []

    def check(condition, message):
        if condition:
            print("  ok - " + message)
        else:
            failures.append(message)
            print("  FAIL - " + message)

    try:
        check(session.wait_for("kconfiglib:", 30), "worker booted")
        check(session.wait_for("Enable application", 30), "menu rendered")

        session.write(" ")                 # toggle the first entry
        time.sleep(0.6)
        session.write("q")                 # quit
        check(session.wait_for("Save configuration?", 15), "save dialog shown")
        session.write("y")                 # save
        session.wait_for("finished.", 20)
        time.sleep(1.0)

        check(session.exitstatus == 0, "UI exited with code 0")
        check(CONFIG.exists(), ".config written")
        check(HEADER.exists(), "header written")

        if CONFIG.exists() and HEADER.exists():
            config_text = CONFIG.read_text(encoding="utf-8")
            header_text = HEADER.read_text(encoding="utf-8")
            check("CONFIG_EXTRA=y" in config_text, "toggle reached .config")
            check("#define CONFIG_EXTRA 1" in header_text, "header reflects the toggle")
            check("#ifndef _RTS_CFG_H_" in header_text, "include guard present")
    finally:
        if session.alive:
            session.kill()

    if failures:
        print("\n---- screen ----")
        print(clean(session.text)[-2000:])
        print("\nFAILED: " + ", ".join(failures))
        return 1

    print("\nALL CHECKS PASSED")
    return 0


if __name__ == "__main__":
    sys.exit(main())
