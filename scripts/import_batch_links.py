#!/usr/bin/env python3
"""Import batch link submissions into list.md with filtering rules."""

from __future__ import annotations

import re
from collections import OrderedDict
from pathlib import Path
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[1]
MD_PATH = ROOT / "list.md"
INPUT = Path(__file__).resolve().parent / "batch_links_may2026.txt"

DATE = "6/7/2026"
CONTRIB = "[yourworstnightmare1](https://github.com/yourworstnightmare1)"

# Map normalized section keys -> exact header title (without leading #)
SECTION_ALIASES: dict[str, str] = {
    "gn-math": "➗ gn-math",
    "gn math": "➗ gn-math",
    "overcloaked": "🏴 OverCloaked",
    "over cloaked": "🏴 OverCloaked",
    "splash": "🌊 Splash",
    "cheesy": "🧀 Cheesy",
    "seamless os": "Seamless OS",
    "selenite": "💜 Selenite",
    "vapor": "💨 Vapor",
    "velera": "🌙 Velara",
    "velara": "🌙 Velara",
    "celestial": "🔷 Celestial",
    "canlite": "📡 CanLite",
    "can lite": "📡 CanLite",
    "brunys": "🧮 BrunysIXLWork",
    "bruny's": "🧮 BrunysIXLWork",
    "brunysixlwork": "🧮 BrunysIXLWork",
    "infamous": "✨ Infamous",
    "rosin": "🎮 Rosin",
    "koopbin": "Koopbin",
    "holy unblocker": "Holy Unblocker",
    "xylora": "✖️ Xylora",
    "equinox": "✨ Equinox",
    "fern": "🪴 Fern",
    "nebulo": "🚀 Nebulo",
    "lucide": "🤍 Lucide",
    "luicide": "🤍 Lucide",
    "dogeub": "🐶 dogeub",
    "dogub": "🐶 dogeub",
    "dominium": "🏛️ Dominum",
    "dominum": "🏛️ Dominum",
    "sea bean": "🫘 Sea Bean",
    "sea bean games": "🫘 Sea Bean",
    "noahs tutoring": "🟨 Noahs Tutoring",
    "noahs tutoring hub": "🟨 Noahs Tutoring",
    "nike hub": "👟 Nikehub",
    "nikehub": "👟 Nikehub",
    "zodiac": "♈ Zodiac",
    "yuki": "Yuki",
    "onlylessons": "📚 OnlyLessons",
    "t9": "T9",
    "tglsc": "⬡ TGLSC Density 4",
    "ford": "Ford",
    "frogies arcade": "🐸 frogie's arcade",
    "frogie arcade": "🐸 frogie's arcade",
    "nettle web": "Nettle Web",
    "korona": "💟 Korona",
    "relic": "▶️ Relic Network",
    "relic network": "▶️ Relic Network",
    "ghost": "👻 Ghost",
    "utopia": "🦄 Utopia Education",
    "utopia education": "🦄 Utopia Education",
    "rammerhead": "Rammerhead",
    "duck": "🦆 Duckmath",
    "duckmath": "🦆 Duckmath",
    "z-kit": "Z-kit",
    "z kit": "Z-kit",
    "luminal": "🌙 LuminalOS",
    "luminalos": "🌙 LuminalOS",
    "aether": "Aether",
    "parcoil": "Parcoil",
    "strawberry": "🍓 Strawberri",
    "strawberri": "🍓 Strawberri",
    "zen": "🧘 Zen",
    "studyhub": "📖 StudyHub",
    "nowgg": "NowGG",
    "interstellar": "Interstellar",
    "sdxp": "❤️ SDXP",
    "strongdogxp": "❤️ SDXP",
    "shadow": "👤 Shadow",
    "galaxy": "🪐 Galaxy",
    "boredom": "🥱 Boredom",
    "boredom v3": "🥱 Boredom",
    "void network": "🖤 Void Network",
    "void": "🖤 Void Network",
    "frosted": "❄️ Frosted",
    "frosted proxy": "❄️ Frosted",
    "pizza edition": "Pizza Edition",
    "space": "🌑 Space",
    "daydreamx": "⭐ DayDream X",
    "daydream x": "⭐ DayDream X",
    "imp": "😈 Imp Proxy",
    "imp proxy": "😈 Imp Proxy",
    "axiom": "🔼 Axiom",
    "cherri": "🌸 Cherri",
    "everest": "⛰️ Everest",
    "truffled": "🍄 Truffled",
    "lunar": "🌕 Lunar",
    "overcloaked": "🏴 OverCloaked",
}

URL_IN_LINE = re.compile(
    r"https?://[^\s<>\"']+|(?:^|\s)((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}(?:/[^\s]*)?)",
    re.IGNORECASE,
)


def norm_key(s: str) -> str:
    s = re.sub(r"[^\w\s-]", " ", s.lower())
    s = re.sub(r"\s+", " ", s).strip()
    s = re.sub(r"\s*\([^)]*\)\s*", " ", s).strip()
    return s


def norm_url(u: str) -> str:
    u = u.strip().rstrip(",.;)")
    if u.startswith("vhttp"):
        u = u[1:]
    if not u.startswith(("http://", "https://")):
        u = "https://" + u
    try:
        p = urlsplit(u)
    except Exception:
        return u.lower()
    host = (p.hostname or "").lower()
    if host.startswith("www."):
        host = host[4:]
    path = p.path or ""
    while path.endswith("/?/") or path.endswith("/?") or path.endswith("/"):
        if path.endswith("/?/"):
            path = path[:-3]
        elif path.endswith("/?"):
            path = path[:-2]
        elif path.endswith("/"):
            path = path[:-1]
        else:
            break
    return host + path


def host_of(u: str) -> str:
    try:
        h = urlsplit(u if "://" in u else "https://" + u).hostname or ""
    except Exception:
        return ""
    h = h.lower()
    return h[4:] if h.startswith("www.") else h


def should_skip_url(u: str) -> str | None:
    if not u or "chrome://" in u:
        return "invalid"
    h = host_of(u)
    if not h or "." not in h:
        return "invalid"
    if h == "b-cdn.net" or h.endswith(".b-cdn.net"):
        return "bunnycdn"
    if h == "registry.npmjs.org":
        return "npm-registry"
    if "<" in u or "br<" in u:
        return "garbage"
    return None


def extract_urls(line: str) -> list[str]:
    line = line.strip()
    if not line:
        return []
    urls = []
    for m in re.finditer(r"https?://[^\s<>\"']+", line, re.I):
        urls.append(m.group(0).rstrip(",.;)"))
    if not urls and re.search(r"[a-z0-9.-]+\.[a-z]{2,}", line, re.I):
        # domain-only line
        part = line.split()[0] if line.split() else line
        if "." in part and not part.startswith("#"):
            urls.append(part)
    return urls


def map_section(line: str) -> str | None:
    key = norm_key(line)
    if not key or len(key) > 80:
        return None
    if key in SECTION_ALIASES:
        return SECTION_ALIASES[key]
    # prefix match (GalaxyV6 -> galaxy)
    for alias, title in sorted(SECTION_ALIASES.items(), key=lambda x: -len(x[0])):
        if key == alias or key.startswith(alias + " "):
            return title
    # fuzzy: remove trailing version markers
    key2 = re.sub(r"\s*v\d+$", "", key).strip()
    if key2 in SECTION_ALIASES:
        return SECTION_ALIASES[key2]
    return None


def load_existing_sections(md: str) -> set[str]:
    return {line[2:].strip() for line in md.splitlines() if line.startswith("# ") and not line.startswith("# Proxy")}


def parse_input(text: str) -> OrderedDict[str, list[str]]:
    groups: OrderedDict[str, list[str]] = OrderedDict()
    current: str | None = None
    for raw in text.splitlines():
        line = raw.strip()
        if not line:
            continue
        if line.startswith("#"):
            continue
        if re.match(r"^[\U0001F300-\U0001FAFF\U00002600-\U000027BF]+\s*$", line):
            continue
        if re.match(r"^\d+\s+links?$", line, re.I):
            continue
        sec = map_section(line)
        if sec and not extract_urls(line):
            current = sec
            groups.setdefault(current, [])
            continue
        urls = extract_urls(line)
        if urls and current:
            for u in urls:
                groups[current].append(u)
        elif urls and not current:
            # orphan URLs — skip
            pass
    return groups


def fmt_row(url: str) -> str:
    if not url.startswith(("http://", "https://")):
        url = "https://" + url
    return f"| | {url} | {DATE} | N/A | N/A | {CONTRIB}"


def insert_into_section(md: str, section_title: str, items: list[str]) -> tuple[str, bool]:
    pattern = re.compile(r"^# " + re.escape(section_title) + r"\s*$", re.MULTILINE)
    m = pattern.search(md)
    if not m:
        return md, False
    section_start = m.start()
    header_end = m.end()
    next_h = re.search(r"^# ", md[header_end:], re.MULTILINE)
    section_end = header_end + next_h.start() if next_h else len(md)
    block = md[section_start:section_end]

    def bump(match: re.Match) -> str:
        cells = match.group(0).split("|")
        try:
            n = int(cells[-2].strip())
        except Exception:
            return match.group(0)
        cells[-2] = f" {n + len(items)} "
        return "|".join(cells)

    new_block, n_sub = re.subn(
        r"^>\s*\|[^\n]*\|\s*\d+\s*\|\s*$", bump, block, count=1, flags=re.MULTILINE
    )
    if n_sub == 0:
        return md, False
    rows_iter = list(re.finditer(r"^\|\s+\|\s+https?://[^\n]+$", new_block, re.MULTILINE))
    addition = "\n" + "\n".join(fmt_row(u) for u in items)
    if rows_iter:
        insert_at = rows_iter[-1].end()
        new_block = new_block[:insert_at] + addition + new_block[insert_at:]
    else:
        div = re.search(r"^\|\s*-\s*\|[^\n]*\|\s*$", new_block, re.MULTILINE)
        if not div:
            return md, False
        new_block = new_block[: div.end()] + addition + new_block[div.end() :]
    return md[:section_start] + new_block + md[section_end:], True


def make_pending_section(name: str, items: list[str]) -> str:
    n = len(items)
    rows_md = "\n".join(fmt_row(u) for u in items)
    return (
        f"\n# {name}\n"
        f"> [!NOTE]\n"
        f"> | Category | Capabilities | Protocol(s) | Links |\n"
        f"> | - | - | - | - |\n"
        f"> | pending | pending | pending | {n} |\n"
        f"> [!IMPORTANT]\n"
        f"> This section has not been categorized or checked for protocol(s) and capabilities.\n"
        f"\n"
        f"| Locked | Link | Found Date | Username | Password | Contributor |\n"
        f"| - | - | - | - | - | - |\n"
        f"{rows_md}\n"
    )


def main() -> None:
    text = INPUT.read_text(encoding="utf-8")
    md = MD_PATH.read_text(encoding="utf-8")
    existing_sections = load_existing_sections(md)

    url_re = re.compile(r"https?://[^\s|]+", re.IGNORECASE)
    existing = {norm_url(u) for u in url_re.findall(md)}

    groups = parse_input(text)
    seen_batch: set[str] = set()
    to_add: OrderedDict[str, list[str]] = OrderedDict()
    pending_new: OrderedDict[str, list[str]] = OrderedDict()
    stats = {"bunnycdn": 0, "dup-list": 0, "dup-batch": 0, "invalid": 0, "npm-registry": 0, "garbage": 0}

    for section, urls in groups.items():
        for raw_u in urls:
            reason = should_skip_url(raw_u)
            if reason:
                stats[reason] = stats.get(reason, 0) + 1
                continue
            if not raw_u.startswith(("http://", "https://")):
                raw_u = "https://" + raw_u
            n = norm_url(raw_u)
            if n in existing:
                stats["dup-list"] += 1
                continue
            if n in seen_batch:
                stats["dup-batch"] += 1
                continue
            seen_batch.add(n)
            if section in existing_sections:
                to_add.setdefault(section, []).append(raw_u)
            else:
                pending_new.setdefault(section, []).append(raw_u)

    print("=== Adding to existing sections ===")
    for sec, items in to_add.items():
        print(f"  {sec}: +{len(items)}")
        md, ok = insert_into_section(md, sec, items)
        if not ok:
            print(f"    !! failed to insert into {sec}")
            pending_new.setdefault(sec, []).extend(items)

    print("\n=== New pending sections ===")
    md = md.rstrip() + "\n"
    for sec, items in pending_new.items():
        if sec in existing_sections:
            md, ok = insert_into_section(md, sec, items)
            if ok:
                print(f"  {sec}: +{len(items)} (existing)")
                continue
        print(f"  {sec}: {len(items)} links (new pending)")
        md += make_pending_section(sec, items)
        existing_sections.add(sec)

    MD_PATH.write_text(md, encoding="utf-8")
    total = sum(len(v) for v in to_add.values()) + sum(len(v) for v in pending_new.values())
    print(f"\nTotal new links added: {total}")
    print("Skipped:", stats)


if __name__ == "__main__":
    main()
