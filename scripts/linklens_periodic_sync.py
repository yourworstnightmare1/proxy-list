#!/usr/bin/env python3
"""Periodically sync gn-math summaries from Discord history.

Runs scripts/linklens_collector.py in --ingest-history mode at a fixed interval.
"""

from __future__ import annotations

import argparse
import os
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
COLLECTOR = ROOT / "scripts" / "linklens_collector.py"


def now_utc() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")


def build_collector_cmd(python_bin: str, history_limit: int) -> list[str]:
    return [
        python_bin,
        str(COLLECTOR),
        "--ingest-history",
        "--history-limit",
        str(history_limit),
    ]


def run_once(cmd: list[str], env: dict[str, str]) -> int:
    print(f"[{now_utc()}] Running: {' '.join(cmd)}")
    proc = subprocess.run(cmd, cwd=ROOT, env=env)
    print(f"[{now_utc()}] Exit code: {proc.returncode}")
    return proc.returncode


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Periodically sync gn-math summaries from Discord history.")
    p.add_argument(
        "--interval-seconds",
        type=int,
        default=int(os.getenv("GN_MATH_SYNC_INTERVAL_SECONDS", os.getenv("LINKLENS_SYNC_INTERVAL_SECONDS", "300"))),
    )
    p.add_argument(
        "--history-limit",
        type=int,
        default=int(os.getenv("GN_MATH_HISTORY_LIMIT", os.getenv("LINKLENS_HISTORY_LIMIT", "4000"))),
    )
    p.add_argument(
        "--python-bin",
        default=os.getenv("GN_MATH_PYTHON_BIN", os.getenv("LINKLENS_PYTHON_BIN", str(ROOT / ".venv" / "bin" / "python"))),
        help="Python executable used to run linklens_collector.py",
    )
    p.add_argument("--run-once", action="store_true", help="Run a single ingest and exit.")
    return p.parse_args()


def main() -> int:
    args = parse_args()
    if not COLLECTOR.is_file():
        print(f"Missing collector script: {COLLECTOR}", file=sys.stderr)
        return 1

    if not os.getenv("DISCORD_BOT_TOKEN"):
        print("Missing DISCORD_BOT_TOKEN in environment.", file=sys.stderr)
        return 1
    if not os.getenv("DISCORD_CHANNEL_ID"):
        print("Missing DISCORD_CHANNEL_ID in environment.", file=sys.stderr)
        return 1
    if not (os.getenv("GN_MATH_AUTHOR_NAMES") or os.getenv("LINKLENS_AUTHOR_NAMES")):
        print("Missing GN_MATH_AUTHOR_NAMES in environment (e.g. gn-math#8961).", file=sys.stderr)
        return 1

    interval = max(10, int(args.interval_seconds))
    history_limit = max(50, int(args.history_limit))
    cmd = build_collector_cmd(args.python_bin, history_limit)
    env = os.environ.copy()

    if args.run_once:
        return run_once(cmd, env)

    print(f"[{now_utc()}] Starting periodic sync every {interval}s (history-limit={history_limit})")
    print(f"[{now_utc()}] Press Ctrl+C to stop.")

    while True:
        run_once(cmd, env)
        time.sleep(interval)


if __name__ == "__main__":
    raise SystemExit(main())
