#!/usr/bin/env python3
"""Parse list.md into structured JSON for the static web UI."""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
INPUT = ROOT / "list.md"
OUTPUT = ROOT / "docs" / "data.json"
LINK_CHECK_META = ROOT / "docs" / "link_check_meta.json"
UNSORTED_INPUT = ROOT / "unsorted.md"
UNSORTED_OUTPUT = ROOT / "docs" / "unsorted.json"


def strip_blockquote_prefix(line: str) -> str:
    s = line.strip()
    if s.startswith(">"):
        s = s[1:].lstrip()
    return s


def split_pipe_row(line: str) -> list[str]:
    """Split a markdown table row into cells (handles optional leading/trailing pipes)."""
    s = strip_blockquote_prefix(line).strip()
    if not s.startswith("|"):
        return []
    parts = [p.strip() for p in s.split("|")]
    if parts and parts[0] == "":
        parts = parts[1:]
    if parts and parts[-1] == "":
        parts = parts[:-1]
    return parts


def split_list_field(s: str) -> list[str]:
    if not s or s.upper() == "N/A":
        return []
    return [t.strip().lower() for t in s.split(",") if t.strip()]


_CONTRIBUTOR_MD = re.compile(r"^\[([^\]]+)\]\(([^)]+)\)\s*$")


def parse_contributor_cell(raw: str) -> tuple[str, str | None]:
    """Return (display_name, optional_profile_url) for JSON / HTML."""
    s = raw.strip()
    m = _CONTRIBUTOR_MD.match(s)
    if m:
        return m.group(1).strip(), m.group(2).strip() or None
    if s == "yourworstnightmare1":
        return s, "https://github.com/yourworstnightmare1"
    return s, None


_IMPORTANT_NOTICES_H2 = re.compile(r"^##\s+Important Notices\s*$", re.IGNORECASE)


def parse_important_notices(text: str) -> str:
    """Return markdown-lite body for ## Important Notices … until next H1/H2 heading."""
    lines = text.splitlines()
    start = -1
    for i, raw in enumerate(lines):
        if _IMPORTANT_NOTICES_H2.match(raw.strip()):
            start = i + 1
            break
    if start < 0:
        return ""

    out_lines: list[str] = []
    for raw in lines[start:]:
        if re.match(r"^##\s+", raw):
            break
        if re.match(r"^#\s+", raw) and not raw.startswith("##"):
            break
        inner = strip_blockquote_prefix(raw).strip()
        if inner.startswith("[!") and inner.endswith("]"):
            continue
        if inner == "":
            continue
        if inner.casefold() == "<br>":
            continue
        out_lines.append(inner)

    return "\n".join(out_lines).strip()


def parse_list_meta(text: str) -> dict[str, str]:
    """Read vX.Y.Z, rN, and Last Updated from the list header blockquote."""
    version, revision, last_updated = "", "", ""
    for raw in text.splitlines()[:40]:
        inner = strip_blockquote_prefix(raw).strip()
        if inner.startswith("[!"):
            continue
        mv = re.match(r"^(v[\d.]+)\s*\|", inner)
        if mv:
            version = mv.group(1)
        mr = re.match(r"^(r\d+)\s*\|", inner, re.IGNORECASE)
        if mr:
            revision = mr.group(1).lower()
        mu = re.search(r"Last Updated:\s*(.+?)\s*\\?$", inner, re.IGNORECASE)
        if mu:
            last_updated = mu.group(1).strip()
    return {"version": version, "revision": revision, "last_updated": last_updated}


def load_link_check_meta() -> dict:
    if not LINK_CHECK_META.is_file():
        return {}
    try:
        return json.loads(LINK_CHECK_META.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return {}


def parse_unsorted_links() -> list[dict[str, str]]:
    if not UNSORTED_INPUT.is_file():
        return []
    raw = UNSORTED_INPUT.read_text(encoding="utf-8")
    links = re.findall(r"https?://[^\s|)]+", raw)
    seen: set[str] = set()
    out: list[dict[str, str]] = []
    for link in links:
        if link in seen:
            continue
        seen.add(link)
        out.append({"link": link})
    return out


def parse_list_md(text: str) -> list[dict]:
    rows: list[dict] = []
    current_provider: str | None = None
    section_category = ""
    section_capabilities = ""
    section_protocols = ""
    in_note_header = False

    for raw in text.splitlines():
        line = raw.rstrip("\n")

        if re.match(r"^#\s+[^#]", line) and not line.startswith("##"):
            title = re.sub(r"^#\s+", "", line).strip()
            if title.casefold() == "proxy list".casefold():
                current_provider = None
            else:
                current_provider = title
            section_category = ""
            section_capabilities = ""
            section_protocols = ""
            in_note_header = False
            continue

        inner = strip_blockquote_prefix(line)
        if inner.strip().startswith("| Category | Capabilities |"):
            in_note_header = True
            continue
        if in_note_header and re.match(r"^\s*\|?\s*-\s*\|", inner):
            continue
        if in_note_header and inner.strip().startswith("|"):
            cells = split_pipe_row(line)
            if (
                len(cells) >= 4
                and cells[0] != "Category"
                and cells[0] != "-"
                and not cells[0].replace("-", "").strip() == ""
            ):
                section_category = cells[0]
                section_capabilities = cells[1]
                section_protocols = cells[2]
            in_note_header = False
            continue

        if not line.strip().startswith("|") or line.strip().startswith(">|"):
            continue

        cells = split_pipe_row(line)
        if len(cells) < 6:
            continue
        if cells[0] == "Locked" and cells[1] == "Link":
            continue
        if cells[0] == "-" and cells[1] == "-":
            continue

        locked, link, found, username, password, contributor = cells[:6]
        if not link.startswith(("http://", "https://")):
            continue
        if not current_provider:
            continue

        cap_tags = split_list_field(section_capabilities)
        proto_tags = split_list_field(section_protocols)
        contrib_label, contrib_url = parse_contributor_cell(contributor)

        rows.append(
            {
                "provider": current_provider,
                "category": section_category,
                "capabilities": section_capabilities,
                "capability_tags": cap_tags,
                "protocols": section_protocols,
                "protocol_tags": proto_tags,
                "locked": locked,
                "link": link,
                "found": found,
                "username": username,
                "password": password,
                "contributor": contrib_label,
                "contributor_url": contrib_url,
            }
        )

    return rows


def main() -> int:
    if not INPUT.is_file():
        print(f"Missing {INPUT}", file=sys.stderr)
        return 1
    raw = INPUT.read_text(encoding="utf-8")
    meta = parse_list_meta(raw)
    important = parse_important_notices(raw)
    links = parse_list_md(raw)
    unsorted_links = parse_unsorted_links()
    payload = {
        "meta": {**meta, "unsorted_total": len(unsorted_links), "important_notices": important},
        "link_check": load_link_check_meta(),
        "links": links,
    }
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    UNSORTED_OUTPUT.write_text(json.dumps({"links": unsorted_links}, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    OUTPUT.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(
        f"Wrote {len(links)} sorted links to {OUTPUT}, {len(unsorted_links)} unsorted links to {UNSORTED_OUTPUT} "
        f"({meta.get('version', '')}{meta.get('revision', '')})"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
