import os
import re
import json
import sys
import requests
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from pathlib import Path

_SCRIPTS = Path(__file__).resolve().parent
if str(_SCRIPTS) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS))
from release_schedule import should_publish_release

INPUT_FILE = "list.md"
STATUS_FILE = "link_status.json"
CHANGELOG_FILE = "CHANGELOG.md"

FAIL_THRESHOLD = 3
# If this share of unique URLs fails in a single run, treat it as checker/network
# outage: do not increment failure counts and do not purge anything.
MASS_FAIL_RATIO = float(os.environ.get("LINK_CHECK_MASS_FAIL_RATIO", "0.25"))
# Hard caps so a false-positive streak cannot wipe most of the list in one commit.
MAX_PURGE_RATIO = float(os.environ.get("LINK_CHECK_MAX_PURGE_RATIO", "0.02"))
MAX_PURGE_ABS = int(os.environ.get("LINK_CHECK_MAX_PURGE_ABS", "250"))
ABORT_FILE = "link_check_abort.json"

NOTE_CATEGORY_LINE = "> | Category | Capabilities | Protocol(s) | Links |"
NOTE_SEP_LINE_RE = re.compile(r"^> \| - \|")

# Only proxy table rows should be purged by link failure — not blockquotes or prose with URLs.
_TABLE_LINK_ROW = re.compile(r"^\|\s*\|\s*(https?://[^\s|]+)", re.IGNORECASE)


# -----------------------
# Extract links
# -----------------------
def extract_links(content):
    """Table-row proxy URLs only (not contributor / prose URLs)."""
    return extract_table_urls(content)


def normalize_url(url):
    return url.strip().rstrip("/")


def extract_table_urls(content):
    """Ordered list of normalized URLs from proxy table rows (| | https...)."""
    found = re.findall(r"^\|\s*\|\s*(https?://[^\s|]+)", content, re.MULTILINE)
    return [normalize_url(u) for u in found]


def url_multiset_signature(content):
    return tuple(sorted(extract_table_urls(content)))


# -----------------------
# Load/save failure state
# -----------------------
def load_status():
    try:
        with open(STATUS_FILE, "r") as f:
            raw = json.load(f)
    except OSError:
        return {}
    # Merge legacy keys (pre-normalization) into normalized keys.
    # Values may be bare ints or {"count": N, ...} objects from older exports.
    out: dict[str, int] = {}
    for k, v in raw.items():
        if isinstance(v, bool):
            continue
        if isinstance(v, int):
            count = v
        elif isinstance(v, dict):
            try:
                count = int(v.get("count") or 0)
            except (TypeError, ValueError):
                continue
        else:
            continue
        nk = normalize_url(str(k))
        out[nk] = max(out.get(nk, 0), count)
    return out


def save_status(status):
    with open(STATUS_FILE, "w") as f:
        json.dump(status, f, indent=2)


# -----------------------
# Test link
# -----------------------
def is_working(url):
    try:
        r = requests.get(
            url,
            timeout=10,
            headers={"User-Agent": "proxy-list-link-checker/1.0"},
        )
        return r.status_code < 400
    except Exception:
        return False


def test_links(links):
    """Map normalized URL -> whether any tested variant responded OK."""
    results: dict[str, bool] = {}
    unique: list[str] = []
    seen_norm: set[str] = set()
    for url in links:
        n = normalize_url(url)
        if n not in seen_norm:
            seen_norm.add(n)
            unique.append(url)
    with ThreadPoolExecutor(max_workers=25) as executor:
        futures = {executor.submit(is_working, url): url for url in unique}
        for future in futures:
            url = futures[future]
            try:
                ok = future.result()
            except Exception:
                ok = False
            n = normalize_url(url)
            results[n] = results.get(n, False) or ok
    return results


# -----------------------
# Process markdown (purge dead links)
# -----------------------
def _env_flag(name: str) -> bool:
    return os.environ.get(name, "").strip().lower() in ("1", "true", "yes", "on")


def max_purge_allowed(total_rows: int) -> int:
    """Largest number of table rows a single run may remove."""
    if total_rows <= 0:
        return 0
    # int() truncates; keep at least 1 so tiny lists can still drop a single dead row.
    by_ratio = max(1, int(total_rows * MAX_PURGE_RATIO))
    return min(MAX_PURGE_ABS, by_ratio)


def count_unique_failures(table_norms: list[str], results: dict) -> tuple[int, int]:
    unique = list(dict.fromkeys(table_norms))
    failed = sum(1 for n in unique if not results.get(n, False))
    return len(unique), failed


def write_abort_report(payload: dict) -> None:
    try:
        with open(ABORT_FILE, "w", encoding="utf-8") as f:
            json.dump(payload, f, indent=2)
    except OSError:
        pass


def process(content, results, status):
    """Update failure counts; optionally drop rows that hit FAIL_THRESHOLD.

    Uses normalized URLs for result lookup and for persistent failure counts so
    trailing slashes and duplicate rows behave consistently.

    Failure counts in link_status.json advance each run. When purging is enabled
    (default in CI unless LINK_CHECK_NO_PURGE=true), rows at or above
    FAIL_THRESHOLD consecutive failures are removed from list.md.

    Safety rails (both skip status updates and purges for the run):
    - MASS_FAIL_RATIO: too many unique URLs failed this run (likely runner outage).
    - MAX_PURGE_ABS / MAX_PURGE_RATIO: would remove too many rows in one pass.
    """
    no_purge = _env_flag("LINK_CHECK_NO_PURGE")

    lines = content.splitlines()
    table_norms: list[str] = []
    for line in lines:
        match = _TABLE_LINK_ROW.search(line)
        if match:
            table_norms.append(normalize_url(match.group(1)))

    unique_n, failed_n = count_unique_failures(table_norms, results)
    fail_ratio = (failed_n / unique_n) if unique_n else 0.0
    mass_fail = unique_n >= 50 and fail_ratio >= MASS_FAIL_RATIO

    # Preview how many rows would be purged if we applied normal rules.
    would_purge_norms: set[str] = set()
    if not no_purge and not mass_fail:
        for norm in dict.fromkeys(table_norms):
            if results.get(norm, False):
                continue
            prev = int(status.get(norm, 0) or 0)
            if prev + 1 >= FAIL_THRESHOLD:
                would_purge_norms.add(norm)
    would_purge_rows = sum(1 for n in table_norms if n in would_purge_norms)
    purge_cap = max_purge_allowed(len(table_norms))
    purge_capped = (not no_purge) and (not mass_fail) and would_purge_rows > purge_cap

    if mass_fail or purge_capped:
        reason = "mass_fail" if mass_fail else "purge_cap"
        write_abort_report(
            {
                "aborted": True,
                "reason": reason,
                "unique_urls": unique_n,
                "failed_urls": failed_n,
                "fail_ratio": round(fail_ratio, 4),
                "mass_fail_ratio": MASS_FAIL_RATIO,
                "would_purge_rows": would_purge_rows,
                "purge_cap": purge_cap,
                "max_purge_abs": MAX_PURGE_ABS,
                "max_purge_ratio": MAX_PURGE_RATIO,
                "message": (
                    "Skipping failure-count updates and purges for this run to protect the list."
                ),
            }
        )
        print(
            f"[link_checker] ABORT ({reason}): failed {failed_n}/{unique_n} "
            f"({fail_ratio:.1%}); would purge {would_purge_rows} rows "
            f"(cap {purge_cap}). Leaving list.md and link_status.json unchanged.",
            flush=True,
        )
        # Keep every table row; do not mutate status.
        return content, len(table_norms), 0, {"aborted": True, "reason": reason}

    new_lines: list[str] = []
    # First row for this URL in this run decides keep/remove; duplicate rows match it.
    keep_duplicate_row: dict[str, bool] = {}

    kept = 0
    removed = 0

    for line in lines:
        match = _TABLE_LINK_ROW.search(line)

        if match:
            url = match.group(1)
            norm = normalize_url(url)

            if norm in keep_duplicate_row:
                if keep_duplicate_row[norm]:
                    new_lines.append(line)
                    kept += 1
                else:
                    removed += 1
                continue

            working = results.get(norm, False)

            if working:
                status[norm] = 0
                new_lines.append(line)
                kept += 1
                keep_duplicate_row[norm] = True
            else:
                prev = int(status.get(norm, 0) or 0)
                status[norm] = prev + 1
                # Purge once consecutive failures reach the threshold. Counts persist
                # across earlier no-purge CI runs, so already-dead links drop on the
                # next failing check after purging is re-enabled.
                purge = (not no_purge) and status[norm] >= FAIL_THRESHOLD

                if purge:
                    removed += 1
                    keep_duplicate_row[norm] = False
                else:
                    new_lines.append(line)
                    kept += 1
                    keep_duplicate_row[norm] = True
        else:
            new_lines.append(line)

    if os.path.isfile(ABORT_FILE):
        try:
            os.remove(ABORT_FILE)
        except OSError:
            pass

    return "\n".join(new_lines), kept, removed, {"aborted": False, "reason": ""}


# -----------------------
# Sections (split on top-level # headings)
# -----------------------
def _is_top_level_h1(line: str) -> bool:
    """True for `# Title` (not `##` / `###`), ignoring leading BOM/whitespace."""
    s = line.lstrip("\ufeff \t")
    return s.startswith("# ") and not s.startswith("##")


def split_sections(content: str) -> list[str]:
    lines = content.split("\n")
    starts = [i for i, line in enumerate(lines) if _is_top_level_h1(line)]
    if not starts:
        return [content]
    sections: list[str] = []
    # Keep any text before the first H1 (must not be dropped on rewrite).
    if starts[0] > 0:
        prefix = "\n".join(lines[: starts[0]]).strip("\n")
        if prefix.strip():
            sections.append(prefix)
    for i, start in enumerate(starts):
        end = starts[i + 1] if i + 1 < len(starts) else len(lines)
        chunk = "\n".join(lines[start:end])
        sections.append(chunk)
    return sections


def join_sections(sections: list[str]) -> str:
    body = "\n\n".join(s.strip("\n") for s in sections)
    return body + ("\n" if body else "")


def is_proxy_list_preamble(section: str) -> bool:
    # UTF-8 BOM / leading spaces at file start break naive startswith("# ")
    s = section.lstrip("\ufeff \t")
    return s.startswith("# Proxy List")


def section_has_locked_table(section: str) -> bool:
    return "| Locked | Link |" in section


def section_table_link_count(section: str) -> int:
    return len(re.findall(r"^\|\s\|\s*https?://", section, re.MULTILINE))


def remove_empty_provider_sections(content: str) -> str:
    sections = split_sections(content)
    kept = []
    for sec in sections:
        if is_proxy_list_preamble(sec):
            kept.append(sec)
            continue
        # Update-notice `#` subsections have no link table — always keep them.
        if not section_has_locked_table(sec):
            kept.append(sec)
            continue
        if section_table_link_count(sec) == 0:
            continue
        kept.append(sec)
    return join_sections(kept)


def update_note_link_count_in_section(section: str) -> str:
    if not section_has_locked_table(section):
        return section
    n = section_table_link_count(section)
    lines = section.split("\n")
    out: list[str] = []
    i = 0
    while i < len(lines):
        line = lines[i]
        if (
            line.strip() == NOTE_CATEGORY_LINE
            and i + 2 < len(lines)
            and NOTE_SEP_LINE_RE.match(lines[i + 1])
        ):
            meta_line = lines[i + 2]
            if meta_line.startswith("> |") and not meta_line.startswith("> | -"):
                new_meta = re.sub(r"\|\s*\d+\s*\|\s*$", f"| {n} |", meta_line)
                out.extend([line, lines[i + 1], new_meta])
                i += 3
                continue
        out.append(line)
        i += 1
    return "\n".join(out)


def sync_all_section_counts(content: str) -> str:
    sections = split_sections(content)
    fixed = []
    for sec in sections:
        fixed.append(update_note_link_count_in_section(sec))
    return join_sections(fixed)


# -----------------------
# Version / revision (list header only)
# -----------------------
def extract_proxy_list_preamble(content: str) -> str:
    """Lines from the start of the file until the first top-level H1 that is not `# Proxy List`.

    Stops before the first provider section (e.g. `# 💜 Selenite`). `##` sections stay in the preamble.
    """
    lines_out: list[str] = []
    for line in content.splitlines():
        if _is_top_level_h1(line):
            if line.lstrip("\ufeff \t").strip() != "# Proxy List":
                break
        lines_out.append(line)
    return "\n".join(lines_out)


def _parse_v_r_from_blockquote_lines(lines: list[str]) -> tuple[str, str, int]:
    """Scan blockquote lines for `> vX |` and `> rN |` metadata."""
    version, rev_str, rev_num = "v0.0.0", "r0", 0
    # ASCII | or fullwidth ｜ (some editors / pastes)
    pipe = r"[\|\uFF5C]"
    for raw in lines:
        s = raw.strip()
        if not s.startswith(">"):
            continue
        inner = s[1:].lstrip()
        if inner.startswith("[!"):
            continue
        mv = re.match(rf"^(v[\d.]+)\s*{pipe}", inner)
        if mv:
            version = mv.group(1)
        mr = re.match(rf"^(r(\d+))\s*{pipe}", inner, re.IGNORECASE)
        if mr:
            rev_str = mr.group(1).lower()
            rev_num = int(mr.group(2))
    return version, rev_str, rev_num


def parse_list_version_revision(content: str) -> tuple[str, str, int]:
    """Returns (version like v2.0.3, revision like r29, revision int)."""
    text = content.lstrip("\ufeff")
    # Prefer scanning the top of the file (works even if # Proxy List block was missing briefly)
    version, rev_str, rev_num = _parse_v_r_from_blockquote_lines(text.splitlines()[:250])
    if version == "v0.0.0":
        preamble = extract_proxy_list_preamble(text)
        version, rev_str, rev_num = _parse_v_r_from_blockquote_lines(
            preamble.splitlines() if preamble.strip() else []
        )
    return version, rev_str, rev_num


def set_total_links_line(content: str, total: int) -> str:
    return re.sub(r"Total Links:\s*\d+", f"Total Links: {total}", content)


def set_last_updated_line(content: str, today: str) -> str:
    return re.sub(r"(> r\d+\s*\|\s*)Last Updated:.*", rf"\1Last Updated: {today}", content)


def set_revision_line(content: str, new_rev_num: int) -> str:
    return re.sub(r"> r\d+\s*\|", f"> r{new_rev_num} |", content, count=1)


# -----------------------
# CHANGELOG
# -----------------------
def update_changelog(removed, total):
    entry = f"""
## {datetime.now().strftime('%Y-%m-%d')}
- Removed: {removed}
- Total: {total}
"""

    try:
        with open(CHANGELOG_FILE, "a") as f:
            f.write(entry)
    except OSError:
        pass


# -----------------------
# MAIN
# -----------------------
def main():
    with open(INPUT_FILE, "r", encoding="utf-8") as f:
        raw = f.read()
    if raw.startswith("\ufeff"):
        raw = raw.lstrip("\ufeff")

    before_sig = url_multiset_signature(raw)
    _, _, rev_num = parse_list_version_revision(raw)

    links = extract_links(raw)

    status = load_status()

    results = test_links(links)

    content, kept, removed, guard = process(raw, results, status)

    if guard.get("aborted"):
        # Leave list.md and status file untouched; still emit commit_info so CI
        # can see removed=0 / current totals without rewriting the list.
        total = len(re.findall(r"^\|\s*\|\s*https?://", raw, re.MULTILINE))
        final_version, final_rev, _ = parse_list_version_revision(raw)
        commit_meta = {
            "version": final_version,
            "revision": final_rev,
            "removed": 0,
            "total": total,
            "links_changed": False,
            "release_published": False,
            "aborted": True,
            "abort_reason": guard.get("reason") or "",
        }
        with open("commit_info.json", "w", encoding="utf-8") as f:
            json.dump(commit_meta, f, indent=2)
        with open("commit_info.txt", "w", encoding="utf-8") as f:
            f.write(f"{final_version}|{final_rev}|0|{total}")
        print(
            "[link_checker] Exiting with code 2 (purge aborted; no list changes written).",
            flush=True,
        )
        return 2

    content = remove_empty_provider_sections(content)
    content = sync_all_section_counts(content)

    total = len(re.findall(r"^\|\s*\|\s*https?://", content, re.MULTILINE))
    content = set_total_links_line(content, total)

    after_sig = url_multiset_signature(content)
    links_changed = before_sig != after_sig

    publish_release = should_publish_release()
    today = datetime.now().strftime("%B %d, %Y")
    if links_changed and publish_release:
        content = set_last_updated_line(content, today)
        content = set_revision_line(content, rev_num + 1)

    with open(INPUT_FILE, "w", encoding="utf-8") as f:
        f.write(content)

    # Drop stale entries so the status file stays small.
    still_present = set(extract_table_urls(content))
    status = {k: v for k, v in status.items() if k in still_present}
    save_status(status)

    if links_changed and publish_release:
        update_changelog(removed, total)

    final_version, final_rev, _ = parse_list_version_revision(content)
    release_published = links_changed and publish_release
    commit_meta = {
        "version": final_version,
        "revision": final_rev,
        "removed": removed,
        "total": total,
        "links_changed": links_changed,
        "release_published": release_published,
        "aborted": False,
        "abort_reason": "",
    }
    with open("commit_info.json", "w", encoding="utf-8") as f:
        json.dump(commit_meta, f, indent=2)
    with open("commit_info.txt", "w", encoding="utf-8") as f:
        f.write(f"{final_version}|{final_rev}|{removed}|{total}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
