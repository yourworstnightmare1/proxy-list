#!/usr/bin/env python3
"""Unit checks for link_checker purge safety rails."""

from __future__ import annotations

import os
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

import link_checker as lc  # noqa: E402


def _table(urls: list[str]) -> str:
    lines = [
        "# Proxy List",
        "",
        "# Provider",
        "> [!NOTE]",
        "> | Category | Capabilities | Protocol(s) | Links |",
        "> | - | - | - | - |",
        f"> | Games | N/A | N/A | {len(urls)} |",
        "",
        "| Locked | Link | Found Date | Username | Password | Contributor |",
        "| - | - | - | - | - | - |",
    ]
    for u in urls:
        lines.append(f"| | {u} | 1/1/2026 | N/A | N/A | tester")
    return "\n".join(lines) + "\n"


def expect(cond: bool, msg: str) -> None:
    if not cond:
        raise AssertionError(msg)


def test_purge_cap_aborts_without_mutating_status() -> None:
    urls = [f"https://example.com/u{i}" for i in range(100)]
    content = _table(urls)
    status = {lc.normalize_url(u): 2 for u in urls}
    results = {lc.normalize_url(u): False for u in urls}
    status_before = dict(status)

    os.environ["LINK_CHECK_MAX_PURGE_ABS"] = "10"
    os.environ["LINK_CHECK_MAX_PURGE_RATIO"] = "1"
    os.environ["LINK_CHECK_MASS_FAIL_RATIO"] = "1.1"  # disable mass-fail for this case
    # reload module constants that read env at import — patch directly
    lc.MAX_PURGE_ABS = 10
    lc.MAX_PURGE_RATIO = 1.0
    lc.MASS_FAIL_RATIO = 1.1

    with tempfile.TemporaryDirectory() as td:
        old = Path.cwd()
        os.chdir(td)
        try:
            out, kept, removed, guard = lc.process(content, results, status)
        finally:
            os.chdir(old)

    expect(guard.get("aborted") is True, "expected purge_cap abort")
    expect(guard.get("reason") == "purge_cap", f"unexpected reason {guard}")
    expect(removed == 0, "abort must not remove rows")
    expect(kept == 100, f"kept={kept}")
    expect(status == status_before, "status must be unchanged on abort")
    expect("| | https://example.com/u0 |" in out, "list content must remain")


def test_mass_fail_aborts() -> None:
    urls = [f"https://example.com/m{i}" for i in range(80)]
    content = _table(urls)
    status = {lc.normalize_url(u): 0 for u in urls}
    # 50% fail
    results = {lc.normalize_url(u): (i % 2 == 0) for i, u in enumerate(urls)}
    before = dict(status)

    lc.MASS_FAIL_RATIO = 0.25
    lc.MAX_PURGE_ABS = 1000
    lc.MAX_PURGE_RATIO = 1.0

    with tempfile.TemporaryDirectory() as td:
        old = Path.cwd()
        os.chdir(td)
        try:
            _out, kept, removed, guard = lc.process(content, results, status)
        finally:
            os.chdir(old)

    expect(guard.get("reason") == "mass_fail", f"unexpected {guard}")
    expect(removed == 0 and kept == 80, f"kept={kept} removed={removed}")
    expect(status == before, "status unchanged on mass fail")


def test_small_purge_still_works() -> None:
    urls = [f"https://example.com/ok{i}" for i in range(20)] + ["https://example.com/dead"]
    content = _table(urls)
    status = {lc.normalize_url(u): 0 for u in urls}
    status[lc.normalize_url("https://example.com/dead")] = 2
    results = {lc.normalize_url(u): True for u in urls}
    results[lc.normalize_url("https://example.com/dead")] = False

    lc.MASS_FAIL_RATIO = 0.25
    lc.MAX_PURGE_ABS = 250
    lc.MAX_PURGE_RATIO = 0.02

    with tempfile.TemporaryDirectory() as td:
        old = Path.cwd()
        os.chdir(td)
        try:
            out, kept, removed, guard = lc.process(content, results, status)
        finally:
            os.chdir(old)

    expect(guard.get("aborted") is False, f"unexpected abort {guard}")
    expect(removed == 1, f"removed={removed}")
    expect(kept == 20, f"kept={kept}")
    expect("https://example.com/dead" not in out, "dead link should be purged")


def main() -> int:
    test_purge_cap_aborts_without_mutating_status()
    test_mass_fail_aborts()
    test_small_purge_still_works()
    print("ok")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
