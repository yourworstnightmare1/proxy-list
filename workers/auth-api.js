/**
 * Login / admin / GitHub-token APIs. Secrets stay on the Worker — never in localStorage.
 *
 * GET  /api/admin/me
 * POST /api/auth/guard          { kind: login|signup|reset, email }
 * POST /api/auth/password-check { password, email? }
 * POST /api/auth/reset          { email }
 * POST /api/github/token        { token }   Bearer Firebase ID token
 * DELETE /api/github/token      Bearer Firebase ID token
 * GET  /api/github/extras       Bearer Firebase ID token
 */

const AUTH_LOGIN_IP_MAX = 8;
const AUTH_LOGIN_EMAIL_MAX = 6;
const AUTH_SIGNUP_IP_MAX = 5;
const AUTH_RESET_IP_MAX = 4;
const AUTH_RESET_EMAIL_MAX = 3;
const AUTH_CHECK_IP_MAX = 20;
const AUTH_WINDOW_SEC = 15 * 60;
const AUTH_HOUR_SEC = 3600;
const GITHUB_TOKEN_TTL_SEC = 14 * 86400;
const GITHUB_REPO_OWNER = "yourworstnightmare1";
const GITHUB_REPO_NAME = "proxy-list";
const GITHUB_REPO_SLUG = GITHUB_REPO_OWNER + "/" + GITHUB_REPO_NAME;
const FIREBASE_WEB_API_KEY_FALLBACK = "AIzaSyBPXPOxZeezDBn2YtgzTsj-Dxje62lYYOQ";

const COMMON_PASSWORDS = new Set(
  [
    "password",
    "password1",
    "password12",
    "password123",
    "password1234",
    "passw0rd",
    "123456",
    "1234567",
    "12345678",
    "123456789",
    "1234567890",
    "12345678910",
    "qwerty",
    "qwerty123",
    "qwertyuiop",
    "letmein",
    "welcome",
    "welcome1",
    "admin",
    "admin123",
    "iloveyou",
    "monkey",
    "dragon",
    "master",
    "login",
    "abc123",
    "abc12345",
    "starwars",
    "shadow",
    "sunshine",
    "princess",
    "football",
    "baseball",
    "soccer",
    "superman",
    "batman",
    "trustno1",
    "whatever",
    "hello123",
    "freedom",
    "pass1234",
    "changeme",
    "secret",
    "secret123",
    "letmein1",
    "access",
    "access123",
    "proxylist",
    "proxy-list",
    "proxy1234",
    "unblocked",
    "unblock",
    "school123",
    "student1",
    "student12",
    "student123",
    "teacher1",
    "computer",
    "internet",
    "minecraft",
    "fortnite",
    "roblox123",
    "password!",
    "Password1",
    "Password123",
    "P@ssw0rd",
    "P@ssword1",
    "Admin1234",
    "Welcome1",
    "Welcome123",
    "Qwerty123",
  ].map((s) => s.toLowerCase())
);

export function submissionAdminUidList(env) {
  const adminCsv = String((env && env.SUBMISSION_ADMIN_UIDS) || "").trim();
  return adminCsv
    ? adminCsv.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean)
    : [
        // Fallback when SUBMISSION_ADMIN_UIDS is unset (local + current production).
        "OiMY32eTKcSnEX73W6oBUKgT6pG3",
        "QDaYz2ETKCSlEK70N3U8UKgTezX2", // yourworstnightmare_
      ];
}

export function isSubmissionAdminUid(env, uid) {
  const id = String(uid || "").trim();
  return !!(id && submissionAdminUidList(env).includes(id));
}

export async function handleAuthApi(request, env, ctx, url, helpers) {
  const path = url.pathname;
  if (path === "/api/admin/me" && request.method === "GET") {
    return handleAdminMe(request, env, helpers);
  }
  if (path === "/api/admin/me" && request.method === "OPTIONS") {
    return helpers.cors(new Response(null, { status: 204 }));
  }
  if (path === "/api/auth/guard" && request.method === "POST") {
    return handleAuthGuard(request, env, ctx, helpers);
  }
  if (path === "/api/auth/guard" && request.method === "OPTIONS") {
    return helpers.cors(new Response(null, { status: 204 }));
  }
  if (path === "/api/auth/password-check" && request.method === "POST") {
    return handlePasswordCheck(request, env, ctx, helpers);
  }
  if (path === "/api/auth/password-check" && request.method === "OPTIONS") {
    return helpers.cors(new Response(null, { status: 204 }));
  }
  if (path === "/api/auth/reset" && request.method === "POST") {
    return handlePasswordReset(request, env, ctx, helpers);
  }
  if (path === "/api/auth/reset" && request.method === "OPTIONS") {
    return helpers.cors(new Response(null, { status: 204 }));
  }
  if (path === "/api/github/token" && request.method === "POST") {
    return handleStoreGithubToken(request, env, ctx, helpers);
  }
  if (path === "/api/github/token" && request.method === "DELETE") {
    return handleClearGithubToken(request, env, helpers);
  }
  if (path === "/api/github/token" && request.method === "OPTIONS") {
    return helpers.cors(new Response(null, { status: 204 }));
  }
  if (path === "/api/github/extras" && request.method === "GET") {
    return handleGithubExtras(request, env, helpers);
  }
  if (path === "/api/github/extras" && request.method === "OPTIONS") {
    return helpers.cors(new Response(null, { status: 204 }));
  }
  return null;
}

async function requireUser(request, env, helpers) {
  const token = helpers.bearerToken(request);
  if (!token) return { error: helpers.json({ ok: false, error: "missing_token" }, 401) };
  const user = await helpers.verifyFirebaseIdToken(env, token);
  if (!user || !user.uid) return { error: helpers.json({ ok: false, error: "invalid_token" }, 401) };
  return { user };
}

async function handleAdminMe(request, env, helpers) {
  const auth = await requireUser(request, env, helpers);
  if (auth.error) return auth.error;
  return helpers.json({
    ok: true,
    admin: isSubmissionAdminUid(env, auth.user.uid),
    uid: auth.user.uid,
  });
}

function normalizeEmail(raw) {
  return String(raw || "")
    .trim()
    .toLowerCase()
    .slice(0, 320);
}

function emailLooksValid(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

async function handleAuthGuard(request, env, ctx, helpers) {
  let body;
  try {
    body = await request.json();
  } catch (_) {
    return helpers.json({ ok: false, error: "invalid_json" }, 400);
  }
  const kind = String((body && body.kind) || "login").toLowerCase();
  const email = normalizeEmail(body && body.email);
  if (!["login", "signup", "reset"].includes(kind)) {
    return helpers.json({ ok: false, error: "bad_kind" }, 400);
  }
  if (!emailLooksValid(email)) {
    return helpers.json({ ok: false, error: "invalid_email" }, 400);
  }

  const ip = helpers.clientIp(request);
  const emailHash = await helpers.sha256Hex(email);
  const ipMax = kind === "reset" ? AUTH_RESET_IP_MAX : kind === "signup" ? AUTH_SIGNUP_IP_MAX : AUTH_LOGIN_IP_MAX;
  const emailMax = kind === "reset" ? AUTH_RESET_EMAIL_MAX : AUTH_LOGIN_EMAIL_MAX;
  const ipWindow = kind === "signup" ? AUTH_HOUR_SEC : AUTH_WINDOW_SEC;
  const emailWindow = kind === "reset" ? AUTH_HOUR_SEC : AUTH_WINDOW_SEC;

  const ipLimit = await helpers.rateLimitOk(ip, ctx, {
    max: ipMax,
    windowSec: ipWindow,
    prefix: "auth-" + kind + "-ip",
  });
  if (!ipLimit.ok) {
    return helpers.json({ ok: false, error: "rate_limited", retrySec: ipWindow }, 429);
  }
  const emailLimit = await helpers.rateLimitOk(emailHash, ctx, {
    max: emailMax,
    windowSec: emailWindow,
    prefix: "auth-" + kind + "-email",
  });
  if (!emailLimit.ok) {
    return helpers.json({ ok: false, error: "rate_limited", retrySec: emailWindow }, 429);
  }
  return helpers.json({ ok: true });
}

function passwordIssues(password, email) {
  const issues = [];
  const pw = String(password || "");
  if (pw.length < 10) issues.push("at least 10 characters");
  if (pw.length > 128) issues.push("at most 128 characters");
  if (!/[a-z]/.test(pw)) issues.push("a lowercase letter");
  if (!/[A-Z]/.test(pw)) issues.push("an uppercase letter");
  if (!/[0-9]/.test(pw)) issues.push("a number");
  const local = String(email || "").split("@")[0] || "";
  if (local.length >= 3 && pw.toLowerCase().includes(local.toLowerCase())) {
    issues.push("not include your email name");
  }
  if (COMMON_PASSWORDS.has(pw.toLowerCase())) issues.push("not a commonly used password");
  if (/^(.)\1{9,}$/.test(pw)) issues.push("not a repeated character");
  if (/^(0123456789|9876543210|abcdefghij|qwertyuiop)/i.test(pw)) {
    issues.push("not a simple keyboard sequence");
  }
  return issues;
}

async function sha1Hex(text) {
  const buf = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(String(text)));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("").toUpperCase();
}

async function hibpPwnedCount(password) {
  const hash = await sha1Hex(password);
  const prefix = hash.slice(0, 5);
  const suffix = hash.slice(5);
  const res = await fetch("https://api.pwnedpasswords.com/range/" + prefix, {
    headers: {
      "Add-Padding": "true",
      "User-Agent": "proxy-list-password-check",
    },
  });
  if (!res.ok) throw new Error("hibp_" + res.status);
  const text = await res.text();
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    const [suf, count] = line.split(":");
    if (suf && suf.trim().toUpperCase() === suffix) return Number(count) || 1;
  }
  return 0;
}

async function handlePasswordCheck(request, env, ctx, helpers) {
  const ip = helpers.clientIp(request);
  const limit = await helpers.rateLimitOk(ip, ctx, {
    max: AUTH_CHECK_IP_MAX,
    windowSec: AUTH_WINDOW_SEC,
    prefix: "auth-pwcheck-ip",
  });
  if (!limit.ok) {
    return helpers.json({ ok: false, error: "rate_limited", retrySec: AUTH_WINDOW_SEC }, 429);
  }
  let body;
  try {
    body = await request.json();
  } catch (_) {
    return helpers.json({ ok: false, error: "invalid_json" }, 400);
  }
  const password = String((body && body.password) || "");
  const email = normalizeEmail(body && body.email);
  const issues = passwordIssues(password, email);
  let leaked = false;
  let leakCount = 0;
  if (password.length >= 8) {
    try {
      leakCount = await hibpPwnedCount(password);
      leaked = leakCount > 0;
    } catch (err) {
      console.warn("hibp_check_failed", err && err.message ? err.message : err);
    }
  }
  const ok = issues.length === 0 && !leaked;
  return helpers.json({
    ok,
    strong: issues.length === 0,
    leaked,
    leakCount: leaked ? leakCount : 0,
    issues,
  });
}

async function handlePasswordReset(request, env, ctx, helpers) {
  let body;
  try {
    body = await request.json();
  } catch (_) {
    return helpers.json({ ok: false, error: "invalid_json" }, 400);
  }
  const guard = await handleAuthGuard(
    new Request(request.url, {
      method: "POST",
      headers: request.headers,
      body: JSON.stringify({ kind: "reset", email: body && body.email }),
    }),
    env,
    ctx,
    helpers
  );
  if (guard.status !== 200) return guard;

  const email = normalizeEmail(body && body.email);
  if (!emailLooksValid(email)) {
    return helpers.json({ ok: false, error: "invalid_email" }, 400);
  }

  const apiKey = String(env.FIREBASE_WEB_API_KEY || FIREBASE_WEB_API_KEY_FALLBACK).trim();
  try {
    const res = await fetch(
      "https://identitytoolkit.googleapis.com/v1/accounts:sendOobCode?key=" + encodeURIComponent(apiKey),
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requestType: "PASSWORD_RESET", email }),
      }
    );
    if (!res.ok) {
      const errBody = await res.json().catch(() => ({}));
      const msg =
        (errBody && errBody.error && errBody.error.message) || "reset_failed";
      if (/EMAIL_NOT_FOUND|INVALID_EMAIL/i.test(String(msg))) {
        return helpers.json({ ok: true });
      }
      if (/RESET_PASSWORD_EXCEED_LIMIT|TOO_MANY_ATTEMPTS/i.test(String(msg))) {
        return helpers.json({ ok: false, error: "rate_limited" }, 429);
      }
      return helpers.json({ ok: false, error: "reset_failed" }, 400);
    }
  } catch (err) {
    console.error("password_reset", err);
    return helpers.json({ ok: false, error: "reset_failed" }, 502);
  }
  return helpers.json({ ok: true });
}

async function githubAesKey(env) {
  const secret = String(env.AUTH_TOKEN_SECRET || env.FIREBASE_PRIVATE_KEY || "proxy-list-github-token-v1");
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("gh-token:" + secret));
  return crypto.subtle.importKey("raw", hash, "AES-GCM", false, ["encrypt", "decrypt"]);
}

function githubTokenCacheReq(uid) {
  return new Request("https://gh-token.proxy-list.internal/" + encodeURIComponent(uid));
}

async function encryptGithubToken(env, token) {
  const key = await githubAesKey(env);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(token));
  const packed = new Uint8Array(iv.length + cipher.byteLength);
  packed.set(iv, 0);
  packed.set(new Uint8Array(cipher), iv.length);
  let bin = "";
  packed.forEach((b) => {
    bin += String.fromCharCode(b);
  });
  return btoa(bin);
}

async function decryptGithubToken(env, packedB64) {
  const raw = Uint8Array.from(atob(String(packedB64 || "")), (c) => c.charCodeAt(0));
  if (raw.length < 13) return "";
  const iv = raw.slice(0, 12);
  const data = raw.slice(12);
  const key = await githubAesKey(env);
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, data);
  return new TextDecoder().decode(plain);
}

async function readStoredGithubToken(uid) {
  try {
    const hit = await caches.default.match(githubTokenCacheReq(uid));
    if (!hit) return "";
    const o = await hit.json();
    return (o && o.token) || "";
  } catch (_) {
    return "";
  }
}

async function writeStoredGithubToken(uid, packed, ctx) {
  const res = new Response(JSON.stringify({ token: packed }), {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "private, max-age=" + GITHUB_TOKEN_TTL_SEC,
    },
  });
  const put = caches.default.put(githubTokenCacheReq(uid), res);
  if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(put);
  else await put;
}

async function clearStoredGithubToken(uid) {
  try {
    await caches.default.put(
      githubTokenCacheReq(uid),
      new Response("{}", {
        headers: { "Cache-Control": "max-age=1", "Content-Type": "application/json" },
      })
    );
  } catch (_) {}
}

async function handleStoreGithubToken(request, env, ctx, helpers) {
  const auth = await requireUser(request, env, helpers);
  if (auth.error) return auth.error;
  let body;
  try {
    body = await request.json();
  } catch (_) {
    return helpers.json({ ok: false, error: "invalid_json" }, 400);
  }
  const token = String((body && body.token) || "").trim();
  if (!token || token.length < 20 || token.length > 512) {
    return helpers.json({ ok: false, error: "bad_token" }, 400);
  }
  if (!/^(gh[pousr]_|github_pat_|gho_|ghu_|ghs_|ghr_)?[A-Za-z0-9_\-]+$/.test(token)) {
    return helpers.json({ ok: false, error: "bad_token" }, 400);
  }
  const packed = await encryptGithubToken(env, token);
  await writeStoredGithubToken(auth.user.uid, packed, ctx);
  return helpers.json({ ok: true });
}

async function handleClearGithubToken(request, env, helpers) {
  const auth = await requireUser(request, env, helpers);
  if (auth.error) return auth.error;
  await clearStoredGithubToken(auth.user.uid);
  return helpers.json({ ok: true });
}

function apiToHtmlUrl(apiUrl) {
  if (!apiUrl) return "";
  return String(apiUrl)
    .replace("api.github.com/repos/", "github.com/")
    .replace(/\/pulls\//, "/pull/");
}

async function classifyGithubNote(note, token) {
  const subject = note.subject || {};
  const type = String(subject.type || "").toLowerCase();
  const apiUrl = subject.url || "";
  const id = String(note.id || "");
  if (!id) return null;
  const fallback = {
    id: "gh-" + id,
    kind: "contribution",
    url: apiToHtmlUrl(apiUrl) || (note.repository && note.repository.html_url) || "",
  };
  if (type !== "pullrequest" && type !== "issue" && type !== "commit") return fallback;
  if (type === "commit" || !apiUrl || !token) return fallback;
  try {
    const res = await fetch(apiUrl, {
      headers: {
        Authorization: "Bearer " + token,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "proxy-list-github-extras",
      },
    });
    if (!res.ok) return fallback;
    const data = await res.json();
    const number = data.number;
    const htmlUrl = data.html_url || apiToHtmlUrl(apiUrl);
    if (type === "pullrequest") {
      if (data.merged) return { id: "gh-" + id, kind: "pr_merged", number, url: htmlUrl };
      if (data.state === "closed") return { id: "gh-" + id, kind: "pr_closed", number, url: htmlUrl };
      return null;
    }
    if (data.state === "open" && note.reason === "state_change") {
      return { id: "gh-" + id, kind: "issue_reopened", number, url: htmlUrl };
    }
    if (data.state === "closed") {
      if (String(data.state_reason || "") === "completed") {
        return { id: "gh-" + id, kind: "issue_completed", number, url: htmlUrl };
      }
      return { id: "gh-" + id, kind: "issue_closed", number, url: htmlUrl };
    }
  } catch (_) {
    return fallback;
  }
  return null;
}

async function handleGithubExtras(request, env, helpers) {
  const auth = await requireUser(request, env, helpers);
  if (auth.error) return auth.error;
  const packed = await readStoredGithubToken(auth.user.uid);
  if (!packed) return helpers.json({ ok: true, starred: false, notifications: [], missing: true });
  let token = "";
  try {
    token = await decryptGithubToken(env, packed);
  } catch (_) {
    token = "";
  }
  if (!token) return helpers.json({ ok: true, starred: false, notifications: [], missing: true });

  const ghHeaders = {
    Authorization: "Bearer " + token,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "proxy-list-github-extras",
  };
  let starred = false;
  try {
    const starRes = await fetch(
      "https://api.github.com/user/starred/" + GITHUB_REPO_OWNER + "/" + GITHUB_REPO_NAME,
      { headers: ghHeaders }
    );
    if (starRes.status === 401) {
      await clearStoredGithubToken(auth.user.uid);
      return helpers.json({ ok: true, starred: false, notifications: [], unauthorized: true });
    }
    starred = starRes.status === 204;
  } catch (_) {
    starred = false;
  }

  const notifications = [];
  try {
    const notifRes = await fetch("https://api.github.com/notifications?participating=true", {
      headers: ghHeaders,
    });
    if (notifRes.status === 401) {
      await clearStoredGithubToken(auth.user.uid);
      return helpers.json({ ok: true, starred, notifications: [], unauthorized: true });
    }
    if (notifRes.ok) {
      const notes = await notifRes.json();
      for (const note of notes || []) {
        const repo = note.repository && note.repository.full_name;
        if (repo !== GITHUB_REPO_SLUG) continue;
        const subject = note.subject || {};
        const type = String(subject.type || "").toLowerCase();
        if (type !== "pullrequest" && type !== "issue" && type !== "commit") continue;
        const reason = String(note.reason || "").toLowerCase();
        if (!["state_change", "author", "subscribed", "comment", "mention"].includes(reason)) continue;
        const classified = await classifyGithubNote(note, token);
        if (classified) {
          classified.githubId = String(note.id || "");
          notifications.push(classified);
        }
      }
    }
  } catch (err) {
    console.warn("github_notifications", err && err.message ? err.message : err);
  }
  return helpers.json({ ok: true, starred, notifications });
}
