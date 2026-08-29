#!/usr/bin/env python3
"""Local GitHub webhook listener that runs the link-check pipeline on push to main."""

from __future__ import annotations

import argparse
import hashlib
import hmac
import json
import os
import sys
import threading
import traceback
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]

# Same path filter as .github/workflows/link_checker.yml
WATCH_PATH_PREFIXES = (
    "list.md",
    "unsorted.md",
    "unsorted_raw.txt",
    "scripts/link_checker.py",
    "scripts/convert_list_to_json.py",
    "scripts/update_link_check_meta.py",
    "scripts/update_unsorted_from_raw.py",
    "scripts/build_filter_stats.py",
    "scripts/build_gdb_stats.py",
    "scripts/release_schedule.py",
)

_run_lock = threading.Lock()
_last_result: dict[str, Any] | None = None


def load_dotenv(path: Path) -> None:
    if not path.is_file():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        os.environ.setdefault(key, value)


def verify_github_signature(secret: str, body: bytes, header_value: str | None) -> bool:
    if not secret:
        return False
    if not header_value or not header_value.startswith("sha256="):
        return False
    digest = header_value.split("=", 1)[1]
    expected = hmac.new(secret.encode("utf-8"), body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, digest)


def path_is_watched(path: str) -> bool:
    path = path.lstrip("./")
    return any(path == prefix or path.endswith("/" + prefix) for prefix in WATCH_PATH_PREFIXES)


def push_touches_watched_paths(payload: dict[str, Any]) -> bool:
    if payload.get("ref") != "refs/heads/main":
        return False
    for commit in payload.get("commits") or []:
        for bucket in ("added", "removed", "modified"):
            for path in commit.get(bucket) or []:
                if path_is_watched(path):
                    return True
    return False


def notify_discord(webhook_url: str, content: str) -> None:
    if not webhook_url:
        return
    data = json.dumps({"content": content[:1900]}).encode("utf-8")
    req = urllib.request.Request(
        webhook_url,
        data=data,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            resp.read()
        print("[webhook] Discord notification sent", flush=True)
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        print(f"[webhook] Discord notification failed: HTTP {exc.code} {body}", flush=True)
    except OSError as exc:
        print(f"[webhook] Discord notification failed: {exc}", flush=True)


def run_pipeline_job(trigger: str, payload: dict[str, Any]) -> dict[str, Any]:
    global _last_result
    print(f"[webhook] Starting pipeline (trigger={trigger})", flush=True)
    try:
        from run_link_check_pipeline import run_pipeline

        repo_root = Path(os.getenv("WEBHOOK_REPO_ROOT", str(ROOT))).resolve()
        pull = os.getenv("WEBHOOK_GIT_PULL", "1").strip().lower() not in {"0", "false", "no", "off"}
        push = os.getenv("WEBHOOK_GIT_PUSH", "1").strip().lower() not in {"0", "false", "no", "off"}
        result = run_pipeline(repo_root=repo_root, pull=pull, push=push)
        result["trigger"] = trigger
        sha = (((payload.get("head_commit") or {}).get("id")) or payload.get("after") or "")[:7]
        result["sha"] = sha
        _last_result = result

        if result.get("release_published"):
            msg = (
                f"Link check finished (`{sha}`): **{result['version']} {result['revision']}** — "
                f"purged **{result['removed']}** dead links, total **{result['total']}**"
            )
        else:
            msg = (
                f"Silent link check finished (`{sha}`): purged **{result['removed']}** dead links, "
                f"total **{result['total']}**"
            )
        msg += " — changes pushed to `main`" if result.get("committed") else " — no commit needed"
        notify_discord(os.getenv("DISCORD_WEBHOOK_URL", "").strip(), msg)
        print(f"[webhook] Pipeline done: {json.dumps(result)}", flush=True)
        return result
    except Exception as exc:
        err = {"ok": False, "error": str(exc), "trigger": trigger}
        _last_result = err
        notify_discord(
            os.getenv("DISCORD_WEBHOOK_URL", "").strip(),
            f"Link check **failed** ({trigger}): `{exc}`",
        )
        print("[webhook] Pipeline failed:", flush=True)
        traceback.print_exc()
        return err


class WebhookHandler(BaseHTTPRequestHandler):
    server_version = "ProxyListWebhook/1.0"

    def log_message(self, fmt: str, *args) -> None:
        print(f"[webhook] {self.address_string()} - {fmt % args}", flush=True)

    def _send_json(self, code: int, payload: dict[str, Any]) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:
        if self.path.rstrip("/") in {"/health", "/"}:
            self._send_json(
                200,
                {
                    "ok": True,
                    "service": "proxy-list-github-webhook",
                    "last_result": _last_result,
                },
            )
            return
        self._send_json(404, {"ok": False, "error": "not found"})

    def do_POST(self) -> None:
        if self.path.rstrip("/") != "/github/webhook":
            self._send_json(404, {"ok": False, "error": "not found"})
            return

        length = int(self.headers.get("Content-Length", "0") or "0")
        body = self.rfile.read(length)
        event = self.headers.get("X-GitHub-Event", "")
        delivery = self.headers.get("X-GitHub-Delivery", "")
        signature = self.headers.get("X-Hub-Signature-256")

        secret = os.getenv("GITHUB_WEBHOOK_SECRET", "").strip()
        if not verify_github_signature(secret, body, signature):
            self._send_json(401, {"ok": False, "error": "invalid signature"})
            return

        try:
            payload = json.loads(body.decode("utf-8"))
        except json.JSONDecodeError:
            self._send_json(400, {"ok": False, "error": "invalid json"})
            return

        if event == "ping":
            self._send_json(200, {"ok": True, "message": "pong", "zen": payload.get("zen")})
            return

        if event != "push":
            self._send_json(200, {"ok": True, "ignored": True, "event": event})
            return

        if not push_touches_watched_paths(payload):
            self._send_json(
                200,
                {"ok": True, "ignored": True, "reason": "push did not touch watched paths"},
            )
            return

        if not _run_lock.acquire(blocking=False):
            self._send_json(202, {"ok": True, "queued": False, "busy": True})
            return

        def worker() -> None:
            try:
                run_pipeline_job(f"github:{delivery or 'push'}", payload)
            finally:
                _run_lock.release()

        threading.Thread(target=worker, name="link-check-pipeline", daemon=True).start()
        self._send_json(202, {"ok": True, "accepted": True, "delivery": delivery})


def main() -> int:
    p = argparse.ArgumentParser(description="GitHub webhook server for proxy-list link checks.")
    p.add_argument("--host", default=os.getenv("WEBHOOK_HOST", "0.0.0.0"))
    p.add_argument("--port", type=int, default=int(os.getenv("WEBHOOK_PORT", "8787")))
    p.add_argument(
        "--env-file",
        type=Path,
        default=Path(os.getenv("WEBHOOK_ENV_FILE", ROOT / "deploy" / "webhook" / ".env")),
    )
    args = p.parse_args()

    load_dotenv(args.env_file)
    if not os.getenv("GITHUB_WEBHOOK_SECRET", "").strip():
        print("Missing GITHUB_WEBHOOK_SECRET (set in env or --env-file).", file=sys.stderr)
        return 1

    # Ensure scripts/ is importable when started from elsewhere.
    scripts_dir = str(ROOT / "scripts")
    if scripts_dir not in sys.path:
        sys.path.insert(0, scripts_dir)

    server = ThreadingHTTPServer((args.host, args.port), WebhookHandler)
    print(
        f"[webhook] Listening on http://{args.host}:{args.port}/github/webhook "
        f"(health: /health, repo={os.getenv('WEBHOOK_REPO_ROOT', str(ROOT))})",
        flush=True,
    )
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n[webhook] Shutting down", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
