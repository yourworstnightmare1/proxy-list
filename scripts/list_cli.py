#!/usr/bin/env python3
"""CLI for editing list.md sections, links, and header.

Examples:
  # Show current header / sections
  python3 scripts/list_cli.py header show
  python3 scripts/list_cli.py section list

  # Add a single link to a section (defaults: today's date, contributor=yourworstnightmare1)
  python3 scripts/list_cli.py link add --section "Velara" --url https://example.com/

  # Bulk add from file (one URL per line; blank lines & '#' comments skipped)
  python3 scripts/list_cli.py link bulk-add --section "gn-math" --file new_urls.txt

  # Edit an existing link
  python3 scripts/list_cli.py link edit --url https://example.com/ --found 4/28/2026 --locked "🔒"

  # Move a link to a different section
  python3 scripts/list_cli.py link edit --url https://example.com/ --section "Selenite"

  # Remove a link
  python3 scripts/list_cli.py link rm --url https://example.com/

  # Edit section metadata (changes flow to docs/data.json + index.html via convert)
  python3 scripts/list_cli.py section edit "Velara" --category Proxy/Games --capabilities captcha --protocols Scramjet

  # Add a new section
  python3 scripts/list_cli.py section add "🍕 Pizza" --category Games --capabilities N/A --protocols N/A --after "Velara"

  # Update header
  python3 scripts/list_cli.py header set --version v3.1 --revision r56 --last-updated "April 28, 2026"
  python3 scripts/list_cli.py header set --auto-total           # recount Total Links from list.md
  python3 scripts/list_cli.py header set --total-links 1234     # set explicit value

Global flags:
  --no-sync     Skip running convert_list_to_json.py (HTML/JSON won't reflect changes)
  --dry-run     Print what would change; don't write files
"""

from __future__ import annotations

import argparse
import re
import subprocess
import sys
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Iterable
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parents[1]
LIST_MD = ROOT / "list.md"
CONVERT_SCRIPT = ROOT / "scripts" / "convert_list_to_json.py"

DEFAULT_CONTRIBUTOR = "yourworstnightmare1"
DEFAULT_CONTRIBUTOR_URL = f"https://github.com/{DEFAULT_CONTRIBUTOR}"

TABLE_HEADER = "| Locked | Link | Found Date | Username | Password | Contributor |"
TABLE_SEPARATOR = "| - | - | - | - | - | - |"

ADMONITION_RE = re.compile(r"^>\s*\[!(?P<kind>[A-Z]+)\]\s*$")
SECTION_TITLE_RE = re.compile(r"^#\s+[^#].*$")
META_HEADER_RE = re.compile(r"^>\s*\|\s*Category\s*\|", re.IGNORECASE)


# ---------- low-level helpers ----------


def read_list() -> list[str]:
    raw = LIST_MD.read_text(encoding="utf-8")
    has_trailing_nl = raw.endswith("\n")
    lines = raw.split("\n")
    if has_trailing_nl and lines and lines[-1] == "":
        lines.pop()
    return lines


def write_list(lines: list[str], dry_run: bool = False) -> None:
    body = "\n".join(lines) + "\n"
    if dry_run:
        print("[dry-run] would write list.md (" f"{len(lines)} lines, {len(body)} bytes)")
        return
    LIST_MD.write_text(body, encoding="utf-8")


def strip_blockquote(line: str) -> str:
    s = line.lstrip()
    if s.startswith(">"):
        s = s[1:].lstrip()
    return s


def split_pipe_row(line: str) -> list[str]:
    s = strip_blockquote(line).strip()
    if not s.startswith("|"):
        return []
    parts = [p.strip() for p in s.split("|")]
    if parts and parts[0] == "":
        parts = parts[1:]
    if parts and parts[-1] == "":
        parts = parts[:-1]
    return parts


def today_date() -> str:
    now = datetime.now()
    return f"{now.month}/{now.day}/{now.year}"


def normalize_url(u: str) -> str:
    return u.strip().rstrip()


def url_match(a: str, b: str) -> bool:
    return a.strip().rstrip("/").casefold() == b.strip().rstrip("/").casefold()


# ---------- section model ----------


@dataclass
class Section:
    title: str
    title_idx: int
    end_idx: int  # exclusive: next section title or end of file
    note_idx: int | None = None  # "> [!NOTE]"
    meta_header_idx: int | None = None
    meta_sep_idx: int | None = None
    meta_data_idx: int | None = None
    category: str = ""
    capabilities: str = ""
    protocols: str = ""
    count_text: str = "0"
    important_idx: int | None = None  # "> [!IMPORTANT]" / etc. line
    important_body_idx: int | None = None  # text line
    important_kind: str = ""
    important_text: str = ""
    table_header_idx: int | None = None
    table_sep_idx: int | None = None
    table_first_row_idx: int | None = None
    table_last_row_idx: int | None = None  # inclusive
    table_row_indices: list[int] = field(default_factory=list)

    @property
    def name_no_emoji(self) -> str:
        return re.sub(r"^[^\w]+", "", self.title).strip()

    @property
    def link_count(self) -> int:
        return len(self.table_row_indices)


def parse_sections(lines: list[str]) -> list[Section]:
    """Parse list.md into sections. Skips the top-level '# Proxy List' header and
    its '## Important Notices' subtree."""
    indices: list[tuple[int, str]] = []
    for i, line in enumerate(lines):
        if SECTION_TITLE_RE.match(line) and not line.startswith("##"):
            title = re.sub(r"^#\s+", "", line).strip()
            indices.append((i, title))

    sections: list[Section] = []
    for idx, (start, title) in enumerate(indices):
        if title.casefold() == "proxy list":
            continue
        end = indices[idx + 1][0] if idx + 1 < len(indices) else len(lines)
        sec = Section(title=title, title_idx=start, end_idx=end)
        _populate_section(lines, sec)
        sections.append(sec)
    return sections


def _populate_section(lines: list[str], sec: Section) -> None:
    i = sec.title_idx + 1
    # locate first admonition block, optional important block, and table
    while i < sec.end_idx:
        line = lines[i]
        s = line.strip()
        if s == "> [!NOTE]" and sec.note_idx is None:
            sec.note_idx = i
            # next non-empty line should be meta header
            j = i + 1
            if j < sec.end_idx and META_HEADER_RE.match(lines[j]):
                sec.meta_header_idx = j
                sec.meta_sep_idx = j + 1
                sec.meta_data_idx = j + 2
                cells = split_pipe_row(lines[sec.meta_data_idx]) if sec.meta_data_idx < sec.end_idx else []
                sec.category = cells[0] if len(cells) > 0 else ""
                sec.capabilities = cells[1] if len(cells) > 1 else ""
                sec.protocols = cells[2] if len(cells) > 2 else ""
                sec.count_text = cells[3] if len(cells) > 3 else "0"
                i = sec.meta_data_idx + 1
                continue
        m = ADMONITION_RE.match(s)
        if m and sec.note_idx is not None and m.group("kind") != "NOTE":
            sec.important_idx = i
            sec.important_kind = m.group("kind")
            j = i + 1
            while j < sec.end_idx and lines[j].lstrip().startswith(">"):
                if strip_blockquote(lines[j]).strip():
                    sec.important_body_idx = j
                    sec.important_text = strip_blockquote(lines[j]).strip()
                    j += 1
                    break
                j += 1
            i = j
            continue
        if s.startswith("|") and "Locked" in s and "Link" in s and sec.table_header_idx is None:
            sec.table_header_idx = i
            sec.table_sep_idx = i + 1
            j = i + 2
            indices: list[int] = []
            while j < sec.end_idx:
                ls = lines[j].lstrip()
                if ls.startswith("|") and parse_link_row(lines[j]) is not None:
                    indices.append(j)
                    j += 1
                    continue
                if ls == "" or ls.startswith("|"):
                    j += 1
                    continue
                break
            sec.table_row_indices = indices
            sec.table_first_row_idx = indices[0] if indices else None
            sec.table_last_row_idx = indices[-1] if indices else None
            i = j
            continue
        i += 1


def find_section(sections: list[Section], name: str) -> Section:
    needle = name.strip()
    if not needle:
        raise SystemExit("section name is empty")
    exact = [s for s in sections if s.title == needle]
    if len(exact) == 1:
        return exact[0]
    if len(exact) > 1:
        raise SystemExit(f"ambiguous section title (exact): {[s.title for s in exact]}")
    cf = needle.casefold()
    starts = [s for s in sections if s.title.casefold().startswith(cf) or s.name_no_emoji.casefold().startswith(cf)]
    if len(starts) == 1:
        return starts[0]
    contains = [s for s in sections if cf in s.title.casefold() or cf in s.name_no_emoji.casefold()]
    if len(contains) == 1:
        return contains[0]
    candidates = starts or contains
    if not candidates:
        raise SystemExit(f"no section matched '{name}'. Try `section list`.")
    raise SystemExit(
        f"ambiguous section '{name}'. Candidates: " + ", ".join(s.title for s in candidates)
    )


# ---------- recount + header ----------


def update_section_counts(lines: list[str]) -> int:
    """Rewrite each section's 'Links' meta cell to match its actual table row count.
    Returns the total number of link rows across all sections."""
    sections = parse_sections(lines)
    total = 0
    for sec in sections:
        n = sec.link_count
        total += n
        if sec.meta_data_idx is not None:
            cells = split_pipe_row(lines[sec.meta_data_idx])
            while len(cells) < 4:
                cells.append("")
            cells[3] = str(n)
            lines[sec.meta_data_idx] = "> | " + " | ".join(cells) + " |"
    return total


def update_total_links(lines: list[str], total: int) -> bool:
    for i, line in enumerate(lines[:40]):
        m = re.match(r"^(\s*>\s*Total Links:\s*)(\d+)(\s*\\?\s*)$", line)
        if m:
            new_line = f"{m.group(1)}{total}{m.group(3)}"
            if new_line != line:
                lines[i] = new_line
                return True
            return False
    return False


def get_header_info(lines: list[str]) -> dict[str, str]:
    info = {"version": "", "released": "", "revision": "", "last_updated": "", "total_links": ""}
    for line in lines[:40]:
        inner = strip_blockquote(line).strip()
        mv = re.match(r"^(v[\d.]+)\s*\|\s*Released:\s*(.+?)\s*\\?$", inner)
        if mv:
            info["version"] = mv.group(1)
            info["released"] = mv.group(2)
            continue
        mr = re.match(r"^(r\d+)\s*\|\s*Last Updated:\s*(.+?)\s*\\?$", inner, re.IGNORECASE)
        if mr:
            info["revision"] = mr.group(1).lower()
            info["last_updated"] = mr.group(2)
            continue
        mt = re.match(r"^Total Links:\s*(\d+)\s*\\?$", inner, re.IGNORECASE)
        if mt:
            info["total_links"] = mt.group(1)
    return info


def set_header(
    lines: list[str],
    version: str | None = None,
    released: str | None = None,
    revision: str | None = None,
    last_updated: str | None = None,
    total_links: int | None = None,
) -> list[str]:
    notes: list[str] = []
    for i in range(min(40, len(lines))):
        line = lines[i]
        inner = strip_blockquote(line).strip()
        prefix_m = re.match(r"^(\s*>\s*)", line)
        prefix = prefix_m.group(1) if prefix_m else "> "
        mv = re.match(r"^(v[\d.]+)\s*\|\s*Released:\s*(.+?)\s*(\\?)\s*$", inner)
        if mv:
            v = version if version is not None else mv.group(1)
            r = released if released is not None else mv.group(2)
            tail = mv.group(3)
            new_inner = f"{v} | Released: {r}{tail}"
            new_line = prefix + new_inner
            if new_line != line:
                lines[i] = new_line
                notes.append(f"version line -> {new_inner}")
            continue
        mr = re.match(r"^(r\d+)\s*\|\s*Last Updated:\s*(.+?)\s*(\\?)\s*$", inner, re.IGNORECASE)
        if mr:
            rv = revision if revision is not None else mr.group(1)
            lu = last_updated if last_updated is not None else mr.group(2)
            tail = mr.group(3)
            new_inner = f"{rv} | Last Updated: {lu}{tail}"
            new_line = prefix + new_inner
            if new_line != line:
                lines[i] = new_line
                notes.append(f"revision line -> {new_inner}")
            continue
        mt = re.match(r"^Total Links:\s*(\d+)\s*(\\?)\s*$", inner, re.IGNORECASE)
        if mt and total_links is not None:
            tail = mt.group(2)
            new_inner = f"Total Links: {total_links}{tail}"
            new_line = prefix + new_inner
            if new_line != line:
                lines[i] = new_line
                notes.append(f"total links -> {new_inner}")
    return notes


# ---------- link rendering ----------


def format_contributor(name: str, url: str | None) -> str:
    name = (name or "").strip()
    if not name:
        return ""
    if url:
        return f"[{name}]({url})"
    if name == DEFAULT_CONTRIBUTOR:
        return f"[{name}]({DEFAULT_CONTRIBUTOR_URL})"
    return name


def render_link_row(
    locked: str,
    link: str,
    found: str,
    username: str,
    password: str,
    contributor_md: str,
) -> str:
    return f"| {locked} | {link} | {found} | {username} | {password} | {contributor_md}"


def parse_link_row(line: str) -> dict | None:
    cells = split_pipe_row(line)
    if len(cells) < 6:
        return None
    if cells[0] in ("Locked", "-") and cells[1] in ("Link", "-"):
        return None
    locked, link, found, username, password, contributor = cells[:6]
    if not link.startswith(("http://", "https://")):
        return None
    return {
        "locked": locked,
        "link": link,
        "found": found,
        "username": username,
        "password": password,
        "contributor": contributor,
    }


# ---------- mutation: links ----------


def find_link(lines: list[str], url: str) -> tuple[Section, int] | None:
    sections = parse_sections(lines)
    for sec in sections:
        if sec.table_first_row_idx is None:
            continue
        for j in range(sec.table_first_row_idx, sec.table_last_row_idx + 1):
            row = parse_link_row(lines[j])
            if row and url_match(row["link"], url):
                return sec, j
    return None


def insert_link_row(
    lines: list[str],
    section: Section,
    *,
    url: str,
    found: str = "",
    locked: str = "",
    username: str = "N/A",
    password: str = "N/A",
    contributor: str = DEFAULT_CONTRIBUTOR,
    contributor_url: str | None = None,
) -> int:
    found = found or today_date()
    contrib_url = contributor_url or (DEFAULT_CONTRIBUTOR_URL if contributor == DEFAULT_CONTRIBUTOR else None)
    contrib_md = format_contributor(contributor, contrib_url)
    row = render_link_row(locked, url, found, username, password, contrib_md)
    if section.table_first_row_idx is None:
        # No existing table; append after meta block (or after important block) inside section
        anchor = section.important_body_idx or section.meta_data_idx or section.note_idx or section.title_idx
        # Ensure blank line before table
        insert_at = anchor + 1
        # advance past any contiguous blank lines
        while insert_at < section.end_idx and lines[insert_at].strip() == "":
            insert_at += 1
        block = ["", TABLE_HEADER, TABLE_SEPARATOR, row]
        lines[insert_at:insert_at] = block
        return insert_at + 3
    insert_at = section.table_last_row_idx + 1
    lines.insert(insert_at, row)
    return insert_at


def cmd_link_add(args, dry: bool) -> int:
    lines = read_list()
    sections = parse_sections(lines)
    sec = find_section(sections, args.section)
    if find_link(lines, args.url):
        print(f"warning: a link matching {args.url} already exists; adding anyway", file=sys.stderr)
    insert_link_row(
        lines,
        sec,
        url=args.url,
        found=args.found or today_date(),
        locked=args.locked or "",
        username=args.username or "N/A",
        password=args.password or "N/A",
        contributor=args.contributor or DEFAULT_CONTRIBUTOR,
        contributor_url=args.contributor_url,
    )
    total = update_section_counts(lines)
    update_total_links(lines, total)
    write_list(lines, dry)
    print(f"added 1 link to '{sec.title}' (section now has {parse_sections(lines)[next(i for i,s in enumerate(parse_sections(lines)) if s.title == sec.title)].link_count}; total={total})")
    return 0


def cmd_link_bulk_add(args, dry: bool) -> int:
    urls: list[str] = []
    if args.file:
        text = Path(args.file).read_text(encoding="utf-8")
    elif args.stdin:
        text = sys.stdin.read()
    else:
        raise SystemExit("provide --file or --stdin")
    for raw in text.splitlines():
        s = raw.strip()
        if not s or s.startswith("#"):
            continue
        urls.append(s)
    if not urls:
        print("no urls to add", file=sys.stderr)
        return 1
    lines = read_list()
    sections = parse_sections(lines)
    sec = find_section(sections, args.section)
    sec_title = sec.title
    added = 0
    for url in urls:
        # re-parse sections (positions shift after insert)
        cur_sections = parse_sections(lines)
        cur_sec = next((x for x in cur_sections if x.title == sec_title), None)
        if cur_sec is None:
            raise SystemExit(f"section '{sec_title}' disappeared mid-bulk; aborting")
        insert_link_row(
            lines,
            cur_sec,
            url=url,
            found=args.found or today_date(),
            locked=args.locked or "",
            username=args.username or "N/A",
            password=args.password or "N/A",
            contributor=args.contributor or DEFAULT_CONTRIBUTOR,
            contributor_url=args.contributor_url,
        )
        added += 1
    total = update_section_counts(lines)
    update_total_links(lines, total)
    write_list(lines, dry)
    print(f"bulk-added {added} link(s) to '{sec_title}' (total now {total})")
    return 0


def cmd_link_edit(args, dry: bool) -> int:
    lines = read_list()
    located = find_link(lines, args.url)
    if not located:
        raise SystemExit(f"no link found matching {args.url}")
    sec, idx = located
    row = parse_link_row(lines[idx])
    assert row is not None
    new_url = args.new_url or row["link"]
    new_locked = args.locked if args.locked is not None else row["locked"]
    new_found = args.found or row["found"]
    new_user = args.username if args.username is not None else row["username"]
    new_pass = args.password if args.password is not None else row["password"]
    if args.contributor is not None or args.contributor_url is not None:
        c_name = args.contributor or DEFAULT_CONTRIBUTOR
        c_url = args.contributor_url or (DEFAULT_CONTRIBUTOR_URL if c_name == DEFAULT_CONTRIBUTOR else None)
        new_contrib = format_contributor(c_name, c_url)
    else:
        new_contrib = row["contributor"]
    new_row_line = render_link_row(new_locked, new_url, new_found, new_user, new_pass, new_contrib)

    if args.section and args.section.strip() and not _section_titles_match(args.section, sec.title):
        # Move row to a different section
        del lines[idx]
        # Re-parse and target
        sections_after = parse_sections(lines)
        target = find_section(sections_after, args.section)
        # Build a fake Section-like position using current state
        insert_link_row(
            lines,
            target,
            url=new_url,
            found=new_found,
            locked=new_locked,
            username=new_user,
            password=new_pass,
            contributor=(args.contributor or DEFAULT_CONTRIBUTOR),
            contributor_url=args.contributor_url,
        )
    else:
        lines[idx] = new_row_line
    total = update_section_counts(lines)
    update_total_links(lines, total)
    write_list(lines, dry)
    print(f"edited link {row['link']} -> {new_url}")
    return 0


def _section_titles_match(query: str, title: str) -> bool:
    q = query.strip().casefold()
    t = title.casefold()
    no_emoji = re.sub(r"^[^\w]+", "", title).strip().casefold()
    return q == t or q == no_emoji


def cmd_link_rm(args, dry: bool) -> int:
    lines = read_list()
    removed = 0
    while True:
        located = find_link(lines, args.url)
        if not located:
            break
        _, idx = located
        del lines[idx]
        removed += 1
        if not args.all:
            break
    if removed == 0:
        raise SystemExit(f"no link found matching {args.url}")
    total = update_section_counts(lines)
    update_total_links(lines, total)
    write_list(lines, dry)
    print(f"removed {removed} link(s) matching {args.url}")
    return 0


# ---------- mutation: sections ----------


def cmd_section_list(args, dry: bool) -> int:
    lines = read_list()
    sections = parse_sections(lines)
    width = max((len(s.title) for s in sections), default=4)
    for s in sections:
        line = f"{s.title.ljust(width)}  links={s.link_count:>4}"
        if args.verbose:
            line += f"  category={s.category!r}  capabilities={s.capabilities!r}  protocols={s.protocols!r}"
            if s.important_text:
                imp = s.important_text if len(s.important_text) <= 80 else s.important_text[:77] + "..."
                line += f"\n    [!{s.important_kind}] {imp}"
        print(line)
    return 0


def cmd_section_show(args, dry: bool) -> int:
    lines = read_list()
    sections = parse_sections(lines)
    sec = find_section(sections, args.name)
    print(f"Title:        {sec.title}")
    print(f"Category:     {sec.category}")
    print(f"Capabilities: {sec.capabilities}")
    print(f"Protocols:    {sec.protocols}")
    print(f"Links:        {sec.link_count} (meta cell says: {sec.count_text})")
    if sec.important_text:
        print(f"[!{sec.important_kind}] {sec.important_text}")
    if sec.table_first_row_idx is not None:
        print("Links:")
        for j in range(sec.table_first_row_idx, sec.table_last_row_idx + 1):
            row = parse_link_row(lines[j])
            if row:
                lock = row["locked"] or " "
                print(f"  [{lock}] {row['link']}  ({row['found']}, {row['contributor']})")
    return 0


def cmd_section_add(args, dry: bool) -> int:
    lines = read_list()
    sections = parse_sections(lines)
    if any(s.title == args.name for s in sections):
        raise SystemExit(f"section '{args.name}' already exists")
    if args.before and args.after:
        raise SystemExit("--before and --after are mutually exclusive")

    insert_pos = len(lines)
    if args.before:
        target = find_section(sections, args.before)
        insert_pos = target.title_idx
    elif args.after:
        target = find_section(sections, args.after)
        insert_pos = target.end_idx

    block = [
        f"# {args.name}",
        "> [!NOTE]",
        "> | Category | Capabilities | Protocol(s) | Links |",
        "> | - | - | - | - |",
        f"> | {args.category or 'N/A'} | {args.capabilities or 'N/A'} | {args.protocols or 'N/A'} | 0 |",
        "",
    ]
    if args.important:
        kind = (args.important_kind or "IMPORTANT").upper()
        block += [
            f"> [!{kind}]",
            f"> {args.important}",
            "",
        ]
    block += [
        TABLE_HEADER,
        TABLE_SEPARATOR,
        "",
    ]
    while insert_pos > 0 and lines[insert_pos - 1].strip() == "":
        insert_pos -= 1
    lines[insert_pos:insert_pos] = ([""] if insert_pos > 0 else []) + block
    total = update_section_counts(lines)
    update_total_links(lines, total)
    write_list(lines, dry)
    print(f"added section '{args.name}' (position {insert_pos})")
    return 0


def cmd_section_edit(args, dry: bool) -> int:
    lines = read_list()
    sections = parse_sections(lines)
    sec = find_section(sections, args.name)

    if args.new_name and args.new_name != sec.title:
        lines[sec.title_idx] = f"# {args.new_name}"

    if sec.meta_data_idx is not None:
        cells = split_pipe_row(lines[sec.meta_data_idx])
        while len(cells) < 4:
            cells.append("")
        if args.category is not None:
            cells[0] = args.category
        if args.capabilities is not None:
            cells[1] = args.capabilities
        if args.protocols is not None:
            cells[2] = args.protocols
        lines[sec.meta_data_idx] = "> | " + " | ".join(cells) + " |"

    if args.important is not None or args.no_important:
        if args.no_important:
            if sec.important_idx is not None:
                # remove admonition + body line (and trailing blank if any)
                end = (sec.important_body_idx or sec.important_idx) + 1
                # also drop a single trailing blank line if present
                if end < sec.end_idx and lines[end].strip() == "":
                    end += 1
                del lines[sec.important_idx:end]
        else:
            kind = (args.important_kind or sec.important_kind or "IMPORTANT").upper()
            new_block = [f"> [!{kind}]", f"> {args.important}", ""]
            if sec.important_idx is not None:
                end = (sec.important_body_idx or sec.important_idx) + 1
                if end < sec.end_idx and lines[end].strip() == "":
                    end += 1
                lines[sec.important_idx:end] = new_block
            else:
                anchor = (sec.meta_data_idx or sec.note_idx or sec.title_idx) + 1
                while anchor < len(lines) and lines[anchor].strip() == "":
                    anchor += 1
                lines[anchor:anchor] = new_block + ([""] if anchor < len(lines) and lines[anchor].strip() != "" else [])

    total = update_section_counts(lines)
    update_total_links(lines, total)
    write_list(lines, dry)
    print(f"edited section '{sec.title}'")
    return 0


def cmd_section_rm(args, dry: bool) -> int:
    lines = read_list()
    sections = parse_sections(lines)
    sec = find_section(sections, args.name)
    if not args.yes:
        raise SystemExit(
            f"refusing to remove section '{sec.title}' with {sec.link_count} link(s); pass --yes to confirm"
        )
    del lines[sec.title_idx:sec.end_idx]
    total = update_section_counts(lines)
    update_total_links(lines, total)
    write_list(lines, dry)
    print(f"removed section '{sec.title}'")
    return 0


# ---------- header commands ----------


def cmd_header_show(args, dry: bool) -> int:
    lines = read_list()
    info = get_header_info(lines)
    sections = parse_sections(lines)
    actual_total = sum(s.link_count for s in sections)
    print(f"Version:      {info['version']}")
    print(f"Released:     {info['released']}")
    print(f"Revision:     {info['revision']}")
    print(f"Last Updated: {info['last_updated']}")
    print(f"Total Links:  {info['total_links']}  (actual count: {actual_total})")
    return 0


def cmd_header_set(args, dry: bool) -> int:
    lines = read_list()
    if args.auto_total and args.total_links is not None:
        raise SystemExit("--auto-total and --total-links are mutually exclusive")
    total = None
    if args.total_links is not None:
        total = args.total_links
    notes = set_header(
        lines,
        version=args.version,
        released=args.released,
        revision=args.revision,
        last_updated=args.last_updated,
        total_links=total,
    )
    actual_total = update_section_counts(lines)
    if args.auto_total:
        if update_total_links(lines, actual_total):
            notes.append(f"total links -> Total Links: {actual_total} (auto)")
    write_list(lines, dry)
    if notes:
        for n in notes:
            print(n)
    else:
        print("no header changes")
    return 0


# ---------- sync ----------


def run_convert(skip: bool) -> int:
    if skip:
        return 0
    if not CONVERT_SCRIPT.is_file():
        print(f"warning: {CONVERT_SCRIPT} not found; skipping convert", file=sys.stderr)
        return 0
    try:
        result = subprocess.run(
            [sys.executable, str(CONVERT_SCRIPT)],
            cwd=str(ROOT),
            check=False,
            capture_output=True,
            text=True,
        )
    except FileNotFoundError as exc:
        print(f"warning: failed to run convert: {exc}", file=sys.stderr)
        return 0
    if result.stdout:
        print(result.stdout.rstrip())
    if result.stderr:
        print(result.stderr.rstrip(), file=sys.stderr)
    return result.returncode


# ---------- argparse ----------


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="list_cli",
        description="Edit list.md (sections, links, header). Auto-syncs docs/data.json so the HTML view updates.",
    )
    p.add_argument("--no-sync", action="store_true", help="skip running scripts/convert_list_to_json.py after edits")
    p.add_argument("--dry-run", action="store_true", help="don't write list.md or run convert")

    sub = p.add_subparsers(dest="group", required=True)

    # link
    g_link = sub.add_parser("link", help="link operations")
    sl = g_link.add_subparsers(dest="cmd", required=True)

    add = sl.add_parser("add", help="add a single link")
    add.add_argument("--section", required=True)
    add.add_argument("--url", required=True)
    add.add_argument("--found")
    add.add_argument("--locked", default="")
    add.add_argument("--username", default="N/A")
    add.add_argument("--password", default="N/A")
    add.add_argument("--contributor", default=DEFAULT_CONTRIBUTOR)
    add.add_argument("--contributor-url")
    add.set_defaults(func=cmd_link_add)

    bulk = sl.add_parser("bulk-add", help="add many links from --file or --stdin")
    bulk.add_argument("--section", required=True)
    bulk.add_argument("--file")
    bulk.add_argument("--stdin", action="store_true")
    bulk.add_argument("--found")
    bulk.add_argument("--locked", default="")
    bulk.add_argument("--username", default="N/A")
    bulk.add_argument("--password", default="N/A")
    bulk.add_argument("--contributor", default=DEFAULT_CONTRIBUTOR)
    bulk.add_argument("--contributor-url")
    bulk.set_defaults(func=cmd_link_bulk_add)

    ed = sl.add_parser("edit", help="edit an existing link (matched by URL)")
    ed.add_argument("--url", required=True)
    ed.add_argument("--section")
    ed.add_argument("--new-url")
    ed.add_argument("--found")
    ed.add_argument("--locked")
    ed.add_argument("--username")
    ed.add_argument("--password")
    ed.add_argument("--contributor")
    ed.add_argument("--contributor-url")
    ed.set_defaults(func=cmd_link_edit)

    rm = sl.add_parser("rm", help="remove a link by URL")
    rm.add_argument("--url", required=True)
    rm.add_argument("--all", action="store_true", help="remove all matching rows")
    rm.set_defaults(func=cmd_link_rm)

    # section
    g_sec = sub.add_parser("section", help="section operations")
    ss = g_sec.add_subparsers(dest="cmd", required=True)

    sl_list = ss.add_parser("list", help="list sections")
    sl_list.add_argument("-v", "--verbose", action="store_true")
    sl_list.set_defaults(func=cmd_section_list)

    sl_show = ss.add_parser("show", help="show a single section")
    sl_show.add_argument("name")
    sl_show.set_defaults(func=cmd_section_show)

    sl_add = ss.add_parser("add", help="create a new section")
    sl_add.add_argument("name", help='full title incl. emoji, e.g. "🍕 Pizza"')
    sl_add.add_argument("--category", default="N/A")
    sl_add.add_argument("--capabilities", default="N/A")
    sl_add.add_argument("--protocols", default="N/A")
    sl_add.add_argument("--important")
    sl_add.add_argument("--important-kind", default="IMPORTANT")
    grp = sl_add.add_mutually_exclusive_group()
    grp.add_argument("--before")
    grp.add_argument("--after")
    sl_add.set_defaults(func=cmd_section_add)

    sl_edit = ss.add_parser("edit", help="edit section metadata")
    sl_edit.add_argument("name")
    sl_edit.add_argument("--new-name")
    sl_edit.add_argument("--category")
    sl_edit.add_argument("--capabilities")
    sl_edit.add_argument("--protocols")
    sl_edit.add_argument("--important")
    sl_edit.add_argument("--important-kind")
    sl_edit.add_argument("--no-important", action="store_true")
    sl_edit.set_defaults(func=cmd_section_edit)

    sl_rm = ss.add_parser("rm", help="delete a section (and all its links)")
    sl_rm.add_argument("name")
    sl_rm.add_argument("--yes", action="store_true")
    sl_rm.set_defaults(func=cmd_section_rm)

    # header
    g_hdr = sub.add_parser("header", help="header operations")
    sh = g_hdr.add_subparsers(dest="cmd", required=True)

    sh_show = sh.add_parser("show")
    sh_show.set_defaults(func=cmd_header_show)

    sh_set = sh.add_parser("set", help="edit version/revision/dates/total links")
    sh_set.add_argument("--version")
    sh_set.add_argument("--released")
    sh_set.add_argument("--revision")
    sh_set.add_argument("--last-updated")
    sh_set.add_argument("--total-links", type=int)
    sh_set.add_argument("--auto-total", action="store_true", help="recount Total Links from list.md")
    sh_set.set_defaults(func=cmd_header_set)

    return p


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    func = getattr(args, "func", None)
    if func is None:
        parser.print_help()
        return 2
    rc = func(args, args.dry_run)
    if rc != 0:
        return rc
    if not args.dry_run:
        rc2 = run_convert(args.no_sync)
        if rc2 != 0:
            return rc2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
