/**
 * Cloudflare Worker: static assets + IP-rate-limited link click API + presence pings.
 *
 * POST /api/link-click  { "url": "https://..." }
 *   - Rate limit: 40 clicks / hour / IP (Cache API)
 *   - Increments Firestore link_clicks/{sha256(normUrl)} via Admin REST when
 *     FIREBASE_PROJECT_ID + FIREBASE_CLIENT_EMAIL + FIREBASE_PRIVATE_KEY are set.
 *   - Also increments click_daily/{yyyy-mm-dd}.counts.{hash} for stats time-series.
 *   - Without Firebase secrets, increments an in-edge Cache counter (Cloudflare-only).
 *
 * POST /api/link-clicks/get  { "urls": ["https://..."] }
 *   - Returns { counts: { [normUrl]: number } } from Firestore (public read) when
 *     project id is set; otherwise from edge cache counters.
 *
 * POST /api/presence-ping  { sessionId, uid?, anonymous?, displayName? }
 *   - Rate limit: 90 pings / hour / IP
 *   - Writes presence_daily / presence_monthly aggregates + optional user totals
 *     for the Statistics → Users panel (unique visitors, hour buckets, top users).
 */
const RATE_LIMIT_MAX = 40;
const RATE_LIMIT_WINDOW_SEC = 3600;
const PRESENCE_RATE_LIMIT_MAX = 90;
const PRESENCE_RATE_LIMIT_WINDOW_SEC = 3600;
const MAX_URL_LEN = 2048;
const MAX_SESSION_ID_LEN = 128;
const MAX_UID_LEN = 128;
const MAX_DISPLAY_NAME_LEN = 32;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/api/link-click" && request.method === "POST") {
      return handleRecordClick(request, env, ctx);
    }
    if (url.pathname === "/api/link-click" && request.method === "OPTIONS") {
      return cors(new Response(null, { status: 204 }));
    }
    if (url.pathname === "/api/link-clicks/get" && request.method === "POST") {
      return handleGetClicks(request, env);
    }
    if (url.pathname === "/api/link-clicks/get" && request.method === "OPTIONS") {
      return cors(new Response(null, { status: 204 }));
    }
    if (url.pathname === "/api/presence-ping" && request.method === "POST") {
      return handlePresencePing(request, env, ctx);
    }
    if (url.pathname === "/api/presence-ping" && request.method === "OPTIONS") {
      return cors(new Response(null, { status: 204 }));
    }

    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }
    return new Response("Not found", { status: 404 });
  },
};

function cors(res) {
  const headers = new Headers(res.headers);
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  headers.set("Access-Control-Allow-Headers", "Content-Type");
  headers.set("Access-Control-Max-Age", "86400");
  return new Response(res.body, { status: res.status, headers });
}

function json(data, status = 200) {
  return cors(
    new Response(JSON.stringify(data), {
      status,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    })
  );
}

function clientIp(request) {
  return (
    request.headers.get("CF-Connecting-IP") ||
    request.headers.get("True-Client-IP") ||
    (request.headers.get("X-Forwarded-For") || "").split(",")[0].trim() ||
    "unknown"
  );
}

function normalizeUrl(raw) {
  let u = String(raw || "").trim();
  if (!u) return "";
  if (!/^https?:\/\//i.test(u)) u = "https://" + u;
  try {
    const parsed = new URL(u);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "";
    let out = parsed.href;
    if (out.endsWith("/") && (out.match(/\//g) || []).length > 3) out = out.replace(/\/+$/, "");
    return out.slice(0, MAX_URL_LEN);
  } catch (_) {
    return "";
  }
}

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function rateLimitOk(ip, ctx, opts = {}) {
  const max = opts.max != null ? opts.max : RATE_LIMIT_MAX;
  const windowSec = opts.windowSec != null ? opts.windowSec : RATE_LIMIT_WINDOW_SEC;
  const prefix = opts.prefix || "click";
  const bucket = Math.floor(Date.now() / (windowSec * 1000));
  const keyUrl = `https://rate-limit.proxy-list.internal/${prefix}/${encodeURIComponent(ip)}/${bucket}`;
  const cache = caches.default;
  const req = new Request(keyUrl);
  let count = 0;
  const hit = await cache.match(req);
  if (hit) {
    count = Number(await hit.text()) || 0;
  }
  if (count >= max) {
    return { ok: false, count, limit: max };
  }
  count += 1;
  const res = new Response(String(count), {
    headers: {
      "Cache-Control": `public, max-age=${windowSec}`,
      "Content-Type": "text/plain",
    },
  });
  ctx.waitUntil(cache.put(req, res.clone()));
  return { ok: true, count, limit: max };
}

/** Returns true the first time this key is seen within maxAgeSec (edge Cache). */
async function edgeFirstSeen(keyPath, maxAgeSec, ctx) {
  const cache = caches.default;
  const req = new Request(`https://presence-dedupe.proxy-list.internal/${keyPath}`);
  const hit = await cache.match(req);
  if (hit) return false;
  const res = new Response("1", {
    headers: {
      "Cache-Control": `public, max-age=${Math.max(60, Math.min(maxAgeSec, 86400 * 40))}`,
      "Content-Type": "text/plain",
    },
  });
  ctx.waitUntil(cache.put(req, res.clone()));
  return true;
}

function sanitizeDisplayName(raw) {
  let s = String(raw || "")
    .replace(/[\u0000-\u001f<>]/g, "")
    .trim()
    .slice(0, MAX_DISPLAY_NAME_LEN);
  if (!s || /^anonymous$/i.test(s)) return "";
  return s;
}

function secondsUntilNextUtcDay(now = new Date()) {
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  return Math.max(60, Math.ceil((next - now.getTime()) / 1000));
}

function secondsUntilNextUtcHour(now = new Date()) {
  const next = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
    now.getUTCHours() + 1
  );
  return Math.max(60, Math.ceil((next - now.getTime()) / 1000));
}

function secondsUntilNextUtcMonth(now = new Date()) {
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
  return Math.max(60, Math.ceil((next - now.getTime()) / 1000));
}

function hasFirebaseAdmin(env) {
  return !!(env.FIREBASE_PROJECT_ID && env.FIREBASE_CLIENT_EMAIL && env.FIREBASE_PRIVATE_KEY);
}

function pemFromEnv(raw) {
  let key = String(raw || "").replace(/\\n/g, "\n").trim();
  if (!key.includes("BEGIN")) {
    key = `-----BEGIN PRIVATE KEY-----\n${key}\n-----END PRIVATE KEY-----`;
  }
  return key;
}

function base64url(bytes) {
  let str;
  if (typeof bytes === "string") {
    str = btoa(bytes);
  } else {
    let s = "";
    bytes.forEach((b) => {
      s += String.fromCharCode(b);
    });
    str = btoa(s);
  }
  return str.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function importPrivateKey(pem) {
  const cleaned = pem.replace(/-----BEGIN PRIVATE KEY-----/, "").replace(/-----END PRIVATE KEY-----/, "").replace(/\s+/g, "");
  const binary = Uint8Array.from(atob(cleaned), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey(
    "pkcs8",
    binary.buffer,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );
}

async function getGoogleAccessToken(env) {
  const cacheKey = "https://token.proxy-list.internal/firebase-access";
  const cache = caches.default;
  const cached = await cache.match(cacheKey);
  if (cached) {
    const data = await cached.json();
    if (data && data.access_token && data.exp * 1000 > Date.now() + 60000) {
      return data.access_token;
    }
  }

  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claim = base64url(
    JSON.stringify({
      iss: env.FIREBASE_CLIENT_EMAIL,
      sub: env.FIREBASE_CLIENT_EMAIL,
      aud: "https://oauth2.googleapis.com/token",
      iat: now,
      exp: now + 3600,
      scope: "https://www.googleapis.com/auth/datastore",
    })
  );
  const unsigned = `${header}.${claim}`;
  const key = await importPrivateKey(pemFromEnv(env.FIREBASE_PRIVATE_KEY));
  const sig = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(unsigned)
  );
  const jwt = `${unsigned}.${base64url(new Uint8Array(sig))}`;

  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });
  if (!tokenRes.ok) {
    const errText = await tokenRes.text();
    throw new Error(`token exchange failed: ${tokenRes.status} ${errText}`);
  }
  const tokenJson = await tokenRes.json();
  const access = tokenJson.access_token;
  const exp = now + Number(tokenJson.expires_in || 3600);
  await cache.put(
    cacheKey,
    new Response(JSON.stringify({ access_token: access, exp }), {
      headers: { "Cache-Control": "public, max-age=3500", "Content-Type": "application/json" },
    })
  );
  return access;
}

async function firestoreIncrementClick(env, docId, displayUrl) {
  const token = await getGoogleAccessToken(env);
  const project = env.FIREBASE_PROJECT_ID;
  const docName = `projects/${project}/databases/(default)/documents/link_clicks/${docId}`;
  const commitUrl = `https://firestore.googleapis.com/v1/projects/${project}/databases/(default)/documents:commit`;

  const incrementWrite = {
    transform: {
      document: docName,
      fieldTransforms: [
        { fieldPath: "count", increment: { integerValue: "1" } },
        { fieldPath: "updated", setToServerValue: "REQUEST_TIME" },
      ],
    },
  };

  const commitRes = await fetch(commitUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      writes: [
        incrementWrite,
        {
          update: {
            name: docName,
            fields: {
              url: { stringValue: displayUrl },
            },
          },
          updateMask: { fieldPaths: ["url"] },
          currentDocument: { exists: true },
        },
      ],
    }),
  });

  if (commitRes.ok) {
    await firestoreIncrementDailyClick(env, token, project, docId, displayUrl).catch((err) => {
      console.error("daily_click_failed", err);
    });
    return { created: false };
  }

  const createRes = await fetch(
    `https://firestore.googleapis.com/v1/projects/${project}/databases/(default)/documents/link_clicks?documentId=${encodeURIComponent(docId)}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        fields: {
          url: { stringValue: displayUrl },
          count: { integerValue: "1" },
          updated: { timestampValue: new Date().toISOString() },
        },
      }),
    }
  );
  if (createRes.ok) {
    await firestoreIncrementDailyClick(env, token, project, docId, displayUrl).catch((err) => {
      console.error("daily_click_failed", err);
    });
    return { created: true };
  }

  const retry = await fetch(commitUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ writes: [incrementWrite] }),
  });
  if (!retry.ok) {
    const t = await retry.text();
    throw new Error(`firestore write failed: ${createRes.status}/${retry.status} ${t}`);
  }
  await firestoreIncrementDailyClick(env, token, project, docId, displayUrl).catch((err) => {
    console.error("daily_click_failed", err);
  });
  return { created: false };
}

function utcDateId(d = new Date()) {
  return d.toISOString().slice(0, 10);
}

/** Lifetime totals stay on link_clicks; daily docs power provider time-series on /stats/. */
async function firestoreIncrementDailyClick(env, token, project, docId, displayUrl) {
  const day = utcDateId();
  const dailyName = `projects/${project}/databases/(default)/documents/click_daily/${day}`;
  const commitUrl = `https://firestore.googleapis.com/v1/projects/${project}/databases/(default)/documents:commit`;
  const countPath = firestoreMapFieldPath("counts", docId);

  const transformWrite = {
    transform: {
      document: dailyName,
      fieldTransforms: [
        { fieldPath: "total", increment: { integerValue: "1" } },
        { fieldPath: countPath, increment: { integerValue: "1" } },
        { fieldPath: "updated", setToServerValue: "REQUEST_TIME" },
      ],
    },
  };

  const commitRes = await fetch(commitUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ writes: [transformWrite] }),
  });
  if (commitRes.ok) return;

  const createRes = await fetch(
    `https://firestore.googleapis.com/v1/projects/${project}/databases/(default)/documents/click_daily?documentId=${encodeURIComponent(day)}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        fields: {
          date: { stringValue: day },
          total: { integerValue: "1" },
          counts: {
            mapValue: {
              fields: {
                [docId]: { integerValue: "1" },
              },
            },
          },
          updated: { timestampValue: new Date().toISOString() },
        },
      }),
    }
  );
  if (createRes.ok) return;

  const retry = await fetch(commitUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ writes: [transformWrite] }),
  });
  if (!retry.ok) {
    const t = await retry.text();
    throw new Error(`daily click write failed: ${createRes.status}/${retry.status} ${t}`);
  }
}

async function edgeIncrement(norm, ctx) {
  const cache = caches.default;
  const key = new Request(`https://clicks.proxy-list.internal/${await sha256Hex(norm)}`);
  let count = 0;
  const hit = await cache.match(key);
  if (hit) count = Number(await hit.text()) || 0;
  count += 1;
  ctx.waitUntil(
    cache.put(
      key,
      new Response(String(count), {
        headers: { "Cache-Control": "public, max-age=31536000", "Content-Type": "text/plain" },
      })
    )
  );
  return count;
}

async function edgeGetCounts(norms) {
  const cache = caches.default;
  const out = {};
  for (const norm of norms) {
    const key = new Request(`https://clicks.proxy-list.internal/${await sha256Hex(norm)}`);
    const hit = await cache.match(key);
    out[norm] = hit ? Number(await hit.text()) || 0 : 0;
  }
  return out;
}

async function firestoreGetCounts(env, norms) {
  const project = env.FIREBASE_PROJECT_ID;
  const out = {};
  // Public Firestore REST get does not need auth when rules allow read: if true
  await Promise.all(
    norms.map(async (norm) => {
      try {
        const id = await sha256Hex(norm);
        const res = await fetch(
          `https://firestore.googleapis.com/v1/projects/${project}/databases/(default)/documents/link_clicks/${id}`
        );
        if (!res.ok) {
          out[norm] = 0;
          return;
        }
        const doc = await res.json();
        const n = doc.fields && doc.fields.count && doc.fields.count.integerValue;
        out[norm] = n != null ? Number(n) : 0;
      } catch (err) {
        console.error("get_click_one_failed", norm, err);
        out[norm] = 0;
      }
    })
  );
  return out;
}

async function handleRecordClick(request, env, ctx) {
  let body;
  try {
    body = await request.json();
  } catch (_) {
    return json({ ok: false, error: "invalid_json" }, 400);
  }
  const displayUrl = String((body && body.url) || "").trim().slice(0, MAX_URL_LEN);
  const norm = normalizeUrl(displayUrl);
  if (!norm || norm.length < 10) {
    return json({ ok: false, error: "invalid_url" }, 400);
  }

  const ip = clientIp(request);
  const rate = await rateLimitOk(ip, ctx);
  if (!rate.ok) {
    return json(
      { ok: false, error: "rate_limited", limit: rate.limit, windowSec: RATE_LIMIT_WINDOW_SEC },
      429
    );
  }

  const docId = await sha256Hex(norm);
  try {
    if (hasFirebaseAdmin(env)) {
      await firestoreIncrementClick(env, docId, displayUrl || norm);
      return json({ ok: true, via: "firestore", rate: { count: rate.count, limit: rate.limit } });
    }
    const count = await edgeIncrement(norm, ctx);
    return json({
      ok: true,
      via: "edge",
      count,
      rate: { count: rate.count, limit: rate.limit },
      warning: "Firebase admin secrets not configured; using edge counter only.",
    });
  } catch (err) {
    console.error("record_click_failed", err);
    return json({ ok: false, error: "internal_error" }, 500);
  }
}

async function handleGetClicks(request, env) {
  let body;
  try {
    body = await request.json();
  } catch (_) {
    return json({ ok: false, error: "invalid_json" }, 400);
  }
  const urls = Array.isArray(body && body.urls) ? body.urls.slice(0, 100) : [];
  const norms = [...new Set(urls.map(normalizeUrl).filter((u) => u && u.length >= 10))];
  try {
    let counts;
    if (env.FIREBASE_PROJECT_ID) {
      counts = await firestoreGetCounts(env, norms);
    } else {
      counts = await edgeGetCounts(norms);
    }
    return json({ ok: true, counts });
  } catch (err) {
    console.error("get_clicks_failed", err);
    return json({ ok: false, error: "internal_error" }, 500);
  }
}

async function firestoreCommitOrCreate(env, token, project, collection, docId, transformWrite, createFields) {
  const docName = `projects/${project}/databases/(default)/documents/${collection}/${docId}`;
  const commitUrl = `https://firestore.googleapis.com/v1/projects/${project}/databases/(default)/documents:commit`;
  const write = {
    transform: {
      document: docName,
      fieldTransforms: transformWrite,
    },
  };
  const commitRes = await fetch(commitUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ writes: [write] }),
  });
  if (commitRes.ok) return;

  const createRes = await fetch(
    `https://firestore.googleapis.com/v1/projects/${project}/databases/(default)/documents/${collection}?documentId=${encodeURIComponent(docId)}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ fields: createFields }),
    }
  );
  if (createRes.ok) return;

  const retry = await fetch(commitUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ writes: [write] }),
  });
  if (!retry.ok) {
    const t = await retry.text();
    throw new Error(`${collection} write failed: ${createRes.status}/${retry.status} ${t}`);
  }
}

function firestoreMapFieldPath(mapField, key) {
  // Numeric / hex map keys must be backtick-quoted for Firestore field transforms.
  const safeKey = String(key || "").replace(/\\/g, "\\\\").replace(/`/g, "\\`");
  return `${mapField}.\`${safeKey}\``;
}

async function firestoreRecordPresence(env, opts) {
  const token = await getGoogleAccessToken(env);
  const project = env.FIREBASE_PROJECT_ID;
  const now = opts.now || new Date();
  const day = utcDateId(now);
  const month = day.slice(0, 7);
  const hour = String(now.getUTCHours()).padStart(2, "0");
  const hourPath = firestoreMapFieldPath("hourHeartbeats", hour);
  const hourUniquePath = firestoreMapFieldPath("hourUniques", hour);

  const dailyTransforms = [
    { fieldPath: "heartbeats", increment: { integerValue: "1" } },
    { fieldPath: hourPath, increment: { integerValue: "1" } },
    { fieldPath: "updated", setToServerValue: "REQUEST_TIME" },
  ];
  if (opts.firstDay) {
    dailyTransforms.push({ fieldPath: "uniqueVisitors", increment: { integerValue: "1" } });
  }
  if (opts.firstHour) {
    dailyTransforms.push({ fieldPath: hourUniquePath, increment: { integerValue: "1" } });
  }
  if (opts.firstSignedInDay) {
    dailyTransforms.push({ fieldPath: "signedInUniques", increment: { integerValue: "1" } });
  }

  const dailyCreate = {
    date: { stringValue: day },
    heartbeats: { integerValue: "1" },
    uniqueVisitors: { integerValue: opts.firstDay ? "1" : "0" },
    signedInUniques: { integerValue: opts.firstSignedInDay ? "1" : "0" },
    hourHeartbeats: {
      mapValue: { fields: { [hour]: { integerValue: "1" } } },
    },
    hourUniques: {
      mapValue: {
        fields: { [hour]: { integerValue: opts.firstHour ? "1" : "0" } },
      },
    },
    updated: { timestampValue: now.toISOString() },
  };

  await firestoreCommitOrCreate(env, token, project, "presence_daily", day, dailyTransforms, dailyCreate);

  const monthlyTransforms = [
    { fieldPath: "heartbeats", increment: { integerValue: "1" } },
    { fieldPath: "updated", setToServerValue: "REQUEST_TIME" },
  ];
  if (opts.firstMonth) {
    monthlyTransforms.push({ fieldPath: "uniqueVisitors", increment: { integerValue: "1" } });
  }
  const monthlyCreate = {
    month: { stringValue: month },
    heartbeats: { integerValue: "1" },
    uniqueVisitors: { integerValue: opts.firstMonth ? "1" : "0" },
    updated: { timestampValue: now.toISOString() },
  };
  await firestoreCommitOrCreate(
    env,
    token,
    project,
    "presence_monthly",
    month,
    monthlyTransforms,
    monthlyCreate
  );

  if (opts.uidHash && opts.label) {
    const userTransforms = [
      { fieldPath: "heartbeats", increment: { integerValue: "1" } },
      { fieldPath: "updated", setToServerValue: "REQUEST_TIME" },
      { fieldPath: "lastSeen", setToServerValue: "REQUEST_TIME" },
    ];
    if (opts.firstUserDay) {
      userTransforms.push({ fieldPath: "daysActive", increment: { integerValue: "1" } });
    }
    const userCreate = {
      label: { stringValue: opts.label },
      heartbeats: { integerValue: "1" },
      daysActive: { integerValue: "1" },
      lastSeen: { timestampValue: now.toISOString() },
      updated: { timestampValue: now.toISOString() },
    };
    await firestoreCommitOrCreate(
      env,
      token,
      project,
      "presence_user_totals",
      opts.uidHash,
      userTransforms,
      userCreate
    );

    // Keep label fresh when username changes (best-effort patch).
    const patchUrl = `https://firestore.googleapis.com/v1/projects/${project}/databases/(default)/documents/presence_user_totals/${opts.uidHash}?updateMask.fieldPaths=label`;
    await fetch(patchUrl, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ fields: { label: { stringValue: opts.label } } }),
    }).catch(() => {});
  }
}

async function handlePresencePing(request, env, ctx) {
  let body;
  try {
    body = await request.json();
  } catch (_) {
    return json({ ok: false, error: "invalid_json" }, 400);
  }

  const sessionId = String((body && body.sessionId) || "")
    .trim()
    .slice(0, MAX_SESSION_ID_LEN)
    .replace(/[^a-zA-Z0-9_-]/g, "");
  if (!sessionId || sessionId.length < 8) {
    return json({ ok: false, error: "invalid_session" }, 400);
  }

  const uid = String((body && body.uid) || "")
    .trim()
    .slice(0, MAX_UID_LEN)
    .replace(/[^a-zA-Z0-9]/g, "");
  const anonymous = !!(body && body.anonymous);
  const displayName = sanitizeDisplayName(body && body.displayName);

  const ip = clientIp(request);
  const rate = await rateLimitOk(ip, ctx, {
    max: PRESENCE_RATE_LIMIT_MAX,
    windowSec: PRESENCE_RATE_LIMIT_WINDOW_SEC,
    prefix: "presence",
  });
  if (!rate.ok) {
    return json(
      {
        ok: false,
        error: "rate_limited",
        limit: rate.limit,
        windowSec: PRESENCE_RATE_LIMIT_WINDOW_SEC,
      },
      429
    );
  }

  const now = new Date();
  const day = utcDateId(now);
  const month = day.slice(0, 7);
  const hour = String(now.getUTCHours()).padStart(2, "0");
  const ipHash = (await sha256Hex(ip)).slice(0, 16);
  const visitorKey = uid ? `u:${uid}` : `s:${sessionId}:${ipHash}`;

  const firstDay = await edgeFirstSeen(
    `day/${day}/${encodeURIComponent(visitorKey)}`,
    secondsUntilNextUtcDay(now) + 3600,
    ctx
  );
  const firstHour = await edgeFirstSeen(
    `hour/${day}-${hour}/${encodeURIComponent(visitorKey)}`,
    secondsUntilNextUtcHour(now) + 600,
    ctx
  );
  const firstMonth = await edgeFirstSeen(
    `month/${month}/${encodeURIComponent(visitorKey)}`,
    secondsUntilNextUtcMonth(now) + 86400,
    ctx
  );

  let uidHash = "";
  let firstSignedInDay = false;
  let firstUserDay = false;
  let label = "";
  if (uid && !anonymous) {
    uidHash = (await sha256Hex(`presence-user:${uid}`)).slice(0, 40);
    label = displayName || "Signed-in user";
    firstSignedInDay = await edgeFirstSeen(
      `signed/${day}/${uidHash}`,
      secondsUntilNextUtcDay(now) + 3600,
      ctx
    );
    firstUserDay = await edgeFirstSeen(
      `userday/${day}/${uidHash}`,
      secondsUntilNextUtcDay(now) + 3600,
      ctx
    );
  }

  try {
    if (hasFirebaseAdmin(env)) {
      await firestoreRecordPresence(env, {
        now,
        firstDay,
        firstHour,
        firstMonth,
        firstSignedInDay,
        firstUserDay,
        uidHash: uidHash || "",
        label,
      });
      return json({
        ok: true,
        via: "firestore",
        day,
        firstDay,
        firstHour,
        rate: { count: rate.count, limit: rate.limit },
      });
    }
    return json({
      ok: true,
      via: "edge",
      day,
      firstDay,
      firstHour,
      warning: "Firebase admin secrets not configured; presence not persisted.",
      rate: { count: rate.count, limit: rate.limit },
    });
  } catch (err) {
    console.error("presence_ping_failed", err);
    return json({ ok: false, error: "internal_error" }, 500);
  }
}
