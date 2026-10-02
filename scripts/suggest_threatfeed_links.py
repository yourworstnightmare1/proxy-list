#!/usr/bin/env python3
"""Suggest new proxy URLs from 1NobleCyber/ThreatFeed that are not already on the list.

Issue #47 — https://github.com/1NobleCyber/ThreatFeed publishes refreshed S3,
Cloudfront, and generic proxy-host feeds. This script downloads those feeds,
expands domains into candidate URLs, and writes ones missing from
docs/submission_url_keys.json (and optionally list.md / unsorted.md).

Usage:
  python3 scripts/suggest_threatfeed_links.py
  python3 scripts/suggest_threatfeed_links.py --out /tmp/threatfeed_candidates.txt
  python3 scripts/suggest_threatfeed_links.py --feeds s3,cloudfront,generic --limit 200

These are discovery candidates only — always verify before adding to list.md.
"""

from __future__ import annotations

import argparse
import csv
import io
import json
import sys
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SUBMISSION_KEYS = ROOT / "docs" / "submission_url_keys.json"
DEFAULT_OUT = ROOT / "scripts" / "threatfeed_candidates.txt"

RAW_BASE = "https://raw.githubusercontent.com/1NobleCyber/ThreatFeed/main"
FEEDS = {
    "s3": f"{RAW_BASE}/S3_WebProxies/raw.csv",
    "cloudfront": f"{RAW_BASE}/Cloudfront_WebProxies/raw.csv",
    "generic": f"{RAW_BASE}/GenericWebProxy/raw.csv",
    # Afraid.org is a huge free-DNS dump with lots of noise; opt-in only.
    "afraid": f"{RAW_BASE}/Afraid_org/raw.csv",
}

UA = "proxy-list-threatfeed-suggest/1.0 (+https://github.com/yourworstnightmare1/proxy-list)"


def fetch_text(url: str, timeout: float = 60.0) -> str:
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "text/csv,*/*"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read().decode("utf-8", errors="replace")


def parse_domains(csv_text: str) -> list[str]:
    reader = csv.reader(io.StringIO(csv_text))
    out: list[str] = []
    for row in reader:
        if not row:
            continue
        cell = (row[0] or "").strip()
        if not cell or cell.casefold() in {"domain", "domains", "host", "hostname"}:
            continue
        # Strip accidental scheme/path
        cell = cell.replace("https://", "").replace("http://", "").split("/")[0].strip().strip(".")
        if cell and "." in cell:
            out.append(cell.casefold())
    return out


def expand_candidates(domain: str, feed: str) -> list[str]:
    """Expand a feed domain into likely working proxy entry URLs."""
    d = domain.strip().casefold()
    if not d:
        return []
    if feed == "s3":
        # Issue #47: S3 buckets usually serve the proxy at /index.html
        return [
            f"https://{d}/index.html",
            f"https://{d}/",
        ]
    if feed == "cloudfront":
        return [
            f"https://{d}/index.html",
            f"https://{d}/",
        ]
    # generic / afraid — try origin path; many return 301/302 to a real page
    return [f"https://{d}/"]


def load_existing_keys() -> set[str]:
    keys: set[str] = set()
    if SUBMISSION_KEYS.is_file():
        try:
            data = json.loads(SUBMISSION_KEYS.read_text(encoding="utf-8"))
            for k in data.get("keys") or []:
                keys.add(str(k).strip().rstrip("/").casefold())
        except (json.JSONDecodeError, OSError):
            pass
    # Also scan list.md / unsorted.md lightly for safety if keys file is stale
    for path in (ROOT / "list.md", ROOT / "unsorted.md"):
        if not path.is_file():
            continue
        for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
            if "http://" not in line and "https://" not in line:
                continue
            for part in line.split("|"):
                p = part.strip()
                if p.startswith("http://") or p.startswith("https://"):
                    keys.add(p.rstrip("/").casefold())
    return keys


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument(
        "--feeds",
        default="s3,cloudfront,generic",
        help="Comma-separated feed ids: s3,cloudfront,generic,afraid (default: s3,cloudfront,generic)",
    )
    ap.add_argument("--out", type=Path, default=DEFAULT_OUT, help=f"Output path (default: {DEFAULT_OUT})")
    ap.add_argument("--limit", type=int, default=0, help="Max candidates to write (0 = no limit)")
    ap.add_argument("--include-existing", action="store_true", help="Do not filter against current list keys")
    args = ap.parse_args()

    feed_ids = [f.strip().casefold() for f in args.feeds.split(",") if f.strip()]
    unknown = [f for f in feed_ids if f not in FEEDS]
    if unknown:
        print(f"Unknown feed id(s): {', '.join(unknown)}", file=sys.stderr)
        print(f"Known: {', '.join(sorted(FEEDS))}", file=sys.stderr)
        return 2

    existing = set() if args.include_existing else load_existing_keys()
    seen_urls: set[str] = set()
    candidates: list[tuple[str, str]] = []  # (url, feed)

    for feed_id in feed_ids:
        url = FEEDS[feed_id]
        print(f"Fetching {feed_id}: {url}", file=sys.stderr)
        try:
            text = fetch_text(url)
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            print(f"  failed: {exc}", file=sys.stderr)
            continue
        domains = parse_domains(text)
        print(f"  {len(domains)} domains", file=sys.stderr)
        for domain in domains:
            for cand in expand_candidates(domain, feed_id):
                key = cand.rstrip("/").casefold()
                if key in seen_urls:
                    continue
                seen_urls.add(key)
                if key in existing or cand.casefold() in existing:
                    continue
                # Also skip if bare origin already credited
                origin = f"https://{domain}".casefold()
                if origin in existing or (origin + "/") in existing:
                    continue
                candidates.append((cand, feed_id))

    if args.limit and args.limit > 0:
        candidates = candidates[: args.limit]

    args.out.parent.mkdir(parents=True, exist_ok=True)
    lines = [
        "# ThreatFeed discovery candidates (not yet verified)",
        "# Source: https://github.com/1NobleCyber/ThreatFeed",
        f"# Feeds: {', '.join(feed_ids)}",
        f"# Count: {len(candidates)}",
        "# Review each URL before adding to list.md / unsorted.md.",
        "",
    ]
    for cand, feed_id in candidates:
        lines.append(f"{cand}\t# {feed_id}")
    args.out.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"Wrote {len(candidates)} candidates to {args.out}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
