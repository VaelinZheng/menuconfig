#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Run Kconfiglib's own configuration UI (menuconfig / guiconfig) on a project.

This is the in-process equivalent of menuconfig.py's
``subprocess.call(["menuconfig", ...])``: it scans the project for Kconfig
files, writes the aggregate Kconfig.projbuild, hands the Kconfig object to
Kconfiglib's bundled UI, and then regenerates the C header from the saved
.config.

Usage:
  python kconfig_ui.py --root <dir> --header <file> [--config <file>]
                       [--ui auto|curses|tk] [--selftest]
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
VENDOR = HERE / "vendor"
sys.path.insert(0, str(VENDOR))
sys.path.insert(0, str(HERE))

import kconfiglib  # noqa: E402

import kconfig_worker as worker  # noqa: E402


def parse_args(argv=None):
    parser = argparse.ArgumentParser(
        prog="kconfig_ui",
        description="Configure a Kconfig project with Kconfiglib's own UI.",
    )
    parser.add_argument("--root", required=True,
                        help="Directory scanned recursively for Kconfig files.")
    parser.add_argument("--header", required=True,
                        help="Output path of the generated C header.")
    parser.add_argument("--config", default=None,
                        help="Path of .config (default: <header dir>/.config).")
    parser.add_argument("--kconfig-name", default="Kconfig")
    parser.add_argument("--aggregate-name", default="Kconfig.projbuild")
    parser.add_argument("--aggregate-mode", default="roots", choices=["roots", "all"])
    parser.add_argument("--exclude-dir", action="append", default=None,
                        help="Directory name to skip while scanning (repeatable).")
    parser.add_argument("--ui", default="auto", choices=["auto", "curses", "tk"],
                        help="auto: curses when a terminal is available, else Tk.")
    parser.add_argument("--env", action="append", default=None, metavar="KEY=VALUE",
                        help="Extra environment variable for Kconfiglib (repeatable).")
    parser.add_argument("--no-guard", action="store_true",
                        help="Do not wrap the generated header in an include guard.")
    parser.add_argument("--no-header", action="store_true",
                        help="Only run the UI, do not generate the header.")
    parser.add_argument("--set", action="append", default=None, metavar="SYM=VALUE",
                        help="Assign a symbol before running (repeatable).")
    parser.add_argument("--selftest", action="store_true",
                        help="Skip the interactive UI: assign --set values, write "
                             ".config and the header, then exit.")
    return parser.parse_args(argv)


def build_aggregate(root: Path, projbuild: Path, args):
    kconfigs = worker.find_kconfigs(root, args.kconfig_name,
                                    args.exclude_dir or [".git", "build", "out"],
                                    skip_paths=[projbuild])
    if not kconfigs:
        raise SystemExit("No '{}' files found under {}".format(args.kconfig_name, root))

    selected = kconfigs
    used_mode = "all"
    if args.aggregate_mode == "roots":
        referenced = worker.referenced_files(root, kconfigs)
        roots = [k for k in kconfigs if os.path.normcase(str(k)) not in referenced]
        if roots:
            selected = roots
            used_mode = "roots"

    worker.write_aggregate(selected, projbuild)
    return kconfigs, selected, used_mode


def load_kconf(projbuild: Path, config: Path):
    kconf = kconfiglib.Kconfig(str(projbuild), warn=True,
                               warn_to_stderr=False, encoding="utf-8")
    if config.exists():
        kconf.load_config(str(config), replace=True)
    return kconf


def apply_assignments(kconf, assignments):
    failed = []
    for item in assignments or []:
        if "=" not in item:
            failed.append("{} (expected SYM=VALUE)".format(item))
            continue
        name, value = item.split("=", 1)
        sym = kconf.syms.get(name.strip())
        if sym is None:
            failed.append("{} (unknown symbol)".format(name))
            continue
        if not sym.set_value(worker.coerce_value(value.strip())):
            failed.append("{}={} (invalid value)".format(name, value))
    return failed


def curses_available():
    try:
        import curses  # noqa: F401
    except Exception as exc:
        return False, str(exc)
    return True, None


def can_use_tk():
    try:
        import tkinter  # noqa: F401
    except Exception:
        return False
    return True


def run_ui(kconf, requested):
    """Launch Kconfiglib's bundled UI. Returns the UI that was used."""

    # 'auto' only tries the curses UI when stdin looks interactive, otherwise a
    # piped stdin would make getch() spin. An explicit 'curses' request is
    # always attempted: on Windows windows-curses reads CONIN$ directly and
    # works even when isatty() reports False (e.g. under winpty).
    try_curses = requested == "curses" or (
        requested == "auto" and sys.stdin.isatty()
    )

    if try_curses:
        available, reason = curses_available()
        if available:
            try:
                import menuconfig
                print("Starting Kconfiglib menuconfig (curses)...")
                menuconfig.menuconfig(kconf)
                return "menuconfig"
            except Exception as exc:
                if requested == "curses":
                    raise SystemExit(
                        "Could not start the curses UI: {}\n"
                        "Install 'windows-curses' on Windows, or run with "
                        "--ui tk to use the Tk interface.".format(exc)
                    )
                print("curses UI unavailable ({}), falling back to the Tk UI.".format(exc))
        elif requested == "curses":
            raise SystemExit(
                "The curses module is not available ({}).\n"
                "On Windows install 'windows-curses'; otherwise use --ui tk.".format(reason)
            )
        else:
            print("curses module not available ({}), using the Tk UI.".format(reason))

    if requested in ("auto", "tk"):
        if not can_use_tk():
            raise SystemExit(
                "Neither the curses UI nor Tk is available.\n"
                "Install 'windows-curses' (Windows) or the python3-tk package."
            )
        import guiconfig
        print("Starting Kconfiglib guiconfig (Tk)...")
        guiconfig.menuconfig(kconf)
        return "guiconfig"

    raise SystemExit("No usable Kconfiglib UI found.")


def generate_header(projbuild: Path, config: Path, header: Path, include_guard: bool):
    if not config.exists():
        print("No .config at {} - skipping header generation.".format(config), file=sys.stderr)
        return None

    kconf = load_kconf(projbuild, config)
    result = worker.write_header_file(kconf, header, include_guard,
                                     "/* Auto-generated - do not edit. */\n")
    return result


def main(argv=None):
    args = parse_args(argv)

    root = Path(args.root).resolve()
    header = Path(args.header).resolve()
    config = Path(args.config).resolve() if args.config else header.parent / ".config"
    projbuild = (header.parent / args.aggregate_name).resolve()

    for item in args.env or []:
        if "=" in item:
            key, value = item.split("=", 1)
            os.environ[key] = value
    # Kconfiglib resolves 'source' paths against $srctree.
    os.environ["srctree"] = str(root).replace("\\", "/")
    # The UI reads and writes this file.
    os.environ["KCONFIG_CONFIG"] = str(config)

    print("root      : {}".format(root))
    print("header    : {}".format(header))
    print("config    : {}".format(config))
    print("aggregate : {}".format(projbuild))

    if header.parent != config.parent and not config.parent.exists():
        config.parent.mkdir(parents=True, exist_ok=True)

    kconfigs, selected, used_mode = build_aggregate(root, projbuild, args)
    print("collected : {} Kconfig file(s), aggregated {} ({})".format(
        len(kconfigs), len(selected), used_mode))
    print("kconfiglib: {}".format(".".join(str(v) for v in kconfiglib.VERSION)))
    print()

    if args.selftest:
        kconf = load_kconf(projbuild, config)
        failures = apply_assignments(kconf, args.set)
        for failure in failures:
            print("assignment failed: {}".format(failure), file=sys.stderr)
        kconf.write_config(str(config), save_old=False)
        print("wrote .config: {}".format(config))
        if not args.no_header:
            message = generate_header(projbuild, config, header, not args.no_guard)
            print(message)
        return 1 if failures else 0

    kconf = load_kconf(projbuild, config)
    failures = apply_assignments(kconf, args.set)
    for failure in failures:
        print("assignment failed: {}".format(failure), file=sys.stderr)

    used_ui = run_ui(kconf, args.ui)
    print()
    print("{} finished.".format(used_ui))

    if not args.no_header:
        message = generate_header(projbuild, config, header, not args.no_guard)
        if message:
            print(message)
    return 0


if __name__ == "__main__":
    sys.exit(main())
