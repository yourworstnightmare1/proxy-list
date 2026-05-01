#!/usr/bin/env python3
"""Apply PR link additions onto the current list.md when GitHub reports merge conflicts.

Resolves section headings by alphanumeric key (so emoji / casing differences match),
applies a small alias map (e.g. PeteZah vs PetZah), skips removed sections (Waves),
then appends any PR-only provider sections not present on main.

Usage:
  python scripts/apply_pr_diff_links.py <base_commit> <pr_ref>
"""

from __future__ import annotations

import argparse
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

_LINK_ROW = re.compile(r"^\|\s*\|\s*(https?://[^\s|]+)", re.IGNORECASE)

# PR norm_key -> main norm_key (when names differ)
NK_ALIAS: dict[str, str] = {
    "petezah": "petzah",
    "otonic": "ontonic",
    "parcoil": "lunaar",
    "ghostservices": "ghost",
    "pizzaedition": "thepizzaedition",
}

# PR provider sections not to import (removed from main by policy)
SKIP_PR_SECTION_NK = frozenset({"waves"})


def norm_key(heading_line: str) -> str:
    s = heading_line.lstrip("#").strip().lower()
    return "".join(c for c in s if c.isalnum())


def normalize_url(u: str) -> str:
    return u.strip().rstrip("/")


def urls_in_document(text: str) -> set[str]:
    found: set[str] = set()
    for line in text.splitlines():
        m = _LINK_ROW.search(line)
        if m:
            found.add(normalize_url(m.group(1)))
    return found


def split_provider_sections(lines: list[str]) -> list[tuple[str, int, int]]:
    indices: list[tuple[str, int]] = []
    for i, line in enumerate(lines):
        if line.startswith("# "):
            indices.append((line.strip(), i))
    blocks: list[tuple[str, int, int]] = []
    for j, (h, start) in enumerate(indices):
        end = indices[j + 1][1] if j + 1 < len(indices) else len(lines)
        blocks.append((h, start, end))
    return blocks


def main_heading_index(lines: list[str]) -> dict[str, str]:
    """norm_key -> canonical `# ...` heading line (first occurrence wins)."""
    out: dict[str, str] = {}
    for h, _s, _e in split_provider_sections(lines):
        k = norm_key(h)
        out.setdefault(k, h)
    return out


def resolve_pr_heading(pr_heading_line: str, main_idx: dict[str, str]) -> str | None:
    """Return canonical main heading line for this PR section, or None."""
    nk = norm_key(pr_heading_line)
    nk = NK_ALIAS.get(nk, nk)
    if nk in SKIP_PR_SECTION_NK:
        return None
    return main_idx.get(nk)


def parse_diff_for_added_rows(diff_text: str) -> dict[str, list[str]]:
    """PR section heading line -> added table rows."""
    current_section = "__preamble__"
    by_section: dict[str, list[str]] = {}

    for raw in diff_text.splitlines():
        if raw.startswith("+++ ") or raw.startswith("--- "):
            continue
        if raw.startswith("diff ") or raw.startswith("index "):
            continue
        if raw.startswith("@@"):
            continue
        if raw.startswith("\\"):
            continue

        prefix = raw[:1] if raw else ""
        body = raw[1:] if prefix in "+- " else raw

        if body.startswith("# "):
            current_section = body.strip()

        if prefix != "+":
            continue
        if "|" not in body or "http" not in body:
            continue
        if not _LINK_ROW.search(body):
            continue
        by_section.setdefault(current_section, []).append(body.rstrip())

    return by_section


def sync_note_link_counts(section_lines: list[str]) -> list[str]:
    NOTE_CATEGORY_LINE = "> | Category | Capabilities | Protocol(s) | Links |"
    NOTE_SEP_LINE_RE = re.compile(r"^> \| - \|")

    out = section_lines[:]
    i = 0
    while i < len(out):
        line = out[i]
        if (
            line.strip() == NOTE_CATEGORY_LINE
            and i + 2 < len(out)
            and NOTE_SEP_LINE_RE.match(out[i + 1])
        ):
            meta_line = out[i + 2]
            if meta_line.startswith("> |") and not meta_line.startswith("> | -"):
                chunk = "\n".join(out[i:])
                n = len(re.findall(r"^\|\s\|\s*https?://", chunk, re.MULTILINE))
                new_meta = re.sub(r"\|\s*\d+\s*\|\s*$", f"| {n} |", meta_line)
                out[i + 2] = new_meta
                i += 3
                continue
        i += 1
    return out


def apply_rows(
    list_text: str,
    rows_by_pr_heading: dict[str, list[str]],
    main_idx: dict[str, str],
    existing_urls: set[str],
) -> tuple[str, int, set[str]]:
    """Returns (new_text, rows_added, canonical_main_headings_touched)."""
    lines = list_text.splitlines()
    added = 0
    touched: set[str] = set()

    # Group rows by resolved main heading
    grouped: dict[str, list[str]] = {}
    for pr_h, rows in rows_by_pr_heading.items():
        if pr_h == "__preamble__":
            continue
        target = resolve_pr_heading(pr_h, main_idx)
        if target is None:
            nk = norm_key(pr_h)
            if nk in SKIP_PR_SECTION_NK:
                continue
            print(f"[warn] No matching section for PR heading (will try append): {pr_h!r}", file=sys.stderr)
            continue
        grouped.setdefault(target, []).extend(rows)

    for heading, rows in grouped.items():
        blocks = split_provider_sections(lines)
        heading_to_block = {h: (s, e) for h, s, e in blocks}
        if heading not in heading_to_block:
            print(f"[warn] Resolved heading missing from file: {heading!r}", file=sys.stderr)
            continue
        _start, end = heading_to_block[heading]
        to_insert: list[str] = []
        for row in rows:
            m = _LINK_ROW.search(row)
            if not m:
                continue
            nu = normalize_url(m.group(1))
            if nu in existing_urls:
                continue
            to_insert.append(row)
            existing_urls.add(nu)
        if not to_insert:
            continue
        for i, row in enumerate(to_insert):
            lines.insert(end + i, row)
        added += len(to_insert)
        touched.add(heading)

    merged = "\n".join(lines)
    if added == 0 and not touched:
        return merged, 0, touched

    lines = merged.splitlines()
    blocks = split_provider_sections(lines)
    new_lines: list[str] = []
    for h, start, end in blocks:
        chunk = lines[start:end]
        if h in touched:
            chunk = sync_note_link_counts(chunk)
        new_lines.extend(chunk)

    return "\n".join(new_lines), added, touched


def append_new_sections_from_pr(main_text: str, pr_text: str, existing_urls: set[str]) -> tuple[str, int]:
    """Append full provider sections that exist in PR but not on main (after alias/skip)."""
    main_lines = main_text.splitlines()
    pr_lines = pr_text.splitlines()
    main_idx = main_heading_index(main_lines)

    appended = 0
    pr_blocks = split_provider_sections(pr_lines)
    parts_to_append: list[str] = []

    for pr_h, start, end in pr_blocks:
        if pr_h.strip() == "# Proxy List":
            continue
        nk = norm_key(pr_h)
        nk = NK_ALIAS.get(nk, nk)
        if nk in SKIP_PR_SECTION_NK:
            continue
        if nk in main_idx and resolve_pr_heading(pr_h, main_idx):
            continue  # already have this section on main
        if nk in main_idx:
            # same key exists — already merged rows above
            continue

        body = "\n".join(pr_lines[start:end])
        # Skip if every URL in this section already exists
        new_urls = []
        for line in body.splitlines():
            m = _LINK_ROW.search(line)
            if m:
                nu = normalize_url(m.group(1))
                if nu not in existing_urls:
                    new_urls.append(nu)
                    existing_urls.add(nu)
        if not new_urls:
            continue
        parts_to_append.append(body)
        appended += 1
        print(f"[info] Appended PR-only section {pr_h!r} ({len(new_urls)} new URLs)", file=sys.stderr)

    if not parts_to_append:
        return main_text, 0

    sep = "\n\n" if main_text.rstrip() else ""
    return main_text.rstrip() + sep + "\n\n".join(parts_to_append) + "\n", appended


def git_show(pr_ref: str, path: str) -> str:
    return subprocess.check_output(
        ["git", "-C", str(ROOT), "show", f"{pr_ref}:{path}"],
        stderr=subprocess.DEVNULL,
    ).decode("utf-8", errors="replace")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("base", help="Merge base commit (e.g. fork point on main)")
    ap.add_argument("pr_ref", help="PR head ref (e.g. pr-4)")
    ap.add_argument("--list", type=Path, default=ROOT / "list.md")
    args = ap.parse_args()

    diff = subprocess.check_output(
        ["git", "-C", str(ROOT), "diff", args.base, args.pr_ref, "--", "list.md"],
        stderr=subprocess.STDOUT,
    ).decode("utf-8", errors="replace")

    rows_by_section = parse_diff_for_added_rows(diff)
    total_rows = sum(len(v) for v in rows_by_section.values())
    print(f"Parsed {total_rows} added table rows from diff.", file=sys.stderr)

    list_path: Path = args.list
    text = list_path.read_text(encoding="utf-8")
    main_lines = text.splitlines()
    main_idx = main_heading_index(main_lines)
    existing = urls_in_document(text)

    pr_list_text = git_show(args.pr_ref, "list.md")

    new_text, added, _touched = apply_rows(text, rows_by_section, main_idx, existing)
    new_text, appended_sections = append_new_sections_from_pr(new_text, pr_list_text, urls_in_document(new_text))

    if added == 0 and appended_sections == 0:
        print("Nothing new to add.", file=sys.stderr)
        return 0

    list_path.write_text(new_text + ("\n" if not new_text.endswith("\n") else ""), encoding="utf-8")
    print(
        f"Updated {list_path.relative_to(ROOT)}: +{added} link row(s), +{appended_sections} new section(s).",
        file=sys.stderr,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
