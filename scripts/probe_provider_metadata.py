#!/usr/bin/env python3
"""Probe one URL per provider for category / capability / protocol signals.

Looks at HTML and linked JS for Scramjet, Ultraviolet, transports, captcha
hints, and game-database markers. Intended as a first pass before manual
browser verification of ambiguous cases.
"""

from __future__ import annotations

import json
import re
import ssl
import sys
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from urllib.parse import urljoin, urlsplit

IN = Path("/tmp/all_providers.json")
OUT = Path("/tmp/provider_probe_results.json")
UA = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36"
)
CTX = ssl.create_default_context()
TIMEOUT = 18
DELAY_BEFORE = 2.0  # seconds before first request to a host

PROTOCOL_SIGS = {
    "Scramjet": [
        r"scramjet",
        r"@mercuryworkshop/scramjet",
        r"scramjet\.controller",
        r"sj\.(?:bundle|client|shared)",
        r"/scramjet/",
    ],
    "Ultraviolet": [
        r"ultraviolet",
        r"@titaniumnetwork-dev/ultraviolet",
        r"UVServiceWorker",
        r"uv\.(?:bundle|config|handler|sw)\.js",
        r"/uv/",
        r"__uv\$",
    ],
    "Rammerhead": [r"rammerhead", r"/rammerhead"],
    "Eclipse": [r"eclipse[-_]?proxy", r"/eclipse/"],
    "Tor": [r"\btor\b.*onion", r"tor-proxy"],
}

CAP_SIGS = {
    "epoxy": [r"epoxy-tls", r"EpoxyClient", r"@mercuryworkshop/epoxy-tls", r"/epoxy"],
    "libcurl": [r"libcurl\.js", r"CurlTransport", r"@mercuryworkshop/libcurl", r"libcurl-transport"],
    "wisp": [r"wisp[-_]?client", r"wisp://", r"@mercuryworkshop/wisp", r"WispClient"],
    "bare": [r"bare[-_]?mux", r"BareClient", r"@tomphttp/bare", r"/bare/"],
    "captcha": [r"recaptcha", r"hcaptcha", r"turnstile", r"captcha"],
    "tab-cloak": [r"tab[-_ ]?cloak", r"cloakTab", r"panic[-_ ]?key", r"about:blank"],
    "panic": [r"panic[-_ ]?(?:key|button|url)", r"panicKey"],
}

GDB_SIGS = {
    "GDB:gn-math": [r"gn-math", r"gnmath", r"cdn\.jsdelivr\.net/gh/gn-math"],
    "GDB:selenite": [r"selenite", r"selenite\.cc"],
    "GDB:petezah": [r"petezah", r"PeteZah"],
    "GDB:duckmath": [r"duckmath"],
    "GDB:truffled": [r"truffled"],
    "GDB:lucide": [r"lucide.*games|/lucide/"],
    "GDB:luminsdk": [r"luminsdk", r"lumin[-_]?sdk", r"lumin\.json"],
    "GDB:ultimate-game-stash": [r"ultimate[-_ ]?game[-_ ]?stash", r"ugs[-_]?db"],
    "GDB:elite-games": [r"elite[-_]?games"],
    "GDB:Seraph": [r"seraph", r"Seraph"],
    "GDB:frogies-arcade": [r"frogies?[-_]?arcade", r"frogie"],
    "GDB:dogeub": [r"dogeub"],
    "GDB:space": [r"/assets/games\.json", r"space[-_]?games"],
    "GDB:boredom": [r"boredom"],
    "GDB:utopia": [r"utopia[-_]?education", r"utopia"],
    "GDB:unblockedzone": [r"unblockedzone"],
    "GDB:noahs-tutoring": [r"noahs?[-_]?tutoring"],
    "GDB:sdxp": [r"sdxp"],
    "GDB:ccported": [r"ccported"],
    "GDB:radon": [r"radon[-_]?games"],
    "GDB:fyinx": [r"fyinx"],
    "GDB:totally-science": [r"totally[-_]?science"],
    "GDB:chicken-kings-vault": [r"chicken[-_]?kings?[-_]?vault"],
}

GAMES_HINTS = [
    r"/games(?:\.json|/)",
    r"gamedb",
    r"game[-_]?list",
    r"catalog\.json",
    r"apps\.json",
    r"data/games",
    r"loadGames",
    r"gameframe",
]
PROXY_HINTS = [
    r"proxy",
    r"serviceworker",
    r"navigator\.serviceWorker",
    r"register.*(uv|scramjet|sw)",
    r"search.*url",
    r"omnibox",
    r"url[-_]?bar",
]


def fetch(url: str, referer: str | None = None) -> tuple[int, str, str, bytes]:
    headers = {
        "User-Agent": UA,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
    }
    if referer:
        headers["Referer"] = referer
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=TIMEOUT, context=CTX) as resp:
        data = resp.read(2_500_000)
        return resp.status, resp.geturl(), resp.headers.get_content_type() or "", data


def extract_script_srcs(html: str, base: str) -> list[str]:
    srcs = []
    for m in re.finditer(r"<script[^>]+src=[\"']([^\"']+)[\"']", html, re.I):
        srcs.append(urljoin(base, m.group(1)))
    # import maps / modulepreload
    for m in re.finditer(r"<link[^>]+href=[\"']([^\"']+\.js[^\"']*)[\"']", html, re.I):
        srcs.append(urljoin(base, m.group(1)))
    # de-dupe preserve order
    seen = set()
    out = []
    for s in srcs:
        if s in seen:
            continue
        seen.add(s)
        out.append(s)
    return out[:25]


def scan_text(blob: str) -> dict:
    low = blob
    found_proto = []
    found_caps = []
    found_gdb = []
    for name, pats in PROTOCOL_SIGS.items():
        if any(re.search(p, low, re.I) for p in pats):
            found_proto.append(name)
    for name, pats in CAP_SIGS.items():
        if any(re.search(p, low, re.I) for p in pats):
            found_caps.append(name)
    for name, pats in GDB_SIGS.items():
        if any(re.search(p, low, re.I) for p in pats):
            found_gdb.append(name)
    games = any(re.search(p, low, re.I) for p in GAMES_HINTS) or bool(found_gdb)
    proxy = any(re.search(p, low, re.I) for p in PROXY_HINTS) or bool(found_proto) or any(
        c in found_caps for c in ("epoxy", "libcurl", "wisp", "bare")
    )
    return {
        "protocols": found_proto,
        "capabilities": found_caps,
        "gdb": found_gdb,
        "games_hint": games,
        "proxy_hint": proxy,
    }


def infer_category(scan: dict, existing_cat: str) -> str:
    games = scan["games_hint"] or bool(scan["gdb"])
    proxy = scan["proxy_hint"] or bool(scan["protocols"])
    if games and proxy:
        return "Proxy/Games"
    if games and not proxy:
        return "Games"
    if proxy and not games:
        return "Proxy"
    # keep existing if we learned nothing useful
    if existing_cat and existing_cat.lower() not in {"pending", "-", ""}:
        return existing_cat
    return "pending"


def probe_one(entry: dict) -> dict:
    urls = [entry["sample"]] + list(entry.get("alts") or [])
    urls = urls[:3]
    time.sleep(DELAY_BEFORE)
    combined = ""
    final_url = ""
    status = None
    err = None
    fetched_scripts = 0
    for url in urls:
        try:
            status, final_url, ctype, data = fetch(url)
            if "html" not in ctype and not data[:200].lstrip().lower().startswith(b"<!DOCTYPE") and b"<html" not in data[:500].lower():
                # try next alt if this is clearly not a page
                if "svg" in ctype or data[:100].lstrip().startswith(b"<svg"):
                    continue
            text = data.decode("utf-8", errors="replace")
            combined += "\n" + text
            # fetch a few scripts from same origin / cdn
            for src in extract_script_srcs(text, final_url)[:12]:
                try:
                    host = (urlsplit(src).hostname or "").lower()
                    # skip huge analytics
                    if any(x in host for x in ("google-analytics", "googletagmanager", "facebook", "clarity.ms")):
                        continue
                    st, _, _, sdata = fetch(src, referer=final_url)
                    combined += "\n" + sdata.decode("utf-8", errors="replace")
                    fetched_scripts += 1
                except Exception:
                    continue
            break
        except Exception as exc:
            err = f"{type(exc).__name__}: {exc}"
            continue

    scan = scan_text(combined) if combined else {
        "protocols": [], "capabilities": [], "gdb": [], "games_hint": False, "proxy_hint": False
    }
    # Scramjet usually implies captcha works
    caps = list(scan["capabilities"])
    if "Scramjet" in scan["protocols"] and "captcha" not in caps:
        caps.append("captcha")
    # merge gdb into capabilities
    for g in scan["gdb"]:
        if g not in caps:
            caps.append(g)

    category = infer_category(scan, entry.get("category") or "")
    protocols = scan["protocols"][:]
    if category == "Games" and not protocols:
        protocols = ["N/A"]

    return {
        "name": entry["name"],
        "existing": {
            "category": entry.get("category"),
            "capabilities": entry.get("capabilities"),
            "protocols": entry.get("protocols"),
        },
        "probed_url": final_url or entry["sample"],
        "http_status": status,
        "error": err,
        "scripts_fetched": fetched_scripts,
        "detected": {
            "category": category,
            "capabilities": caps,
            "protocols": protocols,
            "gdb": scan["gdb"],
            "games_hint": scan["games_hint"],
            "proxy_hint": scan["proxy_hint"],
        },
        "needs_browser": (
            (not combined)
            or (category == "pending")
            or (
                (entry.get("category") or "").lower() in {"pending", "unknown"}
                and not protocols
                and not caps
            )
        ),
    }


def main() -> int:
    entries = json.loads(IN.read_text())
    # Prefer scanning pending/unknown first, but do all
    results = []
    # serial with delay to be polite; parallel would be faster but riskier
    # Use small pool with per-task delay already
    workers = 6
    print(f"Probing {len(entries)} providers with {workers} workers ( {DELAY_BEFORE}s delay each )...", flush=True)
    with ThreadPoolExecutor(max_workers=workers) as ex:
        futs = {ex.submit(probe_one, e): e["name"] for e in entries}
        done = 0
        for fut in as_completed(futs):
            done += 1
            try:
                r = fut.result()
            except Exception as exc:
                r = {"name": futs[fut], "error": str(exc), "needs_browser": True, "detected": {}}
            results.append(r)
            if done % 10 == 0 or done == len(entries):
                print(f"  {done}/{len(entries)}", flush=True)

    results.sort(key=lambda r: r.get("name", "").casefold())
    OUT.write_text(json.dumps(results, indent=2))
    need = [r for r in results if r.get("needs_browser")]
    changed = []
    for r in results:
        det = r.get("detected") or {}
        ex = r.get("existing") or {}
        if det.get("category") and det["category"] != "pending" and (
            (ex.get("category") or "").lower() in {"pending", "unknown", ""}
            or (ex.get("protocols") or "").lower() in {"pending", "unknown", "-", ""}
            or (ex.get("capabilities") or "").lower() in {"pending", "unknown", "-", ""}
        ):
            changed.append(r)
    print(f"Wrote {OUT}")
    print(f"needs_browser={len(need)} update_candidates={len(changed)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
