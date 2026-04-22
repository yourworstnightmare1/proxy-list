#!/usr/bin/env python3
"""Track link additions/removals between link-check workflow runs."""

from __future__ import annotations

import json
import re
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
LIST_MD = ROOT / "list.md"
SNAPSHOT_PATH = ROOT / "docs" / "link_check_snapshot.json"
META_PATH = ROOT / "docs" / "link_check_meta.json"


def normalize_url(url: str) -> str:
    return url.strip().rstrip("/")


def extract_table_urls(content: str) -> list[str]:
    rows = re.findall(r"^\|\s\|\s*(https?://[^\s|]+)", content, re.MULTILINE)
    return [normalize_url(u) for u in rows]


def load_snapshot() -> tuple[list[str], bool]:
    if not SNAPSHOT_PATH.is_file():
        return [], False
    try:
        data = json.loads(SNAPSHOT_PATH.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return [], True
    if not isinstance(data, list):
        return [], True
    out: list[str] = []
    seen: set[str] = set()
    for item in data:
        if not isinstance(item, str):
            continue
        url = normalize_url(item)
        if url and url not in seen:
            seen.add(url)
            out.append(url)
    return out, True


def save_json(path: Path, payload: dict | list[str]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def main() -> int:
    content = LIST_MD.read_text(encoding="utf-8")
    current = extract_table_urls(content)
    previous, had_snapshot = load_snapshot()

    prev_set = set(previous)
    curr_set = set(current)

    # Keep deterministic ordering based on source list/snapshot order.
    if had_snapshot:
        added = [u for u in current if u not in prev_set]
        removed = [u for u in previous if u not in curr_set]
    else:
        # First run in this repo: establish baseline without reporting all links as "added".
        added = []
        removed = []

    now = datetime.now(timezone.utc)
    payload = {
        "checked_at": now.isoformat(timespec="seconds").replace("+00:00", "Z"),
        "checked_at_display": now.strftime("%Y-%m-%d %H:%M UTC"),
        "added_count": len(added),
        "removed_count": len(removed),
        "added_links": added,
        "removed_links": removed,
    }

    save_json(META_PATH, payload)
    save_json(SNAPSHOT_PATH, current)
    print(
        f"Updated link check metadata: +{payload['added_count']} / -{payload['removed_count']} "
        f"at {payload['checked_at_display']}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
