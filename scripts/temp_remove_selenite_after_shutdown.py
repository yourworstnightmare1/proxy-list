#!/usr/bin/env python3
"""
TEMPORARY: Remove the 💜 Selenite provider block from list.md and prune matching
URLs from docs/popular_links.json, then run convert_list_to_json.py.

Scheduled cutoff: May 5, 2026 7:00 PM America/Chicago (CDT).

Usage:
  - Before that time, the script exits with code 2 unless you pass --force (dry runs / tests).
  - At or after that time:  python3 scripts/temp_remove_selenite_after_shutdown.py
  - Cron (machine in US/Central): 0 19 5 5 * cd /path/to/proxy-list && python3 scripts/temp_remove_selenite_after_shutdown.py
  - Or: at 7pm local Chicago time, run the same command from a scheduled task.

Delete this file once Selenite links are gone and changes are merged.
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from datetime import datetime
from pathlib import Path

try:
    from zoneinfo import ZoneInfo
except ImportError:  # pragma: no cover
    print("Python 3.9+ with zoneinfo (tzdata) is required.", file=sys.stderr)
    raise SystemExit(1)

ROOT = Path(__file__).resolve().parents[1]
LIST_MD = ROOT / "list.md"
POPULAR_JSON = ROOT / "docs" / "popular_links.json"
CONVERT = ROOT / "scripts" / "convert_list_to_json.py"

# May 5, 2026 7:00 PM Central Daylight Time (America/Chicago)
DEADLINE = datetime(2026, 5, 5, 19, 0, 0, tzinfo=ZoneInfo("America/Chicago"))

SELENITE_H1 = re.compile(r"^#\s*💜\s+Selenite\s*$")
PROVIDER_H1 = re.compile(r"^#\s+")


def link_from_list_table_row(line: str) -> str | None:
    """Return the link URL from a list.md data row (| Locked | Link | ...), or None."""
    s = line.strip()
    if not s.startswith("|"):
        return None
    parts = [p.strip() for p in s.split("|")]
    if parts and parts[0] == "":
        parts = parts[1:]
    if parts and parts[-1] == "":
        parts = parts[:-1]
    for cell in parts:
        if cell.startswith(("http://", "https://")):
            return cell.split()[0].rstrip(".,;)")
    return None


def find_selenite_ranges(lines: list[str]) -> list[tuple[int, int]]:
    """Return [(start, end), ...] with end exclusive; each range is one provider section."""
    ranges: list[tuple[int, int]] = []
    i = 0
    n = len(lines)
    while i < n:
        if SELENITE_H1.match(lines[i]):
            start = i
            i += 1
            while i < n:
                line = lines[i]
                if PROVIDER_H1.match(line) and not line.startswith("##"):
                    break
                i += 1
            ranges.append((start, i))
            continue
        i += 1
    return ranges


def urls_in_ranges(lines: list[str], ranges: list[tuple[int, int]]) -> set[str]:
    out: set[str] = set()
    for start, end in ranges:
        for line in lines[start:end]:
            u = link_from_list_table_row(line)
            if u:
                out.add(u)
    return out


def prune_popular(urls_to_drop: set[str]) -> bool:
    """Return True if popular_links.json was modified."""
    if not POPULAR_JSON.is_file():
        return False
    try:
        data = json.loads(POPULAR_JSON.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return False
    raw = data.get("urls")
    if not isinstance(raw, list):
        return False

    def norm(u: str) -> str:
        return str(u).strip().rstrip("/")

    drop = {norm(u) for u in urls_to_drop}
    new_urls = []
    for u in raw:
        s = norm(str(u))
        if not s.startswith(("http://", "https://")):
            continue
        if norm(s) in drop or s in drop:
            continue
        new_urls.append(str(u).strip())

    if new_urls == raw:
        return False
    data["urls"] = new_urls
    POPULAR_JSON.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    return True


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument(
        "--force",
        action="store_true",
        help="Ignore the May 5 7pm CDT deadline (for testing or manual early removal).",
    )
    ap.add_argument(
        "--dry-run",
        action="store_true",
        help="Print what would be removed; do not write files or run convert.",
    )
    args = ap.parse_args()

    now = datetime.now(tz=ZoneInfo("America/Chicago"))
    if not args.force and now < DEADLINE:
        print(
            f"Too early: now Chicago is {now.isoformat()}.\n"
            f"Deadline is {DEADLINE.isoformat()}.\n"
            "Run again at or after that time, or use --force to run immediately.",
            file=sys.stderr,
        )
        return 2

    if not LIST_MD.is_file():
        print(f"Missing {LIST_MD}", file=sys.stderr)
        return 1

    text = LIST_MD.read_text(encoding="utf-8")
    lines = text.splitlines()

    ranges = find_selenite_ranges(lines)
    if not ranges:
        print("No # 💜 Selenite section found in list.md; nothing to do.", file=sys.stderr)
        return 0

    urls = urls_in_ranges(lines, ranges)
    total_lines = sum(end - start for start, end in ranges)

    print(f"Found {len(ranges)} Selenite section(s), {total_lines} lines, {len(urls)} URL(s) in block.")

    if args.dry_run:
        for start, end in ranges:
            print(f"  Would delete lines {start + 1}-{end} (1-based)")
        if urls:
            print("  URLs (also pruned from popular_links.json if present):")
            for u in sorted(urls):
                print(f"    {u}")
        return 0

    for start, end in reversed(ranges):
        del lines[start:end]

    LIST_MD.write_text("\n".join(lines) + ("\n" if text.endswith("\n") else ""), encoding="utf-8")
    print(f"Removed Selenite section from {LIST_MD.relative_to(ROOT)}")

    if urls and prune_popular(urls):
        print(f"Pruned Selenite URLs from {POPULAR_JSON.relative_to(ROOT)}")
    elif urls:
        print("No matching URLs removed from popular_links.json (none listed or file missing).")

    print("Running convert_list_to_json.py …")
    r = subprocess.run([sys.executable, str(CONVERT)], cwd=str(ROOT))
    return r.returncode


if __name__ == "__main__":
    raise SystemExit(main())
