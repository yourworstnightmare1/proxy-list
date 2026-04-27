#!/usr/bin/env python3
"""Rebuild web data and refresh links.txt for macro checking.

This script:
1) Rebuilds docs/data.json from list.md
2) Regenerates links.txt (unique sorted links)
3) Prints unchecked-link stats against docs/linklens.json
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parents[1]
CONVERT_SCRIPT = ROOT / "scripts" / "convert_list_to_json.py"
DATA_JSON = ROOT / "docs" / "data.json"
LINKLENS_JSON = ROOT / "docs" / "linklens.json"
LINKS_TXT = ROOT / "links.txt"
DEFAULT_REPO_URL = "https://github.com/yourworstnightmare1/proxy-list"


def run_convert() -> None:
    result = subprocess.run([sys.executable, str(CONVERT_SCRIPT)], cwd=ROOT)
    if result.returncode != 0:
        raise SystemExit(result.returncode)


def normalize_domain(value: str) -> str:
    v = (value or "").strip().lower()
    if v.startswith("domain:"):
        v = v[7:]
    v = v.replace("https://", "").replace("http://", "")
    v = v.split("/", 1)[0].split("?", 1)[0].split("#", 1)[0]
    if v.startswith("www."):
        v = v[4:]
    return v


def domain_of_url(url: str) -> str:
    try:
        d = (urlparse(url).hostname or "").lower()
        if d.startswith("www."):
            d = d[4:]
        return d
    except Exception:
        return ""


def load_links() -> list[str]:
    payload = json.loads(DATA_JSON.read_text(encoding="utf-8"))
    rows = payload.get("links", [])
    out: list[str] = []
    seen: set[str] = set()
    for row in rows:
        if not isinstance(row, dict):
            continue
        link = str(row.get("link", "")).strip()
        if not link.startswith(("http://", "https://")):
            continue
        if link in seen:
            continue
        seen.add(link)
        out.append(link)
    return out


def write_links_txt(links: list[str]) -> None:
    LINKS_TXT.write_text("\n".join(links) + "\n", encoding="utf-8")


def load_checked_domains() -> set[str]:
    if not LINKLENS_JSON.is_file():
        return set()
    payload = json.loads(LINKLENS_JSON.read_text(encoding="utf-8"))
    checked: set[str] = set()
    for key, value in payload.items():
        if not isinstance(value, dict):
            continue
        summary = value.get("summary") or {}
        providers = value.get("providers") or []
        has_signal = (summary.get("total") or 0) > 0 or len(providers) > 0 or value.get("status") == "ok"
        if not has_signal:
            continue
        kd = normalize_domain(str(key))
        vd = normalize_domain(str(value.get("domain", "")))
        if kd:
            checked.add(kd)
        if vd:
            checked.add(vd)
    return checked


def main() -> int:
    if not CONVERT_SCRIPT.is_file():
        print(f"Missing script: {CONVERT_SCRIPT}", file=sys.stderr)
        return 1

    run_convert()
    links = load_links()
    write_links_txt(links)

    checked = load_checked_domains()
    unchecked = [u for u in links if (d := domain_of_url(u)) and d not in checked]

    print(f"Updated {LINKS_TXT} with {len(links)} links.")
    print(f"Checked domains in {LINKLENS_JSON.name}: {len(checked)}")
    print(f"Unchecked links remaining: {len(unchecked)}")
    if unchecked:
        preview = unchecked[:10]
        print("Next unchecked samples:")
        for u in preview:
            print(f" - {u}")

    maybe_send_discord_notification(len(unchecked))
    return 0


def maybe_send_discord_notification(unchecked_count: int) -> None:
    enabled = os.getenv("UNCHECKED_NOTIFY_DISCORD", "1").strip().lower()
    if enabled in {"0", "false", "no", "off"}:
        return
    if unchecked_count <= 0:
        return

    token = os.getenv("DISCORD_BOT_TOKEN", "").strip()
    channel_id = (
        os.getenv("DISCORD_NOTIFY_CHANNEL_ID", "").strip()
        or os.getenv("DISCORD_CHANNEL_ID", "").strip()
    )
    mention = os.getenv("DISCORD_NOTIFY_MENTION", "@xgamingwithjason").strip() or "@xgamingwithjason"
    repo_url = os.getenv("PROXY_LIST_REPO_URL", DEFAULT_REPO_URL).strip() or DEFAULT_REPO_URL

    if not token or not channel_id:
        print("Discord notification skipped (missing DISCORD_BOT_TOKEN or DISCORD_CHANNEL_ID).")
        return

    content = (
        f"{mention} ({unchecked_count}) unchecked links found! Please run the filter checker soon to keep the filters up to date.\n"
        f"{repo_url}"
    )
    payload = json.dumps({"content": content}).encode("utf-8")
    req = urllib.request.Request(
        f"https://discord.com/api/v10/channels/{channel_id}/messages",
        data=payload,
        headers={
            "Authorization": f"Bot {token}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            _ = resp.read()
        print(f"Sent Discord unchecked-links notification to channel {channel_id}.")
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        print(f"Discord notification failed: HTTP {exc.code} {body}", file=sys.stderr)
    except Exception as exc:
        print(f"Discord notification failed: {exc}", file=sys.stderr)


if __name__ == "__main__":
    raise SystemExit(main())
