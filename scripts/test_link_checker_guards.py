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


def test_purge_cap_partial_purge_drains_backlog() -> None:
    """Over-cap healthy runs purge up to the cap instead of aborting forever."""
    urls = [f"https://example.com/u{i}" for i in range(100)]
    content = _table(urls)
    status = {lc.normalize_url(u): 2 for u in urls}
    results = {lc.normalize_url(u): False for u in urls}

    os.environ["LINK_CHECK_MAX_PURGE_ABS"] = "10"
    os.environ["LINK_CHECK_MAX_PURGE_RATIO"] = "1"
    os.environ["LINK_CHECK_MASS_FAIL_RATIO"] = "1.1"  # disable mass-fail for this case
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

    expect(guard.get("aborted") is False, f"expected no abort, got {guard}")
    expect(removed == 10, f"removed={removed}")
    expect(kept == 90, f"kept={kept}")
    # First 10 URLs purged; remainder kept with advanced failure counts.
    expect("| | https://example.com/u0 |" not in out, "first eligible URL should purge")
    expect("| | https://example.com/u10 |" in out, "over-cap URL should remain")
    expect(status[lc.normalize_url("https://example.com/u10")] == 3, "deferred count advances")
    expect(status[lc.normalize_url("https://example.com/u0")] == 3, "purged URL count still advanced")


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


def test_fern_s3_hold_skips_purge_and_streak() -> None:
    """During the Fern AWS outage hold, Fern-section S3 URLs are not purged."""
    urls = [
        "https://example.com/ok",
        "https://s3.amazonaws.com/angelfern/index.html",
        "https://angelfern.s3.amazonaws.com/index.html",
        "https://other-bucket.s3.amazonaws.com/index.html",  # not under Fern H1
    ]
    lines = [
        "# Proxy List",
        "",
        "# Other Provider",
        "| Locked | Link | Found Date | Username | Password | Contributor |",
        "| - | - | - | - | - | - |",
        f"| | {urls[0]} | 1/1/2026 | N/A | N/A | tester",
        f"| | {urls[3]} | 1/1/2026 | N/A | N/A | tester",
        "",
        "# 🪴 Fern",
        "| Locked | Link | Found Date | Username | Password | Contributor |",
        "| - | - | - | - | - | - |",
        f"| | {urls[1]} | 1/1/2026 | N/A | N/A | tester",
        f"| | {urls[2]} | 1/1/2026 | N/A | N/A | tester",
        "",
    ]
    content = "\n".join(lines) + "\n"
    status = {lc.normalize_url(u): 2 for u in urls}
    results = {lc.normalize_url(u): False for u in urls}
    before_fern = {
        lc.normalize_url(urls[1]): status[lc.normalize_url(urls[1])],
        lc.normalize_url(urls[2]): status[lc.normalize_url(urls[2])],
    }

    os.environ["LINK_CHECK_FERN_S3_HOLD_UNTIL"] = "2099-01-01T00:00:00+00:00"
    lc.MASS_FAIL_RATIO = 1.1
    lc.MAX_PURGE_ABS = 250
    lc.MAX_PURGE_RATIO = 1.0

    with tempfile.TemporaryDirectory() as td:
        old = Path.cwd()
        os.chdir(td)
        try:
            out, kept, removed, guard = lc.process(content, results, status)
        finally:
            os.chdir(old)
            os.environ["LINK_CHECK_FERN_S3_HOLD_UNTIL"] = "0"

    expect(guard.get("aborted") is False, f"unexpected abort {guard}")
    expect(urls[1] in out and urls[2] in out, "Fern S3 links must remain")
    expect(urls[3] not in out, "non-Fern S3 link should still purge")
    expect(urls[0] not in out, "dead non-S3 should purge")
    expect(removed == 2, f"removed={removed}")
    expect(status[lc.normalize_url(urls[1])] == before_fern[lc.normalize_url(urls[1])], "Fern streak frozen")
    expect(status[lc.normalize_url(urls[2])] == before_fern[lc.normalize_url(urls[2])], "Fern streak frozen")


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


def test_classify_status_soft_ok() -> None:
    expect(lc.classify_status(200) == "ok", "200")
    expect(lc.classify_status(301) == "ok", "301")
    expect(lc.classify_status(403) == "soft_ok", "403 should be reachable")
    expect(lc.classify_status(401) == "soft_ok", "401")
    expect(lc.classify_status(429) == "soft_ok", "429")
    expect(lc.classify_status(503) == "retry", "503")
    expect(lc.classify_status(404) == "fail", "404")
    expect(lc.classify_status(410) == "fail", "410")


def test_is_working_treats_soft_statuses_as_alive() -> None:
    class FakeResp:
        def __init__(self, code: int):
            self.status_code = code

        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

    class FakeSession:
        def __init__(self, code: int):
            self.code = code
            self.headers = {}

        def get(self, *args, **kwargs):
            return FakeResp(self.code)

        def headers(self):
            return {}

    # Patch thread-local session factory via module helper.
    original = lc._session
    try:
        for code in (403, 401, 429, 451):
            lc._session = lambda c=code: FakeSession(c)  # type: ignore[misc,assignment]
            expect(lc.is_working("https://example.com/blocked", attempts=1) is True, f"code {code}")
        lc._session = lambda: FakeSession(404)  # type: ignore[misc,assignment]
        expect(lc.is_working("https://example.com/missing", attempts=1) is False, "404")
    finally:
        lc._session = original


def main() -> int:
    # Disable the temporary Fern S3 hold by default so other cases stay quiet;
    # the dedicated hold test sets its own until-date.
    os.environ["LINK_CHECK_FERN_S3_HOLD_UNTIL"] = "0"
    try:
        test_purge_cap_partial_purge_drains_backlog()
        test_mass_fail_aborts()
        test_fern_s3_hold_skips_purge_and_streak()
        test_small_purge_still_works()
        test_classify_status_soft_ok()
        test_is_working_treats_soft_statuses_as_alive()
    finally:
        os.environ.pop("LINK_CHECK_FERN_S3_HOLD_UNTIL", None)
    print("ok")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
