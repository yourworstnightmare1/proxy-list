/**
 * Shared presence ping for User Statistics aggregates (Worker → Firestore).
 * Safe no-op when the Worker API is unavailable (e.g. plain GitHub Pages without fallback).
 */
(function (global) {
  "use strict";

  var lastPingAt = 0;
  var MIN_PING_GAP_MS = 45 * 1000;
  var inFlight = false;
  var SESSION_KEY = "proxyList_presence_session_v1";
  var cachedSessionId = "";
  /** Same-origin on Cloudflare Workers; cross-origin fallback for GitHub Pages. */
  var DEFAULT_WORKER_ORIGIN = "https://proxy-list.jasonthegamer48.workers.dev";

  function configuredApiOrigin() {
    try {
      var raw = global.__PROXY_LIST_API_BASE__;
      if (raw == null || raw === false) return "";
      var s = String(raw).trim().replace(/\/+$/, "");
      return s;
    } catch (_) {
      return "";
    }
  }

  function hostIsGitHubPages() {
    try {
      var host = String((global.location && global.location.hostname) || "").toLowerCase();
      return host === "github.io" || host.endsWith(".github.io");
    } catch (_) {
      return false;
    }
  }

  function hostIsLocalDev() {
    try {
      var host = String((global.location && global.location.hostname) || "").toLowerCase();
      return host === "localhost" || host === "127.0.0.1" || host === "[::1]";
    } catch (_) {
      return false;
    }
  }

  /** Ultraviolet / Scramjet (and similar) rewrite location.hostname to the proxy host. */
  function looksLikeWebProxy() {
    try {
      var loc = global.location || {};
      var href = String(loc.href || "");
      var path = String(loc.pathname || "");
      var host = String(loc.hostname || "").toLowerCase();
      if (/\/uv\/|ultraviolet|\/scramjet|\/sj\/|bare-mux|\/service\/|\/proxy\//i.test(href + path)) {
        return true;
      }
      if (
        /github\.io|yourworstnightmare1/i.test(path) &&
        host !== "github.io" &&
        !host.endsWith(".github.io")
      ) {
        return true;
      }
      return false;
    } catch (_) {
      return false;
    }
  }

  /** Match workers/site.js normalizeUrl — used for link_clicks doc ids. */
  function normalizeClickUrl(raw) {
    var u = String(raw || "").trim();
    if (!u) return "";
    if (!/^https?:\/\//i.test(u)) u = "https://" + u;
    try {
      var parsed = new URL(u);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "";
      var out = parsed.href;
      if (out.endsWith("/") && (out.match(/\//g) || []).length > 3) out = out.replace(/\/+$/, "");
      return out.slice(0, 2048);
    } catch (_) {
      return "";
    }
  }

  /** Pre-2026 client key (lowercase) — ratings and older click docs may use this hash. */
  function legacyNormalizeClickUrl(raw) {
    return String(raw || "")
      .trim()
      .replace(/\/+$/, "")
      .toLowerCase();
  }

  function clickUrlVariants(raw) {
    var modern = normalizeClickUrl(raw);
    var legacy = legacyNormalizeClickUrl(raw);
    var out = [];
    if (modern) out.push(modern);
    if (legacy && legacy !== modern) out.push(legacy);
    return out;
  }

  function resolveApiUrl(path) {
    var p = path.charAt(0) === "/" ? path : "/" + path;
    var configured = configuredApiOrigin();
    if (configured) return configured + p;
    if (hostIsGitHubPages() || hostIsLocalDev() || looksLikeWebProxy()) return DEFAULT_WORKER_ORIGIN + p;
    try {
      var pathname = String((global.location && global.location.pathname) || "");
      if (
        /\/stats(\/|$)/i.test(pathname) ||
        /\/contribute(\/|$)/i.test(pathname) ||
        /\/community(\/|$)/i.test(pathname) ||
        /\/about(\/|$)/i.test(pathname) ||
        /\/account(\/|$)/i.test(pathname) ||
        /\/login(\/|$)/i.test(pathname) ||
        /\/admin(\/|$)/i.test(pathname) ||
        /\/games-browser(\/|$)/i.test(pathname)
      ) {
        return ".." + p;
      }
    } catch (_) {}
    return "." + p;
  }

  function getSessionId() {
    if (cachedSessionId && cachedSessionId.length >= 8) return cachedSessionId;
    try {
      var existing = global.sessionStorage && global.sessionStorage.getItem(SESSION_KEY);
      if (existing && String(existing).length >= 8) {
        cachedSessionId = String(existing).replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 128);
        if (cachedSessionId.length >= 8) return cachedSessionId;
      }
    } catch (_) {}
    var id = "";
    try {
      if (global.crypto && typeof global.crypto.getRandomValues === "function") {
        var bytes = new Uint8Array(16);
        global.crypto.getRandomValues(bytes);
        id = Array.prototype.map
          .call(bytes, function (b) {
            return ("0" + b.toString(16)).slice(-2);
          })
          .join("");
      }
    } catch (_) {}
    if (!id || id.length < 8) {
      id = "s" + String(Date.now()) + String(Math.floor(Math.random() * 1e9));
    }
    cachedSessionId = id.slice(0, 128);
    try {
      if (global.sessionStorage) global.sessionStorage.setItem(SESSION_KEY, cachedSessionId);
    } catch (_) {}
    return cachedSessionId;
  }

  function ping(opts) {
    opts = opts || {};
    var sessionId = String(opts.sessionId || getSessionId() || "").trim();
    if (!sessionId || sessionId.length < 8) return Promise.resolve({ ok: false, error: "no_session" });
    var now = Date.now();
    if (!opts.force && (inFlight || now - lastPingAt < MIN_PING_GAP_MS)) {
      return Promise.resolve({ ok: true, skipped: true });
    }
    inFlight = true;
    lastPingAt = now;

    var body = {
      sessionId: sessionId.slice(0, 128),
      uid: opts.uid ? String(opts.uid).slice(0, 128) : "",
      anonymous: !!opts.anonymous,
      displayName: opts.displayName ? String(opts.displayName).slice(0, 32) : "",
    };

    return fetch(resolveApiUrl("/api/presence-ping"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      keepalive: true,
      mode: "cors",
    })
      .then(function (res) {
        return res.json().catch(function () {
          return { ok: res.ok };
        });
      })
      .catch(function () {
        return { ok: false, error: "network" };
      })
      .finally(function () {
        inFlight = false;
      });
  }

  function fetchActiveCount() {
    return fetch(resolveApiUrl("/api/presence-active"), {
      method: "GET",
      mode: "cors",
      cache: "no-store",
    })
      .then(function (res) {
        return res.json().catch(function () {
          return { ok: false };
        });
      })
      .then(function (data) {
        var n = data && Number(data.active);
        return Number.isFinite(n) && n >= 0 ? n : null;
      })
      .catch(function () {
        return null;
      });
  }

  function apiUrl(path) {
    return resolveApiUrl(path);
  }

  global.ProxyListPresence = {
    ping: ping,
    fetchActiveCount: fetchActiveCount,
    getSessionId: getSessionId,
    apiUrl: apiUrl,
    looksLikeWebProxy: looksLikeWebProxy,
    normalizeClickUrl: normalizeClickUrl,
    legacyNormalizeClickUrl: legacyNormalizeClickUrl,
    clickUrlVariants: clickUrlVariants,
  };
})(typeof window !== "undefined" ? window : globalThis);
