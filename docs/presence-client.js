/**
 * Shared presence ping for User Statistics aggregates (Worker → D1, with Firestore history).
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
  /** Prefer localStorage so reloads keep one session; sessionStorage alone churned IDs. */
  var SESSION_KEY = "proxyList_presence_session_v2";
  var SESSION_KEY_LEGACY = "proxyList_presence_session_v1";
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
      if (host !== "localhost" && host !== "127.0.0.1" && host !== "[::1]") return false;
      // wrangler dev serves Worker APIs + assets together. Other local ports
      // (e.g. python http.server on 8080) have no /api and must use production.
      var port = String((global.location && global.location.port) || "");
      return port === "8787";
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

  /**
   * Coarse OS / version / browser / RAM / cores / arch for presence stats.
   * Independent of Sentry consent. Never stores the raw user-agent string.
   */
  var cachedPlatform = detectOsFromUa();
  cachedPlatform.arch = detectArchFromUa(null, cachedPlatform.os);
  cachedPlatform.browser = detectBrowserFromUa();

  function detectArchFromUa(uaRaw, osHint) {
    var ua = "";
    try {
      ua = String(uaRaw || (global.navigator && global.navigator.userAgent) || "");
    } catch (_) {
      ua = "";
    }
    if (/aarch64|arm64/i.test(ua)) return "arm64";
    if (/\barm\b/i.test(ua) && !/arm64|aarch64/i.test(ua)) return "arm";
    if (/Win64|x86_64|amd64|\bx64\b/i.test(ua)) return "x64";
    if (/WOW64|Win32|i686|i386|\bx86\b/i.test(ua)) return "x86";
    var os = String(osHint || "");
    if (!os) {
      if (/\b(?:iPhone|iPad|iPod)\b/i.test(ua) || (/\bMacintosh\b/i.test(ua) && Number((global.navigator && global.navigator.maxTouchPoints) || 0) > 1)) {
        os = "ios";
      } else if (/\bAndroid\b/i.test(ua)) os = "android";
    }
    // Mobile UAs almost never include ISA. Current iOS is ARM64; Android phones are too
    // unless the UA explicitly says x86 (emulator / some Chromebooks).
    if (os === "ios") return "arm64";
    if (os === "android" && !/x86|i686|amd64/i.test(ua)) return "arm64";
    return "unknown";
  }

  function browserFromBrands(brands) {
    var names = [];
    try {
      (brands || []).forEach(function (b) {
        names.push(String((b && b.brand) || "").toLowerCase());
      });
    } catch (_) {}
    function has(part) {
      return names.some(function (n) {
        return n.indexOf(part) >= 0;
      });
    }
    if (has("brave")) return "brave";
    if (has("edge")) return "edge";
    if (has("opera")) return "opera";
    if (has("samsung")) return "samsung";
    if (has("firefox")) return "firefox";
    if (has("google chrome")) return "chrome";
    if (has("safari") && !has("chrome") && !has("chromium")) return "safari";
    if (has("chrome") || has("chromium")) return "chrome";
    return "";
  }

  function detectBrowserFromUa(uaRaw) {
    try {
      if (global.navigator && global.navigator.brave) return "brave";
    } catch (_) {}
    try {
      var uad = global.navigator && global.navigator.userAgentData;
      var fromBrands = browserFromBrands(uad && uad.brands);
      if (fromBrands) return fromBrands;
    } catch (_) {}
    var ua = "";
    try {
      ua = String(uaRaw || (global.navigator && global.navigator.userAgent) || "");
    } catch (_) {
      ua = "";
    }
    if (/Edg(?:e|A|iOS)?\/|EdgiOS/i.test(ua)) return "edge";
    if (/\bOPR\/|\bOpera\b|\bOPiOS\//i.test(ua)) return "opera";
    if (/SamsungBrowser/i.test(ua)) return "samsung";
    if (/\bFirefox\/|\bFxiOS\//i.test(ua)) return "firefox";
    if (/\bCriOS\/|\bChrome\/|\bChromium\//i.test(ua)) return "chrome";
    if (/\bSafari\//i.test(ua) && /\bVersion\//i.test(ua)) return "safari";
    return "other";
  }

  function ramBucketFromDeviceMemory(dm) {
    if (!Number.isFinite(dm) || dm <= 0) return "unknown";
    if (dm < 1) return "under_1gb";
    if (dm >= 32) return "32gb+";
    // Round to whole GB so non-power-of-two reports (5, 6, 12, …) are kept
    // instead of snapping down to 4/8/16. Chrome still only emits 0.25/0.5/1/2/4/8/16/32.
    var n = Math.round(dm);
    if (n < 1) return "under_1gb";
    if (n >= 32) return "32gb+";
    return n + "gb";
  }

  function detectHardware() {
    var ram = "unknown";
    try {
      var dm = Number(global.navigator && global.navigator.deviceMemory);
      ram = ramBucketFromDeviceMemory(dm);
    } catch (_) {}
    var cores = "unknown";
    try {
      var c = Number(global.navigator && global.navigator.hardwareConcurrency);
      if (Number.isFinite(c) && c >= 1) cores = String(Math.min(128, Math.round(c)));
    } catch (_) {}
    return {
      ram: ram,
      cores: cores,
      arch: cachedPlatform.arch || detectArchFromUa(null, cachedPlatform.os) || "unknown",
    };
  }

  function detectOsFromUa(uaRaw) {
    var ua = "";
    try {
      ua = String(uaRaw || (global.navigator && global.navigator.userAgent) || "");
    } catch (_) {
      ua = "";
    }
    var maxTouch = 0;
    try {
      maxTouch = Number((global.navigator && global.navigator.maxTouchPoints) || 0);
    } catch (_) {}

    if (/\bAndroid\b/i.test(ua)) {
      var android = ua.match(/Android[ \/](\d+(?:\.\d+)?)/i);
      return { os: "android", osVersion: android ? android[1] : "unknown" };
    }
    var iosToken = /\b(?:iPhone|iPad|iPod)\b/i.test(ua);
    var ipadOsDesktopUa = /\bMacintosh\b/i.test(ua) && maxTouch > 1;
    if (iosToken || ipadOsDesktopUa) {
      var ios = ua.match(/\bOS (\d+)[_.](\d+)/i);
      return { os: "ios", osVersion: ios ? ios[1] + "." + ios[2] : "unknown" };
    }
    if (/\bCrOS\b/i.test(ua)) {
      var cros = ua.match(/CrOS [^\s]+ (\d+(?:\.\d+)?)/i);
      return { os: "chromeos", osVersion: cros ? cros[1] : "unknown" };
    }
    if (/\bWindows\b/i.test(ua)) {
      var win = "unknown";
      if (/Windows NT 10\.0/i.test(ua)) win = "10";
      else if (/Windows NT 6\.3/i.test(ua)) win = "8.1";
      else if (/Windows NT 6\.2/i.test(ua)) win = "8";
      else if (/Windows NT 6\.1/i.test(ua)) win = "7";
      else {
        var wm = ua.match(/Windows NT (\d+\.\d+)/i);
        if (wm) win = wm[1];
      }
      return { os: "windows", osVersion: win };
    }
    if (/\bMac OS X\b/i.test(ua) || /\bMacintosh\b/i.test(ua)) {
      var mac = ua.match(/Mac OS X (\d+)[_.](\d+)/i);
      return { os: "macos", osVersion: mac ? mac[1] + "." + mac[2] : "unknown" };
    }
    if (/\bLinux\b/i.test(ua)) {
      return { os: "linux", osVersion: "unknown" };
    }
    return { os: "other", osVersion: "unknown" };
  }

  function applyClientHints(base, hints) {
    var out = {
      os: (base && base.os) || "other",
      osVersion: (base && base.osVersion) || "unknown",
      arch: (base && base.arch) || "unknown",
      browser: (base && base.browser) || "other",
    };
    if (!hints) return out;
    var platform = String(hints.platform || "").toLowerCase();
    var pv = String(hints.platformVersion || "").trim();
    var major = parseInt(String(pv.split(".")[0] || ""), 10);
    if (platform === "windows" || out.os === "windows") {
      out.os = "windows";
      if (Number.isFinite(major)) {
        // UA-CH platformVersion: 13+ is Windows 11; 1–12 are Windows 10 (not "Windows 12").
        if (major >= 13) out.osVersion = "11";
        else if (major >= 1) out.osVersion = "10";
      }
    } else if (platform === "macos" || platform === "mac os") {
      out.os = "macos";
      if (pv) out.osVersion = pv.split(".").slice(0, 2).join(".");
    } else if (platform === "chrome os") {
      out.os = "chromeos";
      if (pv) out.osVersion = pv.split(".").slice(0, 2).join(".");
    } else if (platform === "linux" && out.os !== "android") {
      out.os = "linux";
      if (pv && pv !== "0.0.0") out.osVersion = String(major || pv.split(".")[0] || "unknown");
    }
    var a = String((hints && hints.architecture) || "").toLowerCase();
    var b = String((hints && hints.bitness) || "");
    if (a === "arm" && b === "64") out.arch = "arm64";
    else if (a === "arm") out.arch = b === "32" ? "arm" : "arm64";
    else if (a === "x86" && b === "64") out.arch = "x64";
    else if (a === "x86") out.arch = "x86";
    if (!a && (out.os === "ios" || out.arch === "unknown")) {
      if (out.os === "ios") out.arch = "arm64";
      else if (out.os === "android" && out.arch === "unknown") out.arch = "arm64";
    }
    var brandList = (hints && (hints.fullVersionList || hints.brands)) || [];
    var hinted = browserFromBrands(brandList);
    if (hinted) out.browser = hinted;
    return out;
  }

  function refreshPlatformFromHints() {
    try {
      var uad = global.navigator && global.navigator.userAgentData;
      if (!uad) return;
      try {
        if (uad.platform) {
          cachedPlatform = applyClientHints(cachedPlatform, { platform: uad.platform });
        }
      } catch (_) {}
      if (typeof uad.getHighEntropyValues !== "function") return;
      uad
        .getHighEntropyValues(["platform", "platformVersion", "architecture", "bitness", "fullVersionList"])
        .then(function (hints) {
          cachedPlatform = applyClientHints(cachedPlatform, hints || {});
        })
        .catch(function () {});
    } catch (_) {}
  }

  function getPlatformInfo() {
    var hw = detectHardware();
    return {
      os: cachedPlatform.os || "other",
      osVersion: cachedPlatform.osVersion || "unknown",
      browser: cachedPlatform.browser || detectBrowserFromUa() || "other",
      ram: hw.ram,
      cores: hw.cores,
      arch: cachedPlatform.arch || hw.arch || "unknown",
    };
  }

  refreshPlatformFromHints();

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

  function readStoredSessionId() {
    var stores = [];
    try {
      if (global.localStorage) stores.push(global.localStorage);
    } catch (_) {}
    try {
      if (global.sessionStorage) stores.push(global.sessionStorage);
    } catch (_) {}
    var keys = [SESSION_KEY, SESSION_KEY_LEGACY];
    for (var si = 0; si < stores.length; si++) {
      for (var ki = 0; ki < keys.length; ki++) {
        try {
          var existing = stores[si].getItem(keys[ki]);
          if (existing && String(existing).length >= 8) {
            var cleaned = String(existing).replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 128);
            if (cleaned.length >= 8) return cleaned;
          }
        } catch (_) {}
      }
    }
    return "";
  }

  function persistSessionId(id) {
    try {
      if (global.localStorage) global.localStorage.setItem(SESSION_KEY, id);
    } catch (_) {}
    try {
      if (global.sessionStorage) global.sessionStorage.setItem(SESSION_KEY, id);
    } catch (_) {}
  }

  function getSessionId() {
    if (cachedSessionId && cachedSessionId.length >= 8) return cachedSessionId;
    var existing = readStoredSessionId();
    if (existing) {
      cachedSessionId = existing;
      persistSessionId(cachedSessionId);
      return cachedSessionId;
    }
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
    persistSessionId(cachedSessionId);
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
        if (!res.ok && (res.status >= 500 || res.status === 404 || res.status === 405 || res.status === 501)) {
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
    if (hardwareSurveyEnabled()) {
      var platform = getPlatformInfo();
      body.os = platform.os;
      body.osVersion = platform.osVersion;
      body.browser = platform.browser;
      body.ram = platform.ram;
      body.cores = platform.cores;
      body.arch = platform.arch;
    }

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

  var HW_CONSENT_KEY = "proxyList_hardwareConsent_v1";
  var HW_DIALOG_ID = "proxyListHardwareConsentBackdrop";
  var HW_STYLE_ID = "proxyListHardwareConsentStyles";

  function readHardwareConsent() {
    try {
      var v = String(global.localStorage.getItem(HW_CONSENT_KEY) || "");
      if (v === "enabled" || v === "disabled") return v;
    } catch (_) {}
    return "";
  }

  function writeHardwareConsent(value) {
    try {
      global.localStorage.setItem(HW_CONSENT_KEY, value);
    } catch (_) {}
  }

  function hardwareSurveyEnabled() {
    return readHardwareConsent() === "enabled";
  }

  function hardwareHasChoice() {
    var v = readHardwareConsent();
    return v === "enabled" || v === "disabled";
  }

  function emitHardwareConsent(value) {
    try {
      global.dispatchEvent(new CustomEvent("proxy-list-hardware-consent", { detail: { value: value } }));
    } catch (_) {}
  }

  function isEmbedMode() {
    try {
      if (document.documentElement.classList.contains("embed-mode")) return true;
      var params = new URLSearchParams(location.search || "");
      if (params.get("embed") === "1" || params.get("embed") === "true") return true;
    } catch (_) {}
    return false;
  }

  function sentryConsentStillPending() {
    try {
      if (global.ProxyListSentry && typeof global.ProxyListSentry.hasChoice === "function") {
        return !global.ProxyListSentry.hasChoice();
      }
    } catch (_) {}
    return false;
  }

  function statsUsersHref() {
    var prefix = nestedDocsRelativePrefix();
    if (prefix === ".") return "stats/#users";
    return prefix + "/stats/#users";
  }

  function hideHardwareDialog() {
    var el = document.getElementById(HW_DIALOG_ID);
    if (el && el.parentNode) el.parentNode.removeChild(el);
  }

  function ensureHardwareStyles() {
    if (document.getElementById(HW_STYLE_ID)) return;
    var css = document.createElement("style");
    css.id = HW_STYLE_ID;
    css.textContent =
      "#" + HW_DIALOG_ID + "{" +
        "position:fixed;inset:0;z-index:81;display:flex;align-items:center;justify-content:center;" +
        "padding:1rem;background:rgba(7,10,14,.72);" +
      "}" +
      "#" + HW_DIALOG_ID + " .pl-hw-modal{" +
        "width:min(560px,100%);max-height:92vh;overflow:auto;display:flex;flex-direction:column;" +
        "background:var(--surface,#141414);color:var(--text,#e8e8e8);" +
        "border:1px solid var(--border,#2e2e2e);border-radius:10px;" +
        "box-shadow:0 16px 36px rgba(0,0,0,.45);" +
      "}" +
      "#" + HW_DIALOG_ID + " .pl-hw-head{" +
        "padding:.9rem 1rem;border-bottom:1px solid var(--border,#2e2e2e);flex-shrink:0;" +
      "}" +
      "#" + HW_DIALOG_ID + " .pl-hw-title{font-size:1rem;margin:0;font-weight:650;}" +
      "#" + HW_DIALOG_ID + " .pl-hw-body{padding:.9rem 1rem 1.05rem;display:flex;flex-direction:column;gap:.75rem;}" +
      "#" + HW_DIALOG_ID + " .pl-hw-body p{margin:0;color:var(--muted,#9a9a9a);line-height:1.55;font-size:.92rem;}" +
      "#" + HW_DIALOG_ID + " .pl-hw-body a{color:var(--accent,#6cb3ff);}" +
      "#" + HW_DIALOG_ID + " .pl-hw-actions{display:flex;flex-wrap:wrap;gap:.45rem;margin-top:.2rem;}" +
      "#" + HW_DIALOG_ID + " .pl-hw-btn{" +
        "display:inline-flex;align-items:center;justify-content:center;padding:.38rem .7rem;" +
        "font-family:inherit;font-size:.82rem;font-weight:500;border-radius:6px;cursor:pointer;" +
        "border:1px solid var(--border,#2e2e2e);background:var(--surface,#1a1a1a);color:var(--text,#e8e8e8);" +
      "}" +
      "#" + HW_DIALOG_ID + " .pl-hw-btn:hover{border-color:var(--accent,#6cb3ff);color:var(--accent,#6cb3ff);}" +
      "#" + HW_DIALOG_ID + " .pl-hw-btn-primary{" +
        "background:#2a2a2a;border-color:#2d5588;color:var(--accent,#6cb3ff);" +
      "}" +
      "#" + HW_DIALOG_ID + " .pl-hw-btn-primary:hover{background:#333;color:#9fd4ff;}";
    (document.head || document.documentElement).appendChild(css);
  }

  function setHardwareConsent(value) {
    var next = value === "enabled" ? "enabled" : "disabled";
    writeHardwareConsent(next);
    hideHardwareDialog();
    emitHardwareConsent(next);
    if (next === "enabled") {
      try {
        ping({ force: true, anonymous: true });
      } catch (_) {}
    }
    return next;
  }

  function showHardwareDialog() {
    if (hardwareHasChoice() || isEmbedMode()) return;
    if (document.getElementById(HW_DIALOG_ID)) return;
    ensureHardwareStyles();
    var backdrop = document.createElement("div");
    backdrop.id = HW_DIALOG_ID;
    backdrop.setAttribute("role", "dialog");
    backdrop.setAttribute("aria-modal", "true");
    backdrop.setAttribute("aria-labelledby", "proxyListHardwareConsentTitle");

    var modal = document.createElement("section");
    modal.className = "pl-hw-modal";

    var head = document.createElement("div");
    head.className = "pl-hw-head";
    var title = document.createElement("h2");
    title.className = "pl-hw-title";
    title.id = "proxyListHardwareConsentTitle";
    title.textContent = "Hardware Survey";
    head.appendChild(title);

    var body = document.createElement("div");
    body.className = "pl-hw-body";

    var p1 = document.createElement("p");
    p1.textContent =
      "The Hardware Survey collects basic, non-identifiable info about your device and displays it publicly. Info that is collected is your operating system, operating system version, browser, estimated RAM capacity, estimated CPU cores, and CPU architecture. We use this data to know what types of devices our userbase is accessing the site on and lets us know how the site should be optimized to ensure the best experience for all of our users.";

    var p2 = document.createElement("p");
    p2.appendChild(
      document.createTextNode(
        "This is optional and not at all required, it just helps make development easier and improves the experience for everyone. You can see public statistics for all users at "
      )
    );
    var statsLink = document.createElement("a");
    statsLink.href = statsUsersHref();
    statsLink.textContent = "Statistics > Users";
    p2.appendChild(statsLink);
    p2.appendChild(document.createTextNode(" and scrolling down to find them."));

    var p3 = document.createElement("p");
    p3.textContent = "This setting can be changed at any time in Settings.";

    var actions = document.createElement("div");
    actions.className = "pl-hw-actions";

    var enableBtn = document.createElement("button");
    enableBtn.type = "button";
    enableBtn.className = "pl-hw-btn pl-hw-btn-primary";
    enableBtn.textContent = "Opt-into collection of hardware data";
    enableBtn.addEventListener("click", function () {
      setHardwareConsent("enabled");
    });

    var disableBtn = document.createElement("button");
    disableBtn.type = "button";
    disableBtn.className = "pl-hw-btn";
    disableBtn.textContent = "Opt-out";
    disableBtn.addEventListener("click", function () {
      setHardwareConsent("disabled");
    });

    actions.appendChild(enableBtn);
    actions.appendChild(disableBtn);
    body.appendChild(p1);
    body.appendChild(p2);
    body.appendChild(p3);
    body.appendChild(actions);
    modal.appendChild(head);
    modal.appendChild(body);
    backdrop.appendChild(modal);
    (document.body || document.documentElement).appendChild(backdrop);
    try {
      enableBtn.focus();
    } catch (_) {}
  }

  function maybeShowHardwareDialog() {
    if (hardwareHasChoice() || isEmbedMode()) return;
    if (sentryConsentStillPending()) {
      if (global.__proxyListHardwareWaitingOnSentry) return;
      global.__proxyListHardwareWaitingOnSentry = true;
      global.addEventListener("proxy-list-sentry-consent", function onSentryForHardware() {
        global.removeEventListener("proxy-list-sentry-consent", onSentryForHardware);
        global.__proxyListHardwareWaitingOnSentry = false;
        maybeShowHardwareDialog();
      });
      return;
    }
    showHardwareDialog();
  }

  function onHardwareReady(fn) {
    if (document.body) {
      fn();
      return;
    }
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", fn);
      return;
    }
    fn();
  }

  global.ProxyListPresence = {
    ping: ping,
    fetchActiveCount: fetchActiveCount,
    startActiveCountPolling: startActiveCountPolling,
    getSessionId: getSessionId,
    getPlatformInfo: getPlatformInfo,
    apiUrl: apiUrl,
    looksLikeWebProxy: looksLikeWebProxy,
    normalizeClickUrl: normalizeClickUrl,
    legacyNormalizeClickUrl: legacyNormalizeClickUrl,
    clickUrlVariants: clickUrlVariants,
    DEFAULT_WORKER_ORIGIN: DEFAULT_WORKER_ORIGIN,
  };

  global.ProxyListHardware = {
    CONSENT_KEY: HW_CONSENT_KEY,
    hasChoice: hardwareHasChoice,
    getConsent: readHardwareConsent,
    setConsent: setHardwareConsent,
  };

  if (!hardwareHasChoice() && !isEmbedMode()) {
    onHardwareReady(maybeShowHardwareDialog);
  }
})(typeof window !== "undefined" ? window : globalThis);
