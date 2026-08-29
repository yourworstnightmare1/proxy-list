#!/usr/bin/env python3
"""Snapshot game-database catalogs for the Games statistics page.

Fetches the same remote/local sources as docs/game-db-search.js, writes a UTC-day
archive under docs/stats/archive/gdb_catalogs/, diffs against the previous day,
and emits docs/gdb_stats.json for the UI.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DOCS = ROOT / "docs"
OUTPUT_JSON = DOCS / "gdb_stats.json"
ARCHIVE_ROOT = DOCS / "stats" / "archive" / "gdb_catalogs"
GDB_LOCAL = DOCS / "gdb-catalogs"

UA = "Mozilla/5.0 (compatible; proxy-list-gdb-stats/1.0)"
CDN_BASES = (
    "https://cdn.jsdelivr.net",
    "https://fastly.jsdelivr.net",
    "https://gcore.jsdelivr.net",
)
CHANGE_CAP = 100
MOD_HISTORY_CAP = 60

# tag -> label (mirrors docs/game-db-search.js CATALOGS)
CATALOG_META: list[tuple[str, str]] = [
    ("gdb:unblockedzone", "Unblockedzone"),
    ("gdb:gn-math", "gn-math"),
    ("gdb:luminsdk", "Lumin SDK"),
    ("gdb:noahs-tutoring", "Noah's Tutoring"),
    ("gdb:elite-games", "Elite Games"),
    ("gdb:ultimate-game-stash", "Ultimate Game Stash"),
    ("gdb:seraph", "Seraph"),
    ("gdb:chicken-kings-vault", "Chicken King's Vault"),
    ("gdb:lucide", "Lucide"),
    ("gdb:sdxp", "SDXP"),
    ("gdb:duckmath", "DuckMath"),
    ("gdb:ccported", "CCPorted"),
    ("gdb:selenite", "Selenite"),
    ("gdb:radon", "Radon"),
    ("gdb:truffled", "Truffled"),
    ("gdb:totally-science", "Totally Science"),
    ("gdb:petezah", "PeteZah"),
    ("gdb:frogies-arcade", "frogie's arcade"),
    ("gdb:space", "Space"),
    ("gdb:boredom", "Boredom"),
    ("gdb:dogeub", "dogeub"),
    ("gdb:utopia", "Utopia Education"),
]

EMPTY_TAGS = {
    "gdb:sdxp",
    "gdb:truffled",
    "gdb:totally-science",
    "gdb:frogies-arcade",
    "gdb:space",
}


def http_get(url: str, timeout: float = 45.0) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "*/*"})
    with urllib.request.urlopen(req, timeout=timeout) as res:
        return res.read()


def http_json(url: str, timeout: float = 45.0):
    return json.loads(http_get(url, timeout=timeout).decode("utf-8", errors="replace"))


def http_text(url: str, timeout: float = 45.0) -> str:
    return http_get(url, timeout=timeout).decode("utf-8", errors="replace")


def fetch_cdn(path: str, binary: bool = False):
    path = path if path.startswith("/") else "/" + path
    errors: list[str] = []
    for base in CDN_BASES:
        url = base.rstrip("/") + path
        try:
            data = http_get(url)
            if binary:
                return data
            text = data.decode("utf-8", errors="replace")
            if path.endswith(".json") or path.endswith(".jsonc"):
                return json.loads(text)
            return text
        except Exception as err:  # noqa: BLE001
            errors.append(f"{url}: {err}")
    raise RuntimeError("; ".join(errors) or "CDN fetch failed")


def unique_names(raw_names) -> list[str]:
    seen: dict[str, str] = {}
    for raw in raw_names:
        name = str(raw or "").strip()
        if not name:
            continue
        key = re.sub(r"\s+", " ", name).lower()
        if key not in seen:
            seen[key] = name
    return sorted(seen.values(), key=lambda s: s.lower())


def names_from_rows(rows, *keys: str) -> list[str]:
    out = []
    for row in rows or []:
        if isinstance(row, str):
            out.append(row)
            continue
        if not isinstance(row, dict):
            continue
        for k in keys:
            if row.get(k):
                out.append(row[k])
                break
    return unique_names(out)


def load_empty() -> list[str]:
    return []


def load_zones() -> list[str]:
    data = None
    try:
        data = fetch_cdn("/gh/freebuisness/assets@main/zones.json")
    except Exception:
        try:
            data = http_json("https://raw.githubusercontent.com/gn-math/assets/main/zones.json")
        except Exception:
            data = None
    if not isinstance(data, list):
        return []
    names = []
    for g in data:
        if not isinstance(g, dict):
            continue
        if g.get("id") == -1:
            continue
        name = str(g.get("name") or "").strip()
        if not name or name.startswith("[!]"):
            continue
        names.append(name)
    return unique_names(names)


def load_noah() -> list[str]:
    try:
        d = fetch_cdn("/gh/NoahsAmazingTutoringHelp/Noahs-Calculus-Tutor@master/games.json")
        rows = d if isinstance(d, list) else (d.get("games") if isinstance(d, dict) else [])
        names = names_from_rows(rows, "title", "name")
        if names:
            return names
    except Exception:
        pass
    try:
        text = fetch_cdn("/gh/NoahsAmazingTutoringHelp/Noahs-Calculus-Tutor@master/games.js")
        return unique_names(re.findall(r'title:\s*["\'](.+?)["\']', str(text)))
    except Exception:
        return []


def load_elite() -> list[str]:
    d = fetch_cdn("/gh/1234chromebook1234-creator/ww@main/games.json")
    return names_from_rows(d if isinstance(d, list) else [], "title", "name")


def load_seraph() -> list[str]:
    d = fetch_cdn("/gh/DominumNetwork/dominum@main/src/assets/libraries/seraph/games.json")
    return names_from_rows(d if isinstance(d, list) else [], "name", "title")


def load_ckv() -> list[str]:
    d = fetch_cdn("/gh/carbonicality/ChickenKingsVault@main/games.json")
    return names_from_rows(d if isinstance(d, list) else [], "name", "title")


def load_ugs() -> list[str]:
    names: list[str] = []
    for repo in ("tharun9772/ugs-1", "tharun9772/ugs-2", "tharun9772/ugs-3"):
        try:
            listing = http_json(f"https://api.github.com/repos/{repo}/contents/")
        except Exception:
            continue
        if not isinstance(listing, list):
            continue
        for f in listing:
            if not isinstance(f, dict) or f.get("type") != "file":
                continue
            fname = str(f.get("name") or "")
            if re.match(r"^cl.+\.html$", fname, re.I):
                names.append(re.sub(r"^cl", "", fname, flags=re.I).replace(".html", "").replace(".HTML", ""))
    return unique_names(names)


def load_unblockedzone() -> list[str]:
    try:
        text = str(fetch_cdn("/gh/s0n-1m-cr1n3/sc13nc3@latest/assets/index.html"))
    except Exception:
        return []
    names = re.findall(
        r'normalizeGame\(\{\s*name\s*:\s*["\']([^"\']+)["\']',
        text,
    )
    if not names:
        names = re.findall(r'openGame\(\s*[\'"]([^\'"]+)[\'"]', text)
    return unique_names(names)


def load_lucide() -> list[str]:
    # Prefer zones catalog (shared with gn-math / Lumin) when Lucide scrape is sparse.
    zones = load_zones()
    try:
        listing = str(fetch_cdn("/gh/lucideproxy/svg@latest/assets/"))
        m = re.search(r"GamesPage-[A-Za-z0-9_-]+\.js", listing)
        if not m:
            return zones
        text = str(fetch_cdn(f"/gh/lucideproxy/svg@latest/assets/{m.group(0)}"))
        names = []
        for hit in re.findall(
            r'["\']([A-Z][A-Za-z0-9](?:[A-Za-z0-9 .:!&+\-]{2,60}))["\']',
            text,
        ):
            n = hit.strip()
            if " " not in n:
                continue
            if re.match(r"^(Error|Click|Please|Function|Return|Class)\b", n, re.I):
                continue
            names.append(n)
        scraped = unique_names(names)
        return scraped if len(scraped) >= len(zones) else zones
    except Exception:
        return zones


def load_petezah() -> list[str]:
    d = http_json(
        "https://cdn.jsdelivr.net/gh/PeteZah-Games/PeteZahGames@main/public/storage/data/collection.json"
    )
    games = d.get("games") if isinstance(d, dict) else []
    names = []
    for g in games or []:
        if not isinstance(g, dict):
            continue
        label = str(g.get("label") or "").strip()
        if not label or re.search(r"request games", label, re.I):
            continue
        names.append(label)
    return unique_names(names)


def load_ccported() -> list[str]:
    try:
        tree = http_json("https://api.github.com/repos/ccported/games/git/trees/main?recursive=1")
    except Exception:
        return []
    paths = [
        n.get("path")
        for n in (tree.get("tree") if isinstance(tree, dict) else []) or []
        if isinstance(n, dict) and re.search(r"/ccported_game_data\.json$", str(n.get("path") or ""), re.I)
    ]
    if not paths:
        return []
    base = "https://cdn.jsdelivr.net/gh/ccported/games@main"
    names: list[str] = []

    def one(path: str):
        try:
            meta = http_json(f"{base}/{path}", timeout=30.0)
            if isinstance(meta, dict) and meta.get("name"):
                return str(meta["name"])
        except Exception:
            return None
        return None

    with ThreadPoolExecutor(max_workers=16) as pool:
        futs = [pool.submit(one, p) for p in paths if p]
        for fut in as_completed(futs):
            n = fut.result()
            if n:
                names.append(n)
    return unique_names(names)


def load_boredom() -> list[str]:
    repos = (
        "JavierAndPJCreations/BoredomGames",
        "ZShark2166/Boredom-Arcade-Deployable",
    )
    for repo in repos:
        try:
            tree = http_json(f"https://api.github.com/repos/{repo}/git/trees/main?recursive=1")
        except Exception:
            continue
        names = []
        seen: set[str] = set()
        for node in (tree.get("tree") if isinstance(tree, dict) else []) or []:
            if not isinstance(node, dict) or node.get("type") != "tree":
                continue
            path = str(node.get("path") or "")
            if not re.search(r"(Games|games)/", path):
                continue
            m = re.search(r"(?:^|/)(?:BoredomGames/Main/Games|games|Games)/([^/]+)$", path)
            if not m:
                continue
            name = m.group(1).strip()
            key = name.lower()
            if not name or key in seen:
                continue
            seen.add(key)
            names.append(name)
        if names:
            return unique_names(names)
    return []


def load_selenite() -> list[str]:
    rows = fetch_cdn("/gh/selenite-cc/selenite-old@main/games.json")
    return names_from_rows(rows if isinstance(rows, list) else [], "name", "title")


def load_radon() -> list[str]:
    rows = fetch_cdn("/gh/Radon-Games/Radon-Games@main/public/games.json")
    return names_from_rows(rows if isinstance(rows, list) else [], "title", "name")


def load_duckmath() -> list[str]:
    rows = http_json("https://raw.githubusercontent.com/Neruvy/duckmath/main/backup_classes.json")
    return names_from_rows(rows if isinstance(rows, list) else [], "title", "name")


def load_local(file_name: str) -> list[str]:
    path = GDB_LOCAL / file_name
    if not path.is_file():
        return []
    rows = json.loads(path.read_text(encoding="utf-8"))
    return names_from_rows(rows if isinstance(rows, list) else [], "name", "title")


LOADERS = {
    "gdb:unblockedzone": load_unblockedzone,
    "gdb:gn-math": load_zones,
    "gdb:luminsdk": load_zones,
    "gdb:noahs-tutoring": load_noah,
    "gdb:elite-games": load_elite,
    "gdb:ultimate-game-stash": load_ugs,
    "gdb:seraph": load_seraph,
    "gdb:chicken-kings-vault": load_ckv,
    "gdb:lucide": load_lucide,
    "gdb:sdxp": load_empty,
    "gdb:duckmath": load_duckmath,
    "gdb:ccported": load_ccported,
    "gdb:selenite": load_selenite,
    "gdb:radon": load_radon,
    "gdb:truffled": load_empty,
    "gdb:totally-science": load_empty,
    "gdb:petezah": load_petezah,
    "gdb:frogies-arcade": load_empty,
    "gdb:space": load_empty,
    "gdb:boredom": load_boredom,
    "gdb:dogeub": lambda: load_local("dogeub.json"),
    "gdb:utopia": lambda: load_local("utopia.json"),
}


def snapshot_catalogs() -> dict[str, dict]:
    out: dict[str, dict] = {}
    for tag, label in CATALOG_META:
        loader = LOADERS.get(tag, load_empty)
        print(f"  loading {tag}…", flush=True)
        try:
            names = loader()
        except Exception as err:  # noqa: BLE001
            print(f"    ! {tag} failed: {err}", file=sys.stderr)
            names = []
        out[tag] = {
            "label": label,
            "count": len(names),
            "names": names,
            "empty": tag in EMPTY_TAGS,
        }
        print(f"    -> {len(names)} games", flush=True)
    return out


def list_day_files() -> list[Path]:
    folder = ARCHIVE_ROOT / "days"
    if not folder.is_dir():
        return []
    return sorted(folder.glob("????-??-??.json"))


def load_day(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def diff_catalogs(prev: dict | None, curr: dict) -> dict:
    """Return per-catalog and global added/removed name lists."""
    by_catalog: dict[str, dict] = {}
    all_added: list[dict] = []
    all_removed: list[dict] = []
    prev_cats = (prev or {}).get("catalogs") if isinstance(prev, dict) else {}
    if not isinstance(prev_cats, dict):
        prev_cats = {}

    for tag, meta in curr.items():
        label = meta.get("label") or tag
        curr_set = {n.lower(): n for n in meta.get("names") or []}
        prev_meta = prev_cats.get(tag) if isinstance(prev_cats.get(tag), dict) else {}
        prev_set = {n.lower(): n for n in (prev_meta.get("names") or [])}
        added = sorted((curr_set[k] for k in curr_set.keys() - prev_set.keys()), key=str.lower)
        removed = sorted((prev_set[k] for k in prev_set.keys() - curr_set.keys()), key=str.lower)
        by_catalog[tag] = {
            "label": label,
            "added": added,
            "removed": removed,
            "added_count": len(added),
            "removed_count": len(removed),
        }
        for n in added:
            all_added.append({"name": n, "tag": tag, "label": label})
        for n in removed:
            all_removed.append({"name": n, "tag": tag, "label": label})

    all_added.sort(key=lambda x: x["name"].lower())
    all_removed.sort(key=lambda x: x["name"].lower())
    return {
        "by_catalog": by_catalog,
        "all": {
            "added": all_added,
            "removed": all_removed,
            "added_count": len(all_added),
            "removed_count": len(all_removed),
        },
    }


def build_history(day_files: list[Path]) -> list[dict]:
    history = []
    for path in day_files:
        try:
            day = load_day(path)
        except Exception:
            continue
        date = day.get("date") or path.stem
        counts = {}
        catalogs = day.get("catalogs") if isinstance(day.get("catalogs"), dict) else {}
        total = 0
        unique: set[str] = set()
        for tag, meta in catalogs.items():
            if not isinstance(meta, dict):
                continue
            c = int(meta.get("count") or len(meta.get("names") or []))
            counts[tag] = c
            total += c
            for n in meta.get("names") or []:
                unique.add(str(n).strip().lower())
        history.append(
            {
                "date": date,
                "counts": counts,
                "total_entries": total,
                "unique_games": len(unique),
            }
        )
    return history


def build_modifications(day_files: list[Path]) -> list[dict]:
    mods: list[dict] = []
    prev_data = None
    for path in day_files:
        try:
            day = load_day(path)
        except Exception:
            continue
        date = day.get("date") or path.stem
        catalogs = day.get("catalogs") if isinstance(day.get("catalogs"), dict) else {}
        if prev_data is None:
            mods.append(
                {
                    "date": date,
                    "kind": "baseline",
                    "catalogs_touched": [],
                    "added": 0,
                    "removed": 0,
                    "by_catalog": [],
                }
            )
        else:
            diff = diff_catalogs(prev_data, catalogs)
            touched = []
            for tag, ch in diff["by_catalog"].items():
                if ch["added_count"] or ch["removed_count"]:
                    touched.append(
                        {
                            "tag": tag,
                            "label": ch["label"],
                            "added": ch["added_count"],
                            "removed": ch["removed_count"],
                        }
                    )
            touched.sort(key=lambda x: (-(x["added"] + x["removed"]), x["label"].lower()))
            mods.append(
                {
                    "date": date,
                    "kind": "diff",
                    "catalogs_touched": [t["tag"] for t in touched],
                    "added": diff["all"]["added_count"],
                    "removed": diff["all"]["removed_count"],
                    "by_catalog": touched,
                }
            )
        prev_data = {"catalogs": catalogs}
    mods.reverse()  # newest first
    return mods[:MOD_HISTORY_CAP]


def write_summary(day: str, catalogs: dict, day_files: list[Path], diff: dict | None) -> dict:
    catalog_summaries = []
    unique: set[str] = set()
    total_entries = 0
    for tag, label in CATALOG_META:
        meta = catalogs.get(tag) or {"label": label, "count": 0, "names": [], "empty": tag in EMPTY_TAGS}
        count = int(meta.get("count") or 0)
        total_entries += count
        for n in meta.get("names") or []:
            unique.add(str(n).strip().lower())
        catalog_summaries.append(
            {
                "tag": tag,
                "label": meta.get("label") or label,
                "count": count,
                "empty": bool(meta.get("empty") or tag in EMPTY_TAGS),
            }
        )

    latest_changes = {
        "date": day,
        "is_baseline": diff is None,
        "by_catalog": {},
        "all": {"added": [], "removed": [], "added_count": 0, "removed_count": 0},
    }
    if diff:
        for tag, ch in diff["by_catalog"].items():
            latest_changes["by_catalog"][tag] = {
                "label": ch["label"],
                "added": ch["added"][:CHANGE_CAP],
                "removed": ch["removed"][:CHANGE_CAP],
                "added_count": ch["added_count"],
                "removed_count": ch["removed_count"],
                "added_truncated": max(0, ch["added_count"] - CHANGE_CAP),
                "removed_truncated": max(0, ch["removed_count"] - CHANGE_CAP),
            }
        latest_changes["all"] = {
            "added": diff["all"]["added"][:CHANGE_CAP],
            "removed": diff["all"]["removed"][:CHANGE_CAP],
            "added_count": diff["all"]["added_count"],
            "removed_count": diff["all"]["removed_count"],
            "added_truncated": max(0, diff["all"]["added_count"] - CHANGE_CAP),
            "removed_truncated": max(0, diff["all"]["removed_count"] - CHANGE_CAP),
        }

    payload = {
        "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "snapshot_date": day,
        "catalog_count": len(catalog_summaries),
        "total_entries": total_entries,
        "unique_games": len(unique),
        "catalogs": catalog_summaries,
        "history": build_history(day_files),
        "latest_changes": latest_changes,
        "modifications": build_modifications(day_files),
        "_note": "Built by scripts/build_gdb_stats.py. Live UI may also refresh counts via game-db-search.js.",
    }
    return payload


def main() -> int:
    parser = argparse.ArgumentParser(description="Snapshot GDB catalogs → docs/gdb_stats.json")
    parser.add_argument("--out", type=Path, default=OUTPUT_JSON)
    parser.add_argument(
        "--date",
        default="",
        help="UTC day YYYY-MM-DD (default: today UTC)",
    )
    args = parser.parse_args()

    day = args.date.strip() or datetime.now(timezone.utc).strftime("%Y-%m-%d")
    print(f"Snapshotting game databases for {day}…")
    catalogs = snapshot_catalogs()

    days_dir = ARCHIVE_ROOT / "days"
    days_dir.mkdir(parents=True, exist_ok=True)
    day_path = days_dir / f"{day}.json"
    day_payload = {
        "date": day,
        "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "catalogs": catalogs,
    }
    day_path.write_text(json.dumps(day_payload, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"Wrote {day_path}")

    day_files = list_day_files()
    prev = None
    for path in day_files:
        if path.stem < day:
            prev = path
    diff = None
    if prev is not None:
        print(f"Diffing against {prev.name}…")
        prev_data = load_day(prev)
        diff = diff_catalogs(prev_data, catalogs)
    else:
        print("No previous day archive — recording baseline (no adds/removes yet).")

    summary = write_summary(day, catalogs, day_files, diff)
    args.out.write_text(json.dumps(summary, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")

    index = {
        "updated_at": summary["generated_at"],
        "latest_day": day,
        "days": [p.stem for p in day_files],
        "_note": "UTC-day snapshots of game database name lists for docs/stats/games/.",
    }
    ARCHIVE_ROOT.mkdir(parents=True, exist_ok=True)
    (ARCHIVE_ROOT / "index.json").write_text(
        json.dumps(index, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )

    print(
        f"Wrote {args.out} "
        f"({summary['catalog_count']} catalogs, {summary['total_entries']} entries, "
        f"{summary['unique_games']} unique names, {len(summary['history'])} history points)"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
