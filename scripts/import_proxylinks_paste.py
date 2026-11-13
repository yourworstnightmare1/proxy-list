#!/usr/bin/env python3
"""Import proxylinks-pasted.txt into list.md per maintainer paste rules."""

from __future__ import annotations

import re
import sys
from collections import OrderedDict
from pathlib import Path
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[1]
MD_PATH = ROOT / "list.md"
DEFAULT_INPUT = Path(__file__).resolve().parent / "batch_links_aug17_2026.txt"

DATE = "8/17/2026"
CONTRIB = "[yourworstnightmare1](https://github.com/yourworstnightmare1)"
ALLOW_BUNNYCDN = False

FILTER_LABELS = re.compile(
    r"\b(Lightspeed|Linewize|GoGuardian|Securly|Fortiguard|FortiGuard|"
    r"Cisco(?:\s+Umbrella)?|Blocksi(?:\s+(?:Web|Ai|AI))?|LanSchool|Deledao|Iboss|iboss|"
    r"Sophos|Barracuda|Qustodio|DNSFiter|DNSFilter|ZScaler|Palo[\s.]*Alto|"
    r"Content[\s.]*Keeper|Aristotle(?:K12)?|Senso(?:\s*Cloud)?|NextDNS|"
    r"@?(?:Linewize|GoGuardian|Palo\.Alto|Content\.Keeper|iBoss))\b",
    re.IGNORECASE,
)

HTTP_URL = re.compile(r"https?://[^\s<>\"'`\]]+", re.IGNORECASE)
BARE_HOST = re.compile(
    r"(?<![@\w/])((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}"
    r"(?:/[^\s<>\"']*)?)",
    re.IGNORECASE,
)

# Discord / filter-report noise — never treat as section names
NOISE_RE = re.compile(
    r"poortung|fortiguard|all blockers|check-your-links|results for|"
    r"allow popups|type \d|click (?:viewer|the play|re-run)|"
    r"for some reason this gets marked|wildcard|nocaptions|"
    r"the links below|^\(gn=|cdn slop|other (?:links|unblocker)|"
    r"premium unblocker|ignore the filter|buncha void|start void|"
    r"end void links|now has proxy",
    re.IGNORECASE,
)

# Exact aliases (normalized key -> list.md header without #)
SECTION_ALIASES: dict[str, str] = {
    "gn-math": "➗ gn-math",
    "gn math": "➗ gn-math",
    "gn": "➗ gn-math",
    "selenite": "💜 Selenite",
    "velara": "🌙 Velara",
    "velera": "🌙 Velara",
    "shadow": "👤 Shadow",
    "rammerhead": "🐏 Rammerhead",
    "rammer": "🐏 Rammerhead",
    "nebulios": "🚀 Nebulo",
    "nebulo": "🚀 Nebulo",
    "rhodium": "⚛️ Rhodium",
    "invisiproxy": "👥 InvisiProxy",
    "invisi proxy": "👥 InvisiProxy",
    "duckmath": "🦆 Duckmath",
    "duck math": "🦆 Duckmath",
    "duck": "🦆 Duckmath",
    "aether": "🌬️ Aether",
    "rosin": "🎮 Rosin",
    "yuki": "❄️ Yuki",
    "dogeub": "🐶 dogeub",
    "doge ub": "🐶 dogeub",
    "mist": "🌫️ Mist",
    "kamat": "🥋 Kamat",
    "solara": "☀️ Solara",
    "ink": "🖋️ Ink",
    "galaxy": "🪐 Galaxy",
    "snipershot": "🎯 Snipershot",
    "sniper shot": "🎯 Snipershot",
    "nexus": "🔗 Nexus",
    "truffled": "🍄 Truffled",
    "bestspark": "✨ BestSpark",
    "best spark": "✨ BestSpark",
    "cherri": "🌸 Cherri",
    "unblockedzone": "🔓 Unblockedzone",
    "unblocked zone": "🔓 Unblockedzone",
    "space": "🌑 Space",
    "utopia": "🦄 Utopia Education",
    "utopia education": "🦄 Utopia Education",
    "lunar": "🌕 Lunar",
    "study hub": "📖 StudyHub",
    "studyhub": "📖 StudyHub",
    "tung tung": "🪵 Tung Tung",
    "tungtung": "🪵 Tung Tung",
    # Keep Cherri and Strawberri separate
    "strawberri": "🍓 Strawberri",
    "strawberry": "🍓 Strawberri",
    "voya": "🚢 Voya",
    "project echo": "📡 Project Echo",
    "cat class": "🐱 Cat Class",
    "catclass": "🐱 Cat Class",
    "zaka edu": "📘 Zaka EDU",
    "zaka": "📘 Zaka EDU",
    "arctic": "🧊 Arctic",
    "petezah": "🍕 PeteZah",
    "pete zah": "🍕 PeteZah",
    "ford": "Ford",
    "fern": "🪴 Fern",
    "zodiac": "♈ Zodiac",
    "nocturne": "🌙 Nocturne",
    "nocturne v2": "🌙 Nocturne",
    "polaris": "⭐ Polaris",
    "c00lkidtech": "🧊 C00lkidtech",
    "noahs tutoring": "🟨 Noahs Tutoring",
    "noahs": "🟨 Noahs Tutoring",
    "overcloaked": "🏴 OverCloaked",
    "over cloaked": "🏴 OverCloaked",
    "parcoil": "🌀 Parcoil",
    "parcoil lunaar": "🌀 Parcoil",
    "lunaar": "🌘 Lunaar",
    "void network": "🖤 Void Network",
    "void": "🖤 Void Network",
    "desync": "Desync",
    "reds exploit corner": "Reds Exploit Corner",
    "reds exploit": "Reds Exploit Corner",
    "aeos": "⚙️ Aeos",
    "breeze": "Breeze",
    "more cherri": "🌸 Cherri",
    "lucide": "🤍 Lucide",
    "opium": "💊 Opium",
    "astra": "🌟 Astra",
    "abstract": "Abstract",
    "revault": "🔐 Re: Vault",
    "re vault": "🔐 Re: Vault",
    "re: vault": "🔐 Re: Vault",
    "glim": "✨ Glim",
    "kite": "Kite",
    "daydream x": "⭐ DayDream X",
    "daydreamx": "⭐ DayDream X",
    "daydream": "⭐ DayDream X",
    "doge": "Doge",
    "flver": "Flver",
    "rook": "Rook",
    "aurora": "Aurora",
    "cinera": "CINERA",
    "solaraos": "☀️ Solara",
    "solara os": "☀️ Solara",
    "triple t hd": "Triple T HD",
    "interstellar": "🌠 Interstellar",
    "stroberri": "🍓 Strawberri",
    "steobrri": "🍓 Strawberri",
    "strobri": "🍓 Strawberri",
    "yukios": "❄️ Yuki",
    "yuki os": "❄️ Yuki",
    "luna": "🌕 Luna",
    "nebula": "🚀 Nebulo",
    "bull": "🐂 Bull",
    "bull33": "🐂 Bull",
    "bull 33": "🐂 Bull",
    "bull-33": "🐂 Bull",
    "rayzhusz": "🐂 Bull",
    "rayzhusz links": "🐂 Bull",
    "material": "🧱 Material",
    "tungtung": "🪵 Tung Tung",
    "xylora": "🔮 Xylora",
    "toby web": "🦥 Toby Web",
    "toby": "🦥 Toby Web",
    "surreal": "🌀 Surreal",
    "coolkid": "🧊 C00lkidtech",
    "cool kid": "🧊 C00lkidtech",
    "c00lkid": "🧊 C00lkidtech",
    "julian": "🪴 Fern",
    "jullians drop": "🪴 Fern",
    "julian s drop": "🪴 Fern",
    "jullian": "🪴 Fern",
}

# Longest-first for scanning
_ALIAS_KEYS = sorted(SECTION_ALIASES.keys(), key=len, reverse=True)


def norm_key(s: str) -> str:
    s = re.sub(r"[^\w\s-]", " ", s.lower())
    s = re.sub(r"\s+", " ", s).strip()
    return s


def norm_url(u: str) -> str:
    u = u.strip().rstrip(",.;)'\":")
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
    while path.endswith("/?/"):
        path = path[:-3]
    while path.endswith("/?") or path.endswith("/"):
        path = path[:-1] if path.endswith("/") else path[:-2]
        if not path:
            break
    query = p.query or ""
    return host + path + (("?" + query) if query else "")


def host_of(u: str) -> str:
    try:
        h = urlsplit(u if "://" in u else "https://" + u).hostname or ""
    except Exception:
        return ""
    h = h.lower()
    return h[4:] if h.startswith("www.") else h


STORAGE_SECTION_RE = re.compile(
    r"/(?:500klinks|fckyoukiz)/(cherri|arctic)_", re.IGNORECASE
)


def infer_section_from_url(url: str) -> str | None:
    """Route bulk storage URLs to Cherri / Arctic when path contains the slug."""
    m = STORAGE_SECTION_RE.search(url)
    if not m:
        return None
    slug = m.group(1).lower()
    return SECTION_ALIASES.get(slug)


def should_skip_url(u: str) -> str | None:
    if not u or "chrome://" in u:
        return "invalid"
    h = host_of(u)
    if not h or "." not in h:
        return "invalid"
    if not ALLOW_BUNNYCDN and (h == "b-cdn.net" or h.endswith(".b-cdn.net")):
        return "bunnycdn"
    # Exact host or dotted subdomain only (endswith("chesscomfiles.com") also
    # matched prefix-evil hosts like "notchesscomfiles.com").
    if (
        h == "chesscomfiles.com"
        or h.endswith(".chesscomfiles.com")
        or h == "chess.com"
        or h.endswith(".chess.com")
    ):
        return "garbage"
    if h == "registry.npmjs.org":
        return "npm-registry"
    if "<" in u or "br<" in u:
        return "garbage"
    # Truncated / incomplete paste fragments (cannot be completed safely)
    if "..." in u:
        return "incomplete"
    try:
        p = urlsplit(u if "://" in u else "https://" + u)
    except Exception:
        return "invalid"
    path = p.path or ""
    # Ends mid-token: .../in.  .../ro.  .../theplayernat.  .../ind.  .../strawberrii/.
    if re.search(r"/(?:in|ro|ind|gl|ki|i)\.?$", path) or path.endswith("/."):
        return "incomplete"
    if re.search(r"/theplayernat\.?$", path, re.I):
        return "incomplete"
    # Host itself truncated (e.g. s3.us-east-1.amazon..., *.dualstack.us-eas)
    if h.endswith(".") or "amazon..." in h or h.endswith("amazon"):
        return "incomplete"
    tld = h.rsplit(".", 1)[-1]
    if not re.fullmatch(r"[a-z0-9-]{2,24}", tld) or tld in {"us-eas", "amazon", "amazona"}:
        return "incomplete"
    if re.search(r"\.(?:dualstack\.)?us-eas$", h):
        return "incomplete"
    return None


def clean_url_token(tok: str) -> str:
    return tok.strip().lstrip("+").rstrip(",.;)'\":;")


def is_url_token(tok: str) -> bool:
    tok = clean_url_token(tok)
    if not tok:
        return False
    if HTTP_URL.match(tok):
        return True
    return bool(BARE_HOST.fullmatch(tok))


def extract_urls_from_token(tok: str) -> list[str]:
    tok = clean_url_token(tok)
    if not tok:
        return []
    if HTTP_URL.match(tok):
        return [HTTP_URL.match(tok).group(0).rstrip(",.;)'\":")]
    if BARE_HOST.fullmatch(tok):
        return [tok]
    # markdown <https://...>
    found = []
    for m in HTTP_URL.finditer(tok):
        found.append(m.group(0).rstrip(",.;)'\":"))
    return found


def match_section_at(words: list[str], i: int) -> tuple[str, int] | None:
    """If words[i:] starts with a known section alias, return (title, words_consumed)."""
    # Try multi-word then single
    for length in range(min(4, len(words) - i), 0, -1):
        phrase = " ".join(words[i : i + length])
        # strip leading @ and trailing : ,
        phrase = phrase.lstrip("@").rstrip(":,").strip()
        key = norm_key(phrase)
        if key in SECTION_ALIASES:
            return SECTION_ALIASES[key], length
    return None


def header_key(line: str) -> str:
    """Normalize a possible section header (strip @, :, parens commentary)."""
    s = line.strip().lstrip("@").rstrip(":")
    s = re.sub(r"\([^)]*\)", " ", s)
    return norm_key(s)


def is_pure_section_header(line: str) -> bool:
    line = line.strip()
    if not line or len(line) > 80:
        return False
    if re.search(r"cdn slop|other (?:links|unblocker)|premium unblocker|"
                 r"ignore the filter|buncha void|start void|end void",
                 line, re.I):
        return False
    if HTTP_URL.search(line) or BARE_HOST.search(line):
        return False
    # Pure filter-name lines are never providers
    if FILTER_LABELS.fullmatch(line.strip().lstrip("@").rstrip(":")):
        return False
    key = header_key(line)
    return key in SECTION_ALIASES


def is_domain_only_line(line: str) -> bool:
    parts = [clean_url_token(p) for p in line.split() if clean_url_token(p)]
    if not parts:
        return False
    return all(is_url_token(p) for p in parts)


def should_skip_entire_line(line: str) -> bool:
    """Filter-report / instructional lines with no salvageable section+url structure."""
    stripped = line.strip()
    if SKIP_FROM_MARKER.search(line):
        return True
    if re.match(r"^after opening the link", stripped, re.I):
        return True
    if re.match(r"^Library/[^\s]+\.txt$", stripped, re.I):
        return True
    if stripped in {"Announcements", "|"} or re.match(r"^\d+$", stripped):
        return True
    if re.fullmatch(r"[_=-]{3,}", stripped):
        return True
    if re.search(r"cdn and script slop", stripped, re.I):
        return True
    if re.search(r"not working rn", stripped, re.I) and "http" not in stripped.lower():
        return True
    if re.match(r"^Avatar of ", stripped, re.I):
        return True
    if re.match(r"^Aug \d+, \d{4}", stripped):
        return True
    if "arctic the sequel" in stripped.lower() or "lots of links like" in stripped.lower():
        return True
    # Pure filter emoji report blocks
    if ("✅" in line or "❌" in line) and FILTER_LABELS.search(line) and "http" not in line.lower():
        return True
    if stripped.startswith("(gn="):
        return True
    return False


SKIP_FROM_MARKER = re.compile(
    r"the links below have the section name in the url",
    re.IGNORECASE,
)


def tokenize_line(line: str) -> list[str]:
    """Split into words/URLs; keep https URLs intact."""
    line = FILTER_LABELS.sub(" ", line)
    line = re.sub(r"\[allow[^\]]*\]", " ", line, flags=re.I)
    line = re.sub(r"[<>;`]", " ", line)
    line = re.sub(r"[✅❌🛡️🚦🔥🧱🌐☁️⚛️🔒🏫🧹🥏🌳😈💼🛏️🐍🎙️🛢️🪼⏱️]", " ", line)
    # Split but preserve http URLs
    parts: list[str] = []
    pos = 0
    for m in HTTP_URL.finditer(line):
        before = line[pos : m.start()]
        parts.extend(before.split())
        parts.append(m.group(0))
        pos = m.end()
    parts.extend(line[pos:].split())
    return [p for p in parts if p and p not in {"+", "|", "-", "—", "/", "&", "..."}]


def append_urls(
    groups: OrderedDict[str, list[str]],
    current: str | None,
    urls: list[str],
) -> str | None:
    for u in urls:
        inferred = infer_section_from_url(u)
        section = inferred or current
        if not section:
            continue
        groups.setdefault(section, []).append(u)
        if inferred:
            current = inferred
    return current


def parse_tokens_into(
    groups: OrderedDict[str, list[str]], current: str | None, tokens: list[str]
) -> str | None:
    i = 0
    while i < len(tokens):
        tok = tokens[i]
        # Skip noise tokens
        if NOISE_RE.search(tok) or tok.startswith("@") and norm_key(tok.lstrip("@")) not in SECTION_ALIASES:
            # @Strawberry / @Strawberri is a section hint
            if tok.startswith("@"):
                hit = match_section_at([tok], 0)
                if hit:
                    current = hit[0]
                    groups.setdefault(current, [])
            i += 1
            continue
        hit = match_section_at(tokens, i)
        if hit and not is_url_token(tok):
            current, consumed = hit
            groups.setdefault(current, [])
            i += consumed
            continue
        if is_url_token(tok):
            current = append_urls(groups, current, extract_urls_from_token(tok))
            i += 1
            continue
        # Unknown prose — skip
        i += 1
    return current


def parse_input(text: str) -> OrderedDict[str, list[str]]:
    groups: OrderedDict[str, list[str]] = OrderedDict()
    current: str | None = None
    skip_storage_block = False
    force_void = False
    void_title = SECTION_ALIASES["void network"]

    for raw in text.splitlines():
        line = raw.strip()
        if not line:
            continue

        lower = line.lower()
        if "start void links" in lower or "ignore the filter names" in lower:
            force_void = True
            current = void_title
            groups.setdefault(current, [])
            continue
        if "end void links" in lower:
            force_void = False
            continue
        if force_void and (
            FILTER_LABELS.fullmatch(line.lstrip("@").rstrip(":"))
            or re.fullmatch(r"(?i)buncha void sorted by blocker:?", line)
        ):
            current = void_title
            continue

        if SKIP_FROM_MARKER.search(line):
            skip_storage_block = True
            continue
        if skip_storage_block:
            # End when a known section appears
            if is_pure_section_header(line) or (
                match_section_at(tokenize_line(line), 0) and is_url_token(tokenize_line(line)[-1] if tokenize_line(line) else "")
            ):
                # Check if line starts with known section
                toks = tokenize_line(line)
                if toks and match_section_at(toks, 0):
                    skip_storage_block = False
                elif is_pure_section_header(line):
                    skip_storage_block = False
                else:
                    continue
            else:
                # Skip google storage filter-index URLs
                continue

        if should_skip_entire_line(line):
            continue

        if is_pure_section_header(line):
            if force_void:
                current = void_title
            else:
                current = SECTION_ALIASES[header_key(line)]
            groups.setdefault(current, [])
            continue

        # Standalone filter-name lines (outside void block): ignore, keep section
        if FILTER_LABELS.fullmatch(line.lstrip("@").rstrip(":")):
            if force_void:
                current = void_title
            continue

        if is_domain_only_line(line):
            urls: list[str] = []
            for p in line.split():
                urls.extend(extract_urls_from_token(p))
            if force_void:
                current = void_title
            current = append_urls(groups, current, urls)
            continue

        tokens = tokenize_line(line)
        if not tokens:
            continue
        if force_void:
            current = void_title
        current = parse_tokens_into(groups, current, tokens)

    return groups


def load_existing_sections(md: str) -> dict[str, str]:
    out: dict[str, str] = {}
    for line in md.splitlines():
        if line.startswith("# ") and not line.startswith("##") and not line.startswith("# Proxy"):
            title = line[2:].strip()
            bare = re.sub(r"^[\U0001F300-\U0001FAFF\U00002600-\U000027BF\uFE0F]+\s*", "", title)
            out[norm_key(bare)] = title
            out[norm_key(title)] = title
    return out


def resolve_section(mapped: str, existing: dict[str, str]) -> str:
    bare = re.sub(r"^[\U0001F300-\U0001FAFF\U00002600-\U000027BF\uFE0F]+\s*", "", mapped)
    key = norm_key(bare)
    if key in existing:
        return existing[key]
    compact = key.replace(" ", "").replace("-", "")
    for ek, et in existing.items():
        if ek.replace(" ", "").replace("-", "") == compact:
            return et
    return mapped


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
        f"> | pending | - | - | {n} |\n"
        f"> [!IMPORTANT]\n"
        f"> This section has not been categorized or checked for protocol(s) and capabilities.\n"
        f"\n"
        f"| Locked | Link | Found Date | Username | Password | Contributor |\n"
        f"| - | - | - | - | - | - |\n"
        f"{rows_md}\n"
    )


def main() -> None:
    import argparse

    global DATE, ALLOW_BUNNYCDN

    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")

    parser = argparse.ArgumentParser(description="Import batch link paste into list.md")
    parser.add_argument(
        "input",
        nargs="?",
        default=str(DEFAULT_INPUT),
        help="Batch paste file (default: scripts/batch_links_aug17_2026.txt)",
    )
    parser.add_argument(
        "--date",
        default=DATE,
        help="Found Date for new rows (M/D/YYYY)",
    )
    parser.add_argument(
        "--allow-bunny",
        action="store_true",
        help="Keep *.b-cdn.net URLs instead of skipping them",
    )
    args = parser.parse_args()
    DATE = args.date
    ALLOW_BUNNYCDN = bool(args.allow_bunny)
    input_path = Path(args.input)
    if not input_path.is_file():
        print(f"Input file not found: {input_path}", file=sys.stderr)
        sys.exit(1)

    text = input_path.read_text(encoding="utf-8")
    md = MD_PATH.read_text(encoding="utf-8")
    existing_map = load_existing_sections(md)
    existing_titles = set(existing_map.values())

    url_re = re.compile(r"https?://[^\s|]+", re.IGNORECASE)
    existing = {norm_url(u) for u in url_re.findall(md)}

    raw_groups = parse_input(text)
    groups: OrderedDict[str, list[str]] = OrderedDict()
    for sec, urls in raw_groups.items():
        resolved = resolve_section(sec, existing_map)
        groups.setdefault(resolved, []).extend(urls)

    seen_batch: set[str] = set()
    to_add: OrderedDict[str, list[str]] = OrderedDict()
    pending_new: OrderedDict[str, list[str]] = OrderedDict()
    stats: dict[str, int] = {
        "bunnycdn": 0,
        "dup-list": 0,
        "dup-batch": 0,
        "invalid": 0,
        "incomplete": 0,
        "npm-registry": 0,
        "garbage": 0,
    }

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
            if section in existing_titles:
                to_add.setdefault(section, []).append(raw_u)
            else:
                pending_new.setdefault(section, []).append(raw_u)

    print("=== Parsed groups (raw URL counts) ===")
    for sec, urls in groups.items():
        print(f"  {sec}: {len(urls)} raw")

    print("\n=== Adding to existing sections ===")
    for sec, items in to_add.items():
        print(f"  {sec}: +{len(items)}")
        md, ok = insert_into_section(md, sec, items)
        if not ok:
            print(f"    !! failed to insert into {sec}")
            pending_new.setdefault(sec, []).extend(items)

    print("\n=== New pending sections ===")
    md = md.rstrip() + "\n"
    for sec, items in list(pending_new.items()):
        if not items:
            continue
        if sec in existing_titles or re.search(
            r"^# " + re.escape(sec) + r"\s*$", md, re.MULTILINE
        ):
            md, ok = insert_into_section(md, sec, items)
            if ok:
                print(f"  {sec}: +{len(items)} (existing)")
                continue
        print(f"  {sec}: {len(items)} links (new pending)")
        md += make_pending_section(sec, items)
        existing_titles.add(sec)

    MD_PATH.write_text(md, encoding="utf-8")
    total = sum(len(v) for v in to_add.values()) + sum(len(v) for v in pending_new.values())
    print(f"\nTotal new links added: {total}")
    print("Skipped:", stats)


if __name__ == "__main__":
    main()
