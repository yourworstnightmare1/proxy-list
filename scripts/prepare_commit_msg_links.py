#!/usr/bin/env python3
"""Append URLs from newly added list.md table rows to the commit message.

Invoked by .githooks/prepare-commit-msg. Enable hooks with:
  git config core.hooksPath .githooks
"""

from __future__ import annotations

import re
import subprocess
import sys
from collections import Counter
from pathlib import Path

# Link table row in staged diff.
ADDED_ROW = re.compile(r"^\+\| \| (https?://[^\s|]+)")
REMOVED_ROW = re.compile(r"^-\| \| (https?://[^\s|]+)")


def _git(*args: str) -> str:
    return subprocess.check_output(["git", *args], text=True)


def main() -> int:
    if len(sys.argv) < 2:
        return 0

    commit_msg_file = Path(sys.argv[1])
    source = sys.argv[2] if len(sys.argv) > 2 else ""

    # Avoid touching auto-generated merge/squash messages.
    if source in ("merge", "squash"):
        return 0

    try:
        staged = _git("diff", "--cached", "--name-only", "--diff-filter=ACMRT").splitlines()
    except (subprocess.CalledProcessError, FileNotFoundError):
        return 0

    if "list.md" not in staged:
        return 0

    try:
        diff = _git("diff", "--cached", "-U0", "--", "list.md")
    except subprocess.CalledProcessError:
        return 0

    removed = Counter()
    for line in diff.splitlines():
        m = REMOVED_ROW.match(line)
        if m:
            removed[m.group(1).rstrip()] += 1

    urls: list[str] = []
    for line in diff.splitlines():
        m = ADDED_ROW.match(line)
        if not m:
            continue
        url = m.group(1).rstrip()
        if removed[url] > 0:
            removed[url] -= 1
            continue
        urls.append(url)

    if not urls:
        return 0

    body = commit_msg_file.read_text(encoding="utf-8")
    marker = "--- Added links (list.md) ---"
    if marker in body:
        return 0

    append = f"\n{marker}\n" + "\n".join(urls) + "\n"
    commit_msg_file.write_text(body + append, encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
