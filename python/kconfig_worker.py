#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Long-lived Kconfiglib worker for the menuconfig VS Code extension.

Protocol: one JSON object per line on stdin/stdout (NDJSON).

  {"id": 1, "op": "init", "args": {...}}
  {"id": 1, "ok": true, "result": {...}}
  {"id": 1, "ok": false, "error": {"kind": "...", "message": "..."}}

Scanning/aggregation mirrors menuconfig.py: discovered Kconfig files are
listed in a generated Kconfig.projbuild via 'rsource', so that all of them
end up in one configuration tree parsed by Kconfiglib.

The default aggregation mode is "roots": files that are already pulled in by
another discovered file through 'source' are not listed again, which avoids
duplicated menus. Mode "all" reproduces menuconfig.py exactly.
"""

from __future__ import annotations

import json
import os
import re
import sys
import traceback
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE / "vendor"))

import kconfiglib  # noqa: E402  (vendored copy)

KCONFIG_MENU = kconfiglib.MENU
KCONFIG_COMMENT = kconfiglib.COMMENT

SOURCE_RE = re.compile(r'^\s*(osource|orsource|rsource|source)\s+"([^"]*)"', re.M)
VAR_RE = re.compile(r"\$[({]([A-Za-z_][A-Za-z0-9_]*)[)}]")

STATE = {
    "kconf": None,
    "root": None,
    "header": None,
    "config": None,
    "projbuild": None,
    "files": [],
    "collected": [],
    "warnings": [],
    "sym_cache": {},
    "tree": [],
    "visible_names": frozenset(),
    "missing": [],
    "env": {},
}


# --------------------------------------------------------------------------
# helpers
# --------------------------------------------------------------------------

def sym_type_name(sym):
    try:
        return kconfiglib.TYPE_TO_STR[sym.type]
    except Exception:
        return "unknown"


def node_visible(node):
    """Tristate visibility of a menu node: 0 hidden, 1/2 visible."""
    item = node.item
    if isinstance(item, (kconfiglib.Symbol, kconfiglib.Choice)):
        return item.visibility
    if not node.prompt:
        return 0
    if not kconfiglib.expr_value(node.dep):
        return 0
    return 1 if kconfiglib.expr_value(getattr(node, "visibility", node.kconfig.y)) else 0


def first_prompt(sym):
    for node in sym.nodes:
        if node.prompt:
            return node.prompt[0]
    return None


def first_loc(sym):
    for node in sym.nodes:
        if node.prompt:
            return {"file": node.filename, "line": node.linenr}
    node = sym.nodes[0]
    return {"file": node.filename, "line": node.linenr}


def sym_state(sym):
    choice = getattr(sym, "choice", None)
    return {
        "type": sym_type_name(sym),
        "value": sym.str_value,
        "visibility": sym.visibility,
        "assignable": list(sym.assignable),
        "prompt": first_prompt(sym),
        "hasHelp": any(bool(n.help) for n in sym.nodes),
        "loc": first_loc(sym),
        "choice": bool(choice),
        "selected": bool(choice) and choice.selection is sym,
    }


def build_tree(kconf):
    counter = [0]

    def walk(node):
        item = node.item
        if item is KCONFIG_MENU:
            kind, name = "menu", None
        elif item is KCONFIG_COMMENT:
            kind, name = "comment", None
        elif isinstance(item, kconfiglib.Symbol):
            kind, name = "sym", item.name
        else:
            kind, name = "choice", None

        nid = counter[0]
        counter[0] += 1

        entry = {
            "id": nid,
            "k": kind,
            "t": node.prompt[0] if node.prompt else (name or ""),
            "v": node_visible(node),
        }
        if name:
            entry["s"] = name
        if node.is_menuconfig:
            entry["mc"] = 1

        children = []
        child = node.list
        while child is not None:
            children.append(walk(child))
            child = child.next
        if children:
            entry["c"] = children
        return entry

    roots = []
    child = kconf.top_node.list
    while child is not None:
        roots.append(walk(child))
        child = child.next
    return roots


def visible_symbol_names(kconf):
    return frozenset(s.name for s in kconf.unique_defined_syms if s.visibility)


def rebuild_symbols(kconf):
    return {sym.name: sym_state(sym) for sym in kconf.unique_defined_syms}


def snapshot():
    kconf = STATE["kconf"]
    top = kconf.top_node
    return {
        "version": ".".join(str(v) for v in kconfiglib.VERSION),
        "mainmenu": top.prompt[0] if top.prompt else "",
        "tree": STATE["tree"],
        "symbols": STATE["sym_cache"],
        "files": STATE["files"],
        "collected": STATE["collected"],
        "header": str(STATE["header"]) if STATE["header"] else None,
        "config": str(STATE["config"]) if STATE["config"] else None,
        "projbuild": str(STATE["projbuild"]) if STATE["projbuild"] else None,
        "warnings": STATE["warnings"],
        "missing": STATE["missing"],
    }


# --------------------------------------------------------------------------
# scanning / aggregation
# --------------------------------------------------------------------------

def expand_vars(text):
    def repl(match):
        return os.environ.get(match.group(1), "")

    return VAR_RE.sub(repl, text)


def find_kconfigs(root: Path, filename: str, exclude_dirs, skip_paths=()):
    exclude = {d.lower() for d in (exclude_dirs or ())}
    skip = {os.path.normcase(str(Path(p).resolve())) for p in skip_paths}
    found = []
    for dirpath, dirnames, filenames in os.walk(str(root)):
        dirnames[:] = [d for d in dirnames if d.lower() not in exclude]
        if filename in filenames:
            path = (Path(dirpath) / filename).resolve()
            if os.path.normcase(str(path)) not in skip:
                found.append(path)
    found.sort()
    return found


def referenced_files(root: Path, kconfigs):
    """Return the set of discovered files pulled in via source statements."""
    referenced = set()

    for path in kconfigs:
        try:
            text = path.read_text(encoding="utf-8-sig", errors="replace")
        except OSError:
            continue
        for kind, target in SOURCE_RE.findall(text):
            target = expand_vars(target).strip()
            if not target:
                continue
            if kind in ("rsource", "orsource"):
                resolved = (path.parent / target).resolve()
            elif os.path.isabs(target):
                resolved = Path(target)
            else:
                resolved = (root / target).resolve()
            referenced.add(os.path.normcase(str(resolved)))
    return referenced


def write_aggregate(kconfigs, out_file: Path):
    out_file.parent.mkdir(parents=True, exist_ok=True)
    lines = ["# Auto-generated Kconfig which rsource's discovered Kconfig files\n"]
    for k in kconfigs:
        rel = os.path.relpath(str(k), start=str(out_file.parent)).replace("\\", "/")
        if not rel.startswith("."):
            rel = "./" + rel
        lines.append('rsource "{}"\n'.format(rel))
    out_file.write_text("".join(lines), encoding="utf-8")


def compose_header(path: Path, body: str, include_guard: bool, header_text: str) -> str:
    if not body.endswith("\n"):
        body += "\n"
    if not include_guard:
        return header_text + body

    base = path.stem.upper()
    guard = "_" + re.sub(r"[^A-Z0-9]", "_", base) + "_H_"
    return (
        header_text
        + "#ifndef %s\n#define %s\n\n" % (guard, guard)
        + body
        + "\n#endif /* %s */\n" % guard
    )


HEADER_TEXT = "/* Auto-generated - do not edit. */\n"


def write_header_file(kconf, path: Path, include_guard=True, header_text=None):
    """Write an autoconf-style header, skipping the write when unchanged.

    Kconfiglib's write_autoconf() rewrites the whole file, so the body is
    generated into a scratch file and the final content (comment + include
    guard + defines) is composed and compared here.
    """
    header_text = HEADER_TEXT if header_text is None else header_text
    path.parent.mkdir(parents=True, exist_ok=True)

    scratch = path.with_name(path.name + ".menuconfig-tmp")
    try:
        kconf.write_autoconf(str(scratch), header="")
        body = scratch.read_text(encoding="utf-8")
    finally:
        try:
            scratch.unlink()
        except OSError:
            pass

    final = compose_header(path, body, include_guard, header_text)
    unchanged = path.exists() and path.read_text(encoding="utf-8") == final
    if unchanged:
        return "No change to Kconfig header in '{}'".format(path)

    path.write_text(final, encoding="utf-8")
    return "Kconfig header saved to '{}'".format(path)


# --------------------------------------------------------------------------
# operations
# --------------------------------------------------------------------------

def op_init(args):
    root = Path(args["root"]).resolve()
    header = Path(args["header"]).resolve()
    config = Path(args.get("config") or (header.parent / ".config")).resolve()
    filename = args.get("kconfigName") or "Kconfig"
    exclude_dirs = args.get("excludeDirs") or [".git", "build", "out"]
    aggregate_name = args.get("aggregateName") or "Kconfig.projbuild"
    mode = args.get("mode") or "roots"

    for key, value in (args.get("env") or {}).items():
        if value is not None:
            os.environ[str(key)] = str(value)
    # 'source' statements resolve against $srctree when it is set.
    os.environ["srctree"] = str(root).replace("\\", "/")
    STATE["env"] = dict(args.get("env") or {})

    projbuild = (header.parent / aggregate_name).resolve()
    kconfigs = find_kconfigs(root, filename, exclude_dirs, skip_paths=[projbuild])
    if not kconfigs:
        return {
            "ok": False,
            "error": {
                "kind": "not-found",
                "message": "No '{}' files found under {}".format(filename, root),
            },
        }

    referenced = referenced_files(root, kconfigs)
    selected = kconfigs
    used_mode = "all"
    if mode == "roots":
        roots = [k for k in kconfigs if os.path.normcase(str(k)) not in referenced]
        if roots:
            selected = roots
            used_mode = "roots"

    write_aggregate(selected, projbuild)

    kconf = kconfiglib.Kconfig(
        str(projbuild),
        warn=True,
        warn_to_stderr=False,
        encoding="utf-8",
    )

    STATE["kconf"] = kconf
    STATE["root"] = root
    STATE["header"] = header
    STATE["config"] = config
    STATE["projbuild"] = projbuild
    STATE["files"] = [str(f) for f in kconf.kconfig_filenames]
    STATE["collected"] = [str(f) for f in kconfigs]
    STATE["warnings"] = list(kconf.warnings)
    STATE["missing"] = []

    if config.exists():
        kconf.load_config(str(config), replace=True)
        STATE["missing"] = ["{}={}".format(name, value)
                            for name, value in getattr(kconf, "missing_syms", [])]

    STATE["sym_cache"] = rebuild_symbols(kconf)
    STATE["tree"] = build_tree(kconf)
    STATE["visible_names"] = visible_symbol_names(kconf)

    result = snapshot()
    result["aggregate"] = str(projbuild)
    result["aggregatedFrom"] = [str(k) for k in selected]
    result["mode"] = used_mode
    return {"ok": True, "result": result}


def require_kconf():
    if STATE["kconf"] is None:
        raise RuntimeError("worker is not initialized; call 'init' first")
    return STATE["kconf"]


def coerce_value(value):
    if isinstance(value, bool):
        return int(value)
    if isinstance(value, int):
        return value
    if isinstance(value, str):
        text = value.strip()
        if text in ("n", "m", "y"):
            return {"n": 0, "m": 1, "y": 2}[text]
        return text
    return value


def collect_delta():
    kconf = STATE["kconf"]
    changed = {}
    cache = {}
    old_cache = STATE["sym_cache"]
    for sym in kconf.unique_defined_syms:
        state = sym_state(sym)
        cache[sym.name] = state
        old = old_cache.get(sym.name)
        if old is None or (
            old["value"] != state["value"]
            or old["visibility"] != state["visibility"]
            or old["assignable"] != state["assignable"]
            or old["selected"] != state["selected"]
        ):
            changed[sym.name] = state
    STATE["sym_cache"] = cache

    result = {"changed": changed}
    new_visible = visible_symbol_names(kconf)
    if new_visible != STATE["visible_names"]:
        STATE["visible_names"] = new_visible
        STATE["tree"] = build_tree(kconf)
        result["tree"] = STATE["tree"]

    STATE["warnings"] = list(kconf.warnings)
    result["warnings"] = STATE["warnings"]
    return result


def op_set(args):
    kconf = require_kconf()
    name = args["sym"]
    sym = kconf.syms.get(name)
    if sym is None:
        return {"ok": False, "error": {"kind": "unknown-symbol", "message": name}}

    if not sym.set_value(coerce_value(args.get("value"))):
        return {
            "ok": False,
            "error": {
                "kind": "invalid-value",
                "message": "Value {!r} is not valid for {} ({})".format(
                    args.get("value"), name, sym_type_name(sym)
                ),
            },
        }
    return {"ok": True, "result": collect_delta()}


def op_unset(args):
    kconf = require_kconf()
    name = args["sym"]
    sym = kconf.syms.get(name)
    if sym is None:
        return {"ok": False, "error": {"kind": "unknown-symbol", "message": name}}
    sym.unset_value()
    return {"ok": True, "result": collect_delta()}


def op_help(args):
    kconf = require_kconf()
    sym = kconf.syms.get(args["sym"])
    if sym is None:
        return {"ok": False, "error": {"kind": "unknown-symbol", "message": args["sym"]}}
    text = None
    for node in sym.nodes:
        if node.help:
            text = node.help
            break
    return {"ok": True, "result": {"help": text}}


def op_save(args):
    kconf = require_kconf()
    path = Path(args.get("path") or STATE["config"]).resolve()
    path.parent.mkdir(parents=True, exist_ok=True)
    message = kconf.write_config(str(path), save_old=bool(args.get("saveOld")))
    return {"ok": True, "result": {"message": message, "path": str(path)}}


def op_header(args):
    kconf = require_kconf()
    path = Path(args.get("path") or STATE["header"]).resolve()
    before = None
    if path.exists():
        before = path.read_text(encoding="utf-8")

    message = write_header_file(
        kconf,
        path,
        include_guard=bool(args.get("includeGuard", True)),
        header_text=args.get("headerText"),
    )
    after = path.read_text(encoding="utf-8") if path.exists() else None
    return {
        "ok": True,
        "result": {
            "message": message,
            "path": str(path),
            "changed": before != after,
        },
    }


def op_reload(args):
    if STATE["root"] is None:
        return {"ok": False, "error": {"kind": "not-initialized", "message": "not initialized"}}
    return op_init({
        "root": str(STATE["root"]),
        "header": str(STATE["header"]),
        "config": str(STATE["config"]),
        "kconfigName": args.get("kconfigName") or "Kconfig",
        "excludeDirs": args.get("excludeDirs") or [".git", "build", "out"],
        "aggregateName": args.get("aggregateName") or "Kconfig.projbuild",
        "mode": args.get("mode") or "roots",
        "env": args.get("env") or STATE["env"] or {},
    })


def op_shutdown(_args):
    return {"ok": True, "result": {}}


OPS = {
    "init": op_init,
    "set": op_set,
    "unset": op_unset,
    "help": op_help,
    "save": op_save,
    "header": op_header,
    "reload": op_reload,
    "shutdown": op_shutdown,
}


def describe_error(exc):
    if isinstance(exc, kconfiglib.KconfigError):
        kind = "kconfig"
    elif isinstance(exc, OSError):
        kind = "io"
    else:
        kind = "internal"
    return {"kind": kind, "message": str(exc)}


def main():
    try:
        sys.stdout.reconfigure(encoding="utf-8", newline="\n")
        sys.stdin.reconfigure(encoding="utf-8", newline="\n")
    except Exception:
        pass

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
        except Exception as exc:
            sys.stdout.write(json.dumps({
                "id": None, "ok": False,
                "error": {"kind": "bad-request", "message": str(exc)},
            }) + "\n")
            sys.stdout.flush()
            continue

        req_id = request.get("id")
        op = request.get("op")
        handler = OPS.get(op)
        if handler is None:
            response = {
                "id": req_id, "ok": False,
                "error": {"kind": "unknown-op", "message": str(op)},
            }
        else:
            try:
                response = handler(request.get("args") or {})
                response["id"] = req_id
            except Exception as exc:
                response = {"id": req_id, "ok": False, "error": describe_error(exc)}
                traceback.print_exc(file=sys.stderr)

        sys.stdout.write(json.dumps(response, ensure_ascii=False) + "\n")
        sys.stdout.flush()

        if op == "shutdown":
            break


if __name__ == "__main__":
    main()
