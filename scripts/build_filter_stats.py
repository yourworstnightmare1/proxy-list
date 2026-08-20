#!/usr/bin/env python3
"""Aggregate web-filter blocked/unblocked/warning counts for the stats page.

Joins sorted links from docs/data.json to docs/linklens.json using the same
lookup order as the main site (exact URL → domain:host → first domain signal).
Writes docs/filter_stats.json (small) so /stats/ does not need to load linklens.json.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parents[1]
DATA_JSON = ROOT / "docs" / "data.json"
LINKLENS_JSON = ROOT / "docs" / "linklens.json"
OUTPUT_JSON = ROOT / "docs" / "filter_stats.json"

STATUS_KEYS = ("blocked", "unblocked", "warning")


def clean_summary_text(value: object) -> str:
    s = str(value if value is not None else "")
    s = s.replace("**", "")
    s = re.sub(r"\s{2,}", " ", s).strip()
    return s


def normalize_filter_key(value: object) -> str:
    return re.sub(r"[^a-z0-9]+", "", clean_summary_text(value).lower())


def canonical_provider_label(raw: object) -> str:
    s = clean_summary_text(raw)
    if not s:
        return ""
    s = re.sub(r"[\s\uFEFF]*(?:⚠️|⚠)\s*$", "", s).strip()
    while re.search(r"\([^)]*\)\s*$", s):
        s = re.sub(r"\s*\([^)]*\)\s*$", "", s).strip()
    return s


def domain_of(link: str) -> str:
    try:
        return urlparse(link).hostname.lower() if link else ""
    except Exception:
        return ""


def lens_has_signal(entry: object) -> bool:
    if not isinstance(entry, dict):
        return False
    summary = entry.get("summary") or {}
    try:
        total = int(summary.get("total") or 0)
    except (TypeError, ValueError):
        total = 0
    providers = entry.get("providers") if isinstance(entry.get("providers"), list) else []
    return total > 0 or len(providers) > 0 or entry.get("status") == "ok"


def rebuild_domain_index(linklens: dict) -> dict[str, dict]:
    first: dict[str, dict] = {}
    for entry in linklens.values():
        if not isinstance(entry, dict):
            continue
        d = str(entry.get("domain") or "").lower()
        if not d or d in first:
            continue
        if lens_has_signal(entry):
            first[d] = entry
    return first


def summary_entry_for(link: str, linklens: dict, domain_first: dict[str, dict]) -> dict | None:
    by_exact = linklens.get(link)
    if lens_has_signal(by_exact):
        return by_exact  # type: ignore[return-value]
    domain = domain_of(link)
    if not domain:
        return by_exact if isinstance(by_exact, dict) else None
    by_domain = linklens.get("domain:" + domain) or linklens.get(domain)
    if lens_has_signal(by_domain):
        return by_domain  # type: ignore[return-value]
    from_scan = domain_first.get(domain)
    if isinstance(from_scan, dict):
        return from_scan
    if isinstance(by_exact, dict):
        return by_exact
    if isinstance(by_domain, dict):
        return by_domain
    return None


def normalize_status(raw: object) -> str:
    s = clean_summary_text(raw).lower()
    if s in STATUS_KEYS:
        return s
    if s in ("block", "deny", "denied"):
        return "blocked"
    if s in ("allow", "allowed", "ok", "pass"):
        return "unblocked"
    if s in ("warn", "caution"):
        return "warning"
    return ""


def empty_status_counts() -> dict[str, int]:
    return {k: 0 for k in STATUS_KEYS}


def load_sorted_links(path: Path) -> list[dict]:
    raw = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(raw, dict):
        return [row for row in raw if isinstance(row, dict)] if isinstance(raw, list) else []
    links = raw.get("links")
    if not isinstance(links, list):
        return []
    if raw.get("format") == 2 or (links and isinstance(links[0], list)):
        providers = raw.get("providers") or []
        out: list[dict] = []
        for entry in links:
            if not isinstance(entry, list) or len(entry) < 3:
                continue
            pi, _ci, link = entry[0], entry[1], entry[2]
            provider = ""
            if isinstance(pi, int) and 0 <= pi < len(providers):
                provider = str((providers[pi] or {}).get("name") or "")
            out.append({"link": str(link or ""), "provider": provider})
        return out
    return [row for row in links if isinstance(row, dict)]


def aggregate(links: list[dict], linklens: dict) -> dict:
    domain_first = rebuild_domain_index(linklens)
    filters: dict[str, dict] = {}
    # reason -> {count, by_filter: {filter: count}} for blocked only
    reasons: dict[str, dict] = {}
    # domain -> blocked/unblocked/warning + unique filters that blocked it
    domains: dict[str, dict] = {}

    checked = 0
    unchecked = 0
    with_providers = 0

    for row in links:
        link = str((row or {}).get("link") or "").strip()
        if not link:
            continue
        entry = summary_entry_for(link, linklens, domain_first)
        providers = entry.get("providers") if isinstance(entry, dict) else None
        if not isinstance(providers, list) or not providers:
            unchecked += 1
            continue
        checked += 1
        with_providers += 1

        domain = domain_of(link)
        if not domain and isinstance(entry, dict):
            domain = str(entry.get("domain") or "").lower()
        if domain.startswith("www."):
            domain = domain[4:]

        # One status per canonical filter per link (last wins if duplicates).
        per_link: dict[str, tuple[str, str, str]] = {}
        for p in providers:
            if not isinstance(p, dict):
                continue
            label = canonical_provider_label(p.get("provider"))
            key = normalize_filter_key(label)
            if not key:
                continue
            status = normalize_status(p.get("status"))
            if not status:
                continue
            category = clean_summary_text(p.get("category")) or "Uncategorized"
            per_link[key] = (label, status, category)

        if domain:
            dslot = domains.get(domain)
            if not dslot:
                dslot = {
                    "domain": domain,
                    "links": 0,
                    **empty_status_counts(),
                    "filters_blocking": set(),
                }
                domains[domain] = dslot
            dslot["links"] += 1

        for key, (label, status, category) in per_link.items():
            slot = filters.get(key)
            if not slot:
                slot = {"name": label, "key": key, **empty_status_counts(), "total": 0}
                filters[key] = slot
            slot[status] += 1
            slot["total"] += 1
            if domain:
                dslot[status] += 1
                if status == "blocked":
                    dslot["filters_blocking"].add(label)
            if status == "blocked":
                r = reasons.get(category)
                if not r:
                    r = {"reason": category, "count": 0, "by_filter": defaultdict(int)}
                    reasons[category] = r
                r["count"] += 1
                r["by_filter"][label] += 1

    filter_list = sorted(filters.values(), key=lambda f: (-int(f["blocked"]), -int(f["total"]), f["name"].lower()))
    reason_list = []
    for r in reasons.values():
        by_filter = [
            {"name": name, "count": count}
            for name, count in sorted(r["by_filter"].items(), key=lambda kv: (-kv[1], kv[0].lower()))
        ]
        reason_list.append({"reason": r["reason"], "count": int(r["count"]), "by_filter": by_filter})
    reason_list.sort(key=lambda x: (-x["count"], x["reason"].lower()))

    domain_list = []
    for d in domains.values():
        blocking = sorted(d["filters_blocking"])
        domain_list.append(
            {
                "domain": d["domain"],
                "links": int(d["links"]),
                "blocked": int(d["blocked"]),
                "unblocked": int(d["unblocked"]),
                "warning": int(d["warning"]),
                "filters_blocking": len(blocking),
                "blocking_filters": blocking,
            }
        )
    domain_list.sort(
        key=lambda x: (-x["blocked"], -x["filters_blocking"], -x["links"], x["domain"])
    )

    return {
        "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "sorted_links": len(links),
        "links_with_filter_data": checked,
        "links_without_filter_data": unchecked,
        "filter_count": len(filter_list),
        "filters": filter_list,
        "block_reasons": reason_list,
        "blocked_domains": domain_list[:100],
    }


def main() -> int:
    p = argparse.ArgumentParser(description="Build docs/filter_stats.json from data.json + linklens.json")
    p.add_argument("--data", type=Path, default=DATA_JSON)
    p.add_argument("--linklens", type=Path, default=LINKLENS_JSON)
    p.add_argument("--out", type=Path, default=OUTPUT_JSON)
    args = p.parse_args()

    if not args.data.is_file():
        print(f"Missing {args.data}", file=sys.stderr)
        return 1
    if not args.linklens.is_file():
        print(f"Missing {args.linklens}", file=sys.stderr)
        return 1

    print(f"Loading {args.data}…")
    links = load_sorted_links(args.data)
    print(f"Loading {args.linklens}…")
    linklens = json.loads(args.linklens.read_text(encoding="utf-8"))
    if not isinstance(linklens, dict):
        print("linklens.json must be an object", file=sys.stderr)
        return 1

    print(f"Aggregating {len(links)} sorted links against {len(linklens)} lens entries…")
    payload = aggregate(links, linklens)
    args.out.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(
        f"Wrote {args.out} "
        f"({payload['filter_count']} filters, {len(payload['block_reasons'])} block reasons, "
        f"{len(payload.get('blocked_domains') or [])} top blocked domains, "
        f"{payload['links_with_filter_data']} checked / {payload['links_without_filter_data']} unchecked)"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
