#!/usr/bin/env python3
"""Collect gn-math style results from Discord into docs/linklens.json.

This script sends a command per URL/domain in a Discord channel, waits for the
response message (typically from another bot), parses provider verdict lines,
and stores normalized results keyed by URL.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import re
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

import discord

ROOT = Path(__file__).resolve().parents[1]
DATA_JSON = ROOT / "docs" / "data.json"
OUTPUT_JSON = ROOT / "docs" / "linklens.json"
CHECKED_DOMAINS_TXT = ROOT / "docs" / "checked_domains.txt"

STATUS_MAP = {"✅": "unblocked", "❌": "blocked", "⚠️": "warning"}
LINE_RE = re.compile(r"^\s*(?:[^\w\s]+)?\s*(.+?)(?:\s*\((.*?)\))?\s*([✅❌⚠️])\s*$")


def now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def safe_domain(url: str) -> str:
    try:
        return urlparse(url).hostname or ""
    except Exception:
        return ""


def normalize_domain_text(value: str) -> str:
    s = (value or "").strip().lower()
    s = re.sub(r"^https?://", "", s)
    s = re.sub(r"[/?#].*$", "", s)
    s = re.sub(r"^all\s+domain\s+", "", s)
    s = re.sub(r"^all\s+url\s+", "", s)
    s = re.sub(r"^www\.", "", s)
    return s


def extract_domains_from_text(text: str) -> list[str]:
    domains: set[str] = set()
    patterns = [
        r"(?:results\s+for\s+)(?:all\s+(?:domain|url)\s+)?((?:https?://)?[a-z0-9.-]+\.[a-z]{2,})",
        r"(?:/check\s+all\s+domain\s+)((?:https?://)?[a-z0-9.-]+\.[a-z]{2,})",
        r"(?:/check\s+all\s+url\s+)((?:https?://)?[a-z0-9.-]+\.[a-z]{2,})",
    ]
    lower_text = text.lower()
    for pat in patterns:
        for raw in re.findall(pat, lower_text):
            d = normalize_domain_text(raw)
            if d:
                domains.add(d)
    return sorted(domains)


def normalize_payload(payload: Any) -> list[dict[str, Any]]:
    if isinstance(payload, list):
        return [row for row in payload if isinstance(row, dict)]
    if isinstance(payload, dict):
        links = payload.get("links", [])
        if isinstance(links, list):
            return [row for row in links if isinstance(row, dict)]
    return []


def load_links(path: Path) -> list[str]:
    raw = json.loads(path.read_text(encoding="utf-8"))
    rows = normalize_payload(raw)
    out: list[str] = []
    seen: set[str] = set()
    for row in rows:
        link = str(row.get("link", "")).strip()
        if not link.startswith(("http://", "https://")):
            continue
        if link in seen:
            continue
        seen.add(link)
        out.append(link)
    return out


def load_existing(path: Path) -> dict[str, Any]:
    if not path.is_file():
        return {}
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return {}
    return payload if isinstance(payload, dict) else {}


def write_output(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def _atomic_write_text(path: Path, body: str) -> None:
    """Write text via temp file + rename so concurrent readers never see partial state."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(body, encoding="utf-8")
    os.replace(tmp, path)


def append_checked_domains(domains: list[str]) -> int:
    """Append new domains into docs/checked_domains.txt, preserving order and deduping.

    Always rewrites the whole file deduplicated, so even if entries somehow drifted
    out of sync (manual edits, prior buggy code, crashed collector run), this call
    self-heals the file.
    """
    seen: set[str] = set()
    ordered: list[str] = []
    if CHECKED_DOMAINS_TXT.is_file():
        for raw in CHECKED_DOMAINS_TXT.read_text(encoding="utf-8").splitlines():
            d = normalize_domain_text(raw)
            if d and d not in seen:
                seen.add(d)
                ordered.append(d)
    added = 0
    for raw in domains:
        d = normalize_domain_text(raw or "")
        if d and d not in seen:
            seen.add(d)
            ordered.append(d)
            added += 1
    body = "\n".join(ordered) + ("\n" if ordered else "")
    _atomic_write_text(CHECKED_DOMAINS_TXT, body)
    return added


def extract_message_text(message: discord.Message) -> str:
    chunks: list[str] = []
    if message.content:
        chunks.append(message.content)
    for embed in message.embeds:
        if embed.title:
            chunks.append(embed.title)
        if embed.description:
            chunks.append(embed.description)
        for field in embed.fields:
            chunks.append(field.name)
            chunks.append(field.value)
        if embed.footer and embed.footer.text:
            chunks.append(embed.footer.text)
    return "\n".join(chunks)


def parse_provider_lines(text: str) -> tuple[list[dict[str, str]], dict[str, int]]:
    def clean_field(value: str) -> str:
        cleaned = value.replace("**", "").strip()
        cleaned = re.sub(r"\s{2,}", " ", cleaned)
        return cleaned

    providers: list[dict[str, str]] = []
    summary = {"blocked": 0, "unblocked": 0, "warning": 0}
    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line:
            continue
        m = LINE_RE.match(line)
        if not m:
            continue
        name, category, icon = m.groups()
        status = STATUS_MAP.get(icon, "warning")
        summary[status] += 1
        providers.append(
            {
                "provider": clean_field(name),
                "category": clean_field(category or "Unknown"),
                "status": status,
                "icon": icon,
            }
        )
    return providers, summary


def is_stale(entry: dict[str, Any], max_age_days: float) -> bool:
    if max_age_days <= 0:
        return True
    checked = str(entry.get("checked_at", "")).strip()
    if not checked:
        return True
    try:
        dt = datetime.fromisoformat(checked.replace("Z", "+00:00"))
    except ValueError:
        return True
    age = datetime.now(timezone.utc) - dt.astimezone(timezone.utc)
    return age.total_seconds() > max_age_days * 86400


@dataclass
class Config:
    token: str
    channel_id: int
    command_template: str
    response_timeout: float
    min_delay: float
    max_links: int
    max_age_days: float
    target_author_id: int | None
    target_author_name: str | None
    target_author_names: set[str]
    dry_run: bool
    force: bool
    history_limit: int
    ingest_history: bool


class CollectorClient(discord.Client):
    def __init__(self, cfg: Config, links: list[str], output: dict[str, Any]) -> None:
        intents = discord.Intents.default()
        intents.guilds = True
        intents.messages = True
        intents.message_content = True
        super().__init__(intents=intents)
        self.cfg = cfg
        self.links = links
        self.output = output
        self.channel: discord.TextChannel | None = None
        self.updated = 0
        self.skipped = 0
        self.failed = 0

    def author_matches(self, msg: discord.Message) -> bool:
        if self.user and msg.author.id == self.user.id:
            return False
        if self.cfg.target_author_id is not None and msg.author.id != self.cfg.target_author_id:
            return False
        if self.cfg.target_author_name and str(msg.author) != self.cfg.target_author_name:
            return False
        if self.cfg.target_author_names and str(msg.author) not in self.cfg.target_author_names:
            return False
        return True

    async def ingest_history(self) -> None:
        assert self.channel is not None
        checked_at = now_iso()
        seen = 0
        matched = 0
        new_domains: list[str] = []
        async for msg in self.channel.history(limit=self.cfg.history_limit):
            seen += 1
            if not self.author_matches(msg):
                continue
            text = extract_message_text(msg)
            providers, summary = parse_provider_lines(text)
            if not providers:
                continue
            urls = sorted(set(re.findall(r"https?://[^\s|)]+", text)))
            domains = extract_domains_from_text(text)
            total = summary["blocked"] + summary["unblocked"] + summary["warning"]
            if not urls and not domains:
                continue
            matched += 1
            record = {
                "checked_at": checked_at,
                "status": "ok",
                "source_message_id": str(msg.id),
                "source_author_id": str(msg.author.id),
                "source_author": str(msg.author),
                "providers": providers,
                "summary": {**summary, "total": total},
                "raw_excerpt": text[:5000],
            }
            for url in urls:
                self.output[url] = {"url": url, "domain": safe_domain(url), **record}
                self.updated += 1
                d = safe_domain(url)
                if d:
                    new_domains.append(d)
            for domain in domains:
                self.output["domain:" + domain] = {"url": "", "domain": domain, **record}
                self.updated += 1
                new_domains.append(domain)
        write_output(OUTPUT_JSON, self.output)
        added = append_checked_domains(new_domains)
        print(
            f"History ingest done: scanned={seen} matched={matched} updated={self.updated} "
            f"checked_domains_added={added}"
        )

    async def on_ready(self) -> None:
        print(f"Connected as {self.user} ({self.user.id})")
        # Self-heal the checked_domains file on startup. If a previous run was
        # interrupted, or someone hand-edited the file, this drops any duplicate
        # rows so the resume baseline is clean before we append more.
        try:
            healed = append_checked_domains([])
            print(f"checked_domains.txt self-heal pass complete (added={healed}).")
        except Exception as exc:  # pragma: no cover - non-fatal
            print(f"checked_domains.txt self-heal failed: {exc}")
        ch = self.get_channel(self.cfg.channel_id)
        if not isinstance(ch, discord.TextChannel):
            try:
                fetched = await self.fetch_channel(self.cfg.channel_id)
            except discord.DiscordException as exc:
                print(f"Could not fetch channel {self.cfg.channel_id}: {exc}")
                await self.close()
                return
            if not isinstance(fetched, discord.TextChannel):
                print(f"Channel {self.cfg.channel_id} is not a text channel")
                await self.close()
                return
            ch = fetched
        self.channel = ch
        try:
            if self.cfg.ingest_history:
                await self.ingest_history()
            else:
                await self.run_collection()
        finally:
            write_output(OUTPUT_JSON, self.output)
            print(
                "Done:",
                f"updated={self.updated}",
                f"skipped={self.skipped}",
                f"failed={self.failed}",
                f"total={len(self.links)}",
            )
            await self.close()

    async def run_collection(self) -> None:
        assert self.channel is not None
        checked_at = now_iso()
        processed = 0
        for link in self.links:
            if 0 < self.cfg.max_links <= processed:
                break
            processed += 1

            domain = safe_domain(link)
            current = self.output.get(link, {})
            if not self.cfg.force and isinstance(current, dict) and not is_stale(current, self.cfg.max_age_days):
                self.skipped += 1
                continue

            command = self.cfg.command_template.format(url=link, domain=domain)
            print(f"[{processed}/{len(self.links)}] {domain or link}")
            if self.cfg.dry_run:
                self.skipped += 1
                print(f"  dry-run command: {command}")
                continue

            sent = await self.channel.send(command)

            def _check(msg: discord.Message) -> bool:
                if msg.channel.id != self.channel.id:
                    return False
                if msg.id == sent.id:
                    return False
                if not self.author_matches(msg):
                    return False
                text = extract_message_text(msg).lower()
                if domain and domain.lower() in text:
                    return True
                if link.lower() in text:
                    return True
                if msg.reference and msg.reference.message_id == sent.id:
                    return True
                return False

            try:
                reply = await self.wait_for("message", check=_check, timeout=self.cfg.response_timeout)
            except TimeoutError:
                self.failed += 1
                self.output[link] = {
                    "url": link,
                    "domain": domain,
                    "checked_at": checked_at,
                    "status": "timeout",
                    "error": f"No matching response in {self.cfg.response_timeout}s",
                    "providers": [],
                    "summary": {"blocked": 0, "unblocked": 0, "warning": 0, "total": 0},
                }
                write_output(OUTPUT_JSON, self.output)
                await asyncio.sleep(self.cfg.min_delay)
                continue

            text = extract_message_text(reply)
            providers, summary = parse_provider_lines(text)
            total = summary["blocked"] + summary["unblocked"] + summary["warning"]
            status = "ok" if total else "parsed_empty"
            self.output[link] = {
                "url": link,
                "domain": domain,
                "checked_at": checked_at,
                "status": status,
                "source_message_id": str(reply.id),
                "source_author_id": str(reply.author.id),
                "providers": providers,
                "summary": {**summary, "total": total},
                "raw_excerpt": text[:5000],
            }
            self.updated += 1
            write_output(OUTPUT_JSON, self.output)
            if status == "ok" and domain:
                append_checked_domains([domain])
            await asyncio.sleep(self.cfg.min_delay)


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Collect gn-math link safety summaries from Discord messages.")
    p.add_argument("--channel-id", type=int, default=int(os.getenv("DISCORD_CHANNEL_ID", "0") or "0"))
    p.add_argument("--token", default=os.getenv("DISCORD_BOT_TOKEN", ""))
    p.add_argument(
        "--command-template",
        default=os.getenv("GN_MATH_COMMAND_TEMPLATE", os.getenv("LINKLENS_COMMAND_TEMPLATE", "/check all url {domain}")),
    )
    p.add_argument(
        "--target-author-id",
        type=int,
        default=int(os.getenv("GN_MATH_AUTHOR_ID", os.getenv("LINKLENS_AUTHOR_ID", "0")) or "0"),
    )
    p.add_argument(
        "--target-author-name",
        default=os.getenv("GN_MATH_AUTHOR_NAME", os.getenv("LINKLENS_AUTHOR_NAME", "")),
    )
    p.add_argument(
        "--target-author-names",
        default=os.getenv("GN_MATH_AUTHOR_NAMES", os.getenv("LINKLENS_AUTHOR_NAMES", "")),
        help="Comma-separated author tags to accept, e.g. gn-math#8961",
    )
    p.add_argument(
        "--response-timeout",
        type=float,
        default=float(os.getenv("GN_MATH_RESPONSE_TIMEOUT", os.getenv("LINKLENS_RESPONSE_TIMEOUT", "35"))),
    )
    p.add_argument("--min-delay", type=float, default=float(os.getenv("GN_MATH_MIN_DELAY", os.getenv("LINKLENS_MIN_DELAY", "4.0"))))
    p.add_argument("--max-links", type=int, default=int(os.getenv("GN_MATH_MAX_LINKS", os.getenv("LINKLENS_MAX_LINKS", "0"))))
    p.add_argument(
        "--max-age-days",
        type=float,
        default=float(os.getenv("GN_MATH_MAX_AGE_DAYS", os.getenv("LINKLENS_MAX_AGE_DAYS", "7"))),
    )
    p.add_argument(
        "--history-limit",
        type=int,
        default=int(os.getenv("GN_MATH_HISTORY_LIMIT", os.getenv("LINKLENS_HISTORY_LIMIT", "200"))),
    )
    p.add_argument("--ingest-history", action="store_true", help="Parse existing summary messages from channel history.")
    p.add_argument("--force", action="store_true", help="Re-check links even if fresh in output file.")
    p.add_argument("--dry-run", action="store_true", help="Print commands without sending Discord messages.")
    return p.parse_args()


def validate_args(args: argparse.Namespace) -> Config:
    if not args.token:
        raise SystemExit("Missing Discord token. Set DISCORD_BOT_TOKEN or --token.")
    if not args.channel_id:
        raise SystemExit("Missing channel id. Set DISCORD_CHANNEL_ID or --channel-id.")
    return Config(
        token=args.token,
        channel_id=args.channel_id,
        command_template=args.command_template,
        response_timeout=max(5.0, args.response_timeout),
        min_delay=max(0.0, args.min_delay),
        max_links=max(0, args.max_links),
        max_age_days=max(0.0, args.max_age_days),
        target_author_id=args.target_author_id or None,
        target_author_name=(args.target_author_name or "").strip() or None,
        target_author_names={s.strip() for s in str(args.target_author_names or "").split(",") if s.strip()},
        dry_run=bool(args.dry_run),
        force=bool(args.force),
        history_limit=max(1, args.history_limit),
        ingest_history=bool(args.ingest_history),
    )


def main() -> int:
    args = parse_args()
    cfg = validate_args(args)
    if not DATA_JSON.is_file():
        raise SystemExit(f"Missing {DATA_JSON}. Run scripts/convert_list_to_json.py first.")
    links = load_links(DATA_JSON)
    if not links:
        raise SystemExit("No links found in docs/data.json")
    existing = load_existing(OUTPUT_JSON)
    client = CollectorClient(cfg, links, existing)
    client.run(cfg.token)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
