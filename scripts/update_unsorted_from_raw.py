#!/usr/bin/env python3
"""Normalize raw unsorted link dumps into unsorted.md.

Rules applied:
- Keep only http/https URLs
- Drop bunny CDN links (b-cdn.net)
- Drop links already present in list.md (normalized, trailing slash-insensitive)
- Drop duplicates
"""

from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
LIST_MD = ROOT / "list.md"
UNSORTED_MD = ROOT / "unsorted.md"
RAW_INPUT = ROOT / "unsorted_raw.txt"

URL_RE = re.compile(r"https?://[^\s|)>\"]+")


def normalize(url: str) -> str:
    return url.strip().rstrip("/")


def extract_urls(text: str) -> list[str]:
    return [u.strip() for u in URL_RE.findall(text)]


def is_bcdn(url: str) -> bool:
    return ".b-cdn.net" in url.lower() or url.lower().startswith("https://b-cdn.net")


def load_existing_list_urls() -> set[str]:
    content = LIST_MD.read_text(encoding="utf-8")
    rows = re.findall(r"^\|\s\|\s*(https?://[^\s|]+)", content, re.MULTILINE)
    return {normalize(u) for u in rows}


def load_existing_unsorted_urls() -> list[str]:
    if not UNSORTED_MD.is_file():
        return []
    content = UNSORTED_MD.read_text(encoding="utf-8")
    return extract_urls(content)


def build_unsorted(urls: list[str]) -> str:
    lines = [
        "# Unsorted Links",
        "",
        "Links that do not have a confirmed provider section yet.",
        "Move links from here into `list.md` once sorted.",
        "",
    ]
    lines.extend(f"- {u}" for u in urls)
    lines.append("")
    return "\n".join(lines)


def main() -> int:
    if not RAW_INPUT.is_file():
        raise SystemExit(f"Missing raw input file: {RAW_INPUT}")

    list_urls = load_existing_list_urls()
    raw_urls = extract_urls(RAW_INPUT.read_text(encoding="utf-8"))
    carried = load_existing_unsorted_urls()

    # Keep order of first appearance across prior unsorted then new raw input.
    merged = carried + raw_urls
    out: list[str] = []
    seen: set[str] = set()

    for url in merged:
        n = normalize(url)
        if not n or n in seen:
            continue
        if is_bcdn(n):
            continue
        if n in list_urls:
            continue
        seen.add(n)
        out.append(n)

    UNSORTED_MD.write_text(build_unsorted(out), encoding="utf-8")
    print(f"Wrote {len(out)} unsorted links to {UNSORTED_MD}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
