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

try:
    import certifi
except ImportError:
    certifi = None  # type: ignore[misc, assignment]

ROOT = Path(__file__).resolve().parents[1]
TOKEN_FILE = ROOT / ".token"
DATA_JSON = ROOT / "docs" / "data.json"
OUTPUT_JSON = ROOT / "docs" / "linklens.json"
CHECKED_DOMAINS_TXT = ROOT / "docs" / "checked_domains.txt"

STATUS_MAP = {"✅": "unblocked", "❌": "blocked", "⚠️": "warning", "⚠": "warning"}
LINE_RE = re.compile(r"^\s*(?:[^\w\s]+)?\s*(.+?)(?:\s*\((.*?)\))?\s*([✅❌⚠️⚠])\s*$")
# gn-math often ends lines with Discord custom emoji, e.g. <:blocked:1234567890>
DISCORD_VERDICT_TAIL = re.compile(r"<a?:([A-Za-z0-9_]+):(\d+)>\s*$")
# e.g. **StudentKeeper** ⏱️ Timed out  /  **Foo** Warning
TIMED_OUT_LINE_RE = re.compile(
    r"^\s*(?:\*\*)?(?:[^\w\s]+\s*)?([^*()\n]+?)(?:\*\*)?(?:\s*\((.*?)\))?\s*"
    r"(?:⏱️\s*)?(?:timed\s*out|timeout|warning)\s*$",
    re.IGNORECASE,
)
IBOSS_PROVIDER_RE = re.compile(r"^\s*iboss\s*$", re.IGNORECASE)


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


def _verdict_status_from_discord_emoji_name(e_name: str) -> str:
    n = (e_name or "").lower().replace("-", "_")
    if n == "blocked":
        return "blocked"
    if n == "unblocked":
        return "unblocked"
    if n in ("warning", "warn", "timeout", "error", "inconclusive"):
        return "warning"
    if n.startswith("unblock"):
        return "unblocked"
    if "block" in n and "unblock" not in n:
        return "blocked"
    return "warning"


def _parse_markdown_discord_verdict_line(line: str, clean_field) -> tuple[str, str, str, str] | None:
    m = DISCORD_VERDICT_TAIL.search(line)
    if not m:
        return None
    e_name = m.group(1)
    before = line[: m.start()].strip()
    mm = re.search(r"\*\*([^*]+)\*\*", before)
    if not mm:
        return None
    name = clean_field(mm.group(1))
    cat_raw = before[mm.end() :].strip()
    category = clean_field(cat_raw) if cat_raw else "Unknown"
    if category != "Unknown" and re.fullmatch(r"\([^()]+\)", category):
        category = category[1:-1].strip()
    status = _verdict_status_from_discord_emoji_name(e_name)
    return name, category, status, f":{e_name}:"


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
        # Normalize emoji+VS16 warning glyph so LINE_RE can match a single char.
        line_norm = line.replace("⚠️", "⚠")
        m = LINE_RE.match(line_norm)
        if m:
            name, category, icon = m.groups()
            status = STATUS_MAP.get(icon, "warning")
            if icon == "⚠":
                icon = "⚠️"
            summary[status] += 1
            providers.append(
                {
                    "provider": clean_field(name),
                    "category": clean_field(category or "Unknown"),
                    "status": status,
                    "icon": icon,
                }
            )
            continue
        dv = _parse_markdown_discord_verdict_line(line, clean_field)
        if dv:
            name, category, status, icon_repr = dv
            summary[status] += 1
            providers.append(
                {
                    "provider": name,
                    "category": category,
                    "status": status,
                    "icon": icon_repr,
                }
            )
            continue
        to = TIMED_OUT_LINE_RE.match(line)
        if to:
            name = clean_field(to.group(1))
            category = clean_field(to.group(2) or "Unknown")
            summary["warning"] += 1
            providers.append(
                {
                    "provider": name,
                    "category": category,
                    "status": "warning",
                    "icon": "⚠️",
                }
            )
    return providers, summary


def apply_words_md_overrides(domain: str, providers: list[dict[str, str]]) -> list[dict[str, str]]:
    """Apply .WORDS.md filter corrections after Discord ingest."""
    host = normalize_domain_text(domain or "")
    # Exact domain only: storage.googleapis.com + iBoss blocked → unblocked.
    if host != "storage.googleapis.com":
        return providers
    out: list[dict[str, str]] = []
    for row in providers:
        item = dict(row)
        if IBOSS_PROVIDER_RE.match(str(item.get("provider") or "")) and item.get("status") == "blocked":
            item["status"] = "unblocked"
            item["icon"] = "✅"
            item["_override"] = "words.md:iboss-storage-googleapis-unblocked"
        out.append(item)
    return out


def rebuild_summary(providers: list[dict[str, str]]) -> dict[str, int]:
    summary = {"blocked": 0, "unblocked": 0, "warning": 0}
    for row in providers:
        status = str(row.get("status") or "warning")
        if status not in summary:
            status = "warning"
        summary[status] += 1
    return summary


def finalize_providers(domain: str, providers: list[dict[str, str]]) -> tuple[list[dict[str, str]], dict[str, int]]:
    providers = apply_words_md_overrides(domain, providers)
    summary = rebuild_summary(providers)
    return providers, summary


def reparse_linklens_from_raw_excerpts(path: Path) -> tuple[int, int]:
    """Rebuild providers/summary from stored raw_excerpt (fixes older parses that missed <:blocked:> lines)."""
    data = load_existing(path)
    if not data:
        return 0, 0
    keys = 0
    updated = 0
    for _key, entry in data.items():
        if not isinstance(entry, dict):
            continue
        keys += 1
        raw = str(entry.get("raw_excerpt") or "").strip()
        if not raw:
            continue
        providers, summary = parse_provider_lines(raw)
        if not providers:
            continue
        total = summary["blocked"] + summary["unblocked"] + summary["warning"]
        entry["providers"] = providers
        entry["summary"] = {**summary, "total": total}
        entry["status"] = "ok" if total else "parsed_empty"
        updated += 1
    write_output(path, data)
    return updated, keys


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
        tag = str(msg.author)
        uname = getattr(msg.author, "name", "") or ""
        if self.cfg.target_author_name:
            want = self.cfg.target_author_name
            if tag != want and uname != want and uname != want.split("#", 1)[0]:
                return False
        if self.cfg.target_author_names:
            bare_allowed = {a.split("#", 1)[0] for a in self.cfg.target_author_names}
            if (
                tag not in self.cfg.target_author_names
                and uname not in self.cfg.target_author_names
                and uname not in bare_allowed
            ):
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
            targets: list[tuple[str, str]] = []
            for url in urls:
                targets.append((url, safe_domain(url)))
            for domain in domains:
                targets.append(("domain:" + domain, domain))
            for key, domain in targets:
                providers_final, summary_final = finalize_providers(domain, providers)
                total_final = (
                    summary_final["blocked"] + summary_final["unblocked"] + summary_final["warning"]
                )
                record = {
                    "checked_at": checked_at,
                    "status": "ok",
                    "source_message_id": str(msg.id),
                    "source_author_id": str(msg.author.id),
                    "source_author": str(msg.author),
                    "providers": providers_final,
                    "summary": {**summary_final, "total": total_final},
                    "raw_excerpt": text[:5000],
                }
                if key.startswith("domain:"):
                    self.output[key] = {"url": "", "domain": domain, **record}
                else:
                    self.output[key] = {"url": key, "domain": domain, **record}
                self.updated += 1
                if domain:
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
            providers, summary = finalize_providers(domain, providers)
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
            if domain:
                self.output["domain:" + domain] = {
                    "url": link if link.startswith(("http://", "https://")) else "",
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


def _discord_ssl_context():
    if not certifi:
        raise SystemExit(
            "REST Discord API calls require certifi (pip install certifi) for SSL certificates."
        )
    import ssl

    return ssl.create_default_context(cafile=certifi.where())


def _discord_api_json(method: str, path_with_query: str, token: str) -> Any:
    """Synchronous Discord REST call using stdlib + certifi (avoids broken aiohttp SSL on some Mac/Python installs)."""
    import time
    import urllib.error
    import urllib.request

    url = f"https://discord.com/api/v10{path_with_query}"
    req = urllib.request.Request(
        url,
        method=method,
        headers={
            "Authorization": f"Bot {token}",
            "User-Agent": "proxy-list-linklens-collector/1.0 (+https://github.com)",
        },
    )
    ctx = _discord_ssl_context()
    last_err: Exception | None = None
    for attempt in range(8):
        try:
            with urllib.request.urlopen(req, context=ctx, timeout=90) as resp:
                body = resp.read().decode("utf-8")
                if not body:
                    return None
                return json.loads(body)
        except urllib.error.HTTPError as exc:
            err_body = exc.read().decode("utf-8", errors="replace")[:500]
            if exc.code == 429:
                retry_after = 1.0
                try:
                    payload = json.loads(err_body)
                    retry_after = float(payload.get("retry_after") or 1.0)
                except Exception:
                    pass
                time.sleep(max(0.5, retry_after) + 0.25 * attempt)
                last_err = exc
                continue
            raise SystemExit(f"Discord HTTP {exc.code}: {err_body}") from exc
    raise SystemExit(f"Discord HTTP 429: rate limited after retries ({last_err})")


def discord_bot_user_id(token: str) -> int | None:
    data = _discord_api_json("GET", "/users/@me", token)
    if not isinstance(data, dict) or "id" not in data:
        return None
    try:
        return int(data["id"])
    except (TypeError, ValueError):
        return None


def fetch_channel_messages_rest(token: str, channel_id: int, max_messages: int) -> list[dict[str, Any]]:
    """Paginate GET /channels/{id}/messages (newest first per request; walk older with before=)."""
    out: list[dict[str, Any]] = []
    before: str | None = None
    while len(out) < max_messages:
        take = min(100, max_messages - len(out))
        q = f"/channels/{channel_id}/messages?limit={take}"
        if before:
            q += f"&before={before}"
        batch = _discord_api_json("GET", q, token)
        if not batch:
            break
        if not isinstance(batch, list):
            break
        out.extend(batch)
        if len(batch) < take:
            break
        before = str(batch[-1]["id"])
    return out[:max_messages]


def snowflake_to_iso_utc(sfid: str) -> str:
    ts = ((int(sfid) >> 22) + 1420070400000) / 1000.0
    return datetime.fromtimestamp(ts, tz=timezone.utc).replace(microsecond=0).isoformat().replace(
        "+00:00", "Z"
    )


def extract_api_message_text(msg: dict[str, Any]) -> str:
    chunks: list[str] = []
    if msg.get("content"):
        chunks.append(str(msg["content"]))
    for emb in msg.get("embeds") or []:
        if not isinstance(emb, dict):
            continue
        if emb.get("title"):
            chunks.append(str(emb["title"]))
        if emb.get("description"):
            chunks.append(str(emb["description"]))
        for field in emb.get("fields") or []:
            if not isinstance(field, dict):
                continue
            if field.get("name"):
                chunks.append(str(field["name"]))
            if field.get("value"):
                chunks.append(str(field["value"]))
        footer = emb.get("footer")
        if isinstance(footer, dict) and footer.get("text"):
            chunks.append(str(footer["text"]))
    return "\n".join(chunks)


def author_matches_api(author: dict[str, Any], cfg: Config, bot_user_id: int | None) -> bool:
    try:
        aid = int(author.get("id", 0))
    except (TypeError, ValueError):
        return False
    if bot_user_id is not None and aid == bot_user_id:
        return False
    if cfg.target_author_id is not None and aid != cfg.target_author_id:
        return False
    uname = str(author.get("username") or "").strip()
    disp = str(author.get("global_name") or "").strip()
    disc = str(author.get("discriminator") or "").strip()
    tag = f"{uname}#{disc}" if disc else uname
    if cfg.target_author_name:
        want = cfg.target_author_name.strip()
        if uname != want and disp != want and tag != want:
            return False
    if cfg.target_author_names:
        allowed = {s.strip() for s in cfg.target_author_names if s and s.strip()}
        # Accept username, display name, or username#discriminator forms.
        candidates = {uname, disp, tag}
        if disc:
            candidates.add(f"{uname}#{disc}")
        # Also allow bare username when allow-list uses Tag#1234 form
        bare_allowed = {a.split("#", 1)[0] for a in allowed if a}
        if not (candidates & allowed) and uname not in bare_allowed and disp not in bare_allowed:
            return False
    return True


def run_history_ingest_rest(cfg: Config, output: dict[str, Any]) -> None:
    """Import gn-math (or other bot) embed summaries from channel history without discord.py."""
    bot_id = discord_bot_user_id(cfg.token)
    msgs = fetch_channel_messages_rest(cfg.token, cfg.channel_id, cfg.history_limit)
    new_domains: list[str] = []
    seen = 0
    matched = 0
    updated = 0
    for msg in msgs:
        if not isinstance(msg, dict):
            continue
        seen += 1
        author = msg.get("author")
        if not isinstance(author, dict):
            continue
        if not author_matches_api(author, cfg, bot_id):
            continue
        text = extract_api_message_text(msg)
        providers, summary = parse_provider_lines(text)
        if not providers:
            continue
        urls = sorted(set(re.findall(r"https?://[^\s|)]+", text)))
        domains = extract_domains_from_text(text)
        if not urls and not domains:
            continue
        matched += 1
        checked_at = snowflake_to_iso_utc(str(msg.get("id", "0")))
        targets: list[tuple[str, str]] = []
        for url in urls:
            targets.append((url, safe_domain(url)))
        for domain in domains:
            targets.append(("domain:" + domain, domain))
        for key, domain in targets:
            providers_final, summary_final = finalize_providers(domain, providers)
            total_final = (
                summary_final["blocked"] + summary_final["unblocked"] + summary_final["warning"]
            )
            record = {
                "checked_at": checked_at,
                "status": "ok",
                "source_message_id": str(msg.get("id", "")),
                "source_author_id": str(author.get("id", "")),
                "source_author": str(author.get("username", ""))[:120],
                "providers": providers_final,
                "summary": {**summary_final, "total": total_final},
                "raw_excerpt": text[:5000],
            }
            if key.startswith("domain:"):
                output[key] = {"url": "", "domain": domain, **record}
            else:
                output[key] = {"url": key, "domain": domain, **record}
            updated += 1
            if domain:
                new_domains.append(domain)
    write_output(OUTPUT_JSON, output)
    added = append_checked_domains(new_domains)
    print(
        f"REST history ingest: http_messages={len(msgs)} scanned={seen} matched={matched} "
        f"rows_touched={updated} checked_domains_added={added}"
    )


def apply_dot_token_env() -> None:
    """Load Discord collector settings from .token into os.environ when unset.

    Supports simple KEY=value lines (optional double/single quotes), # comments,
    and blank lines — same layout as a minimal dotenv file.
    """
    if not TOKEN_FILE.is_file():
        return
    parsed: dict[str, str] = {}
    try:
        for raw in TOKEN_FILE.read_text(encoding="utf-8").splitlines():
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, rest = line.partition("=")
            key = key.strip()
            val = rest.strip()
            if (val.startswith('"') and val.endswith('"')) or (val.startswith("'") and val.endswith("'")):
                val = val[1:-1]
            parsed[key] = val
    except OSError:
        return
    for key, val in parsed.items():
        if not val.strip():
            continue
        if not (os.getenv(key) or "").strip():
            os.environ[key] = val.strip()


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
    p.add_argument(
        "--urls",
        default="",
        help="Comma-separated URLs/domains to check instead of all links from data.json.",
    )
    p.add_argument("--ingest-history", action="store_true", help="Parse existing summary messages from channel history.")
    p.add_argument(
        "--ingest-history-rest",
        action="store_true",
        help="Same as --ingest-history but uses Discord REST + certifi (no discord.py). Use if SSL to Discord fails.",
    )
    p.add_argument(
        "--reparse-from-raw",
        action="store_true",
        help="Rewrite providers/summary in linklens.json from each entry's raw_excerpt (no Discord).",
    )
    p.add_argument("--force", action="store_true", help="Re-check links even if fresh in output file.")
    p.add_argument("--dry-run", action="store_true", help="Print commands without sending Discord messages.")
    return p.parse_args()


def validate_args(args: argparse.Namespace) -> Config:
    if not args.token:
        raise SystemExit("Missing Discord token. Set DISCORD_BOT_TOKEN, --token, or DISCORD_BOT_TOKEN in .token.")
    if not args.channel_id:
        raise SystemExit("Missing channel id. Set DISCORD_CHANNEL_ID, --channel-id, or DISCORD_CHANNEL_ID in .token.")
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
    apply_dot_token_env()
    args = parse_args()
    if getattr(args, "ingest_history_rest", False) and args.ingest_history:
        raise SystemExit("Use only one of --ingest-history or --ingest-history-rest.")
    if args.reparse_from_raw:
        if not OUTPUT_JSON.is_file():
            raise SystemExit(f"Missing {OUTPUT_JSON}")
        updated, keys = reparse_linklens_from_raw_excerpts(OUTPUT_JSON)
        print(f"Reparse from raw_excerpt: updated={updated} linklens keys (scanned {keys} top-level keys).")
        return 0
    cfg = validate_args(args)
    if getattr(args, "ingest_history_rest", False):
        existing = load_existing(OUTPUT_JSON)
        run_history_ingest_rest(cfg, existing)
        return 0
    urls_arg = str(getattr(args, "urls", "") or "").strip()
    if urls_arg:
        links = []
        for part in urls_arg.split(","):
            item = part.strip()
            if not item:
                continue
            if item.startswith(("http://", "https://")):
                links.append(item)
            else:
                # Treat bare domain as https URL so command template + domain lookup work.
                links.append("https://" + normalize_domain_text(item))
        if not links:
            raise SystemExit("No valid URLs given via --urls")
    else:
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
