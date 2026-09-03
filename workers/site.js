/**
 * Cloudflare Worker: static assets + IP-rate-limited link click API + presence pings.
 *
 * POST /api/link-click  { "url": "https://..." }
 *   - Rate limit: 40 clicks / hour / IP (Cache API)
 *   - Increments Firestore link_clicks/{sha256(normUrl)} via Admin REST when
 *     FIREBASE_PROJECT_ID + FIREBASE_CLIENT_EMAIL + FIREBASE_PRIVATE_KEY are set.
 *   - Also increments click_daily/{yyyy-mm-dd}.counts.{hash}, plus click_monthly/
 *     click_yearly totals for long-term archives.
 *   - Without Firebase secrets, increments an in-edge Cache counter (Cloudflare-only).
 *
 * POST /api/link-clicks/get  { "urls": ["https://..."] }
 *   - Returns { counts: { [normUrl]: number } } from edge-cached Firestore reads.
 *
 * GET /api/top-opens
 *   - Cached top link_clicks by count (5 min) for the Most opened section.
 *
 * POST /api/presence-ping  { sessionId, uid?, anonymous?, displayName? }
 *   - Rate limit: 90 pings / hour / IP
 *   - Writes presence_daily / presence_monthly aggregates + optional user totals
 *     for the Statistics → Users panel (unique visitors, hour buckets, top users).
 *   - Tracks ~5-minute live sessions in the edge Cache and returns { active }.
 *
 * GET  /api/presence-active
 *   - Returns { ok, active } for the live-session count (no Firebase required).
 *
 * GET /api/steam/search?term=...
 *   - Proxies store.steampowered.com/api/storesearch (CORS + edge cache).
 *
 * GET /api/steam/appdetails?appids=123
 *   - Proxies store.steampowered.com/api/appdetails (CORS + edge cache).
 *
 * /__/auth/* and /__/firebase/* → reverse-proxy to the Firebase Auth helper host
 *   so signInWithRedirect works when authDomain is this Worker origin (avoids
 *   third-party cookie blocking on GitHub Pages).
 */
const RATE_LIMIT_MAX = 40;
const RATE_LIMIT_WINDOW_SEC = 3600;
const PRESENCE_RATE_LIMIT_MAX = 90;
const PRESENCE_RATE_LIMIT_WINDOW_SEC = 3600;
const PRESENCE_ACTIVE_STALE_MS = 5 * 60 * 1000;
const PRESENCE_ACTIVE_CACHE_REQ = new Request("https://presence-active.proxy-list.internal/sessions");
const STEAM_RATE_LIMIT_MAX = 120;
const STEAM_RATE_LIMIT_WINDOW_SEC = 3600;
const STEAM_SEARCH_CACHE_TTL_SEC = 3600;
const STEAM_DETAILS_CACHE_TTL_SEC = 86400;
const STEAM_UA =
  "Mozilla/5.0 (compatible; proxy-list-steam-proxy/1.0; +https://github.com/yourworstnightmare1/proxy-list)";
const MAX_URL_LEN = 2048;
const MAX_SESSION_ID_LEN = 128;
const MAX_UID_LEN = 128;
const MAX_DISPLAY_NAME_LEN = 32;
const FS_CLICK_CACHE_TTL_SEC = 600;
const TOP_OPENS_CACHE_TTL_SEC = 300;
const TOP_OPENS_LIMIT = 80;
const FIREBASE_AUTH_HELPER_ORIGIN = "https://proxy-list-c06ea.firebaseapp.com";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/__/auth" || url.pathname.startsWith("/__/auth/") || url.pathname.startsWith("/__/firebase/")) {
      return proxyFirebaseAuthHelper(request, url);
    }

    if (url.pathname === "/api/link-click" && request.method === "POST") {
      return handleRecordClick(request, env, ctx);
    }
    if (url.pathname === "/api/link-click" && request.method === "OPTIONS") {
      return cors(new Response(null, { status: 204 }));
    }
    if (url.pathname === "/api/link-clicks/get" && request.method === "POST") {
      return handleGetClicks(request, env, ctx);
    }
    if (url.pathname === "/api/link-clicks/get" && request.method === "OPTIONS") {
      return cors(new Response(null, { status: 204 }));
    }
    if (url.pathname === "/api/top-opens" && request.method === "GET") {
      return handleTopOpens(request, env, ctx);
    }
    if (url.pathname === "/api/top-opens" && request.method === "OPTIONS") {
      return cors(new Response(null, { status: 204 }));
    }
    if (url.pathname === "/api/presence-ping" && request.method === "POST") {
      return handlePresencePing(request, env, ctx);
    }
    if (url.pathname === "/api/presence-ping" && request.method === "OPTIONS") {
      return cors(new Response(null, { status: 204 }));
    }
    if (url.pathname === "/api/presence-active" && request.method === "GET") {
      return handlePresenceActive();
    }
    if (url.pathname === "/api/presence-active" && request.method === "OPTIONS") {
      return cors(new Response(null, { status: 204 }));
    }
    if (url.pathname === "/api/steam/search" && request.method === "GET") {
      return handleSteamSearch(request, env, ctx);
    }
    if (url.pathname === "/api/steam/search" && request.method === "OPTIONS") {
      return cors(new Response(null, { status: 204 }));
    }
    if (url.pathname === "/api/steam/appdetails" && request.method === "GET") {
      return handleSteamAppDetails(request, env, ctx);
    }
    if (url.pathname === "/api/steam/appdetails" && request.method === "OPTIONS") {
      return cors(new Response(null, { status: 204 }));
    }
    if (url.pathname === "/api/submissions/sync" && request.method === "POST") {
      return handleSubmissionsSync(request, env);
    }
    if (url.pathname === "/api/submissions/sync" && request.method === "OPTIONS") {
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
  headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  headers.set("Access-Control-Allow-Headers", "Content-Type");
  headers.set("Access-Control-Max-Age", "86400");
  return new Response(res.body, { status: res.status, headers });
}

/**
 * Transparent reverse proxy for Firebase Auth redirect/popup helpers.
 * Must not 302 to firebaseapp.com — the browser has to stay on this origin.
 */
async function proxyFirebaseAuthHelper(request, url) {
  const target = new URL(url.pathname + url.search, FIREBASE_AUTH_HELPER_ORIGIN);
  const headers = new Headers(request.headers);
  headers.delete("host");
  headers.set("Host", new URL(FIREBASE_AUTH_HELPER_ORIGIN).host);

  const init = {
    method: request.method,
    headers,
    redirect: "manual",
  };
  if (request.method !== "GET" && request.method !== "HEAD") {
    init.body = request.body;
    // Required when forwarding a ReadableStream body in the Workers runtime.
    init.duplex = "half";
  }

  let upstream;
  try {
    upstream = await fetch(target.toString(), init);
  } catch (err) {
    return new Response("Auth helper proxy failed", { status: 502 });
  }

  const outHeaders = new Headers(upstream.headers);
  // Keep Set-Cookie / body as-is so the helper session stays first-party on this host.
  const location = outHeaders.get("Location");
  if (location) {
    try {
      const locUrl = new URL(location, FIREBASE_AUTH_HELPER_ORIGIN);
      if (locUrl.origin === new URL(FIREBASE_AUTH_HELPER_ORIGIN).origin) {
        locUrl.protocol = url.protocol;
        locUrl.host = url.host;
        outHeaders.set("Location", locUrl.toString());
      }
    } catch (_) {}
  }

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: outHeaders,
  });
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

function legacyNormalizeUrl(raw) {
  return String(raw || "")
    .trim()
    .replace(/\/+$/, "")
    .toLowerCase();
}

function clickUrlVariants(raw) {
  const modern = normalizeUrl(raw);
  const legacy = legacyNormalizeUrl(raw);
  const out = [];
  if (modern) out.push(modern);
  if (legacy && legacy !== modern) out.push(legacy);
  return out;
}

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function fsClickNormCacheRequest(normHash) {
  return new Request(`https://fs-click-norm.proxy-list.internal/${normHash}`);
}

function cacheTextResponse(text, ttlSec) {
  return new Response(String(text), {
    headers: {
      "Cache-Control": `public, max-age=${ttlSec}`,
      "Content-Type": "text/plain",
    },
  });
}

async function cachePutClickNorm(norm, count, ctx) {
  const cache = caches.default;
  const hash = await sha256Hex(norm);
  const put = cache.put(fsClickNormCacheRequest(hash), cacheTextResponse(Number(count) || 0, FS_CLICK_CACHE_TTL_SEC));
  if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(put);
  else await put;
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

async function readActiveSessionMap() {
  try {
    const hit = await caches.default.match(PRESENCE_ACTIVE_CACHE_REQ);
    if (!hit) return {};
    const raw = await hit.json();
    return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  } catch (_) {
    return {};
  }
}

function pruneActiveSessionMap(map, now) {
  const out = {};
  for (const [id, ts] of Object.entries(map || {})) {
    const n = Number(ts);
    if (!id || !Number.isFinite(n)) continue;
    if (now - n <= PRESENCE_ACTIVE_STALE_MS) out[id] = n;
  }
  return out;
}

async function touchActiveSession(sessionId, ctx) {
  const now = Date.now();
  const map = pruneActiveSessionMap(await readActiveSessionMap(), now);
  if (sessionId) map[sessionId] = now;
  const count = Object.keys(map).length;
  const res = new Response(JSON.stringify(map), {
    headers: {
      "Cache-Control": "public, max-age=600",
      "Content-Type": "application/json; charset=utf-8",
    },
  });
  ctx.waitUntil(caches.default.put(PRESENCE_ACTIVE_CACHE_REQ, res.clone()));
  return count;
}

async function handlePresenceActive() {
  const map = pruneActiveSessionMap(await readActiveSessionMap(), Date.now());
  return json({ ok: true, active: Object.keys(map).length });
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

function secondsUntilNextUtcYear(now = new Date()) {
  const next = Date.UTC(now.getUTCFullYear() + 1, 0, 1);
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

function parseCountFromCommitJson(body) {
  if (!body || !Array.isArray(body.writeResults)) return null;
  for (const wr of body.writeResults) {
    const tr = wr.transformResults;
    if (!Array.isArray(tr)) continue;
    for (const t of tr) {
      if (t && t.integerValue != null) return Number(t.integerValue);
    }
  }
  return null;
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
    const commitBody = await commitRes.json().catch(() => ({}));
    await firestoreIncrementDailyClick(env, token, project, docId, displayUrl).catch((err) => {
      console.error("daily_click_failed", err);
    });
    return { created: false, count: parseCountFromCommitJson(commitBody) };
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
    return { created: true, count: 1 };
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
  const retryBody = await retry.json().catch(() => ({}));
  await firestoreIncrementDailyClick(env, token, project, docId, displayUrl).catch((err) => {
    console.error("daily_click_failed", err);
  });
  return { created: false, count: parseCountFromCommitJson(retryBody) };
}

function utcDateId(d = new Date()) {
  return d.toISOString().slice(0, 10);
}

function utcMonthId(d = new Date()) {
  return d.toISOString().slice(0, 7);
}

function utcYearId(d = new Date()) {
  return String(d.getUTCFullYear());
}

/**
 * Increment a period archive doc's `total` (day→month→year rollups).
 * Keeps historical aggregates even after UI lookbacks move on.
 */
async function firestoreIncrementPeriodTotal(env, token, project, collection, docId, idField, idValue) {
  const docName = `projects/${project}/databases/(default)/documents/${collection}/${docId}`;
  const commitUrl = `https://firestore.googleapis.com/v1/projects/${project}/databases/(default)/documents:commit`;
  const transformWrite = {
    transform: {
      document: docName,
      fieldTransforms: [
        { fieldPath: "total", increment: { integerValue: "1" } },
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
    `https://firestore.googleapis.com/v1/projects/${project}/databases/(default)/documents/${collection}?documentId=${encodeURIComponent(docId)}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        fields: {
          [idField]: { stringValue: idValue },
          total: { integerValue: "1" },
          updated: { timestampValue: new Date().toISOString() },
        },
      }),
    }
  );
  if (!createRes.ok) {
    const t = await createRes.text().catch(() => "");
    throw new Error(`${collection} archive create failed: ${createRes.status} ${t}`);
  }
}

/** Lifetime totals stay on link_clicks; daily docs power provider time-series on /stats/. */
async function firestoreIncrementDailyClick(env, token, project, docId, displayUrl) {
  const day = utcDateId();
  const month = utcMonthId();
  const year = utcYearId();
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
  if (commitRes.ok) {
    await Promise.all([
      firestoreIncrementPeriodTotal(env, token, project, "click_monthly", month, "month", month).catch((err) =>
        console.error("click_monthly_failed", err)
      ),
      firestoreIncrementPeriodTotal(env, token, project, "click_yearly", year, "year", year).catch((err) =>
        console.error("click_yearly_failed", err)
      ),
    ]);
    return;
  }

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
  if (createRes.ok) {
    await Promise.all([
      firestoreIncrementPeriodTotal(env, token, project, "click_monthly", month, "month", month).catch((err) =>
        console.error("click_monthly_failed", err)
      ),
      firestoreIncrementPeriodTotal(env, token, project, "click_yearly", year, "year", year).catch((err) =>
        console.error("click_yearly_failed", err)
      ),
    ]);
    return;
  }

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
  await Promise.all([
    firestoreIncrementPeriodTotal(env, token, project, "click_monthly", month, "month", month).catch((err) =>
      console.error("click_monthly_failed", err)
    ),
    firestoreIncrementPeriodTotal(env, token, project, "click_yearly", year, "year", year).catch((err) =>
      console.error("click_yearly_failed", err)
    ),
  ]);
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

async function firestoreReadClickCount(env, docId, token) {
  const project = env.FIREBASE_PROJECT_ID;
  const authToken = token || (await getGoogleAccessToken(env));
  const res = await fetch(
    `https://firestore.googleapis.com/v1/projects/${project}/databases/(default)/documents/link_clicks/${docId}`,
    { headers: { Authorization: `Bearer ${authToken}` } }
  );
  if (!res.ok) return null;
  const doc = await res.json();
  const n = doc.fields && doc.fields.count && doc.fields.count.integerValue;
  return n != null ? Number(n) : null;
}

async function firestoreGetCounts(env, norms, ctx) {
  const project = env.FIREBASE_PROJECT_ID;
  const out = {};
  for (const norm of norms) out[norm] = 0;
  if (!project || !norms.length) return out;

  const cache = caches.default;
  const missing = [];
  for (const norm of norms) {
    const hash = await sha256Hex(norm);
    const hit = await cache.match(fsClickNormCacheRequest(hash));
    if (hit) {
      out[norm] = Number(await hit.text()) || 0;
    } else {
      missing.push(norm);
    }
  }
  if (!missing.length) return out;

  const useAdmin = hasFirebaseAdmin(env);
  let token = null;
  if (useAdmin) {
    try {
      token = await getGoogleAccessToken(env);
    } catch (err) {
      console.error("get_clicks_token_failed", err);
    }
  }

  const allIds = [];
  const idToNorm = new Map();
  for (const norm of missing) {
    for (const variant of clickUrlVariants(norm)) {
      const id = await sha256Hex(variant);
      if (!idToNorm.has(id)) {
        idToNorm.set(id, norm);
        allIds.push(id);
      }
    }
  }
  const idToCount = new Map();
  const batchUrl = `https://firestore.googleapis.com/v1/projects/${project}/databases/(default)/documents:batchGet`;

  for (let i = 0; i < allIds.length; i += 100) {
    const chunk = allIds.slice(i, i + 100);
    try {
      const headers = { "Content-Type": "application/json" };
      if (token) headers.Authorization = `Bearer ${token}`;
      const res = await fetch(batchUrl, {
        method: "POST",
        headers,
        body: JSON.stringify({
          documents: chunk.map(
            (id) => `projects/${project}/databases/(default)/documents/link_clicks/${id}`
          ),
        }),
      });
      if (!res.ok) continue;
      const rows = await res.json();
      if (!Array.isArray(rows)) continue;
      for (const row of rows) {
        const found = row && row.found;
        if (!found || !found.name) continue;
        const id = found.name.split("/").pop();
        const n = found.fields && found.fields.count && found.fields.count.integerValue;
        idToCount.set(id, n != null ? Number(n) : 0);
      }
    } catch (err) {
      console.error("get_clicks_batch_failed", err);
    }
  }

  for (const norm of missing) {
    let best = 0;
    for (const variant of clickUrlVariants(norm)) {
      const id = await sha256Hex(variant);
      if (idToCount.has(id)) best = Math.max(best, idToCount.get(id));
    }
    out[norm] = best;
    await cachePutClickNorm(norm, best, ctx);
  }
  return out;
}

async function firestoreTopOpens(env, limit) {
  const project = env.FIREBASE_PROJECT_ID;
  if (!project || !hasFirebaseAdmin(env)) return [];
  let token;
  try {
    token = await getGoogleAccessToken(env);
  } catch (err) {
    console.error("top_opens_token_failed", err);
    return [];
  }
  const cap = Math.max(1, Math.min(limit, 100));

  function parseDocFields(fields) {
    if (!fields || typeof fields !== "object") return null;
    const urlField = fields.url;
    const countField = fields.count;
    const urlVal = urlField && urlField.stringValue ? String(urlField.stringValue).trim() : "";
    let countVal = 0;
    if (countField) {
      if (countField.integerValue != null) countVal = Number(countField.integerValue);
      else if (countField.doubleValue != null) countVal = Number(countField.doubleValue);
    }
    if (!urlVal || !Number.isFinite(countVal) || countVal <= 0) return null;
    return { url: urlVal, count: countVal };
  }

  try {
    const listUrl =
      `https://firestore.googleapis.com/v1/projects/${project}/databases/(default)/documents/link_clicks` +
      `?pageSize=${cap}&orderBy=count%20desc`;
    const listRes = await fetch(listUrl, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (listRes.ok) {
      const body = await listRes.json();
      const docs = Array.isArray(body.documents) ? body.documents : [];
      const out = [];
      for (const doc of docs) {
        const row = parseDocFields(doc.fields);
        if (row) out.push(row);
      }
      if (out.length) return out;
    } else {
      const t = await listRes.text().catch(() => "");
      console.error("top_opens_list_failed", listRes.status, t.slice(0, 300));
    }
  } catch (err) {
    console.error("top_opens_list_error", err);
  }

  try {
    const queryUrl = `https://firestore.googleapis.com/v1/projects/${project}/databases/(default)/documents:runQuery`;
    const res = await fetch(queryUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        structuredQuery: {
          from: [{ collectionId: "link_clicks" }],
          orderBy: [{ field: { fieldPath: "count" }, direction: "DESCENDING" }],
          limit: cap,
        },
      }),
    });
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      console.error("top_opens_query_failed", res.status, t.slice(0, 300));
      return [];
    }
    const rows = await res.json();
    if (!Array.isArray(rows)) return [];
    const out = [];
    for (const row of rows) {
      const doc = row && row.document;
      if (!doc || !doc.fields) continue;
      const parsed = parseDocFields(doc.fields);
      if (parsed) out.push(parsed);
    }
    return out;
  } catch (err) {
    console.error("top_opens_query_error", err);
    return [];
  }
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
      const result = await firestoreIncrementClick(env, docId, displayUrl || norm);
      let count = Number.isFinite(result.count) ? result.count : null;
      if (count == null) {
        try {
          count = await firestoreReadClickCount(env, docId);
        } catch (err) {
          console.error("read_click_after_write_failed", err);
        }
      }
      const edgeCount = await edgeIncrement(norm, ctx);
      if (count == null && edgeCount) count = edgeCount;
      if (count != null) await cachePutClickNorm(norm, count, ctx);
      return json({
        ok: true,
        via: "firestore",
        norm,
        count,
        rate: { count: rate.count, limit: rate.limit },
      });
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

async function handleGetClicks(request, env, ctx) {
  let body;
  try {
    body = await request.json();
  } catch (_) {
    return json({ ok: false, error: "invalid_json" }, 400);
  }
  const urls = Array.isArray(body && body.urls) ? body.urls.slice(0, 80) : [];
  const norms = [...new Set(urls.map(normalizeUrl).filter((u) => u && u.length >= 10))];
  try {
    let counts;
    if (hasFirebaseAdmin(env) || env.FIREBASE_PROJECT_ID) {
      counts = await firestoreGetCounts(env, norms, ctx);
    } else {
      counts = {};
    }
    const edgeCounts = await edgeGetCounts(norms);
    for (const norm of norms) {
      const fs = counts[norm] || 0;
      const edge = edgeCounts[norm] || 0;
      counts[norm] = Math.max(fs, edge);
    }
    return json({ ok: true, counts });
  } catch (err) {
    console.error("get_clicks_failed", err);
    return json({ ok: false, error: "internal_error" }, 500);
  }
}

async function handleTopOpens(request, env, ctx) {
  const cache = caches.default;
  const cacheKey = new Request("https://top-opens.proxy-list.internal/v2");
  try {
    const hit = await cache.match(cacheKey);
    if (hit) {
      return cors(
        new Response(hit.body, {
          status: 200,
          headers: {
            "Content-Type": "application/json; charset=utf-8",
            "X-Cache": "HIT",
          },
        })
      );
    }
  } catch (_) {}

  try {
    const links = await firestoreTopOpens(env, TOP_OPENS_LIMIT);
    const payload = JSON.stringify({ ok: true, links });
    const res = new Response(payload, {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": `public, max-age=${TOP_OPENS_CACHE_TTL_SEC}`,
      },
    });
    if (links.length > 0 && ctx && typeof ctx.waitUntil === "function") {
      ctx.waitUntil(cache.put(cacheKey, res.clone()));
    }
    return cors(res);
  } catch (err) {
    console.error("top_opens_failed", err);
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

  const year = day.slice(0, 4);
  const yearlyTransforms = [
    { fieldPath: "heartbeats", increment: { integerValue: "1" } },
    { fieldPath: "updated", setToServerValue: "REQUEST_TIME" },
  ];
  if (opts.firstYear) {
    yearlyTransforms.push({ fieldPath: "uniqueVisitors", increment: { integerValue: "1" } });
  }
  const yearlyCreate = {
    year: { stringValue: year },
    heartbeats: { integerValue: "1" },
    uniqueVisitors: { integerValue: opts.firstYear ? "1" : "0" },
    updated: { timestampValue: now.toISOString() },
  };
  await firestoreCommitOrCreate(
    env,
    token,
    project,
    "presence_yearly",
    year,
    yearlyTransforms,
    yearlyCreate
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

  const active = await touchActiveSession(sessionId, ctx);

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
  const year = String(now.getUTCFullYear());
  const firstYear = await edgeFirstSeen(
    `year/${year}/${encodeURIComponent(visitorKey)}`,
    secondsUntilNextUtcYear(now) + 86400,
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
        firstYear,
        firstSignedInDay,
        firstUserDay,
        uidHash: uidHash || "",
        label,
      });
      return json({
        ok: true,
        via: "firestore",
        active,
        day,
        firstDay,
        firstHour,
        rate: { count: rate.count, limit: rate.limit },
      });
    }
    return json({
      ok: true,
      via: "edge",
      active,
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

async function steamRateLimit(request, ctx) {
  const ip = clientIp(request);
  return rateLimitOk(ip, ctx, {
    max: STEAM_RATE_LIMIT_MAX,
    windowSec: STEAM_RATE_LIMIT_WINDOW_SEC,
    prefix: "steam",
  });
}

async function cachedSteamJson(cacheKeyUrl, upstreamUrl, ttlSec, ctx) {
  const cache = caches.default;
  const cacheReq = new Request(cacheKeyUrl);
  const hit = await cache.match(cacheReq);
  if (hit) {
    const cloned = new Response(hit.body, hit);
    cloned.headers.set("X-Steam-Cache", "HIT");
    return cors(cloned);
  }

  const upstream = await fetch(upstreamUrl, {
    headers: {
      Accept: "application/json",
      "User-Agent": STEAM_UA,
    },
  });
  const text = await upstream.text();
  if (!upstream.ok) {
    return json(
      { ok: false, error: "steam_upstream", status: upstream.status },
      upstream.status === 429 ? 429 : 502
    );
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (_) {
    return json({ ok: false, error: "steam_bad_json" }, 502);
  }

  const body = JSON.stringify({ ok: true, data: parsed });
  const res = new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": `public, max-age=${ttlSec}`,
      "X-Steam-Cache": "MISS",
    },
  });
  const toStore = res.clone();
  ctx.waitUntil(cache.put(cacheReq, toStore));
  return cors(res);
}

async function handleSteamSearch(request, env, ctx) {
  const rate = await steamRateLimit(request, ctx);
  if (!rate.ok) {
    return json(
      {
        ok: false,
        error: "rate_limited",
        limit: rate.limit,
        windowSec: STEAM_RATE_LIMIT_WINDOW_SEC,
      },
      429
    );
  }

  const url = new URL(request.url);
  const term = String(url.searchParams.get("term") || "")
    .trim()
    .slice(0, 80);
  if (term.length < 2) {
    return json({ ok: false, error: "invalid_term" }, 400);
  }

  const upstream =
    "https://store.steampowered.com/api/storesearch/?" +
    new URLSearchParams({ term, l: "english", cc: "US" }).toString();
  const cacheKey =
    "https://steam-proxy.proxy-list.internal/search/v1?" +
    new URLSearchParams({ term: term.toLowerCase() }).toString();
  return cachedSteamJson(cacheKey, upstream, STEAM_SEARCH_CACHE_TTL_SEC, ctx);
}

async function handleSteamAppDetails(request, env, ctx) {
  const rate = await steamRateLimit(request, ctx);
  if (!rate.ok) {
    return json(
      {
        ok: false,
        error: "rate_limited",
        limit: rate.limit,
        windowSec: STEAM_RATE_LIMIT_WINDOW_SEC,
      },
      429
    );
  }

  const url = new URL(request.url);
  const raw = String(url.searchParams.get("appids") || "").trim();
  const appids = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => /^\d{1,10}$/.test(s))
    .slice(0, 1);
  if (!appids.length) {
    return json({ ok: false, error: "invalid_appids" }, 400);
  }

  const id = appids[0];
  const upstream =
    "https://store.steampowered.com/api/appdetails?" +
    new URLSearchParams({ appids: id, l: "english" }).toString();
  const cacheKey = `https://steam-proxy.proxy-list.internal/appdetails/v1/${id}`;
  return cachedSteamJson(cacheKey, upstream, STEAM_DETAILS_CACHE_TTL_SEC, ctx);
}

/**
 * Kick GitHub Actions to pull approved Firestore submissions into list.md.
 * Requires env.GITHUB_PUBLISH_TOKEN (repo scope: actions:write) and optional
 * env.GITHUB_REPO (default yourworstnightmare1/proxy-list).
 * Caller must send Authorization: Bearer <Firebase ID token> for an admin UID.
 */
async function handleSubmissionsSync(request, env) {
  const auth = String(request.headers.get("Authorization") || "");
  const m = /^Bearer\s+(.+)$/i.exec(auth);
  if (!m) return json({ ok: false, error: "missing_token" }, 401);

  let uid = "";
  try {
    const tip = await fetch(
      "https://oauth2.googleapis.com/tokeninfo?id_token=" + encodeURIComponent(m[1].trim())
    );
    if (!tip.ok) return json({ ok: false, error: "invalid_token" }, 401);
    const info = await tip.json();
    uid = String(info.user_id || info.sub || "");
    const aud = String(info.aud || "");
    const expectedAud = String(env.FIREBASE_PROJECT_ID || "").trim();
    if (expectedAud && aud && aud !== expectedAud) {
      return json({ ok: false, error: "wrong_audience" }, 401);
    }
  } catch (err) {
    console.error("submissions_sync_token", err);
    return json({ ok: false, error: "token_check_failed" }, 401);
  }

  const adminCsv = String(env.SUBMISSION_ADMIN_UIDS || "").trim();
  const admins = adminCsv
    ? adminCsv.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean)
    : ["OiMY32eTKcSnEX73W6oBUKgT6pG3"];
  if (!uid || !admins.includes(uid)) {
    return json({ ok: false, error: "forbidden" }, 403);
  }

  const ghToken = String(env.GITHUB_PUBLISH_TOKEN || "").trim();
  if (!ghToken) {
    return json({
      ok: true,
      queued: false,
      warning: "GITHUB_PUBLISH_TOKEN not set; scheduled sync will publish approvals.",
    });
  }

  const repo = String(env.GITHUB_REPO || "yourworstnightmare1/proxy-list").trim();
  const workflow = String(env.GITHUB_SYNC_WORKFLOW || "sync_approved_submissions.yml").trim();
  const ref = String(env.GITHUB_SYNC_REF || "main").trim();
  const res = await fetch(
    `https://api.github.com/repos/${repo}/actions/workflows/${workflow}/dispatches`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ghToken}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
        "User-Agent": "proxy-list-worker",
      },
      body: JSON.stringify({ ref }),
    }
  );
  if (!res.ok && res.status !== 204) {
    const text = await res.text();
    console.error("github_dispatch_failed", res.status, text);
    return json({ ok: false, error: "github_dispatch_failed", status: res.status }, 502);
  }
  return json({ ok: true, queued: true });
}
