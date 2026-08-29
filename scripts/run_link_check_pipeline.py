#!/usr/bin/env python3
"""Run the same link-check + export + optional commit/push steps as CI."""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path

_SCRIPTS = Path(__file__).resolve().parent
if str(_SCRIPTS) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS))
from release_schedule import commit_message_for_run

ROOT = Path(__file__).resolve().parents[1]

GIT_ADD_PATHS = [
    "*.md",
    "docs/data.json",
    "docs/unsorted.json",
    "docs/contributor_link_totals.json",
    "docs/filter_stats.json",
    "docs/link_check_meta.json",
    "docs/link_check_snapshot.json",
    "link_status.json",
    "docs/gdb_stats.json",
    "docs/stats/archive/gdb_catalogs",
]

GIT_USER_NAME = "auto-link-bot"
GIT_USER_EMAIL = "bot@users.noreply.github.com"


def _run(cmd: list[str], *, cwd: Path, check: bool = True) -> subprocess.CompletedProcess:
    print(f"[pipeline] {' '.join(cmd)}", flush=True)
    return subprocess.run(cmd, cwd=cwd, check=check)


def read_commit_info(repo_root: Path) -> dict:
    defaults = {
        "version": "v0.0.0",
        "revision": "r0",
        "removed": "0",
        "total": "0",
        "release_published": False,
    }
    jp = repo_root / "commit_info.json"
    if jp.is_file():
        meta = json.loads(jp.read_text(encoding="utf-8"))
        out = dict(defaults)
        for key in ("version", "revision", "removed", "total"):
            val = meta.get(key)
            if val is not None:
                out[key] = str(val)
        if "release_published" in meta:
            out["release_published"] = bool(meta["release_published"])
        return out

    tp = repo_root / "commit_info.txt"
    if tp.is_file():
        raw = tp.read_text(encoding="utf-8").strip().replace("\r\n", "\n").replace("\r", "\n")
        parts = [x.strip() for x in raw.split("|")]
        if len(parts) >= 4:
            return {
                "version": parts[0] or defaults["version"],
                "revision": parts[1] or defaults["revision"],
                "removed": parts[2] or defaults["removed"],
                "total": parts[3] or defaults["total"],
                "release_published": False,
            }
    return defaults


def git_pull(repo_root: Path) -> None:
    _run(["git", "fetch", "origin", "main"], cwd=repo_root)
    _run(["git", "checkout", "main"], cwd=repo_root)
    _run(["git", "pull", "--ff-only", "origin", "main"], cwd=repo_root)


def git_commit_and_push(repo_root: Path, info: dict[str, str]) -> bool:
    _run(["git", "config", "user.name", GIT_USER_NAME], cwd=repo_root)
    _run(["git", "config", "user.email", GIT_USER_EMAIL], cwd=repo_root)
    _run(["git", "add", *GIT_ADD_PATHS], cwd=repo_root)
    diff = subprocess.run(
        ["git", "diff", "--cached", "--quiet"],
        cwd=repo_root,
        check=False,
    )
    if diff.returncode == 0:
        print("[pipeline] No changes to commit", flush=True)
        return False

    message = commit_message_for_run(info)
    _run(["git", "commit", "-m", message], cwd=repo_root)
    _run(["git", "push", "origin", "main"], cwd=repo_root)
    return True


def run_pipeline(
    *,
    repo_root: Path | None = None,
    pull: bool = True,
    push: bool = True,
) -> dict:
    repo_root = (repo_root or ROOT).resolve()
    py = sys.executable

    if pull:
        git_pull(repo_root)

    link_checker = _run([py, "scripts/link_checker.py"], cwd=repo_root, check=False)
    _run([py, "scripts/update_unsorted_from_raw.py"], cwd=repo_root)
    _run([py, "scripts/update_link_check_meta.py"], cwd=repo_root)
    _run([py, "scripts/convert_list_to_json.py"], cwd=repo_root)
    _run([py, "scripts/build_filter_stats.py"], cwd=repo_root)
    _run([py, "scripts/build_gdb_stats.py"], cwd=repo_root, check=False)

    info = read_commit_info(repo_root)
    committed = False
    if push:
        committed = git_commit_and_push(repo_root, info)

    return {
        "ok": link_checker.returncode == 0,
        "link_checker_exit": link_checker.returncode,
        "committed": committed,
        **info,
    }


def main() -> int:
    p = argparse.ArgumentParser(description="Run local link-check pipeline (mirrors GitHub Actions).")
    p.add_argument("--repo-root", type=Path, default=ROOT, help="Repository root (default: repo root).")
    p.add_argument("--no-pull", action="store_true", help="Skip git pull before running.")
    p.add_argument("--no-push", action="store_true", help="Skip git commit/push after running.")
    p.add_argument(
        "--publish-release",
        action="store_true",
        help="Bump revision and Last Updated in list.md (Sunday release).",
    )
    p.add_argument(
        "--silent",
        action="store_true",
        help="Never bump revision/Last Updated (silent maintenance).",
    )
    args = p.parse_args()

    if args.publish_release and args.silent:
        print("error: --publish-release and --silent are mutually exclusive", file=sys.stderr)
        return 2
    if args.publish_release:
        os.environ["LINK_CHECK_PUBLISH_RELEASE"] = "true"
    elif args.silent:
        os.environ["LINK_CHECK_PUBLISH_RELEASE"] = "silent"

    if os.getenv("WEBHOOK_GIT_PUSH", "1").strip().lower() in {"0", "false", "no", "off"}:
        push = False
    else:
        push = not args.no_push

    result = run_pipeline(repo_root=args.repo_root, pull=not args.no_pull, push=push)
    print(json.dumps(result, indent=2), flush=True)
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
