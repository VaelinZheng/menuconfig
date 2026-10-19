#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Smoke test driving python/kconfig_worker.py over NDJSON (no VS Code needed).

Run: python test/drive_worker.py
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
FIXTURE = HERE / "fixture"
HEADER = FIXTURE / "rts_cfg.h"
CONFIG = FIXTURE / ".config"


class Worker:
    def __init__(self):
        self.proc = subprocess.Popen(
            [sys.executable, "-u", str(ROOT / "python" / "kconfig_worker.py")],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            cwd=str(FIXTURE),
        )
        self.next_id = 1

    def call(self, op, args=None):
        req_id = self.next_id
        self.next_id += 1
        payload = {"id": req_id, "op": op, "args": args or {}}
        self.proc.stdin.write(json.dumps(payload) + "\n")
        self.proc.stdin.flush()
        line = self.proc.stdout.readline()
        if not line:
            err = self.proc.stderr.read()
            raise RuntimeError("worker died: " + err)
        response = json.loads(line)
        assert response["id"] == req_id, response
        return response

    def close(self):
        try:
            self.call("shutdown")
        finally:
            self.proc.stdin.close()
            self.proc.wait(timeout=10)


def check(cond, message):
    if not cond:
        raise AssertionError(message)
    print("  ok - " + message)


def main() -> int:
    for stale in (HEADER, CONFIG, FIXTURE / "Kconfig.projbuild"):
        if stale.exists():
            stale.unlink()

    worker = Worker()
    try:
        print("[init]")
        response = worker.call("init", {
            "root": str(FIXTURE),
            "header": str(HEADER),
            "config": str(CONFIG),
            "mode": "roots",
        })
        check(response.get("ok"), "init succeeded")
        snap = response["result"]

        check(len(snap["collected"]) == 4, "collected 4 Kconfig files")
        check(len(snap["aggregatedFrom"]) == 2, "aggregated only the 2 root files")
        check(snap["mode"] == "roots", "aggregation mode is roots")
        check((FIXTURE / "Kconfig.projbuild").exists(), "Kconfig.projbuild generated")

        for name in ("APP", "DRIVER", "DRIVER_LEVEL", "LIB_NAME", "LIB_DEBUG", "EXTRA"):
            check(name in snap["symbols"], "symbol %s present" % name)

        check(snap["symbols"]["APP"]["value"] == "y", "APP defaults to y")
        check(snap["symbols"]["DRIVER"]["visibility"] == 2, "DRIVER visible")
        check(snap["symbols"]["EXTRA"]["value"] == "m", "EXTRA defaults to m")
        check(snap["symbols"]["DRIVER_LEVEL"]["type"] == "int", "DRIVER_LEVEL is int")
        check(snap["symbols"]["LIB_NAME"]["type"] == "string", "LIB_NAME is string")

        print("[set APP=n]")
        response = worker.call("set", {"sym": "APP", "value": "n"})
        check(response.get("ok"), "set succeeded")
        changed = response["result"]["changed"]
        check(changed["APP"]["value"] == "n", "APP is n")
        check(changed["DRIVER"]["visibility"] == 0, "DRIVER became hidden")
        check("tree" in response["result"], "tree resent on visibility change")

        print("[set APP=y]")
        response = worker.call("set", {"sym": "APP", "value": "y"})
        check(response["result"]["changed"]["DRIVER"]["visibility"] == 2, "DRIVER visible again")

        print("[set APP=2 invalid]")
        response = worker.call("set", {"sym": "APP", "value": "m"})
        check(not response.get("ok"), "m is rejected for bool symbol")

        print("[set DRIVER_LEVEL out of range]")
        response = worker.call("set", {"sym": "DRIVER_LEVEL", "value": "42"})
        check(response.get("ok"), "int assignment is accepted")
        check("DRIVER_LEVEL" not in response["result"]["changed"],
              "out-of-range int does not change the effective value")
        check(any("outside the active range" in w for w in response["result"]["warnings"]),
              "out-of-range assignment reported as a warning")

        print("[set DRIVER_LEVEL=4]")
        response = worker.call("set", {"sym": "DRIVER_LEVEL", "value": "4"})
        check(response["result"]["changed"]["DRIVER_LEVEL"]["value"] == "4",
              "in-range int applied")

        print("[save .config]")
        response = worker.call("save", {})
        check(response.get("ok"), "save succeeded")
        text = CONFIG.read_text(encoding="utf-8")
        check("CONFIG_APP=y" in text, ".config contains CONFIG_APP=y")
        check("CONFIG_EXTRA=m" in text, ".config contains CONFIG_EXTRA=m")
        check('CONFIG_LIB_NAME="demo"' in text, ".config contains quoted string")

        print("[generate header]")
        response = worker.call("header", {})
        check(response.get("ok"), "header generated")
        header_text = HEADER.read_text(encoding="utf-8")
        check("#define CONFIG_APP 1" in header_text, "autoconf has CONFIG_APP 1")
        check("#define CONFIG_EXTRA_MODULE 1" in header_text, "m becomes _MODULE")
        check('"demo"' in header_text, "string value emitted")
        check("#ifndef _RTS_CFG_H_" in header_text, "include guard added")
        check(header_text.count("#ifndef _RTS_CFG_H_") == 1, "guard not duplicated")

        print("[header idempotent]")
        mtime = HEADER.stat().st_mtime_ns
        response = worker.call("header", {})
        check(not response["result"]["changed"], "second header write reports no change")
        check(HEADER.stat().st_mtime_ns == mtime, "header mtime is preserved")
        check(header_text.count("#ifndef _RTS_CFG_H_") == 1, "guard appears once")
        check(header_text.count("Auto-generated - do not edit") == 1,
              "header comment not duplicated")

        print("[reload]")
        response = worker.call("reload", {})
        check(response.get("ok"), "reload succeeded")

        print("[help]")
        response = worker.call("help", {"sym": "APP"})
        check("Master switch" in (response["result"]["help"] or ""), "help text returned")

        print("[unknown symbol]")
        response = worker.call("set", {"sym": "NOPE", "value": "y"})
        check(not response.get("ok") and response["error"]["kind"] == "unknown-symbol",
              "unknown symbol reported")

    finally:
        worker.close()

    print("\nALL CHECKS PASSED")
    return 0


if __name__ == "__main__":
    sys.exit(main())
