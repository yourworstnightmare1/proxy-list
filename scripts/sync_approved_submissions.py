#!/usr/bin/env python3
"""Publish approved Firestore link submissions into list.md (+ convert).

Sources (first that works):
  1. --json FILE   array of submission dicts (or {"docs":[...]})
  2. Firestore REST via FIREBASE_PROJECT_ID + FIREBASE_CLIENT_EMAIL + FIREBASE_PRIVATE_KEY
     (same names as the Cloudflare Worker), FIREBASE_SERVICE_ACCOUNT JSON, or
     GOOGLE_APPLICATION_CREDENTIALS

Idempotent: skips URLs already present in list.md. New providers get a section stub.

Examples:
  python scripts/sync_approved_submissions.py --json approved.json
  python scripts/sync_approved_submissions.py --dry-run
  python scripts/sync_approved_submissions.py --mark-published
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import re
import subprocess
import sys
import time
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
LIST_CLI = ROOT / "scripts" / "list_cli.py"
LIST_MD = ROOT / "list.md"
COLLECTION = "linkSubmissions"


def b64url(data: bytes | str) -> str:
    if isinstance(data, str):
        data = data.encode("utf-8")
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def load_service_account() -> dict[str, str] | None:
    path = os.environ.get("GOOGLE_APPLICATION_CREDENTIALS") or os.environ.get(
        "FIREBASE_SERVICE_ACCOUNT_FILE"
    )
    raw_json = os.environ.get("FIREBASE_SERVICE_ACCOUNT") or os.environ.get(
        "FIREBASE_SERVICE_ACCOUNT_JSON"
    )
    if raw_json:
        return json.loads(raw_json)
    if path and Path(path).is_file():
        return json.loads(Path(path).read_text(encoding="utf-8"))
    project = os.environ.get("FIREBASE_PROJECT_ID")
    email = os.environ.get("FIREBASE_CLIENT_EMAIL")
    key = os.environ.get("FIREBASE_PRIVATE_KEY")
    if project and email and key:
        return {
            "project_id": project,
            "client_email": email,
            "private_key": key.replace("\\n", "\n"),
        }
    return None


def rsa_sign_pkcs1_sha256(pem: str, message: bytes) -> bytes:
    try:
        from cryptography.hazmat.primitives import hashes, serialization
        from cryptography.hazmat.primitives.asymmetric import padding

        key = serialization.load_pem_private_key(pem.encode("utf-8"), password=None)
        return key.sign(message, padding.PKCS1v15(), hashes.SHA256())
    except ImportError:
        pass

    import tempfile

    with tempfile.NamedTemporaryFile("w", suffix=".pem", delete=False, encoding="utf-8") as kf:
        kf.write(pem)
        key_path = kf.name
    with tempfile.NamedTemporaryFile("wb", delete=False) as mf:
        mf.write(message)
        msg_path = mf.name
    sig_path = msg_path + ".sig"
    try:
        subprocess.run(
            ["openssl", "dgst", "-sha256", "-sign", key_path, "-out", sig_path, msg_path],
            check=True,
            capture_output=True,
        )
        return Path(sig_path).read_bytes()
    finally:
        for p in (key_path, msg_path, sig_path):
            try:
                os.unlink(p)
            except OSError:
                pass


def google_access_token(sa: dict[str, str]) -> str:
    now = int(time.time())
    header = b64url(json.dumps({"alg": "RS256", "typ": "JWT"}, separators=(",", ":")))
    claim = b64url(
        json.dumps(
            {
                "iss": sa["client_email"],
                "sub": sa["client_email"],
                "aud": "https://oauth2.googleapis.com/token",
                "iat": now,
                "exp": now + 3600,
                "scope": "https://www.googleapis.com/auth/datastore",
            },
            separators=(",", ":"),
        )
    )
    unsigned = f"{header}.{claim}".encode("ascii")
    sig = b64url(rsa_sign_pkcs1_sha256(sa["private_key"], unsigned))
    jwt = f"{header}.{claim}.{sig}"
    body = urllib.parse.urlencode(
        {
            "grant_type": "urn:ietf:params:oauth:grant-type:jwt-bearer",
            "assertion": jwt,
        }
    ).encode("utf-8")
    req = urllib.request.Request(
        "https://oauth2.googleapis.com/token",
        data=body,
        headers={"Content-Type": "application/x-www-form-urlencoded"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=60) as resp:
        payload = json.loads(resp.read().decode("utf-8"))
    token = payload.get("access_token")
    if not token:
        raise RuntimeError(f"token response missing access_token: {payload}")
    return token


def fs_val(v: dict[str, Any]) -> Any:
    if "stringValue" in v:
        return v["stringValue"]
    if "booleanValue" in v:
        return v["booleanValue"]
    if "integerValue" in v:
        return int(v["integerValue"])
    if "doubleValue" in v:
        return float(v["doubleValue"])
    if "timestampValue" in v:
        return v["timestampValue"]
    if "nullValue" in v:
        return None
    return None


def firestore_doc_to_submission(doc: dict[str, Any]) -> dict[str, Any]:
    name = doc.get("name", "")
    doc_id = name.rsplit("/", 1)[-1]
    fields = doc.get("fields") or {}
    data = {k: fs_val(v) for k, v in fields.items()}
    data["id"] = doc_id
    data["_name"] = name
    return data


def firestore_run_query(sa: dict[str, str], status: str = "approved") -> list[dict[str, Any]]:
    project = sa["project_id"]
    token = google_access_token(sa)
    url = (
        f"https://firestore.googleapis.com/v1/projects/{project}"
        f"/databases/(default)/documents:runQuery"
    )
    query = {
        "structuredQuery": {
            "from": [{"collectionId": COLLECTION}],
            "where": {
                "fieldFilter": {
                    "field": {"fieldPath": "status"},
                    "op": "EQUAL",
                    "value": {"stringValue": status},
                }
            },
            "limit": 500,
        }
    }
    req = urllib.request.Request(
        url,
        data=json.dumps(query).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=120) as resp:
        rows = json.loads(resp.read().decode("utf-8"))
    out: list[dict[str, Any]] = []
    for row in rows:
        doc = row.get("document")
        if not doc:
            continue
        out.append(firestore_doc_to_submission(doc))
    return out


def firestore_patch_published(sa: dict[str, str], doc_id: str) -> None:
    project = sa["project_id"]
    token = google_access_token(sa)
    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    url = (
        f"https://firestore.googleapis.com/v1/projects/{project}/databases/(default)/"
        f"documents/{COLLECTION}/{urllib.parse.quote(doc_id, safe='')}"
        f"?updateMask.fieldPaths=publishedToList&updateMask.fieldPaths=publishedAt"
    )
    body = {
        "fields": {
            "publishedToList": {"booleanValue": True},
            "publishedAt": {"timestampValue": now},
        }
    }
    req = urllib.request.Request(
        url,
        data=json.dumps(body).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        },
        method="PATCH",
    )
    with urllib.request.urlopen(req, timeout=60) as resp:
        resp.read()


def load_json_submissions(path: Path) -> list[dict[str, Any]]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    if isinstance(payload, list):
        return payload
    if isinstance(payload, dict):
        for key in ("docs", "documents", "submissions", "entries"):
            if isinstance(payload.get(key), list):
                return payload[key]
    raise SystemExit(f"unrecognized JSON shape in {path}")


def normalize_url(url: str) -> str:
    return (url or "").strip()


def urls_in_list() -> set[str]:
    text = LIST_MD.read_text(encoding="utf-8")
    found: set[str] = set()
    for m in re.finditer(r"https?://[^\s|]+", text):
        u = m.group(0).rstrip(")")
        found.add(u)
        found.add(u.rstrip("/"))
        found.add(u if u.endswith("/") else u + "/")
    return found


def section_titles() -> list[str]:
    titles = []
    for line in LIST_MD.read_text(encoding="utf-8").splitlines():
        if line.startswith("# ") and not line.startswith("## "):
            titles.append(line[2:].strip())
    return titles


def strip_emoji_prefix(name: str) -> str:
    return re.sub(r"^[^\w#]+", "", name or "", flags=re.UNICODE).strip()


def resolve_section(provider: str) -> str | None:
    titles = section_titles()
    needle = (provider or "").strip()
    if not needle:
        return None
    for t in titles:
        if t == needle:
            return t
    n_cf = needle.casefold()
    for t in titles:
        if t.casefold() == n_cf:
            return t
    core = strip_emoji_prefix(needle).casefold()
    matches = [t for t in titles if strip_emoji_prefix(t).casefold() == core]
    if len(matches) == 1:
        return matches[0]
    matches = [
        t for t in titles if core and core in strip_emoji_prefix(t).casefold()
    ]
    if len(matches) == 1:
        return matches[0]
    return None


def run_list_cli(cli_args: list[str], dry: bool) -> int:
    cmd = [sys.executable, str(LIST_CLI), "--no-sync", *cli_args]
    if dry:
        cmd.insert(2, "--dry-run")
    print("+", " ".join(cmd))
    return subprocess.call(cmd, cwd=str(ROOT))


def found_date_from_sub(sub: dict[str, Any]) -> str:
    raw = sub.get("created") or sub.get("updated") or ""
    if isinstance(raw, str) and "T" in raw:
        try:
            dt = datetime.fromisoformat(raw.replace("Z", "+00:00"))
            return f"{dt.month}/{dt.day}/{dt.year}"
        except ValueError:
            pass
    now = datetime.now()
    return f"{now.month}/{now.day}/{now.year}"


def contributor_args(sub: dict[str, Any]) -> list[str]:
    label = (
        sub.get("submitterLabel")
        or sub.get("submitterGithub")
        or sub.get("contributor")
        or "contributor"
    )
    gh = (sub.get("submitterGithub") or "").strip().lstrip("@")
    out = ["--contributor", str(label)[:80]]
    if gh:
        out.extend(["--contributor-url", f"https://github.com/{gh}"])
    return out


def ensure_section(provider: str, note: str, dry: bool) -> str:
    existing = resolve_section(provider)
    if existing:
        return existing
    title = provider.strip() or "New provider"
    add_args = [
        "section",
        "add",
        title,
        "--category",
        "pending",
        "--capabilities",
        "N/A",
        "--protocols",
        "N/A",
    ]
    if note:
        add_args.extend(
            [
                "--important",
                "This section has not been fully categorized or checked for protocol(s) "
                f"and capabilities. Submitter note: {note[:300]}",
            ]
        )
    else:
        add_args.extend(
            [
                "--important",
                "This section has not been fully categorized or checked for protocol(s) "
                "and capabilities.",
            ]
        )
    code = run_list_cli(add_args, dry)
    if code != 0 and not dry:
        raise SystemExit(f"section add failed for {title!r} (exit {code})")
    return title


def add_link(section: str, url: str, sub: dict[str, Any], dry: bool) -> int:
    args = [
        "link",
        "add",
        "--section",
        section,
        "--url",
        url,
        "--found",
        found_date_from_sub(sub),
        *contributor_args(sub),
    ]
    return run_list_cli(args, dry)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--json", type=Path, help="approved submissions JSON dump")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument(
        "--mark-published",
        action="store_true",
        help="set publishedToList=true on imported Firestore docs (needs Firebase creds)",
    )
    ap.add_argument(
        "--include-published",
        action="store_true",
        help="do not skip docs already marked publishedToList",
    )
    ap.add_argument("--no-convert", action="store_true")
    args = ap.parse_args()

    sa = load_service_account()
    if args.json:
        subs = load_json_submissions(args.json)
    elif sa:
        print("Fetching approved submissions from Firestore…")
        subs = firestore_run_query(sa, "approved")
    else:
        print(
            "No --json and no Firebase credentials "
            "(FIREBASE_PROJECT_ID + FIREBASE_CLIENT_EMAIL + FIREBASE_PRIVATE_KEY, "
            "or FIREBASE_SERVICE_ACCOUNT).",
            file=sys.stderr,
        )
        return 2

    existing = urls_in_list()
    added = 0
    skipped = 0
    imported_ids: list[str] = []

    for sub in subs:
        if not isinstance(sub, dict):
            continue
        if sub.get("status") and str(sub.get("status")).lower() != "approved":
            skipped += 1
            continue
        if sub.get("publishedToList") and not args.include_published:
            skipped += 1
            continue
        url = normalize_url(str(sub.get("url") or ""))
        if not url.startswith("http"):
            print(f"skip invalid url: {url!r}")
            skipped += 1
            continue
        if url in existing or url.rstrip("/") in existing or (url + "/") in existing:
            print(f"already in list.md: {url}")
            skipped += 1
            if args.mark_published and sa and sub.get("id"):
                imported_ids.append(str(sub["id"]))
            continue

        provider = str(sub.get("provider") or "").strip()
        note = str(sub.get("optionalNote") or sub.get("note") or "").strip()
        is_new = bool(sub.get("isNewProvider"))
        section = resolve_section(provider)
        if not section:
            if is_new or provider:
                section = ensure_section(provider, note, args.dry_run)
            else:
                print(f"no section for {url} (provider={provider!r}); skipping")
                skipped += 1
                continue

        code = add_link(section, url, sub, args.dry_run)
        if code != 0:
            print(f"failed to add {url} -> {section} (exit {code})", file=sys.stderr)
            continue
        added += 1
        existing.add(url)
        existing.add(url.rstrip("/"))
        if sub.get("id"):
            imported_ids.append(str(sub["id"]))

    print(f"done: added={added} skipped={skipped}")

    if added and not args.dry_run and not args.no_convert:
        convert = ROOT / "scripts" / "convert_list_to_json.py"
        print("+", sys.executable, convert)
        subprocess.check_call([sys.executable, str(convert)], cwd=str(ROOT))

    if args.mark_published and sa and imported_ids and not args.dry_run:
        for doc_id in imported_ids:
            try:
                firestore_patch_published(sa, doc_id)
                print(f"marked published: {doc_id}")
            except Exception as exc:
                print(f"warning: could not mark {doc_id}: {exc}", file=sys.stderr)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
