/**
 * Shared presence ping for User Statistics aggregates (Worker → Firestore).
 * Safe no-op when the Worker API is unavailable (e.g. plain GitHub Pages without fallback).
 *
 * Under Scramjet/Ultraviolet/etc., relative /api calls are rewritten and fail. We detect
 * proxied hosts and always hit the production Worker origin with CORS instead.
 */
(function (global) {
  "use strict";

  var lastPingAt = 0;
  var MIN_PING_GAP_MS = 45 * 1000;
  var inFlight = false;
  var SESSION_KEY = "proxyList_presence_session_v1";
  var cachedSessionId = "";
  /** Same-origin on Cloudflare Workers; cross-origin fallback for GitHub Pages / proxies. */
  var DEFAULT_WORKER_ORIGIN = "https://proxy-list.jasonthegamer48.workers.dev";
  var activePollTimer = null;
  var ACTIVE_POLL_MS = 60 * 1000;
  var lastKnownActive = null;

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

  /** True when this page is served by our Cloudflare Worker (API is same-origin). */
  function hostIsOurWorkerDeployment() {
    try {
      var host = String((global.location && global.location.hostname) || "").toLowerCase();
      if (host === "proxy-list.jasonthegamer48.workers.dev") return true;
      // Workers Builds previews: <branch>-proxy-list.jasonthegamer48.workers.dev
      if (/-proxy-list\.jasonthegamer48\.workers\.dev$/i.test(host)) return true;
      if (/\.proxy-list\.jasonthegamer48\.workers\.dev$/i.test(host)) return true;
      return false;
    } catch (_) {
      return false;
    }
  }

  /** Ultraviolet / Scramjet / Eclipse (and similar) rewrite location or inject a service worker. */
  function looksLikeWebProxy() {
    try {
      var loc = global.location || {};
      var href = String(loc.href || "");
      var path = String(loc.pathname || "");
      var host = String(loc.hostname || "").toLowerCase();
      var search = String(loc.search || "");
      var blob = href + path + search;

      if (/\/uv\/|ultraviolet|\/scramjet|\/sj\/|bare-mux|\/service\/|\/proxy\/|\/eclipse\//i.test(blob)) {
        return true;
      }
      if (
        /github\.io|yourworstnightmare1|proxy-list\.jasonthegamer48/i.test(path) &&
        host !== "github.io" &&
        !host.endsWith(".github.io") &&
        !hostIsOurWorkerDeployment() &&
        !hostIsLocalDev()
      ) {
        return true;
      }
      // Proxies often inject a <base href="https://real-site/..."> while location stays on the proxy host.
      try {
        var baseEl = global.document && global.document.querySelector("base[href]");
        if (baseEl) {
          var baseHref = String(baseEl.href || baseEl.getAttribute("href") || "");
          if (/github\.io|workers\.dev|yourworstnightmare1/i.test(baseHref)) {
            var baseHost = "";
            try {
              baseHost = new URL(baseHref, href).hostname.toLowerCase();
            } catch (_) {}
            if (baseHost && baseHost !== host) return true;
          }
        }
      } catch (_) {}

      // Global hooks common to UV / Scramjet / bare clients.
      try {
        if (
          global.__uv$config ||
          global.__uv ||
          global.$scramjet ||
          global.scramjet ||
          global.BareMux ||
          global.__eclipse$config
        ) {
          return true;
        }
      } catch (_) {}

      // Service worker controlling the page whose script URL looks like a web proxy.
      try {
        var ctrl = global.navigator && global.navigator.serviceWorker && global.navigator.serviceWorker.controller;
        var swUrl = ctrl && (ctrl.scriptURL || "");
        if (/uv|scramjet|bare|eclipse|proxy|sw\.js|service.?worker/i.test(String(swUrl))) {
          return true;
        }
      } catch (_) {}

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

  function nestedDocsRelativePrefix() {
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
        /\/games-browser(\/|$)/i.test(pathname) ||
        /\/fix-loading(\/|$)/i.test(pathname)
      ) {
        return "..";
      }
    } catch (_) {}
    return ".";
  }

  function resolveApiUrl(path) {
    var p = path.charAt(0) === "/" ? path : "/" + path;
    var configured = configuredApiOrigin();
    if (configured) return configured + p;

    // Proxied views / GitHub Pages / unknown mirrors: always use the production Worker.
    // Relative /api paths get rewritten by UV/Scramjet and never reach our Worker.
    if (hostIsGitHubPages() || looksLikeWebProxy()) {
      return DEFAULT_WORKER_ORIGIN + p;
    }

    // Same-origin Worker (prod + preview builds) or local wrangler.
    if (hostIsOurWorkerDeployment() || hostIsLocalDev()) {
      return nestedDocsRelativePrefix() + p;
    }

    // Mirrored static hosts without the Worker API.
    return DEFAULT_WORKER_ORIGIN + p;
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

  function defaultWorkerOrigin() {
    try {
      return new URL(DEFAULT_WORKER_ORIGIN).origin;
    } catch (_) {
      return DEFAULT_WORKER_ORIGIN;
    }
  }

  function primaryUsesDefaultWorkerOrigin(urlStr) {
    try {
      var base = (global.location && global.location.href) || DEFAULT_WORKER_ORIGIN;
      return new URL(String(urlStr), base).origin === defaultWorkerOrigin();
    } catch (_) {
      return false;
    }
  }

  function parseJsonResponse(res) {
    return res
      .json()
      .catch(function () {
        return { ok: res.ok };
      })
      .then(function (data) {
        if (!data || typeof data !== "object") return { ok: res.ok };
        return data;
      });
  }

  /**
   * Fetch that retries against the production Worker when a relative/proxied call fails.
   * Service workers often rewrite first-party /api URLs; absolute cors to DEFAULT_WORKER_ORIGIN
   * is the reliable path under Scramjet/UV.
   */
  function apiFetch(path, init) {
    var primary = resolveApiUrl(path);
    var opts = init || {};
    var attempt = function (url) {
      return fetch(url, opts).then(function (res) {
        // HTML error pages / opaque proxy failures → treat as soft failure for retry.
        var ct = String(res.headers && res.headers.get && res.headers.get("content-type") || "");
        if (!res.ok && res.status >= 500) {
          var err = new Error("http_" + res.status);
          err.response = res;
          throw err;
        }
        if (ct && /text\/html/i.test(ct) && !/json/i.test(ct)) {
          var htmlErr = new Error("html_response");
          htmlErr.response = res;
          throw htmlErr;
        }
        return res;
      });
    };

    return attempt(primary).catch(function (firstErr) {
      var fallback = DEFAULT_WORKER_ORIGIN + (path.charAt(0) === "/" ? path : "/" + path);
      if (primary === fallback || primaryUsesDefaultWorkerOrigin(primary)) {
        throw firstErr;
      }
      return attempt(fallback);
    });
  }

  function ping(opts) {
    opts = opts || {};
    var sessionId = String(opts.sessionId || getSessionId() || "").trim();
    if (!sessionId || sessionId.length < 8) return Promise.resolve({ ok: false, error: "no_session" });
    var now = Date.now();
    if (!opts.force && (inFlight || now - lastPingAt < MIN_PING_GAP_MS)) {
      return Promise.resolve({
        ok: true,
        skipped: true,
        active: lastKnownActive,
      });
    }
    inFlight = true;
    lastPingAt = now;

    var body = {
      sessionId: sessionId.slice(0, 128),
      uid: opts.uid ? String(opts.uid).slice(0, 128) : "",
      anonymous: !!opts.anonymous,
      displayName: opts.displayName ? String(opts.displayName).slice(0, 32) : "",
    };

    // keepalive POSTs often 404/fail under Scramjet/Ultraviolet; skip when proxied.
    var useKeepalive = !looksLikeWebProxy();
    return apiFetch("/api/presence-ping", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      keepalive: useKeepalive,
      mode: "cors",
      credentials: "omit",
      cache: "no-store",
    })
      .then(parseJsonResponse)
      .then(function (data) {
        var n = data && Number(data.active);
        if (Number.isFinite(n) && n >= 0) lastKnownActive = n;
        return data;
      })
      .catch(function () {
        return { ok: false, error: "network" };
      })
      .finally(function () {
        inFlight = false;
      });
  }

  function fetchActiveCount() {
    return apiFetch("/api/presence-active", {
      method: "GET",
      mode: "cors",
      credentials: "omit",
      cache: "no-store",
    })
      .then(parseJsonResponse)
      .then(function (data) {
        var n = data && Number(data.active);
        if (Number.isFinite(n) && n >= 0) {
          lastKnownActive = n;
          return n;
        }
        return null;
      })
      .catch(function () {
        return null;
      });
  }

  /** Keep polling /api/presence-active so the footer updates even when POSTs are blocked. */
  function startActiveCountPolling(onCount, intervalMs) {
    var cb = typeof onCount === "function" ? onCount : null;
    var ms = intervalMs != null ? Number(intervalMs) : ACTIVE_POLL_MS;
    if (!Number.isFinite(ms) || ms < 15000) ms = ACTIVE_POLL_MS;

    function tick() {
      void fetchActiveCount().then(function (n) {
        if (n == null || !cb) return;
        try {
          cb(n);
        } catch (_) {}
      });
    }

    tick();
    if (activePollTimer) {
      try {
        clearInterval(activePollTimer);
      } catch (_) {}
    }
    activePollTimer = setInterval(tick, ms);
    return function stop() {
      if (activePollTimer) {
        try {
          clearInterval(activePollTimer);
        } catch (_) {}
        activePollTimer = null;
      }
    };
  }

  function apiUrl(path) {
    return resolveApiUrl(path);
  }

  global.ProxyListPresence = {
    ping: ping,
    fetchActiveCount: fetchActiveCount,
    startActiveCountPolling: startActiveCountPolling,
    getSessionId: getSessionId,
    apiUrl: apiUrl,
    looksLikeWebProxy: looksLikeWebProxy,
    normalizeClickUrl: normalizeClickUrl,
    legacyNormalizeClickUrl: legacyNormalizeClickUrl,
    clickUrlVariants: clickUrlVariants,
    DEFAULT_WORKER_ORIGIN: DEFAULT_WORKER_ORIGIN,
  };
})(typeof window !== "undefined" ? window : globalThis);
