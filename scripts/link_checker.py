import re
import json
import requests
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime

INPUT_FILE = "list.md"
STATUS_FILE = "link_status.json"
CHANGELOG_FILE = "CHANGELOG.md"

FAIL_THRESHOLD = 3

NOTE_CATEGORY_LINE = "> | Category | Capabilities | Protocol(s) | Links |"
NOTE_SEP_LINE_RE = re.compile(r"^> \| - \|")


# -----------------------
# Extract links
# -----------------------
def extract_links(content):
    return re.findall(r"https?://[^\s|]+", content)


def normalize_url(url):
    return url.strip().rstrip("/")


def extract_table_urls(content):
    """Ordered list of normalized URLs from proxy table rows (| | https...)."""
    found = re.findall(r"^\|\s\|\s*(https?://[^\s|]+)", content, re.MULTILINE)
    return [normalize_url(u) for u in found]


def url_multiset_signature(content):
    return tuple(sorted(extract_table_urls(content)))


# -----------------------
# Load/save failure state
# -----------------------
def load_status():
    try:
        with open(STATUS_FILE, "r") as f:
            return json.load(f)
    except OSError:
        return {}


def save_status(status):
    with open(STATUS_FILE, "w") as f:
        json.dump(status, f, indent=2)


# -----------------------
# Test link
# -----------------------
def is_working(url):
    try:
        r = requests.get(url, timeout=5)
        return r.status_code < 400
    except OSError:
        return False


def test_links(links):
    results = {}
    with ThreadPoolExecutor(max_workers=25) as executor:
        futures = {executor.submit(is_working, url): url for url in links}
        for future in futures:
            url = futures[future]
            try:
                results[url] = future.result()
            except OSError:
                results[url] = False
    return results


# -----------------------
# Process markdown (purge dead links)
# -----------------------
def process(content, results, status):
    seen = set()
    new_lines = []

    kept = 0
    removed = 0

    for line in content.splitlines():
        match = re.search(r"(https?://[^\s|]+)", line)

        if match:
            url = match.group(1)
            norm = normalize_url(url)

            if norm in seen:
                continue
            seen.add(norm)

            working = results.get(url, False)

            if working:
                status[url] = 0
                new_lines.append(line)
                kept += 1
            else:
                status[url] = status.get(url, 0) + 1

                if status[url] < FAIL_THRESHOLD:
                    new_lines.append(line)
                    kept += 1
                else:
                    removed += 1
        else:
            new_lines.append(line)

    return "\n".join(new_lines), kept, removed


# -----------------------
# Sections (split on top-level # headings)
# -----------------------
def split_sections(content: str) -> list[str]:
    lines = content.split("\n")
    starts = [i for i, line in enumerate(lines) if line.startswith("# ")]
    if not starts:
        return [content]
    sections = []
    for i, start in enumerate(starts):
        end = starts[i + 1] if i + 1 < len(starts) else len(lines)
        chunk = "\n".join(lines[start:end])
        sections.append(chunk)
    return sections


def join_sections(sections: list[str]) -> str:
    body = "\n\n".join(s.strip("\n") for s in sections)
    return body + ("\n" if body else "")


def is_proxy_list_preamble(section: str) -> bool:
    return section.lstrip().startswith("# Proxy List")


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
        if section_has_locked_table(sec) and section_table_link_count(sec) == 0:
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
def parse_list_version_revision(content: str) -> tuple[str, str, int]:
    """Returns (version like v2.0.3, revision like r29, revision int)."""
    version, rev_str, rev_num = "v0.0.0", "r0", 0
    for raw in content.splitlines()[:50]:
        s = raw.strip()
        if s.startswith(">"):
            inner = s[1:].lstrip()
            if inner.startswith("[!"):
                continue
            mv = re.match(r"^(v[\d.]+)\s*\|", inner)
            if mv:
                version = mv.group(1)
            mr = re.match(r"^(r(\d+))\s*\|", inner, re.IGNORECASE)
            if mr:
                rev_str = mr.group(1).lower()
                rev_num = int(mr.group(2))
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

    before_sig = url_multiset_signature(raw)
    _, _, rev_num = parse_list_version_revision(raw)

    links = extract_links(raw)

    status = load_status()

    results = test_links(links)

    content, kept, removed = process(raw, results, status)

    content = remove_empty_provider_sections(content)
    content = sync_all_section_counts(content)

    total = len(re.findall(r"^\|\s\|\s*https?://", content, re.MULTILINE))
    content = set_total_links_line(content, total)

    after_sig = url_multiset_signature(content)
    links_changed = before_sig != after_sig

    today = datetime.now().strftime("%B %d, %Y")
    if links_changed:
        content = set_last_updated_line(content, today)
        content = set_revision_line(content, rev_num + 1)

    with open(INPUT_FILE, "w", encoding="utf-8") as f:
        f.write(content)

    save_status(status)

    update_changelog(removed, total)

    final_version, final_rev, _ = parse_list_version_revision(content)
    with open("commit_info.txt", "w", encoding="utf-8") as f:
        f.write(f"{final_version}|{final_rev}|{removed}|{total}")


if __name__ == "__main__":
    main()
