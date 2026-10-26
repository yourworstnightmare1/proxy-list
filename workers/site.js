/**
 * Cloudflare Worker: static assets + IP-rate-limited link click API + presence pings.
 *
 * POST /api/link-click  { "url": "https://..." }
 *   - Rate limit: 40 clicks / hour / IP (Cache API)
 *   - When STATS_STORE=d1 and env.DB is bound: increments D1 link_clicks by
 *     sha256(normUrl) plus click_daily / click_period rollups, and skips Firestore.
 *   - Else increments Firestore link_clicks/{sha256(normUrl)} via Admin REST when
 *     FIREBASE_PROJECT_ID + FIREBASE_CLIENT_EMAIL + FIREBASE_PRIVATE_KEY are set.
 *   - Firestore path also increments click_daily/{yyyy-mm-dd}.counts.{hash}, plus
 *     click_monthly / click_yearly totals.
 *   - Without D1 or Firebase secrets, increments an in-edge Cache counter.
 *
 * POST /api/link-clicks/get  { "urls": ["https://..."] }
 *   - Returns { counts: { [normUrl]: number } } from D1 (if bound) and/or
 *     edge-cached Firestore reads. Hash IDs stay sha256(norm).
 *   - Sums distinct hash docs across URL-key variants (legacy vs modern keys).
 *   - Omits keys when no store has a value so clients keep disk cache.
 *
 * POST /api/link-ratings/get  { "urls": ["https://..."] }
 *   - Returns { ratings: { [normUrl]: { up, down } } } from D1 and/or Admin Firestore.
 *   - Optional Authorization: Bearer <Firebase ID token> adds { self: { [norm]: vote } }.
 *   - Used when client Firebase Auth is blocked (e.g. workers.dev referrer).
 *
 * POST /api/link-rating  { "url", "vote": 1|-1|0 }  (Bearer Firebase ID token)
 *   - D1-only vote write (aggregates + per-uid vote). Auth/folders stay on Firebase.
 *
 * GET /api/top-opens
 *   - Cached top link_clicks by count (5 min) for the Most opened section.
 *
 * GET  /api/click-stats/daily?days=90
 * POST /api/click-stats/daily  { hashes?, days? }
 * GET  /api/click-stats/period?kind=month|year&lookback=36
 *   - D1 rollups for /stats/, Math.max-merged with legacy Firestore click_daily /
 *     click_monthly / click_yearly so pre-D1 months (e.g. Aug/Sep) still appear
 *     for Scramjet/Tor clients that cannot reach Firebase from the browser.
 *
 * POST /api/presence-ping  { sessionId, uid?, anonymous?, displayName?, os?, osVersion?, browser?, ram?, cores?, arch? }
 *   - Rate limit: 90 pings / hour / IP
 *   - When STATS_STORE=d1: writes D1 presence_daily / presence_hour / presence_period
 *     (and optional user totals) for Statistics → Users.
 *   - Coarse OS + version (allowlisted) go to presence_os_daily. Independent of Sentry.
 *   - Coarse RAM (through 32 GB+) / CPU cores / arch go to presence_hw_daily.
 *   - Else writes Firestore presence_daily / monthly / yearly when admin secrets exist.
 *   - Tracks ~3-minute live sessions in the edge Cache and returns { active }.
 *   - Signed-in users are keyed by uid (proxy + raw tabs count once); anonymous
 *     by session id (not anonymous Firebase uid — those churn under web proxies).
 *
 * GET /api/presence-stats/daily?days=32
 * GET /api/presence-stats/period?kind=month|year&lookback=36
 * GET /api/presence-stats/os?days=32
 * GET /api/presence-stats/hardware?days=32
 *   - D1 presence rollups for /stats/, Math.max-merged with legacy Firestore
 *     presence_daily / monthly / yearly for pre-D1 history (Scramjet-safe).
 *
 * GET  /api/presence-active
 *   - Returns { ok, active } for the live-session count (no Firebase required).
 *   - Prunes and persists the edge session map so abandoned ids do not linger.
 *
 * GET /api/steam/search?term=...
 *   - Proxies store.steampowered.com/api/storesearch (CORS + edge cache).
 *
 * GET /api/steam/appdetails?appids=123
 *   - Proxies store.steampowered.com/api/appdetails (CORS + edge cache).
 *
 * Auth / admin (see workers/auth-api.js):
 *   GET  /api/admin/me
 *   POST /api/auth/guard | /api/auth/password-check | /api/auth/reset
 *   POST|DELETE /api/github/token
 *   GET  /api/github/extras
 *
 * /__/auth/* and /__/firebase/* → reverse-proxy to the Firebase Auth helper host
 *   so signInWithRedirect works when authDomain is this Worker origin (avoids
 *   third-party cookie blocking on GitHub Pages).
 */
import { handleAuthApi, isSubmissionAdminUid } from "./auth-api.js";

const RATE_LIMIT_MAX = 40;
const RATE_LIMIT_WINDOW_SEC = 3600;
const PRESENCE_RATE_LIMIT_MAX = 90;
const PRESENCE_RATE_LIMIT_WINDOW_SEC = 3600;
/** Drop sessions with no heartbeat for this long (client pings ~every 60s). */
const PRESENCE_ACTIVE_STALE_MS = 3 * 60 * 1000;
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
const FS_CLICK_CACHE_TTL_SEC = 3600;
const FS_RATING_CACHE_TTL_SEC = 300;
const TOP_OPENS_CACHE_TTL_SEC = 1800;
const TOP_OPENS_FAIL_TTL_SEC = 180;
const TOP_OPENS_LAST_GOOD_TTL_SEC = 7 * 86400;
const TOP_OPENS_LAST_GOOD_REQ = new Request("https://top-opens.proxy-list.internal/last-good");
const TOP_OPENS_LIMIT = 80;
const MEM_CACHE_MAX = 20000;

/**
 * Per-isolate memory cache. Isolates are reused across many requests in a colo, and
 * unlike the Cache API this costs no subrequests and also works on *.workers.dev.
 */
const memCache = new Map();

function memGet(key) {
  const e = memCache.get(key);
  if (!e) return undefined;
  if (e.exp <= Date.now()) {
    memCache.delete(key);
    return undefined;
  }
  return e.v;
}

function memSet(key, value, ttlSec) {
  if (memCache.size >= MEM_CACHE_MAX) {
    const oldest = memCache.keys().next().value;
    if (oldest !== undefined) memCache.delete(oldest);
  }
  memCache.delete(key);
  memCache.set(key, { v: value, exp: Date.now() + ttlSec * 1000 });
}

async function batchCacheRequest(kind, norms) {
  const sig = await sha256Hex([...norms].sort().join("\n"));
  return new Request(`https://${kind}-batch.proxy-list.internal/${sig}`);
}

async function batchCacheGet(kind, norms) {
  try {
    const hit = await caches.default.match(await batchCacheRequest(kind, norms));
    if (!hit) return null;
    const o = await hit.json();
    return o && typeof o === "object" ? o : null;
  } catch (_) {
    return null;
  }
}

async function batchCachePut(kind, norms, obj, ttlSec, ctx) {
  if (!ctx || typeof ctx.waitUntil !== "function") return;
  try {
    const req = await batchCacheRequest(kind, norms);
    ctx.waitUntil(
      caches.default.put(
        req,
        new Response(JSON.stringify(obj), {
          headers: { "Content-Type": "application/json", "Cache-Control": `public, max-age=${ttlSec}` },
        })
      )
    );
  } catch (_) {}
}
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
    if (url.pathname === "/api/link-ratings/get" && request.method === "POST") {
      return handleGetRatings(request, env, ctx);
    }
    if (url.pathname === "/api/link-ratings/get" && request.method === "OPTIONS") {
      return cors(new Response(null, { status: 204 }));
    }
    if (url.pathname === "/api/link-rating" && request.method === "POST") {
      return handleLinkRatingVote(request, env, ctx);
    }
    if (url.pathname === "/api/link-rating" && request.method === "OPTIONS") {
      return cors(new Response(null, { status: 204 }));
    }
    if (url.pathname === "/api/top-opens" && request.method === "GET") {
      return handleTopOpens(request, env, ctx);
    }
    if (url.pathname === "/api/top-opens" && request.method === "OPTIONS") {
      return cors(new Response(null, { status: 204 }));
    }
    if (url.pathname === "/api/click-stats/daily" && (request.method === "GET" || request.method === "POST")) {
      return handleClickStatsDaily(request, env);
    }
    if (url.pathname === "/api/click-stats/daily" && request.method === "OPTIONS") {
      return cors(new Response(null, { status: 204 }));
    }
    if (url.pathname === "/api/click-stats/period" && request.method === "GET") {
      return handleClickStatsPeriod(request, env);
    }
    if (url.pathname === "/api/click-stats/period" && request.method === "OPTIONS") {
      return cors(new Response(null, { status: 204 }));
    }
    if (url.pathname === "/api/presence-ping" && request.method === "POST") {
      return handlePresencePing(request, env, ctx);
    }
    if (url.pathname === "/api/presence-ping" && request.method === "OPTIONS") {
      return cors(new Response(null, { status: 204 }));
    }
    if (url.pathname === "/api/presence-active" && request.method === "GET") {
      return handlePresenceActive(ctx);
    }
    if (url.pathname === "/api/presence-active" && request.method === "OPTIONS") {
      return cors(new Response(null, { status: 204 }));
    }
    if (url.pathname === "/api/presence-stats/daily" && request.method === "GET") {
      return handlePresenceStatsDaily(request, env);
    }
    if (url.pathname === "/api/presence-stats/daily" && request.method === "OPTIONS") {
      return cors(new Response(null, { status: 204 }));
    }
    if (url.pathname === "/api/presence-stats/period" && request.method === "GET") {
      return handlePresenceStatsPeriod(request, env);
    }
    if (url.pathname === "/api/presence-stats/period" && request.method === "OPTIONS") {
      return cors(new Response(null, { status: 204 }));
    }
    if (url.pathname === "/api/presence-stats/os" && request.method === "GET") {
      return handlePresenceStatsOs(request, env);
    }
    if (url.pathname === "/api/presence-stats/os" && request.method === "OPTIONS") {
      return cors(new Response(null, { status: 204 }));
    }
    if (url.pathname === "/api/presence-stats/hardware" && request.method === "GET") {
      return handlePresenceStatsHardware(request, env);
    }
    if (url.pathname === "/api/presence-stats/hardware" && request.method === "OPTIONS") {
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
    if (url.pathname === "/api/sentry" && request.method === "POST") {
      return handleSentryTunnel(request);
    }
    if (url.pathname === "/api/sentry" && request.method === "OPTIONS") {
      return cors(new Response(null, { status: 204 }));
    }

    const authApi = await handleAuthApi(request, env, ctx, url, {
      json,
      cors,
      clientIp,
      rateLimitOk,
      sha256Hex,
      bearerToken,
      verifyFirebaseIdToken,
    });
    if (authApi) return authApi;

    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }
    return new Response("Not found", { status: 404 });
  },
};

function cors(res) {
  const headers = new Headers(res.headers);
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  // Authorization is required for admin kicks (e.g. POST /api/submissions/sync from GitHub Pages).
  // sentry-trace / baggage are injected by the browser SDK on instrumented fetch().
  headers.set(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, sentry-trace, baggage"
  );
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
  // v2: counts sum legacy+modern URL hashes (v1 cached Math.max and under-counted).
  return new Request(`https://fs-click-norm.proxy-list.internal/v2/${normHash}`);
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

/**
 * Stable map key for live presence.
 * Signed-in accounts collapse proxy + raw tabs to one entry (uid).
 * Anonymous / no-auth use the browser session id — do not key by anonymous
 * Firebase uid (proxies often mint a new anonymous auth uid per load).
 */
function activePresenceKey(sessionId, uid, anonymous) {
  const u = String(uid || "").trim();
  if (u && !anonymous) return "u:" + u.slice(0, 128);
  const s = String(sessionId || "").trim();
  if (s) return "s:" + s.slice(0, 128);
  return "";
}

async function writeActiveSessionMap(map, ctx) {
  const res = new Response(JSON.stringify(map), {
    headers: {
      "Cache-Control": "public, max-age=600",
      "Content-Type": "application/json; charset=utf-8",
    },
  });
  const put = caches.default.put(PRESENCE_ACTIVE_CACHE_REQ, res.clone());
  if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(put);
  else await put;
  return res;
}

async function touchActiveSession(sessionId, ctx, opts) {
  const now = Date.now();
  const map = pruneActiveSessionMap(await readActiveSessionMap(), now);
  const uid = opts && opts.uid ? String(opts.uid) : "";
  const anonymous = !!(opts && opts.anonymous);
  const key = activePresenceKey(sessionId, uid, anonymous);
  if (key) {
    map[key] = now;
    // Signed-in: drop the anonymous session key so proxy↔raw does not double-count.
    if (key.startsWith("u:") && sessionId) {
      delete map["s:" + String(sessionId).trim().slice(0, 128)];
      delete map[String(sessionId).trim().slice(0, 128)]; // legacy unprefixed keys
    }
  }
  const count = Object.keys(map).length;
  await writeActiveSessionMap(map, ctx);
  return count;
}

async function handlePresenceActive(ctx) {
  const now = Date.now();
  const before = await readActiveSessionMap();
  const map = pruneActiveSessionMap(before, now);
  // Persist prune so abandoned sessions leave the edge Cache entry.
  if (Object.keys(before).length !== Object.keys(map).length) {
    await writeActiveSessionMap(map, ctx);
  }
  return json({
    ok: true,
    active: Object.keys(map).length,
    staleMs: PRESENCE_ACTIVE_STALE_MS,
  });
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

function hasD1(env) {
  return !!(env && env.DB && typeof env.DB.prepare === "function");
}

function preferD1Stats(env) {
  return hasD1(env) && String(env.STATS_STORE || "").toLowerCase() === "d1";
}

function firebaseProjectIdPublic(env) {
  return String(env.FIREBASE_PROJECT_ID || env.FIREBASE_PROJECT_ID_PUBLIC || "").trim();
}

/**
 * Verify a Firebase ID token via Google's tokeninfo endpoint (no admin SDK needed).
 * Returns { uid } or null.
 */
async function verifyFirebaseIdToken(env, rawToken) {
  const token = String(rawToken || "").trim();
  if (!token) return null;
  try {
    const tip = await fetch(
      "https://oauth2.googleapis.com/tokeninfo?id_token=" + encodeURIComponent(token)
    );
    if (!tip.ok) return null;
    const info = await tip.json();
    const uid = String(info.user_id || info.sub || "").trim();
    if (!uid) return null;
    const aud = String(info.aud || "");
    const expected = firebaseProjectIdPublic(env);
    if (expected && aud && aud !== expected) return null;
    // Reject anonymous Firebase sessions (sign_in_provider not always on tokeninfo).
    const firebaseClaim = info.firebase;
    if (firebaseClaim && typeof firebaseClaim === "object") {
      const provider = String(firebaseClaim.sign_in_provider || "");
      if (provider === "anonymous") return null;
    }
    return { uid, email: String(info.email || "") };
  } catch (err) {
    console.error("verify_firebase_id_token", err);
    return null;
  }
}

function bearerToken(request) {
  const auth = String(request.headers.get("Authorization") || "");
  const m = /^Bearer\s+(.+)$/i.exec(auth);
  return m ? m[1].trim() : "";
}

async function d1IncrementClick(env, hash, displayUrl) {
  const now = Date.now();
  const day = utcDateId();
  const month = utcMonthId();
  const year = utcYearId();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO link_clicks (hash, url, count, updated) VALUES (?, ?, 1, ?)
       ON CONFLICT(hash) DO UPDATE SET
         count = link_clicks.count + 1,
         url = COALESCE(NULLIF(excluded.url, ''), link_clicks.url),
         updated = excluded.updated`
    ).bind(hash, displayUrl || "", now),
    env.DB.prepare(
      `INSERT INTO click_daily (date, hash, count) VALUES (?, ?, 1)
       ON CONFLICT(date, hash) DO UPDATE SET count = click_daily.count + 1`
    ).bind(day, hash),
    env.DB.prepare(
      `INSERT INTO click_period (kind, period, total, updated) VALUES ('month', ?, 1, ?)
       ON CONFLICT(kind, period) DO UPDATE SET total = click_period.total + 1, updated = excluded.updated`
    ).bind(month, now),
    env.DB.prepare(
      `INSERT INTO click_period (kind, period, total, updated) VALUES ('year', ?, 1, ?)
       ON CONFLICT(kind, period) DO UPDATE SET total = click_period.total + 1, updated = excluded.updated`
    ).bind(year, now),
  ]);
  const row = await env.DB.prepare(`SELECT count FROM link_clicks WHERE hash = ?`).bind(hash).first();
  return Number(row && row.count) || 1;
}

async function d1GetClickCounts(env, norms) {
  const out = {};
  if (!hasD1(env) || !norms.length) return out;

  const allIds = [];
  const seenId = new Set();
  const normVariants = new Map();
  for (const norm of norms) {
    const variants = clickUrlVariants(norm);
    normVariants.set(norm, variants);
    for (const variant of variants) {
      const id = await sha256Hex(variant);
      if (seenId.has(id)) continue;
      seenId.add(id);
      allIds.push(id);
    }
  }
  if (!allIds.length) return out;

  const idToCount = new Map();
  for (let i = 0; i < allIds.length; i += 80) {
    const chunk = allIds.slice(i, i + 80);
    const placeholders = chunk.map(() => "?").join(",");
    const rows = await env.DB.prepare(
      `SELECT hash, count FROM link_clicks WHERE hash IN (${placeholders})`
    )
      .bind(...chunk)
      .all();
    for (const row of (rows && rows.results) || []) {
      idToCount.set(String(row.hash), Number(row.count) || 0);
    }
  }

  for (const norm of norms) {
    let sum = 0;
    let saw = false;
    const used = new Set();
    for (const variant of normVariants.get(norm) || []) {
      const id = await sha256Hex(variant);
      if (used.has(id)) continue;
      used.add(id);
      if (!idToCount.has(id)) continue;
      sum += idToCount.get(id);
      saw = true;
    }
    if (saw) out[norm] = sum;
  }
  return out;
}

async function d1GetRatings(env, norms) {
  const out = {};
  if (!hasD1(env) || !norms.length) return out;

  const allIds = [];
  const seenId = new Set();
  const normVariants = new Map();
  for (const norm of norms) {
    const variants = clickUrlVariants(norm);
    normVariants.set(norm, variants);
    for (const variant of variants) {
      const id = await sha256Hex(variant);
      if (seenId.has(id)) continue;
      seenId.add(id);
      allIds.push(id);
    }
  }

  const idToRating = new Map();
  for (let i = 0; i < allIds.length; i += 80) {
    const chunk = allIds.slice(i, i + 80);
    const placeholders = chunk.map(() => "?").join(",");
    const rows = await env.DB.prepare(
      `SELECT hash, up, down FROM link_ratings WHERE hash IN (${placeholders})`
    )
      .bind(...chunk)
      .all();
    for (const row of (rows && rows.results) || []) {
      idToRating.set(String(row.hash), {
        up: Number(row.up) || 0,
        down: Number(row.down) || 0,
      });
    }
  }

  for (const norm of norms) {
    let best = { up: 0, down: 0 };
    let sawAny = false;
    const used = new Set();
    for (const variant of normVariants.get(norm) || []) {
      const id = await sha256Hex(variant);
      if (used.has(id)) continue;
      used.add(id);
      if (!idToRating.has(id)) continue;
      const ag = idToRating.get(id);
      if (!sawAny || ag.up > best.up || ag.down > best.down) {
        best = ag;
        sawAny = true;
      }
    }
    // Omit missing keys so clients can fall back to Firestore / disk cache
    // instead of treating "not migrated yet" as a confirmed 0/0.
    if (sawAny) out[norm] = best;
  }
  return out;
}

async function d1GetSelfVotes(env, uid, norms) {
  const out = {};
  if (!hasD1(env) || !uid || !norms.length) return out;
  const hashes = [];
  const hashToNorm = new Map();
  for (const norm of norms) {
    const hash = await sha256Hex(norm);
    hashes.push(hash);
    hashToNorm.set(hash, norm);
  }
  for (let i = 0; i < hashes.length; i += 80) {
    const chunk = hashes.slice(i, i + 80);
    const placeholders = chunk.map(() => "?").join(",");
    const rows = await env.DB.prepare(
      `SELECT hash, vote FROM link_rating_votes WHERE uid = ? AND hash IN (${placeholders})`
    )
      .bind(uid, ...chunk)
      .all();
    for (const row of (rows && rows.results) || []) {
      const norm = hashToNorm.get(String(row.hash));
      if (norm) out[norm] = Number(row.vote) || 0;
    }
  }
  return out;
}

async function d1ApplyRatingVote(env, uid, norm, nextVote) {
  const hash = await sha256Hex(norm);
  const now = Date.now();
  const vote = nextVote === 1 || nextVote === -1 ? nextVote : 0;

  const existing = await env.DB.prepare(
    `SELECT vote FROM link_rating_votes WHERE uid = ? AND hash = ?`
  )
    .bind(uid, hash)
    .first();
  const old = existing ? Number(existing.vote) || 0 : 0;

  const agg = await env.DB.prepare(`SELECT up, down FROM link_ratings WHERE hash = ?`)
    .bind(hash)
    .first();
  let up = agg ? Number(agg.up) || 0 : 0;
  let down = agg ? Number(agg.down) || 0 : 0;

  if (old === 1) up = Math.max(0, up - 1);
  if (old === -1) down = Math.max(0, down - 1);
  if (vote === 1) up++;
  if (vote === -1) down++;

  const stmts = [];
  if (vote === 0) {
    if (existing) {
      stmts.push(env.DB.prepare(`DELETE FROM link_rating_votes WHERE uid = ? AND hash = ?`).bind(uid, hash));
    }
  } else {
    stmts.push(
      env.DB.prepare(
        `INSERT INTO link_rating_votes (uid, hash, vote, norm, updated) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(uid, hash) DO UPDATE SET vote = excluded.vote, norm = excluded.norm, updated = excluded.updated`
      ).bind(uid, hash, vote, norm, now)
    );
  }
  if (vote !== 0 || old !== 0) {
    stmts.push(
      env.DB.prepare(
        `INSERT INTO link_ratings (hash, norm, up, down, updated) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(hash) DO UPDATE SET norm = excluded.norm, up = excluded.up, down = excluded.down, updated = excluded.updated`
      ).bind(hash, norm, up, down, now)
    );
  }
  if (stmts.length) await env.DB.batch(stmts);
  return { hash, up, down, vote, old };
}

async function d1TopOpens(env, limit) {
  if (!hasD1(env)) return [];
  const cap = Math.max(1, Math.min(limit || TOP_OPENS_LIMIT, 100));
  const fetchCap = Math.min(150, Math.max(Math.ceil(cap * 1.5), 60));
  const rows = await env.DB.prepare(
    `SELECT url, count FROM link_clicks WHERE count > 0 ORDER BY count DESC LIMIT ?`
  )
    .bind(fetchCap)
    .all();
  const byNorm = new Map();
  for (const row of (rows && rows.results) || []) {
    const urlVal = String(row.url || "").trim();
    const count = Number(row.count) || 0;
    if (!urlVal || count <= 0) continue;
    const norm = normalizeUrl(urlVal) || legacyNormalizeUrl(urlVal);
    if (!norm) continue;
    const prev = byNorm.get(norm);
    if (!prev) {
      byNorm.set(norm, { url: normalizeUrl(urlVal) || urlVal, count });
    } else {
      prev.count += count;
      const modern = normalizeUrl(urlVal);
      if (modern) prev.url = modern;
    }
  }
  return [...byNorm.values()].sort((a, b) => b.count - a.count).slice(0, cap);
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
  const memToken = memGet("gtoken");
  if (memToken) return memToken;
  const cacheKey = "https://token.proxy-list.internal/firebase-access";
  const cache = caches.default;
  const cached = await cache.match(cacheKey);
  if (cached) {
    const data = await cached.json();
    if (data && data.access_token && data.exp * 1000 > Date.now() + 60000) {
      memSet("gtoken", data.access_token, Math.max(1, data.exp - Math.floor(Date.now() / 1000) - 120));
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
  memSet("gtoken", access, Math.max(1, exp - now - 120));
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

function utcDayIds(lookback, now = new Date()) {
  const n = Math.max(1, Math.min(Number(lookback) || 90, 90));
  const out = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - i));
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

function utcMonthIds(lookback, now = new Date()) {
  const n = Math.max(1, Math.min(Number(lookback) || 36, 36));
  const out = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    out.push(d.toISOString().slice(0, 7));
  }
  return out;
}

function utcYearIds(lookback, now = new Date()) {
  const n = Math.max(1, Math.min(Number(lookback) || 10, 10));
  const y = now.getUTCFullYear();
  const out = [];
  for (let i = n - 1; i >= 0; i--) out.push(String(y - i));
  return out;
}

async function d1DailyTotals(env, lookback) {
  const ids = utcDayIds(lookback);
  if (!hasD1(env) || !ids.length) return ids.map((date) => ({ date, total: 0 }));
  const rows = await env.DB.prepare(
    `SELECT date, SUM(count) AS total FROM click_daily WHERE date >= ? GROUP BY date`
  )
    .bind(ids[0])
    .all();
  const byDate = new Map();
  for (const row of (rows && rows.results) || []) {
    byDate.set(String(row.date), Number(row.total) || 0);
  }
  return ids.map((date) => ({ date, total: byDate.get(date) || 0 }));
}

async function d1DailyCountsForHashes(env, lookback, hashes) {
  const ids = utcDayIds(lookback);
  const byDate = new Map(ids.map((d) => [d, {}]));
  if (!hasD1(env) || !ids.length || !hashes.length) {
    return ids.map((date) => ({ date, counts: byDate.get(date) || {} }));
  }
  for (let i = 0; i < hashes.length; i += 80) {
    const chunk = hashes.slice(i, i + 80);
    const placeholders = chunk.map(() => "?").join(",");
    const rows = await env.DB.prepare(
      `SELECT date, hash, count FROM click_daily WHERE date >= ? AND hash IN (${placeholders})`
    )
      .bind(ids[0], ...chunk)
      .all();
    for (const row of (rows && rows.results) || []) {
      const date = String(row.date);
      if (!byDate.has(date)) continue;
      byDate.get(date)[String(row.hash)] = Number(row.count) || 0;
    }
  }
  return ids.map((date) => ({ date, counts: byDate.get(date) || {} }));
}

async function d1PeriodTotals(env, kind, lookback) {
  const periods = kind === "year" ? utcYearIds(lookback) : utcMonthIds(lookback);
  if (!hasD1(env) || !periods.length) return periods.map((period) => ({ period, total: 0 }));
  const placeholders = periods.map(() => "?").join(",");
  const rows = await env.DB.prepare(
    `SELECT period, total FROM click_period WHERE kind = ? AND period IN (${placeholders})`
  )
    .bind(kind, ...periods)
    .all();
  const byPeriod = new Map();
  for (const row of (rows && rows.results) || []) {
    byPeriod.set(String(row.period), Number(row.total) || 0);
  }
  return periods.map((period) => ({ period, total: byPeriod.get(period) || 0 }));
}

function parseLookback(raw, fallback, max) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(1, Math.min(Math.trunc(n), max));
}

/** Parse a Firestore mapValue of numeric fields into a plain { key: number } object. */
function fsMapNumberFields(mapField) {
  const out = {};
  const fields = mapField && mapField.mapValue && mapField.mapValue.fields;
  if (!fields || typeof fields !== "object") return out;
  for (const [k, v] of Object.entries(fields)) {
    out[k] = fsNumberField(v);
  }
  return out;
}

function mergeHourNumberMaps(a, b) {
  const out = {};
  for (const src of [a, b]) {
    if (!src || typeof src !== "object") continue;
    for (const [k, v] of Object.entries(src)) {
      out[k] = Math.max(Number(out[k]) || 0, Number(v) || 0);
    }
  }
  return out;
}

/**
 * Batch-get Firestore docs by id (public-read archives; admin token optional).
 * Returns Map<docId, fields>.
 */
async function firestoreBatchGetFields(env, collection, docIds) {
  const project = firebaseProjectIdPublic(env) || String(env.FIREBASE_PROJECT_ID || "").trim();
  const out = new Map();
  if (!project || !collection || !docIds.length) return out;
  const unique = [...new Set(docIds.map((id) => String(id || "").trim()).filter(Boolean))];
  if (!unique.length) return out;

  const cacheKey = `fsdocs:${collection}:${unique.join(",")}`;
  const cached = memGet(cacheKey);
  if (cached && cached instanceof Map) return cached;

  let token = null;
  if (hasFirebaseAdmin(env)) {
    try {
      token = await getGoogleAccessToken(env);
    } catch (err) {
      console.error("firestore_batch_get_token_failed", err);
    }
  }

  const batchUrl = `https://firestore.googleapis.com/v1/projects/${project}/databases/(default)/documents:batchGet`;
  for (let i = 0; i < unique.length; i += 100) {
    const chunk = unique.slice(i, i + 100);
    try {
      const headers = { "Content-Type": "application/json" };
      if (token) headers.Authorization = `Bearer ${token}`;
      const res = await fetch(batchUrl, {
        method: "POST",
        headers,
        body: JSON.stringify({
          documents: chunk.map(
            (id) => `projects/${project}/databases/(default)/documents/${collection}/${id}`
          ),
        }),
      });
      if (!res.ok) {
        console.error("firestore_batch_get_http", collection, res.status);
        continue;
      }
      const rows = await res.json();
      if (!Array.isArray(rows)) continue;
      for (const row of rows) {
        const found = row && row.found;
        if (!found || !found.name) continue;
        const id = found.name.split("/").pop();
        out.set(id, found.fields || {});
      }
    } catch (err) {
      console.error("firestore_batch_get_failed", collection, err);
    }
  }

  // Short isolate cache so stats panels sharing one page load hit FS once.
  memSet(cacheKey, out, 120);
  return out;
}

async function mergeClickPeriodWithFirestore(env, kind, periods) {
  const collection = kind === "year" ? "click_yearly" : "click_monthly";
  const fsDocs = await firestoreBatchGetFields(
    env,
    collection,
    periods.map((row) => row.period)
  );
  return periods.map((row) => {
    const fields = fsDocs.get(row.period);
    const fsTotal = fields ? fsNumberField(fields.total) : 0;
    return { period: row.period, total: Math.max(Number(row.total) || 0, fsTotal) };
  });
}

async function mergePresencePeriodWithFirestore(env, kind, periods) {
  const collection = kind === "year" ? "presence_yearly" : "presence_monthly";
  const fsDocs = await firestoreBatchGetFields(
    env,
    collection,
    periods.map((row) => row.period)
  );
  return periods.map((row) => {
    const fields = fsDocs.get(row.period);
    return {
      period: row.period,
      uniqueVisitors: Math.max(
        Number(row.uniqueVisitors) || 0,
        fields ? fsNumberField(fields.uniqueVisitors) : 0
      ),
      heartbeats: Math.max(Number(row.heartbeats) || 0, fields ? fsNumberField(fields.heartbeats) : 0),
    };
  });
}

async function mergePresenceDailyWithFirestore(env, days) {
  const fsDocs = await firestoreBatchGetFields(
    env,
    "presence_daily",
    days.map((row) => row.date)
  );
  return days.map((row) => {
    const fields = fsDocs.get(row.date);
    if (!fields) return row;
    return {
      date: row.date,
      uniqueVisitors: Math.max(Number(row.uniqueVisitors) || 0, fsNumberField(fields.uniqueVisitors)),
      heartbeats: Math.max(Number(row.heartbeats) || 0, fsNumberField(fields.heartbeats)),
      signedInUniques: Math.max(Number(row.signedInUniques) || 0, fsNumberField(fields.signedInUniques)),
      hourHeartbeats: mergeHourNumberMaps(row.hourHeartbeats, fsMapNumberFields(fields.hourHeartbeats)),
      hourUniques: mergeHourNumberMaps(row.hourUniques, fsMapNumberFields(fields.hourUniques)),
    };
  });
}

async function mergeClickDailyTotalsWithFirestore(env, days) {
  const fsDocs = await firestoreBatchGetFields(
    env,
    "click_daily",
    days.map((row) => row.date)
  );
  return days.map((row) => {
    const fields = fsDocs.get(row.date);
    const fsTotal = fields ? fsNumberField(fields.total) : 0;
    return { date: row.date, total: Math.max(Number(row.total) || 0, fsTotal) };
  });
}

async function mergeClickDailyCountsWithFirestore(env, days, hashes) {
  if (!hashes.length) return days;
  const fsDocs = await firestoreBatchGetFields(
    env,
    "click_daily",
    days.map((row) => row.date)
  );
  return days.map((row) => {
    const fields = fsDocs.get(row.date);
    const fsCounts = fields ? fsMapNumberFields(fields.counts) : {};
    const counts = { ...(row.counts || {}) };
    for (const hash of hashes) {
      const next = Math.max(Number(counts[hash]) || 0, Number(fsCounts[hash]) || 0);
      if (next > 0) counts[hash] = next;
    }
    return { date: row.date, counts };
  });
}

async function handleClickStatsDaily(request, env) {
  if (!preferD1Stats(env)) {
    return json({ ok: true, via: "none", days: [] });
  }
  let lookback = 90;
  let hashes = [];
  if (request.method === "GET") {
    const url = new URL(request.url);
    lookback = parseLookback(url.searchParams.get("days"), 90, 90);
  } else {
    let body;
    try {
      body = await request.json();
    } catch (_) {
      return json({ ok: false, error: "invalid_json" }, 400);
    }
    lookback = parseLookback(body && body.days, 90, 90);
    hashes = Array.isArray(body && body.hashes)
      ? [...new Set(body.hashes.map((h) => String(h || "").trim().toLowerCase()).filter((h) => /^[a-f0-9]{64}$/.test(h)))].slice(
          0,
          400
        )
      : [];
  }
  try {
    if (hashes.length) {
      let days = await d1DailyCountsForHashes(env, lookback, hashes);
      try {
        days = await mergeClickDailyCountsWithFirestore(env, days, hashes);
      } catch (err) {
        console.error("click_stats_daily_fs_merge_failed", err);
      }
      return json({ ok: true, via: "d1", days });
    }
    let days = await d1DailyTotals(env, lookback);
    try {
      days = await mergeClickDailyTotalsWithFirestore(env, days);
    } catch (err) {
      console.error("click_stats_daily_fs_merge_failed", err);
    }
    return json({ ok: true, via: "d1", days });
  } catch (err) {
    console.error("click_stats_daily_failed", err);
    return json({ ok: false, error: "internal_error" }, 500);
  }
}

async function handleClickStatsPeriod(request, env) {
  if (!preferD1Stats(env)) {
    return json({ ok: true, via: "none", kind: "month", periods: [] });
  }
  const url = new URL(request.url);
  const kind = String(url.searchParams.get("kind") || "month").toLowerCase() === "year" ? "year" : "month";
  const lookback = parseLookback(url.searchParams.get("lookback"), kind === "year" ? 10 : 36, kind === "year" ? 10 : 36);
  try {
    let periods = await d1PeriodTotals(env, kind, lookback);
    try {
      periods = await mergeClickPeriodWithFirestore(env, kind, periods);
    } catch (err) {
      console.error("click_stats_period_fs_merge_failed", err);
    }
    return json({ ok: true, via: "d1", kind, periods });
  } catch (err) {
    console.error("click_stats_period_failed", err);
    return json({ ok: false, error: "internal_error" }, 500);
  }
}

const PRESENCE_OS_ALLOW = new Set(["windows", "macos", "ios", "android", "chromeos", "linux", "other"]);

function sanitizePresenceOs(raw) {
  const os = String(raw || "")
    .toLowerCase()
    .replace(/[^a-z]/g, "");
  return PRESENCE_OS_ALLOW.has(os) ? os : "";
}

function sanitizePresenceOsVersion(raw) {
  const v = String(raw || "")
    .replace(/[^0-9A-Za-z._-]/g, "")
    .slice(0, 24);
  return v || "unknown";
}

const PRESENCE_RAM_ALLOW = new Set([
  "under_1gb",
  "1gb",
  "2gb",
  "4gb",
  "8gb",
  "8gb+",
  "16gb",
  "32gb",
  "32gb+",
  "unknown",
]);
const PRESENCE_ARCH_ALLOW = new Set(["x64", "x86", "arm64", "arm", "unknown"]);
const PRESENCE_BROWSER_ALLOW = new Set([
  "chrome",
  "edge",
  "firefox",
  "safari",
  "opera",
  "samsung",
  "brave",
  "other",
]);
const PRESENCE_HW_KIND_ALLOW = new Set(["ram", "cores", "arch", "browser"]);

function sanitizePresenceRam(raw) {
  const v = String(raw || "").toLowerCase();
  if (v === "32gb") return "32gb+";
  return PRESENCE_RAM_ALLOW.has(v) ? v : "";
}

function sanitizePresenceCores(raw) {
  const n = parseInt(String(raw || ""), 10);
  if (Number.isFinite(n) && n >= 1 && n <= 128) return String(n);
  if (String(raw || "").toLowerCase() === "unknown") return "unknown";
  return "";
}

function sanitizePresenceArch(raw) {
  const v = String(raw || "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
  if (v === "amd64" || v === "x8664") return "x64";
  if (v === "aarch64") return "arm64";
  if (v === "ia32") return "x86";
  return PRESENCE_ARCH_ALLOW.has(v) ? v : "";
}

function sanitizePresenceBrowser(raw) {
  const v = String(raw || "")
    .toLowerCase()
    .replace(/[^a-z]/g, "");
  if (v === "msie" || v === "ie" || v === "internetexplorer") return "other";
  if (v === "chromium" || v === "crios") return "chrome";
  if (v === "fxios") return "firefox";
  if (v === "edgios" || v === "msedge") return "edge";
  return PRESENCE_BROWSER_ALLOW.has(v) ? v : "";
}

async function d1RecordPresence(env, opts) {
  const now = opts.now || new Date();
  const day = utcDateId(now);
  const month = utcMonthId(now);
  const year = utcYearId(now);
  const hour = String(now.getUTCHours()).padStart(2, "0");
  const ts = now.getTime();
  const firstDay = opts.firstDay ? 1 : 0;
  const firstHour = opts.firstHour ? 1 : 0;
  const firstSigned = opts.firstSignedInDay ? 1 : 0;
  const firstMonth = opts.firstMonth ? 1 : 0;
  const firstYear = opts.firstYear ? 1 : 0;
  const firstUserDay = opts.firstUserDay ? 1 : 0;
  const os = sanitizePresenceOs(opts.os);
  const osVersion = sanitizePresenceOsVersion(opts.osVersion);
  const ram = sanitizePresenceRam(opts.ram);
  const cores = sanitizePresenceCores(opts.cores);
  const arch = sanitizePresenceArch(opts.arch);
  const browser = sanitizePresenceBrowser(opts.browser);

  const stmts = [
    env.DB.prepare(
      `INSERT INTO presence_daily (date, unique_visitors, heartbeats, signed_in_uniques, updated)
       VALUES (?, ?, 1, ?, ?)
       ON CONFLICT(date) DO UPDATE SET
         unique_visitors = presence_daily.unique_visitors + excluded.unique_visitors,
         heartbeats = presence_daily.heartbeats + 1,
         signed_in_uniques = presence_daily.signed_in_uniques + excluded.signed_in_uniques,
         updated = excluded.updated`
    ).bind(day, firstDay, firstSigned, ts),
    env.DB.prepare(
      `INSERT INTO presence_hour (date, hour, heartbeats, uniques) VALUES (?, ?, 1, ?)
       ON CONFLICT(date, hour) DO UPDATE SET
         heartbeats = presence_hour.heartbeats + 1,
         uniques = presence_hour.uniques + excluded.uniques`
    ).bind(day, hour, firstHour),
    env.DB.prepare(
      `INSERT INTO presence_period (kind, period, unique_visitors, heartbeats, updated)
       VALUES ('month', ?, ?, 1, ?)
       ON CONFLICT(kind, period) DO UPDATE SET
         unique_visitors = presence_period.unique_visitors + excluded.unique_visitors,
         heartbeats = presence_period.heartbeats + 1,
         updated = excluded.updated`
    ).bind(month, firstMonth, ts),
    env.DB.prepare(
      `INSERT INTO presence_period (kind, period, unique_visitors, heartbeats, updated)
       VALUES ('year', ?, ?, 1, ?)
       ON CONFLICT(kind, period) DO UPDATE SET
         unique_visitors = presence_period.unique_visitors + excluded.unique_visitors,
         heartbeats = presence_period.heartbeats + 1,
         updated = excluded.updated`
    ).bind(year, firstYear, ts),
  ];
  if (opts.uidHash && opts.label) {
    stmts.push(
      env.DB.prepare(
        `INSERT INTO presence_user_totals (uid_hash, label, heartbeats, days_active, last_seen, updated)
         VALUES (?, ?, 1, ?, ?, ?)
         ON CONFLICT(uid_hash) DO UPDATE SET
           label = excluded.label,
           heartbeats = presence_user_totals.heartbeats + 1,
           days_active = presence_user_totals.days_active + excluded.days_active,
           last_seen = excluded.last_seen,
           updated = excluded.updated`
      ).bind(opts.uidHash, opts.label, firstUserDay, ts, ts)
    );
  }
  if (os) {
    stmts.push(
      env.DB.prepare(
        `INSERT INTO presence_os_daily (date, os, os_version, unique_visitors, heartbeats, updated)
         VALUES (?, ?, ?, ?, 1, ?)
         ON CONFLICT(date, os, os_version) DO UPDATE SET
           unique_visitors = presence_os_daily.unique_visitors + excluded.unique_visitors,
           heartbeats = presence_os_daily.heartbeats + 1,
           updated = excluded.updated`
      ).bind(day, os, osVersion, firstDay, ts)
    );
  }
  await env.DB.batch(stmts);
  const hwStmts = [];
  const hwRows = [
    ["ram", ram],
    ["cores", cores],
    ["arch", arch],
    ["browser", browser],
  ];
  for (const [kind, value] of hwRows) {
    if (!value || !PRESENCE_HW_KIND_ALLOW.has(kind)) continue;
    hwStmts.push(
      env.DB.prepare(
        `INSERT INTO presence_hw_daily (date, kind, value, unique_visitors, heartbeats, updated)
         VALUES (?, ?, ?, ?, 1, ?)
         ON CONFLICT(date, kind, value) DO UPDATE SET
           unique_visitors = presence_hw_daily.unique_visitors + excluded.unique_visitors,
           heartbeats = presence_hw_daily.heartbeats + 1,
           updated = excluded.updated`
      ).bind(day, kind, value, firstDay, ts)
    );
  }
  if (hwStmts.length) {
    try {
      await env.DB.batch(hwStmts);
    } catch (err) {
      console.error("presence_hw_insert_failed", err);
    }
  }
}

function emptyHourMap() {
  return {};
}

async function d1PresenceDaily(env, lookback) {
  const ids = utcDayIds(lookback);
  if (!hasD1(env) || !ids.length) {
    return ids.map((date) => ({
      date,
      uniqueVisitors: 0,
      heartbeats: 0,
      signedInUniques: 0,
      hourHeartbeats: emptyHourMap(),
      hourUniques: emptyHourMap(),
    }));
  }
  const dailyRows = await env.DB.prepare(
    `SELECT date, unique_visitors, heartbeats, signed_in_uniques FROM presence_daily WHERE date >= ?`
  )
    .bind(ids[0])
    .all();
  const hourRows = await env.DB.prepare(
    `SELECT date, hour, heartbeats, uniques FROM presence_hour WHERE date >= ?`
  )
    .bind(ids[0])
    .all();
  const byDate = new Map();
  for (const row of (dailyRows && dailyRows.results) || []) {
    byDate.set(String(row.date), {
      uniqueVisitors: Number(row.unique_visitors) || 0,
      heartbeats: Number(row.heartbeats) || 0,
      signedInUniques: Number(row.signed_in_uniques) || 0,
      hourHeartbeats: {},
      hourUniques: {},
    });
  }
  for (const row of (hourRows && hourRows.results) || []) {
    const date = String(row.date);
    let rec = byDate.get(date);
    if (!rec) {
      rec = {
        uniqueVisitors: 0,
        heartbeats: 0,
        signedInUniques: 0,
        hourHeartbeats: {},
        hourUniques: {},
      };
      byDate.set(date, rec);
    }
    const hour = String(row.hour || "").padStart(2, "0");
    rec.hourHeartbeats[hour] = Number(row.heartbeats) || 0;
    rec.hourUniques[hour] = Number(row.uniques) || 0;
  }
  return ids.map((date) => {
    const rec = byDate.get(date);
    return {
      date,
      uniqueVisitors: rec ? rec.uniqueVisitors : 0,
      heartbeats: rec ? rec.heartbeats : 0,
      signedInUniques: rec ? rec.signedInUniques : 0,
      hourHeartbeats: rec ? rec.hourHeartbeats : {},
      hourUniques: rec ? rec.hourUniques : {},
    };
  });
}

async function d1PresencePeriod(env, kind, lookback) {
  const periods = kind === "year" ? utcYearIds(lookback) : utcMonthIds(lookback);
  if (!hasD1(env) || !periods.length) {
    return periods.map((period) => ({ period, uniqueVisitors: 0, heartbeats: 0 }));
  }
  const placeholders = periods.map(() => "?").join(",");
  const rows = await env.DB.prepare(
    `SELECT period, unique_visitors, heartbeats FROM presence_period WHERE kind = ? AND period IN (${placeholders})`
  )
    .bind(kind, ...periods)
    .all();
  const byPeriod = new Map();
  for (const row of (rows && rows.results) || []) {
    byPeriod.set(String(row.period), {
      uniqueVisitors: Number(row.unique_visitors) || 0,
      heartbeats: Number(row.heartbeats) || 0,
    });
  }
  return periods.map((period) => {
    const rec = byPeriod.get(period);
    return {
      period,
      uniqueVisitors: rec ? rec.uniqueVisitors : 0,
      heartbeats: rec ? rec.heartbeats : 0,
    };
  });
}

async function handlePresenceStatsDaily(request, env) {
  if (!preferD1Stats(env)) {
    return json({ ok: true, via: "none", days: [] });
  }
  const url = new URL(request.url);
  const lookback = parseLookback(url.searchParams.get("days"), 32, 32);
  try {
    let days = await d1PresenceDaily(env, lookback);
    try {
      days = await mergePresenceDailyWithFirestore(env, days);
    } catch (err) {
      console.error("presence_stats_daily_fs_merge_failed", err);
    }
    return json({ ok: true, via: "d1", days });
  } catch (err) {
    console.error("presence_stats_daily_failed", err);
    return json({ ok: false, error: "internal_error" }, 500);
  }
}

async function d1PresenceOs(env, lookback) {
  const ids = utcDayIds(lookback);
  if (!hasD1(env) || !ids.length) {
    return { days: [], totals: [] };
  }
  const rows = await env.DB.prepare(
    `SELECT date, os, os_version, unique_visitors, heartbeats
     FROM presence_os_daily
     WHERE date >= ?
     ORDER BY date ASC, unique_visitors DESC`
  )
    .bind(ids[0])
    .all();
  const days = [];
  const totalsMap = new Map();
  for (const row of (rows && rows.results) || []) {
    const os = String(row.os || "");
    const osVersion = String(row.os_version || "unknown");
    const uniqueVisitors = Number(row.unique_visitors) || 0;
    const heartbeats = Number(row.heartbeats) || 0;
    days.push({
      date: String(row.date || ""),
      os,
      osVersion,
      uniqueVisitors,
      heartbeats,
    });
    const key = os + "\0" + osVersion;
    const cur = totalsMap.get(key) || { os, osVersion, uniqueVisitors: 0, heartbeats: 0 };
    cur.uniqueVisitors += uniqueVisitors;
    cur.heartbeats += heartbeats;
    totalsMap.set(key, cur);
  }
  const totals = Array.from(totalsMap.values()).sort(
    (a, b) => b.uniqueVisitors - a.uniqueVisitors || String(a.os).localeCompare(String(b.os))
  );
  return { days, totals };
}

async function d1PresenceHardware(env, lookback) {
  const ids = utcDayIds(lookback);
  const empty = { ram: [], cores: [], arch: [], browser: [] };
  if (!hasD1(env) || !ids.length) return empty;
  const rows = await env.DB.prepare(
    `SELECT kind, value, SUM(unique_visitors) AS unique_visitors, SUM(heartbeats) AS heartbeats
     FROM presence_hw_daily
     WHERE date >= ?
     GROUP BY kind, value`
  )
    .bind(ids[0])
    .all();
  const out = { ram: [], cores: [], arch: [], browser: [] };
  for (const row of (rows && rows.results) || []) {
    const kind = String(row.kind || "");
    if (!out[kind]) continue;
    out[kind].push({
      value: String(row.value || "unknown"),
      uniqueVisitors: Number(row.unique_visitors) || 0,
      heartbeats: Number(row.heartbeats) || 0,
    });
  }
  const ramOrder = ["under_1gb", "1gb", "2gb", "4gb", "8gb", "8gb+", "16gb", "32gb+", "unknown"];
  out.ram.sort((a, b) => ramOrder.indexOf(a.value) - ramOrder.indexOf(b.value) || b.uniqueVisitors - a.uniqueVisitors);
  out.cores.sort((a, b) => {
    const an = parseInt(a.value, 10);
    const bn = parseInt(b.value, 10);
    if (Number.isFinite(an) && Number.isFinite(bn)) return an - bn;
    if (Number.isFinite(an)) return -1;
    if (Number.isFinite(bn)) return 1;
    return String(a.value).localeCompare(String(b.value));
  });
  const archOrder = ["x64", "arm64", "x86", "arm", "unknown"];
  out.arch.sort((a, b) => archOrder.indexOf(a.value) - archOrder.indexOf(b.value) || b.uniqueVisitors - a.uniqueVisitors);
  const browserOrder = ["chrome", "edge", "safari", "firefox", "opera", "brave", "samsung", "other"];
  out.browser.sort(
    (a, b) =>
      b.uniqueVisitors - a.uniqueVisitors ||
      browserOrder.indexOf(a.value) - browserOrder.indexOf(b.value) ||
      String(a.value).localeCompare(String(b.value))
  );
  return out;
}

async function handlePresenceStatsHardware(request, env) {
  if (!preferD1Stats(env)) {
    return json({ ok: true, via: "none", ram: [], cores: [], arch: [], browser: [] });
  }
  const url = new URL(request.url);
  const lookback = parseLookback(url.searchParams.get("days"), 32, 32);
  try {
    const data = await d1PresenceHardware(env, lookback);
    return json({
      ok: true,
      via: "d1",
      ram: data.ram,
      cores: data.cores,
      arch: data.arch,
      browser: data.browser,
    });
  } catch (err) {
    console.error("presence_stats_hardware_failed", err);
    return json({ ok: false, error: "internal_error" }, 500);
  }
}

async function handlePresenceStatsOs(request, env) {
  if (!preferD1Stats(env)) {
    return json({ ok: true, via: "none", days: [], totals: [] });
  }
  const url = new URL(request.url);
  const lookback = parseLookback(url.searchParams.get("days"), 32, 32);
  try {
    const data = await d1PresenceOs(env, lookback);
    return json({ ok: true, via: "d1", days: data.days, totals: data.totals });
  } catch (err) {
    console.error("presence_stats_os_failed", err);
    return json({ ok: false, error: "internal_error" }, 500);
  }
}

async function handlePresenceStatsPeriod(request, env) {
  if (!preferD1Stats(env)) {
    return json({ ok: true, via: "none", kind: "month", periods: [] });
  }
  const url = new URL(request.url);
  const kind = String(url.searchParams.get("kind") || "month").toLowerCase() === "year" ? "year" : "month";
  const lookback = parseLookback(url.searchParams.get("lookback"), kind === "year" ? 10 : 36, kind === "year" ? 10 : 36);
  try {
    let periods = await d1PresencePeriod(env, kind, lookback);
    try {
      periods = await mergePresencePeriodWithFirestore(env, kind, periods);
    } catch (err) {
      console.error("presence_stats_period_fs_merge_failed", err);
    }
    return json({ ok: true, via: "d1", kind, periods });
  } catch (err) {
    console.error("presence_stats_period_failed", err);
    return json({ ok: false, error: "internal_error" }, 500);
  }
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
  if (!project || !norms.length) return out;

  const memMissing = [];
  for (const norm of norms) {
    const v = memGet("c:" + norm);
    if (v !== undefined) out[norm] = v;
    else memMissing.push(norm);
  }
  if (!memMissing.length) return out;

  // Per-URL Cache API match/put burns subrequests (~2N). Skip cache for larger batches.
  const useCache = memMissing.length <= 20;
  const cache = caches.default;
  let missing = [];
  if (useCache) {
    for (const norm of memMissing) {
      const hash = await sha256Hex(norm);
      const hit = await cache.match(fsClickNormCacheRequest(hash));
      if (hit) {
        out[norm] = Number(await hit.text()) || 0;
        memSet("c:" + norm, out[norm], FS_CLICK_CACHE_TTL_SEC);
      } else {
        missing.push(norm);
      }
    }
  } else {
    missing.push(...memMissing);
  }
  if (!missing.length) return out;

  // Visitors page through the same default-sorted chunks, so whole batches repeat.
  const batchNorms = missing.slice();
  const batchHit = await batchCacheGet("clicks", batchNorms);
  if (batchHit) {
    const stillMissing = [];
    for (const norm of missing) {
      if (Object.prototype.hasOwnProperty.call(batchHit, norm)) {
        out[norm] = Number(batchHit[norm]) || 0;
        memSet("c:" + norm, out[norm], FS_CLICK_CACHE_TTL_SEC);
      } else {
        stillMissing.push(norm);
      }
    }
    missing = stillMissing;
    if (!missing.length) return out;
  }

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
  let batchOk = false;

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
      batchOk = true;
      const rows = await res.json();
      if (!Array.isArray(rows)) continue;
      for (const row of rows) {
        const found = row && row.found;
        if (!found || !found.name) continue;
        const id = found.name.split("/").pop();
        const n = fsNumberField(found.fields && found.fields.count);
        idToCount.set(id, n);
      }
    } catch (err) {
      console.error("get_clicks_batch_failed", err);
    }
  }

  for (const norm of missing) {
    // Sum distinct Firestore docs across URL-key variants. Legacy clients hashed
    // lowercase/stripped URLs; modern clients use URL.href — clicks split across
    // two docs. Math.max under-counted (e.g. 207+175 → showed 207 instead of 382).
    let total = 0;
    const seenIds = new Set();
    let sawAny = false;
    for (const variant of clickUrlVariants(norm)) {
      const id = await sha256Hex(variant);
      if (seenIds.has(id)) continue;
      seenIds.add(id);
      if (idToCount.has(id)) {
        sawAny = true;
        total += Number(idToCount.get(id)) || 0;
      }
    }
    // Only set/cache when we observed real docs — omit key on FS failure so
    // clients keep disk cache instead of treating missing as 0.
    if (sawAny) {
      out[norm] = total;
      memSet("c:" + norm, total, FS_CLICK_CACHE_TTL_SEC);
      if (useCache) await cachePutClickNorm(norm, total, ctx);
    } else if (batchOk) {
      // Confirmed empty (batch succeeded, no docs) — safe to report 0.
      out[norm] = 0;
      memSet("c:" + norm, 0, FS_CLICK_CACHE_TTL_SEC);
      if (useCache) await cachePutClickNorm(norm, 0, ctx);
    }
  }
  if (batchOk && !batchHit) {
    const snapshot = {};
    for (const norm of batchNorms) {
      if (Object.prototype.hasOwnProperty.call(out, norm)) snapshot[norm] = out[norm];
    }
    await batchCachePut("clicks", batchNorms, snapshot, FS_CLICK_CACHE_TTL_SEC, ctx);
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
  // Pull extra docs so legacy+modern hash pairs for the same URL can be summed
  // before we take the top N unique links.
  // Every listed doc is a billed read; 1.5x covers the few legacy/modern duplicates.
  const fetchCap = Math.min(150, Math.max(Math.ceil(cap * 1.5), 60));

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

  function mergeTopOpenRows(rows) {
    const byNorm = new Map();
    for (const row of rows || []) {
      if (!row || !row.url) continue;
      const norm = normalizeUrl(row.url) || legacyNormalizeUrl(row.url);
      if (!norm) continue;
      const prev = byNorm.get(norm);
      const count = Number(row.count) || 0;
      if (!prev) {
        byNorm.set(norm, { url: normalizeUrl(row.url) || row.url, count });
      } else {
        prev.count += count;
        // Prefer the modern normalized URL as the display key.
        const modern = normalizeUrl(row.url);
        if (modern) prev.url = modern;
      }
    }
    return [...byNorm.values()].sort((a, b) => b.count - a.count).slice(0, cap);
  }

  try {
    const listUrl =
      `https://firestore.googleapis.com/v1/projects/${project}/databases/(default)/documents/link_clicks` +
      `?pageSize=${fetchCap}&orderBy=count%20desc`;
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
      const merged = mergeTopOpenRows(out);
      if (merged.length) return merged;
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
          limit: fetchCap,
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
    return mergeTopOpenRows(out);
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
    if (preferD1Stats(env)) {
      const count = await d1IncrementClick(env, docId, displayUrl || norm);
      memSet("c:" + norm, count, FS_CLICK_CACHE_TTL_SEC);
      await cachePutClickNorm(norm, count, ctx);
      return json({
        ok: true,
        via: "d1",
        norm,
        hash: docId,
        count,
        rate: { count: rate.count, limit: rate.limit },
      });
    }
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
      if (count != null) {
        memSet("c:" + norm, count, FS_CLICK_CACHE_TTL_SEC);
        await cachePutClickNorm(norm, count, ctx);
      }
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
    let counts = {};
    let via = "none";
    if (preferD1Stats(env)) {
      counts = await d1GetClickCounts(env, norms);
      via = "d1";
    } else if (hasFirebaseAdmin(env) || env.FIREBASE_PROJECT_ID) {
      counts = await firestoreGetCounts(env, norms, ctx);
      via = "firestore";
    }
    const edgeCounts = await edgeGetCounts(norms);
    const out = {};
    for (const norm of norms) {
      const hasStore = Object.prototype.hasOwnProperty.call(counts, norm);
      const store = hasStore ? Number(counts[norm]) || 0 : null;
      const edge = Number(edgeCounts[norm]) || 0;
      if (hasStore) {
        out[norm] = Math.max(store, edge);
      } else if (edge > 0) {
        out[norm] = edge;
      } else if (via === "d1") {
        out[norm] = 0;
      }
      // Firestore/edge: omit missing keys so clients keep disk cache.
    }
    return json({ ok: true, counts: out, via });
  } catch (err) {
    console.error("get_clicks_failed", err);
    return json({ ok: false, error: "internal_error" }, 500);
  }
}

function fsNumberField(field) {
  if (!field || typeof field !== "object") return 0;
  if (field.integerValue != null) return Number(field.integerValue) || 0;
  if (field.doubleValue != null) return Math.trunc(Number(field.doubleValue)) || 0;
  return 0;
}

async function firestoreGetRatings(env, norms, ctx) {
  const project = env.FIREBASE_PROJECT_ID;
  const out = {};
  if (!project || !hasFirebaseAdmin(env) || !norms.length) return out;

  // Cap batch size: avoid per-URL Cache API (each match/put counts as a subrequest).
  // Free Workers allow ~50 subrequests; token + a few batchGets must stay under that.
  const capped = [];
  for (const norm of norms.slice(0, 40)) {
    const v = memGet("r:" + norm);
    if (v !== undefined) out[norm] = v;
    else capped.push(norm);
  }
  if (!capped.length) return out;

  const batchHit = await batchCacheGet("ratings", capped);
  if (batchHit && capped.every((n) => Object.prototype.hasOwnProperty.call(batchHit, n))) {
    for (const norm of capped) {
      const r = batchHit[norm] || {};
      out[norm] = { up: Number(r.up) || 0, down: Number(r.down) || 0 };
      memSet("r:" + norm, out[norm], FS_RATING_CACHE_TTL_SEC);
    }
    return out;
  }

  let token;
  try {
    token = await getGoogleAccessToken(env);
  } catch (err) {
    console.error("get_ratings_token_failed", err);
    return out;
  }

  const allIds = [];
  const seenId = new Set();
  const normVariants = new Map();
  for (const norm of capped) {
    const variants = clickUrlVariants(norm);
    normVariants.set(norm, variants);
    for (const variant of variants) {
      const id = await sha256Hex(variant);
      if (seenId.has(id)) continue;
      seenId.add(id);
      allIds.push(id);
    }
  }

  const idToRating = new Map();
  const batchUrl = `https://firestore.googleapis.com/v1/projects/${project}/databases/(default)/documents:batchGet`;
  let batchOk = false;

  for (let i = 0; i < allIds.length; i += 100) {
    const chunk = allIds.slice(i, i + 100);
    try {
      const res = await fetch(batchUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          documents: chunk.map(
            (id) => `projects/${project}/databases/(default)/documents/linkRatings/${id}`
          ),
        }),
      });
      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        console.error("get_ratings_batch_http", res.status, String(errText).slice(0, 300));
        continue;
      }
      batchOk = true;
      const rows = await res.json();
      if (!Array.isArray(rows)) continue;
      for (const row of rows) {
        const found = row && row.found;
        if (!found || !found.name) continue;
        const id = found.name.split("/").pop();
        const fields = found.fields || {};
        idToRating.set(id, {
          up: fsNumberField(fields.up),
          down: fsNumberField(fields.down),
        });
      }
    } catch (err) {
      console.error("get_ratings_batch_failed", err);
    }
  }

  if (!batchOk) return out;

  for (const norm of capped) {
    let best = { up: 0, down: 0 };
    let sawAny = false;
    const used = new Set();
    for (const variant of normVariants.get(norm) || []) {
      const id = await sha256Hex(variant);
      if (used.has(id)) continue;
      used.add(id);
      if (!idToRating.has(id)) continue;
      const ag = idToRating.get(id);
      if (!sawAny || ag.up > best.up || ag.down > best.down) {
        best = ag;
        sawAny = true;
      }
    }
    // Always include keys so clients can tell "fetched" from "request failed".
    out[norm] = best;
    memSet("r:" + norm, best, FS_RATING_CACHE_TTL_SEC);
  }
  const snapshot = {};
  for (const norm of capped) snapshot[norm] = out[norm];
  await batchCachePut("ratings", capped, snapshot, FS_RATING_CACHE_TTL_SEC, ctx);
  return out;
}

async function handleGetRatings(request, env, ctx) {
  let body;
  try {
    body = await request.json();
  } catch (_) {
    return json({ ok: false, error: "invalid_json" }, 400);
  }
  const urls = Array.isArray(body && body.urls) ? body.urls.slice(0, 40) : [];
  const norms = [...new Set(urls.map(normalizeUrl).filter((u) => u && u.length >= 10))];
  try {
    let ratings = {};
    let via = "none";
    if (preferD1Stats(env)) {
      ratings = await d1GetRatings(env, norms);
      via = "d1";
    } else if (hasFirebaseAdmin(env)) {
      ratings = await firestoreGetRatings(env, norms, ctx);
      via = "firestore";
    } else {
      return json({ ok: true, ratings: {}, warning: "stats_store_unavailable" });
    }
    if (via === "d1") {
      for (const norm of norms) {
        if (!Object.prototype.hasOwnProperty.call(ratings, norm)) {
          ratings[norm] = { up: 0, down: 0 };
        }
      }
    }
    const payload = { ok: true, ratings, via };
    const token = bearerToken(request);
    if (token && preferD1Stats(env)) {
      const user = await verifyFirebaseIdToken(env, token);
      if (user && user.uid) {
        payload.self = await d1GetSelfVotes(env, user.uid, norms);
      }
    }
    return json(payload);
  } catch (err) {
    console.error("get_ratings_failed", err);
    return json({ ok: false, error: "internal_error" }, 500);
  }
}

async function handleLinkRatingVote(request, env, ctx) {
  if (!preferD1Stats(env)) {
    return json({ ok: false, error: "d1_required" }, 503);
  }
  const user = await verifyFirebaseIdToken(env, bearerToken(request));
  if (!user || !user.uid) {
    return json({ ok: false, error: "unauthorized" }, 401);
  }

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
  let nextVote = Number(body && body.vote);
  if (nextVote !== 1 && nextVote !== -1 && nextVote !== 0) {
    return json({ ok: false, error: "invalid_vote" }, 400);
  }

  const ip = clientIp(request);
  const rate = await rateLimitOk(ip, ctx, { max: 120, prefix: "rating" });
  if (!rate.ok) {
    return json(
      { ok: false, error: "rate_limited", limit: rate.limit, windowSec: RATE_LIMIT_WINDOW_SEC },
      429
    );
  }

  try {
    const result = await d1ApplyRatingVote(env, user.uid, norm, nextVote);
    memSet("r:" + norm, { up: result.up, down: result.down }, FS_RATING_CACHE_TTL_SEC);
    return json({
      ok: true,
      via: "d1",
      norm,
      hash: result.hash,
      up: result.up,
      down: result.down,
      vote: result.vote,
    });
  } catch (err) {
    console.error("link_rating_vote_failed", err);
    return json({ ok: false, error: "internal_error" }, 500);
  }
}

async function handleTopOpens(request, env, ctx) {
  const memHit = memGet("top-opens");
  if (memHit !== undefined) {
    return cors(
      new Response(memHit, {
        status: 200,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": `public, max-age=${TOP_OPENS_CACHE_TTL_SEC}`,
          "X-Cache": "MEM",
        },
      })
    );
  }
  const cache = caches.default;
  // v5: D1 preview seeds store per-hash counts (not legacy+modern sums).
  const cacheKey = new Request("https://top-opens.proxy-list.internal/v5");
  try {
    const hit = await cache.match(cacheKey);
    if (hit) {
      const body = await hit.text();
      memSet("top-opens", body, TOP_OPENS_CACHE_TTL_SEC);
      return cors(
        new Response(body, {
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
    let links = [];
    let via = "firestore";
    if (preferD1Stats(env)) {
      links = await d1TopOpens(env, TOP_OPENS_LIMIT);
      via = "d1";
    } else {
      links = await firestoreTopOpens(env, TOP_OPENS_LIMIT);
    }
    let payload = JSON.stringify({ ok: true, links, via });
    // Cache failures briefly too, so a quota outage isn't re-queried on every page view.
    const ttl = links.length > 0 ? TOP_OPENS_CACHE_TTL_SEC : TOP_OPENS_FAIL_TTL_SEC;
    if (links.length > 0) {
      memSet("top-opens-last-good", payload, TOP_OPENS_LAST_GOOD_TTL_SEC);
      if (ctx && typeof ctx.waitUntil === "function") {
        ctx.waitUntil(
          cache.put(
            TOP_OPENS_LAST_GOOD_REQ,
            new Response(payload, {
              headers: {
                "Content-Type": "application/json; charset=utf-8",
                "Cache-Control": `public, max-age=${TOP_OPENS_LAST_GOOD_TTL_SEC}`,
              },
            })
          )
        );
      }
    } else {
      // Firestore read failed (usually quota): serve the last good list instead of an empty one.
      let lastGood = memGet("top-opens-last-good");
      if (lastGood === undefined) {
        try {
          const hit = await cache.match(TOP_OPENS_LAST_GOOD_REQ);
          if (hit) lastGood = await hit.text();
        } catch (_) {}
      }
      if (lastGood) {
        try {
          const o = JSON.parse(lastGood);
          if (o && Array.isArray(o.links) && o.links.length) {
            payload = JSON.stringify({ ok: true, links: o.links, stale: true });
          }
        } catch (_) {}
      }
    }
    memSet("top-opens", payload, ttl);
    const res = new Response(payload, {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": `public, max-age=${ttl}`,
      },
    });
    if (ctx && typeof ctx.waitUntil === "function") {
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

  const uid = String((body && body.uid) || "")
    .trim()
    .slice(0, MAX_UID_LEN)
    .replace(/[^a-zA-Z0-9]/g, "");
  const anonymous = !!(body && body.anonymous);
  const displayName = sanitizeDisplayName(body && body.displayName);

  // Count after parsing uid so signed-in users collapse across proxy/raw tabs.
  const active = await touchActiveSession(sessionId, ctx, { uid, anonymous });

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
    if (preferD1Stats(env)) {
      await d1RecordPresence(env, {
        now,
        firstDay,
        firstHour,
        firstMonth,
        firstYear,
        firstSignedInDay,
        firstUserDay,
        uidHash: uidHash || "",
        label,
        os: body && body.os,
        osVersion: body && body.osVersion,
        ram: body && body.ram,
        cores: body && body.cores,
        arch: body && body.arch,
        browser: body && body.browser,
      });
      return json({
        ok: true,
        via: "d1",
        active,
        day,
        firstDay,
        firstHour,
        rate: { count: rate.count, limit: rate.limit },
      });
    }
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
    return json({
      ok: true,
      via: "edge",
      active,
      day,
      firstDay,
      firstHour,
      warning: "presence_persist_failed",
      rate: { count: rate.count, limit: rate.limit },
    });
  }
}

/** Forward Sentry envelopes so ad blockers that filter *.sentry.io still receive events. */
async function handleSentryTunnel(request) {
  let buf;
  try {
    buf = await request.arrayBuffer();
  } catch (_) {
    return json({ ok: false, error: "empty" }, 400);
  }
  if (!buf || buf.byteLength < 2 || buf.byteLength > 256000) {
    return json({ ok: false, error: "bad_payload" }, 413);
  }
  const preview = new TextDecoder().decode(buf.slice(0, 2048));
  const firstLine = String(preview.split("\n")[0] || "").trim();
  let dsnHost = "";
  let projectId = "";
  try {
    const header = JSON.parse(firstLine);
    if (header && header.dsn) {
      const u = new URL(String(header.dsn));
      dsnHost = String(u.host || "");
      projectId = String(u.pathname || "").replace(/^\//, "").split("/")[0];
    }
  } catch (_) {}
  if (!dsnHost || !projectId) {
    return json({ ok: false, error: "bad_dsn" }, 400);
  }
  if (!/\.ingest\.sentry\.io$/i.test(dsnHost) && !/\.ingest\.[a-z]+\.sentry\.io$/i.test(dsnHost)) {
    return json({ ok: false, error: "bad_dsn_host" }, 400);
  }
  try {
    const upstream = await fetch("https://" + dsnHost + "/api/" + encodeURIComponent(projectId) + "/envelope/", {
      method: "POST",
      headers: {
        "Content-Type": request.headers.get("Content-Type") || "application/x-sentry-envelope",
      },
      body: buf,
    });
    return cors(
      new Response(upstream.body, {
        status: upstream.status,
        headers: { "Content-Type": upstream.headers.get("Content-Type") || "application/json" },
      })
    );
  } catch (err) {
    console.warn("sentry_tunnel_failed", err && err.message ? err.message : err);
    return json({ ok: false, error: "tunnel_failed" }, 502);
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

  if (!uid || !isSubmissionAdminUid(env, uid)) {
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
