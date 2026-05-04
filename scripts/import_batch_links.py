#!/usr/bin/env python3
"""Merge batch link lists into list.md: filters b-cdn.net & blooket.com, dedupes, updates counts."""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
LIST_MD = ROOT / "list.md"
BATCH_DIR = ROOT / "scripts" / "batch_link_batches"
BATCH_JSON = ROOT / "scripts" / "batch_links_payload.json"

# Map batch folder name -> exact list.md heading line (without newline)
SECTION_HEADINGS: dict[str, str] = {
    "Studyhub": "# 📖 StudyHub",
    "Strawberry": "# 🍓 Strawberry",
    "AWP": "# 🔫 AWP",
    "Velara": "# 🌙 Velara",
    "Fern": "# 🪴 Fern",
    "Korona": "# Korona",
    "Frogies_arcade": "# 🐸 frogie's arcade",
    "Only_lessons": "# 📚 Only lessons",
    "DogeUB": "# 🐶 dogeub",
    "55gms": "# 55gms",
    "Utopia": "# 🦄 Utopia Education",
    "Axiom": "# 🔼 Axiom",
    "TGLSC": "# ⬡ TGLSC Density 4",
    "Rosin": "# 🎮 Rosin",
    "Overcloaked": "# 🏴 OverCloaked",
    "Lucide": "# 🤍 Lucide",
    "Vapor": "# 💨 Vapor",
    "Lunar": "# 🌕 Lunar",
    "Rammerhead": "# Rammerhead",
    "Galaxy": "# 🪐 Galaxy",
    "Void": "# 🖤 Void Network",
    "DaydreamX": "# ⭐ DayDream X",
    "Space": "# 🌑 Space",
    "Petezah": "# 🍕 PetZah",
    "Shadow": "# 👤 Shadow",
    "Zen": "# Zen",
    "Cherri": "# Cherri",
    "Interstellar": "# Interstellar",
    "GN-math": "# ➗ gn-math",
    "SDXP": "# SDXP",
    "Boredom": "# 🥱 Boredom",
    "Truffled": "# 🍄 Truffled",
    "Cheesy": "# 🧀 Cheesy",
    "Canlite": "# 📡 CanLite",
    "Splash": "# Splash",
    "Infamous": "# Infamous",
    "Celestial": "# 🔷 Celestial",
    "Frosted": "# Frosted",
    "Mist": "# Mist",
    "Bromine": "# Bromine",
    "Nebulo": "# 🚀 Nebulo",
    "OneKey": "# 🗝️ 1Key",
    "Platinum_UB": "# Platinum UB",
    "Shuttle": "# Shuttle",
}

# Sections we may create at EOF if missing (pending meta row)
CREATABLE_SECTIONS = frozenset(
    {"Only_lessons", "55gms", "Zen", "Frosted", "Shuttle"}
)

# Batch file section title -> internal key (folder / JSON key)
BATCH_TITLE_TO_KEY: dict[str, str] = {
    "Studyhub": "Studyhub",
    "Strawberry": "Strawberry",
    "AWP": "AWP",
    "Velara": "Velara",
    "Fern": "Fern",
    "Korona": "Korona",
    "Frogies arcade": "Frogies_arcade",
    "Only lessons": "Only_lessons",
    "DogeUB": "DogeUB",
    "55gms": "55gms",
    "Utopia": "Utopia",
    "Axiom": "Axiom",
    "TGLSC": "TGLSC",
    "Rosin": "Rosin",
    "Overcloaked": "Overcloaked",
    "Lucide": "Lucide",
    "Vapor": "Vapor",
    "Lunar": "Lunar",
    "Rammerhead": "Rammerhead",
    "Galaxy": "Galaxy",
    "Void": "Void",
    "DaydreamX": "DaydreamX",
    "Space": "Space",
    "Petezah": "Petezah",
    "Shadow": "Shadow",
    "Zen": "Zen",
    "Cherri": "Cherri",
    "Interstellar": "Interstellar",
    "GN-math": "GN-math",
    "SDXP": "SDXP",
    "Bordem": "Boredom",
    "Truffled": "Truffled",
    "Cheesy": "Cheesy",
    "Canlite": "Canlite",
    "Splach": "Splash",
    "Infamous": "Infamous",
    "Celestial": "Celestial",
    "Frosted": "Frosted",
    "Mist": "Mist",
    "Bromine": "Bromine",
    "Nebulo": "Nebulo",
    "1Key": "OneKey",
    "Platinum": "Platinum_UB",
    "Shuttle": "Shuttle",
}

CONTRIBUTOR = "[yourworstnightmare1](https://github.com/yourworstnightmare1)"
FOUND_DATE = "5/2/2026"
ROW_TMPL = "| | {link} | {found} | N/A | N/A | {contrib}|\n"


def normalize_url(u: str) -> str:
    u = (u or "").strip()
    if not u.startswith(("http://", "https://")):
        return ""
    u = u.rstrip("/").strip()
    return u


def norm_key(u: str) -> str:
    return normalize_url(u).lower()


def url_allowed(u: str) -> bool:
    nu = normalize_url(u)
    if not nu:
        return False
    low = nu.lower()
    if ".b-cdn.net" in low or low.endswith("b-cdn.net"):
        return False
    if "blooket.com" in low:
        return False
    return True


def collect_existing_urls(text: str) -> set[str]:
    seen: set[str] = set()
    for m in re.finditer(r"\|\s*\|\s*(https?://[^\s|]+)", text):
        seen.add(norm_key(m.group(1)))
    return seen


def count_links_in_section(body: str) -> int:
    return len(re.findall(r"\|\s*\|\s*https?://", body))


def replace_note_stat_row(section_block: str) -> str:
    """Set the link-count cell in the stats row (Category | Capabilities | Protocols | N)."""
    n = count_links_in_section(section_block)

    def repl(m: re.Match[str]) -> str:
        return m.group(1) + str(n) + m.group(3)

    # Third data row under NOTE: > | Proxy/Games | ... | N |  OR pending row
    out = re.sub(
        r"(> \|[^\n|]+\|[^\n|]+\|[^\n|]+\|\s*)(\d+)(\s*\|\s*$)",
        repl,
        section_block,
        count=1,
        flags=re.MULTILINE,
    )
    return out


def extract_section(text: str, heading_line: str) -> tuple[str, str, str] | None:
    """Return (before, section_block_including_heading, after) or None."""
    idx = text.find(heading_line)
    if idx < 0:
        return None
    before = text[:idx]
    chunk_from_heading = text[idx + len(heading_line) :]
    # Next H1-style provider heading: \n# <space> ... (not ##)
    m = re.search(r"\n(?=# [^#])", chunk_from_heading)
    if m:
        end = idx + len(heading_line) + m.start()
        section_block = text[idx:end]
        after = text[end:]
    else:
        section_block = text[idx:]
        after = ""
    return before, section_block, after


def append_rows_to_section_block(section_block: str, new_urls: list[str]) -> str:
    rows = ""
    for u in new_urls:
        rows += ROW_TMPL.format(link=u, found=FOUND_DATE, contrib=CONTRIBUTOR)
    return section_block.rstrip() + "\n" + rows


def new_section_block(heading_line: str, urls: list[str], *, all_pending: bool) -> str:
    n = len(urls)
    if all_pending:
        note_row = f"> | pending | pending | pending | {n} |\n"
    else:
        note_row = f"> | Proxy/Games | pending | pending | {n} |\n"
    block = (
        f"{heading_line}\n"
        f"> [!NOTE]\n"
        f"> | Category | Capabilities | Protocol(s) | Links |\n"
        f"> | - | - | - | - |\n"
        f"{note_row}"
        f"> [!IMPORTANT]\n"
        f"> This section has not been categorized or checked for protocol(s) and capabilities.\n"
        f"\n"
        f"| Locked | Link | Found Date | Username | Password | Contributor |\n"
        f"| - | - | - | - | - | - |\n"
    )
    for u in urls:
        block += ROW_TMPL.format(link=u, found=FOUND_DATE, contrib=CONTRIBUTOR)
    return block + "\n"


def load_batch_from_dir() -> dict[str, list[str]]:
    out: dict[str, list[str]] = {}
    if not BATCH_DIR.is_dir():
        return out
    for p in sorted(BATCH_DIR.glob("*.txt")):
        key = p.stem
        lines = [
            normalize_url(x)
            for x in p.read_text(encoding="utf-8").splitlines()
            if x.strip()
        ]
        lines = [x for x in lines if x and url_allowed(x)]
        if lines:
            out[key] = lines
    return out


def load_batch_from_json() -> dict[str, list[str]]:
    if not BATCH_JSON.is_file():
        return {}
    raw = json.loads(BATCH_JSON.read_text(encoding="utf-8"))
    out: dict[str, list[str]] = {}
    for k, v in raw.items():
        if not isinstance(v, list):
            continue
        urls = [normalize_url(x) for x in v if isinstance(x, str)]
        urls = [x for x in urls if x and url_allowed(x)]
        if urls:
            out[str(k)] = urls
    return out


def parse_batch_full_file(path: Path) -> dict[str, list[str]]:
    """Section name line (no http) then URL lines; blank lines optional."""
    raw_text = path.read_text(encoding="utf-8")
    out: dict[str, list[str]] = {}
    current_key: str | None = None
    for line in raw_text.splitlines():
        s = line.strip()
        if not s:
            continue
        if re.match(r"^https?://", s, re.I):
            if not current_key:
                continue
            u = normalize_url(s)
            if u and url_allowed(u):
                out.setdefault(current_key, []).append(u)
        else:
            title = s.strip()
            key = BATCH_TITLE_TO_KEY.get(title)
            if not key:
                # Try case-insensitive / whitespace
                low = title.casefold()
                for k, v in BATCH_TITLE_TO_KEY.items():
                    if k.casefold() == low:
                        key = v
                        break
            if not key:
                print(f"Warning: unknown batch section title {title!r}, skipping until known.", file=sys.stderr)
                current_key = None
                continue
            current_key = key
    return out


def merge_lists(existing: dict[str, list[str]], present: set[str]) -> dict[str, list[str]]:
    """Dedupe: drop URLs whose norm_key is in present."""
    merged: dict[str, list[str]] = {}
    for sec, urls in existing.items():
        new_u: list[str] = []
        for u in urls:
            nk = norm_key(u)
            if nk in present:
                continue
            new_u.append(u)
            present.add(nk)
        if new_u:
            merged[sec] = new_u
    return merged


def update_total_line(text: str, total: int) -> str:
    return re.sub(
        r"(Total Links:\s*)(\d+)",
        rf"\g<1>{total}",
        text,
        count=1,
        flags=re.IGNORECASE,
    )


def main() -> int:
    ap = argparse.ArgumentParser(description="Import batch links into list.md")
    ap.add_argument(
        "--from",
        dest="batch_file",
        type=Path,
        metavar="FILE",
        help="Batch file: section name line then https URLs (see BATCH_TITLE_TO_KEY)",
    )
    args = ap.parse_args()

    batch: dict[str, list[str]] = {}
    if args.batch_file:
        if not args.batch_file.is_file():
            print(f"Missing {args.batch_file}", file=sys.stderr)
            return 1
        batch.update(parse_batch_full_file(args.batch_file))
    batch.update(load_batch_from_json())
    batch.update(load_batch_from_dir())
    if not batch:
        print("No batch data (add scripts/batch_links_payload.json or scripts/batch_link_batches/*.txt)", file=sys.stderr)
        return 1

    text = LIST_MD.read_text(encoding="utf-8")
    present = collect_existing_urls(text)

    filtered = merge_lists(batch, present)
    if not filtered:
        print("Nothing new to add (all filtered or duplicates).")
        return 0

    added = 0
    for sec_key, urls in filtered.items():
        heading = SECTION_HEADINGS.get(sec_key)
        if not heading:
            print(f"Unknown section key: {sec_key}", file=sys.stderr)
            return 1
        ext = extract_section(text, heading)
        if ext is None:
            if sec_key not in CREATABLE_SECTIONS:
                print(f"Missing section in list.md: {heading}", file=sys.stderr)
                return 1
            block = new_section_block(heading, urls, all_pending=True)
            text = text.rstrip() + "\n\n" + block
            added += len(urls)
            print(f"Created {heading}: +{len(urls)}")
            continue

        before, section_block, after = ext
        new_block = append_rows_to_section_block(section_block, urls)
        new_block = replace_note_stat_row(new_block)
        text = before + new_block + after
        added += len(urls)
        print(f"Updated {heading}: +{len(urls)}")

    total_links = len(re.findall(r"\|\s*\|\s*https?://", text))
    text = update_total_line(text, total_links)

    LIST_MD.write_text(text, encoding="utf-8")
    print(f"Done. Added {added} links; Total Links header -> {total_links}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
