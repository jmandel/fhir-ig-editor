#!/usr/bin/env python3
# Helper for gen-packages-list.sh: read a ResolutionStep JSON on stdin and print
# the UNION of compile_set + context_closure, one `id#version` per line, in stock
# load order (compile_set first, then any extra from the context closure).
import json
import sys


def main() -> None:
    d = json.load(sys.stdin)
    if not d.get("satisfied", False):
        missing = d.get("missing", [])
        print(
            "gen-packages-list: resolver closure is incomplete; "
            f"populate the exact missing packages first: {json.dumps(missing, separators=(',', ':'))}",
            file=sys.stderr,
        )
        raise SystemExit(2)
    seen = []

    def add(p):
        label = f"{p['package_id']}#{p['version']}"
        if label not in seen:
            seen.append(label)

    for p in d.get("compile_set", []):
        add(p)
    for p in d.get("context_closure", []):
        add(p)
    for label in seen:
        print(label)


if __name__ == "__main__":
    main()
