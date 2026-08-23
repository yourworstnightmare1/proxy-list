#!/usr/bin/env python3
"""Parse list.md into structured JSON for the static web UI."""

from __future__ import annotations

import gzip
import json
import re
import sys
from pathlib import Path

from submission_url_key import submission_url_key

ROOT = Path(__file__).resolve().parents[1]
INPUT = ROOT / "list.md"
OUTPUT = ROOT / "docs" / "data.json"
OUTPUT_GZ = ROOT / "docs" / "data.json.gz"
CONTRIBUTOR_TOTALS = ROOT / "docs" / "contributor_link_totals.json"
LINK_CHECK_META = ROOT / "docs" / "link_check_meta.json"
LINK_STATUS = ROOT / "link_status.json"
POPULAR_LINKS = ROOT / "docs" / "popular_links.json"
UNSORTED_INPUT = ROOT / "unsorted.md"
UNSORTED_OUTPUT = ROOT / "docs" / "unsorted.json"
SUBMISSION_URL_KEYS = ROOT / "docs" / "submission_url_keys.json"
UPDATE_CHANGELOG = ROOT / "docs" / "update_changelog.json"
ARCHIVED_PROVIDERS = ROOT / "docs" / "archived_providers.json"

LINK_CHECK_FAIL_THRESHOLD = 3
HIDDEN_SECTION_MARKER = "<!-- proxy-list:hidden -->"

# Credited contributor for entries in unsorted.md until they are merged into list.md rows.
UNSORTED_CONTRIBUTOR = "yourworstnightmare1"
UNSORTED_CONTRIBUTOR_URL = "https://github.com/yourworstnightmare1"


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
    out: list[str] = []
    for part in s.split(","):
        tag = part.strip().lower()
        if not tag or tag in {"-", "—", "–", "n/a", "pending", "unknown"}:
            continue
        out.append(tag)
    return out


_CONTRIBUTOR_MD = re.compile(r"^\[([^\]]+)\]\(([^)]+)\)\s*$")


def normalize_contributor_name(raw: str) -> str:
    """Match docs/contribute/index.html normalizeContributorName for stable JSON keys."""
    s = (raw or "").strip()
    return s if s else "Anonymous Contributor"


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
_UPDATE_NOTICE_H2 = re.compile(r"^##\s+Update Notice\s*$", re.IGNORECASE)


def _looks_like_provider_h1(lines: list[str], h1_idx: int) -> bool:
    """True if this H1 is a provider section (followed by Category/link tables)."""
    for raw in lines[h1_idx + 1 : h1_idx + 24]:
        if re.match(r"^#{1,2}\s+", raw) and not raw.strip().startswith("###"):
            # Nested H1/H2 before a provider table → not a provider block.
            if re.match(r"^#\s+", raw) and not raw.startswith("##"):
                return False
            if re.match(r"^##\s+", raw):
                return False
        inner = strip_blockquote_prefix(raw).strip().casefold()
        if "category" in inner and "capabilities" in inner:
            return True
        if "locked" in inner and "link" in inner and "found date" in inner:
            return True
    return False


def _extract_md_section(text: str, heading_re: re.Pattern[str], *, allow_h1: bool = False) -> str:
    """Return markdown-lite body for a `## Heading` block until next H1/H2 heading.

    When allow_h1 is True (Update Notice), keep `#` section headings and blank lines so
    the site can render multi-section notices; stop only at the next provider H1 or H2.
    """
    lines = text.splitlines()
    start = -1
    for i, raw in enumerate(lines):
        if heading_re.match(raw.strip()):
            start = i + 1
            break
    if start < 0:
        return ""

    out_lines: list[str] = []
    for i, raw in enumerate(lines[start:], start=start):
        if re.match(r"^##\s+", raw):
            break
        if re.match(r"^#\s+", raw) and not raw.startswith("##"):
            if not allow_h1 or _looks_like_provider_h1(lines, i):
                break
        inner = strip_blockquote_prefix(raw).rstrip()
        stripped = inner.strip()
        if stripped.startswith("[!") and stripped.endswith("]"):
            continue
        if stripped.casefold() == "<br>":
            continue
        if stripped == "":
            if allow_h1:
                out_lines.append("")
            continue
        out_lines.append(stripped)

    return "\n".join(out_lines).strip()


# Subsections under ## Important Notices (### ...) excluded from docs/data.json only.
# list.md keeps full text for markdown readers.
_SITE_EXCLUDED_IMPORTANT_HEADINGS = frozenset(
    {
        "now available as a website!",
    }
)


def _exclude_subsections_for_site(md: str, excluded_titles: frozenset[str]) -> str:
    """Remove ### blocks whose title (first line) matches excluded_titles (casefold)."""
    body = md.strip()
    if not body:
        return ""
    parts = re.split(r"(?=^### )", body, flags=re.MULTILINE)
    kept: list[str] = []
    for part in parts:
        s = part.strip()
        if not s:
            continue
        if s.startswith("###"):
            title_line = s.split("\n", 1)[0]
            inner = title_line.replace("###", "", 1).strip().casefold()
            if inner in excluded_titles:
                continue
        kept.append(s)
    return "\n\n".join(kept).strip()


def parse_important_notices(text: str) -> str:
    raw = _extract_md_section(text, _IMPORTANT_NOTICES_H2)
    return _exclude_subsections_for_site(raw, _SITE_EXCLUDED_IMPORTANT_HEADINGS)


def parse_update_notice(text: str) -> str:
    return _extract_md_section(text, _UPDATE_NOTICE_H2, allow_h1=True)


def load_update_changelog() -> list[dict[str, str]]:
    if not UPDATE_CHANGELOG.is_file():
        return []
    try:
        payload = json.loads(UPDATE_CHANGELOG.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return []
    entries = payload.get("entries")
    return entries if isinstance(entries, list) else []


def sync_update_changelog(entries: list[dict], meta: dict[str, str], update_notice: str) -> list[dict]:
    """Ensure the current list.md update notice is archived at the top."""
    notice = (update_notice or "").strip()
    if not notice:
        return entries
    current = {
        "version": meta.get("version", ""),
        "revision": meta.get("revision", ""),
        "released": meta.get("last_updated", ""),
        "update_notice": notice,
    }
    out: list[dict] = []
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        if (
            str(entry.get("version", "")) == current["version"]
            and str(entry.get("revision", "")) == current["revision"]
            and str(entry.get("update_notice", "")).strip() == notice
        ):
            return entries
        out.append(entry)
    if out and str(out[0].get("update_notice", "")).strip() == notice:
        out[0] = {**out[0], **current}
        return out
    return [current, *out]


def write_update_changelog(entries: list[dict]) -> None:
    body = {
        "_note": "Archived site update notices. Regenerate history with: python3 scripts/build_update_changelog.py",
        "entries": entries,
    }
    UPDATE_CHANGELOG.write_text(json.dumps(body, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


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


def _normalize_url_key(u: str) -> str:
    return str(u or "").strip().rstrip("/").casefold()


def load_popular_config() -> tuple[list[str], str]:
    """Return (ordered urls, optional note) from popular_links.json."""
    if not POPULAR_LINKS.is_file():
        return [], ""
    try:
        raw = json.loads(POPULAR_LINKS.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return [], ""
    urls = raw.get("urls")
    if not isinstance(urls, list):
        return [], ""
    note = raw.get("note")
    note_s = str(note).strip() if isinstance(note, str) else ""
    out_urls: list[str] = []
    for u in urls:
        s = str(u).strip()
        if s.startswith(("http://", "https://")):
            out_urls.append(s)
    return out_urls, note_s


def resolve_popular_entries(all_links: list[dict], urls: list[str]) -> list[dict]:
    """Map curated URL list to full row dicts from list.md (preserves order, skips missing)."""
    by_key: dict[str, dict] = {}
    for row in all_links:
        link = row.get("link")
        if not link:
            continue
        by_key[_normalize_url_key(link)] = row
    out: list[dict] = []
    for u in urls:
        row = by_key.get(_normalize_url_key(u))
        if row:
            out.append(row)
    return out


def load_failing_links() -> dict[str, int]:
    """Return {normalized_url -> consecutive_fail_count} for URLs with count > 0."""
    if not LINK_STATUS.is_file():
        return {}
    try:
        raw = json.loads(LINK_STATUS.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return {}
    out: dict[str, int] = {}
    for k, v in raw.items():
        if not isinstance(v, int) or v <= 0:
            continue
        nk = str(k).strip().rstrip("/")
        if nk:
            out[nk] = max(out.get(nk, 0), v)
    return out


def parse_unsorted_links(existing_sorted_keys: set[str] | None = None) -> list[dict[str, str]]:
    if not UNSORTED_INPUT.is_file():
        return []
    existing_sorted_keys = existing_sorted_keys or set()
    raw = UNSORTED_INPUT.read_text(encoding="utf-8")
    _bullet_link = re.compile(r"^\s*-\s+(https?://\S+)\s*$")
    seen: set[str] = set()
    out: list[dict[str, str]] = []
    for line in raw.splitlines():
        m = _bullet_link.match(line)
        if not m:
            continue
        link = m.group(1).strip()
        nk = _normalize_url_key(link)
        if not nk or nk in seen:
            continue
        if nk in existing_sorted_keys:
            continue
        seen.add(nk)
        out.append(
            {
                "link": link,
                "contributor": UNSORTED_CONTRIBUTOR,
                "contributor_url": UNSORTED_CONTRIBUTOR_URL,
            }
        )
    return out


def parse_list_md(text: str) -> list[dict]:
    rows: list[dict] = []
    current_provider: str | None = None
    section_category = ""
    section_capabilities = ""
    section_protocols = ""
    section_additional_notes = ""
    in_note_header = False
    in_important = False
    important_lines: list[str] = []

    def flush_important() -> None:
        nonlocal section_additional_notes, in_important, important_lines
        note = "\n".join(important_lines).strip()
        # Skip boilerplate pending-section text.
        if note and "has not been categorized" not in note.casefold():
            section_additional_notes = note
        important_lines = []
        in_important = False

    for raw in text.splitlines():
        line = raw.rstrip("\n")

        if re.match(r"^#\s+[^#]", line) and not line.startswith("##"):
            if in_important:
                flush_important()
            title = re.sub(r"^#\s+", "", line).strip()
            if title.casefold() == "proxy list".casefold():
                current_provider = None
            else:
                current_provider = title
            section_category = ""
            section_capabilities = ""
            section_protocols = ""
            section_additional_notes = ""
            in_note_header = False
            in_important = False
            important_lines = []
            continue

        inner = strip_blockquote_prefix(line)
        inner_s = inner.strip()

        if re.match(r"^\[!(IMPORTANT|WARNING|NOTE|TIP|CAUTION)\]\s*$", inner_s, re.I):
            kind = re.match(r"^\[!(\w+)\]", inner_s, re.I)
            # The category meta uses [!NOTE]; only treat other admonitions (and IMPORTANT) as notes.
            # But some sections put IMPORTANT after the NOTE meta block.
            if kind and kind.group(1).upper() == "NOTE":
                # Could be the start of the category NOTE — leave for table parser below.
                if in_important:
                    flush_important()
                continue
            if in_important:
                flush_important()
            in_important = True
            important_lines = []
            continue

        if in_important:
            if not line.strip():
                flush_important()
                continue
            if line.strip().startswith("|") and not line.strip().startswith(">|") and not line.strip().startswith("> |"):
                flush_important()
                # fall through to table parsing
            elif inner_s.startswith("| Category |"):
                flush_important()
                # fall through
            elif line.startswith(">") or line.startswith("> "):
                if inner_s and not inner_s.startswith("[!"):
                    important_lines.append(inner_s)
                continue
            else:
                flush_important()

        if inner_s.startswith("| Category | Capabilities |"):
            in_note_header = True
            continue
        if in_note_header and re.match(r"^\s*\|?\s*-\s*\|", inner):
            continue
        if in_note_header and inner_s.startswith("|"):
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
                "additional_notes": section_additional_notes,
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


def parse_archived_providers(text: str) -> list[dict]:
    """Provider sections marked hidden (usually 0 links) — metadata kept for revival."""
    out: list[dict] = []
    current_provider: str | None = None
    section_category = ""
    section_capabilities = ""
    section_protocols = ""
    section_additional_notes = ""
    section_hidden = False
    section_link_count = 0
    in_note_header = False
    in_important = False
    important_lines: list[str] = []

    def flush_important() -> None:
        nonlocal section_additional_notes, in_important, important_lines
        note = "\n".join(important_lines).strip()
        if note and "has not been categorized" not in note.casefold():
            section_additional_notes = note
        important_lines = []
        in_important = False

    def flush_section() -> None:
        nonlocal current_provider, section_hidden, section_link_count
        if current_provider and section_hidden:
            out.append(
                {
                    "name": current_provider,
                    "category": section_category,
                    "capabilities": section_capabilities,
                    "capability_tags": split_list_field(section_capabilities),
                    "protocols": section_protocols,
                    "protocol_tags": split_list_field(section_protocols),
                    "additional_notes": section_additional_notes,
                    "link_count": section_link_count,
                    "hidden": True,
                }
            )
        current_provider = None
        section_hidden = False
        section_link_count = 0

    for raw in text.splitlines():
        line = raw.rstrip("\n")
        if line.strip() == HIDDEN_SECTION_MARKER:
            section_hidden = True
            continue

        if re.match(r"^#\s+[^#]", line) and not line.startswith("##"):
            if in_important:
                flush_important()
            flush_section()
            title = re.sub(r"^#\s+", "", line).strip()
            if title.casefold() == "proxy list".casefold():
                current_provider = None
            else:
                current_provider = title
            section_category = ""
            section_capabilities = ""
            section_protocols = ""
            section_additional_notes = ""
            section_hidden = False
            section_link_count = 0
            in_note_header = False
            in_important = False
            important_lines = []
            continue

        if not current_provider:
            continue

        inner = strip_blockquote_prefix(line)
        inner_s = inner.strip()

        if re.match(r"^\[!(IMPORTANT|WARNING|NOTE|TIP|CAUTION)\]\s*$", inner_s, re.I):
            kind = re.match(r"^\[!(\w+)\]", inner_s, re.I)
            if kind and kind.group(1).upper() == "NOTE":
                if in_important:
                    flush_important()
                continue
            if in_important:
                flush_important()
            in_important = True
            important_lines = []
            continue

        if in_important:
            if not line.strip() or (line.strip().startswith("|") and not line.strip().startswith(">")):
                flush_important()
            elif inner_s.startswith("| Category |"):
                flush_important()
            elif line.startswith(">") or line.startswith("> "):
                if inner_s and not inner_s.startswith("[!"):
                    important_lines.append(inner_s)
                continue
            else:
                flush_important()

        if inner_s.startswith("| Category | Capabilities |"):
            in_note_header = True
            continue
        if in_note_header and re.match(r"^\s*\|?\s*-\s*\|", inner):
            continue
        if in_note_header and inner_s.startswith("|"):
            cells = split_pipe_row(line)
            if len(cells) >= 4 and cells[0] not in {"Category", "-"}:
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
        if cells[1].startswith(("http://", "https://")):
            section_link_count += 1

    if in_important:
        flush_important()
    flush_section()
    return out


def contributor_counts_from_rows(rows: list[dict]) -> dict[str, dict]:
    """Per normalized contributor: live row count and first seen profile URL."""
    out: dict[str, dict] = {}
    for row in rows:
        label = normalize_contributor_name(str(row.get("contributor") or ""))
        href = row.get("contributor_url")
        href_s = href.strip() if isinstance(href, str) else None
        if label not in out:
            out[label] = {"count": 0, "href": None}
        e = out[label]
        e["count"] += 1
        if not e["href"] and href_s:
            e["href"] = href_s
    return out


def load_contributor_totals(path: Path) -> dict[str, dict[str, object]]:
    if not path.is_file():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return {}
    raw = data.get("contributors")
    if not isinstance(raw, dict):
        return {}
    out: dict[str, dict[str, object]] = {}
    for k, v in raw.items():
        name = normalize_contributor_name(str(k))
        if isinstance(v, int):
            out[name] = {"links_total": max(0, v), "contributor_url": None}
            continue
        if not isinstance(v, dict):
            continue
        lt = v.get("links_total", v.get("count", 0))
        try:
            n = max(0, int(lt))
        except (TypeError, ValueError):
            n = 0
        url = v.get("contributor_url")
        out[name] = {
            "links_total": n,
            "contributor_url": url.strip() if isinstance(url, str) and url.strip() else None,
        }
    return out


def merge_contributor_totals(
    existing: dict[str, dict[str, object]],
    current: dict[str, dict],
) -> dict[str, dict[str, object | None]]:
    """Never decrease a contributor's total when links are removed from list.md."""
    merged: dict[str, dict[str, object | None]] = {}
    for name, v in existing.items():
        try:
            n = max(0, int(v.get("links_total", 0)))
        except (TypeError, ValueError):
            n = 0
        u = v.get("contributor_url")
        merged[name] = {
            "links_total": n,
            "contributor_url": u if isinstance(u, str) and u.strip() else None,
        }
    for name, cur in current.items():
        c = max(0, int(cur.get("count", 0)))
        href = cur.get("href")
        href_s = href if isinstance(href, str) and href.strip() else None
        prev = merged.get(name, {"links_total": 0, "contributor_url": None})
        try:
            prev_n = max(0, int(prev.get("links_total", 0)))
        except (TypeError, ValueError):
            prev_n = 0
        prev_u = prev.get("contributor_url")
        merged[name] = {
            "links_total": max(prev_n, c),
            "contributor_url": (prev_u if isinstance(prev_u, str) and prev_u.strip() else None) or href_s,
        }
    return merged


def write_contributor_totals(path: Path, merged: dict[str, dict[str, object | None]]) -> None:
    contributors = {
        name: {
            "links_total": int(data.get("links_total", 0)),
            "contributor_url": data.get("contributor_url"),
        }
        for name, data in sorted(merged.items(), key=lambda kv: kv[0].casefold())
    }
    body = {"contributors": contributors, "_note": "links_total is cumulative; convert_list_to_json.py updates with max(previous, current live count)."}
    path.write_text(json.dumps(body, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def build_compact_payload(payload: dict) -> dict:
    """Format v2: intern providers/contributors; links are [providerIdx, contributorIdx, url, found]."""
    links = payload.get("links") or []
    providers_list: list[dict] = []
    provider_index: dict[str, int] = {}
    contributors_list: list[dict] = []
    contributor_index: dict[tuple[str, str | None], int] = {}

    def provider_idx(row: dict) -> int:
        name = str(row.get("provider") or "")
        if name not in provider_index:
            provider_index[name] = len(providers_list)
            providers_list.append(
                {
                    "name": name,
                    "category": row.get("category") or "",
                    "capabilities": row.get("capabilities") or "",
                    "capability_tags": row.get("capability_tags") or [],
                    "protocols": row.get("protocols") or "",
                    "protocol_tags": row.get("protocol_tags") or [],
                    "additional_notes": row.get("additional_notes") or "",
                }
            )
        return provider_index[name]

    def contributor_idx(row: dict) -> int:
        label = str(row.get("contributor") or "")
        url = row.get("contributor_url")
        url_s = url.strip() if isinstance(url, str) and url.strip() else None
        key = (label, url_s)
        if key not in contributor_index:
            contributor_index[key] = len(contributors_list)
            contributors_list.append({"name": label, "url": url_s})
        return contributor_index[key]

    compact_links: list[list[object]] = []
    for row in links:
        compact_links.append(
            [
                provider_idx(row),
                contributor_idx(row),
                row.get("link") or "",
                row.get("found") or "",
            ]
        )

    meta = dict(payload.get("meta") or {})
    meta.pop("update_changelog", None)

    return {
        "format": 2,
        "meta": meta,
        "link_check": payload.get("link_check") or {},
        "failing_links": payload.get("failing_links") or {},
        "providers": providers_list,
        "archived_providers": payload.get("archived_providers") or [],
        "contributors": contributors_list,
        "links": compact_links,
    }


def write_list_data(path: Path, gz_path: Path, payload: dict) -> tuple[int, int]:
    body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(body)
    with gzip.open(gz_path, "wb", compresslevel=9) as gz:
        gz.write(body)
    return len(body), gz_path.stat().st_size


def write_submission_url_keys(
    path: Path,
    links: list[dict],
    unsorted_links: list[dict],
    meta: dict,
    archived_providers: list[dict] | None = None,
) -> None:
    """Compact index for on-site submission duplicate checks (full URL keys, not domains)."""
    keys: set[str] = set()
    providers: set[str] = set()
    for row in links + unsorted_links:
        link = row.get("link", "")
        if link:
            keys.add(submission_url_key(link))
        provider = (row.get("provider") or "").strip()
        if provider:
            providers.add(provider)
    for ap in archived_providers or []:
        name = (ap.get("name") or "").strip()
        if name:
            providers.add(name)
    body = {
        "version": meta.get("version", ""),
        "revision": meta.get("revision", ""),
        "keys": sorted(keys),
        "providers": sorted(providers, key=str.casefold),
        "blocked_domain_patterns": ["b-cdn.net"],
        "_note": "Generated by convert_list_to_json.py. Keys are full normalized URLs (subdomain + path), not registrable domains. providers includes archived (hidden empty) sections.",
    }
    path.write_text(json.dumps(body, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def main() -> int:
    if not INPUT.is_file():
        print(f"Missing {INPUT}", file=sys.stderr)
        return 1
    raw = INPUT.read_text(encoding="utf-8")
    meta = parse_list_meta(raw)
    important = parse_important_notices(raw)
    update_notice = parse_update_notice(raw)
    changelog_entries = sync_update_changelog(load_update_changelog(), meta, update_notice)
    write_update_changelog(changelog_entries)
    links = parse_list_md(raw)
    archived_providers = parse_archived_providers(raw)
    ARCHIVED_PROVIDERS.write_text(
        json.dumps(
            {
                "providers": archived_providers,
                "_note": "Empty provider sections kept in list.md with <!-- proxy-list:hidden --> so metadata survives until links return. Not shown on the main list.",
            },
            indent=2,
            ensure_ascii=False,
        )
        + "\n",
        encoding="utf-8",
    )
    sorted_keys = {_normalize_url_key(row.get("link", "")) for row in links if row.get("link")}
    unsorted_links = parse_unsorted_links(sorted_keys)
    live_by_contributor = contributor_counts_from_rows(links + unsorted_links)
    prev_totals = load_contributor_totals(CONTRIBUTOR_TOTALS)
    merged_totals = merge_contributor_totals(prev_totals, live_by_contributor)
    write_contributor_totals(CONTRIBUTOR_TOTALS, merged_totals)
    popular_urls, popular_note = load_popular_config()
    popular_entries = resolve_popular_entries(links, popular_urls)
    payload = {
        "meta": {
            **meta,
            "unsorted_total": len(unsorted_links),
            "important_notices": important,
            "update_notice": update_notice,
            "fail_threshold": LINK_CHECK_FAIL_THRESHOLD,
            "popular_note": popular_note,
            "popular_links": popular_entries,
        },
        "link_check": load_link_check_meta(),
        "failing_links": load_failing_links(),
        "links": links,
        "archived_providers": archived_providers,
    }
    compact = build_compact_payload(payload)
    raw_bytes, gz_bytes = write_list_data(OUTPUT, OUTPUT_GZ, compact)
    UNSORTED_OUTPUT.write_text(json.dumps({"links": unsorted_links}, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    all_keys_rows = links + unsorted_links
    write_submission_url_keys(SUBMISSION_URL_KEYS, links, unsorted_links, meta, archived_providers)
    print(
        f"Wrote {len(links)} sorted links to {OUTPUT} ({raw_bytes / 1048576:.2f} MB, "
        f"gz {gz_bytes / 1048576:.2f} MB), {len(unsorted_links)} unsorted links to {UNSORTED_OUTPUT}, "
        f"{len(merged_totals)} contributor totals to {CONTRIBUTOR_TOTALS}, "
        f"{len(archived_providers)} archived providers to {ARCHIVED_PROVIDERS}, "
        f"{len({submission_url_key(r.get('link', '')) for r in all_keys_rows if r.get('link')})} submission URL keys to {SUBMISSION_URL_KEYS} "
        f"({meta.get('version', '')}{meta.get('revision', '')})"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
