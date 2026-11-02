/**
 * Site-wide debug overlays: UA/host HUD, console toasts, performance graph.
 * Reads proxyList_app_settings_v1 from localStorage (and IndexedDB when present).
 * On the main list page, call ProxyListDebug.applySettings(appSettings) after settings load/change.
 */
(function loadSentryFromOverlays(global) {
  "use strict";
  try {
    if (global.__PROXY_LIST_SENTRY__ || global.__PROXY_LIST_SENTRY_SCRIPT__) return;
    var scripts = document.getElementsByTagName("script");
    for (var i = 0; i < scripts.length; i++) {
      if (/sentry-init\.js(\?|$)/i.test(scripts[i].src || "")) return;
    }
    var base = "";
    var cur = document.currentScript && document.currentScript.src;
    if (cur) base = cur.replace(/[^/]+$/, "");
    var s = document.createElement("script");
    s.src = base + "sentry-init.js";
    s.async = true;
    s.onerror = function () {
      try {
        var fallback = document.createElement("script");
        fallback.src = "https://proxy-list.jasonthegamer48.workers.dev/sentry-init.js";
        fallback.async = true;
        (document.head || document.documentElement).appendChild(fallback);
      } catch (_) {}
    };
    (document.head || document.documentElement).appendChild(s);
  } catch (_) {}
})(typeof window !== "undefined" ? window : globalThis);

(function (global) {
  "use strict";

  if (global.ProxyListDebug && global.ProxyListDebug.__booted) return;

  var LS_KEY = "proxyList_app_settings_v1";
  var LS_DEBUG_KEY = "proxyList_debug_overlays_v1";
  var SS_LOGS_KEY = "proxyList_debug_log_buffers_v1";
  var SS_LAYOUT_KEY = "proxyList_debug_layout_v1";
  var IDB_NAME = "proxyListSettings";
  var IDB_STORE = "appSettings";
  var STYLE_ID = "proxyListDebugOverlayStyles";
  var MAX_LOG_ENTRIES = 500;
  var WORKER_ORIGIN = "https://proxy-list.jasonthegamer48.workers.dev";
  var SCRIPT_DIR = (function () {
    try {
      var cur = document.currentScript && document.currentScript.src;
      if (cur) return String(cur).replace(/[^/]+$/, "");
      var scripts = document.getElementsByTagName("script");
      for (var i = 0; i < scripts.length; i++) {
        var src = scripts[i].src || "";
        if (/debug-overlays\.js(\?|$)/i.test(src)) return src.replace(/[^/]+$/, "");
      }
    } catch (_) {}
    return "";
  })();
  var erudaLoading = false;

  var settings = {
    debugMode: false,
    debugShowUserAgent: true,
    debugEruda: true,
    debugPerfGraph: false,
    debugCullingTest: false,
  };

  var consoleLogBuffer = [];
  var chunkLogBuffer = [];
  var consoleHooksInstalled = false;
  var debugMenuOpen = false;
  var debugMenuKeyWired = false;
  var layoutWired = false;
  var uaHudMinimized = false;
  var panelPositions = { perf: null, menu: null };
  var perfTimer = null;
  var perfSamples = [];
  var lastFrameTs = 0;
  var cpuEma = 0;
  var bootPromise = null;
  var lastScriptRankTs = 0;
  var longTaskMsByScript = Object.create(null);
  var longTaskObserverStarted = false;
  var cullingWired = false;
  var cullingRaf = 0;
  var cullingScale = 0.75;
  var CULLING_SELECTOR =
    "main tr, main .featured-slide, main .featured-proxies, main .popular-section, main .stats, main .table-chunk-wrap thead, aside fieldset, aside .sidebar-actions .btn, aside .search-wrap, aside .match-mode, header, .site-footer, .floating-corner-actions, .quick-search-palette-hint";

  function $(id) {
    return document.getElementById(id);
  }

  function normalizeDebugSettings(raw) {
    var out = {
      debugMode: false,
      debugShowUserAgent: true,
      debugEruda: true,
      debugPerfGraph: false,
      debugCullingTest: false,
    };
    if (!raw || typeof raw !== "object") return out;
    if (typeof raw.debugMode === "boolean") out.debugMode = raw.debugMode;
    else if (raw.debugMode === "enabled") out.debugMode = true;
    else if (raw.debugMode === "disabled") out.debugMode = false;
    if (typeof raw.debugShowUserAgent === "boolean") out.debugShowUserAgent = raw.debugShowUserAgent;
    if (typeof raw.debugEruda === "boolean") out.debugEruda = raw.debugEruda;
    else if (raw.debugEruda === "enabled") out.debugEruda = true;
    else if (raw.debugEruda === "disabled") out.debugEruda = false;
    if (typeof raw.debugPerfGraph === "boolean") out.debugPerfGraph = raw.debugPerfGraph;
    if (typeof raw.debugCullingTest === "boolean") out.debugCullingTest = raw.debugCullingTest;
    else if (raw.debugCullingTest === "enabled") out.debugCullingTest = true;
    else if (raw.debugCullingTest === "disabled") out.debugCullingTest = false;
    return out;
  }

  function isDebugMode() {
    return settings.debugMode === true;
  }

  function readLocalStorageSettings() {
    try {
      var raw = localStorage.getItem(LS_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (_) {
      return null;
    }
  }

  function readDebugMirror() {
    try {
      var raw = localStorage.getItem(LS_DEBUG_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (_) {
      return null;
    }
  }

  function writeDebugMirror(raw) {
    try {
      var n = normalizeDebugSettings(raw);
      localStorage.setItem(
        LS_DEBUG_KEY,
        JSON.stringify({
          debugMode: n.debugMode === true,
          debugShowUserAgent: n.debugShowUserAgent !== false,
          debugEruda: n.debugEruda !== false,
          debugPerfGraph: n.debugPerfGraph === true,
          debugCullingTest: n.debugCullingTest === true,
        })
      );
    } catch (_) {}
  }

  function readIdbSettings() {
    return new Promise(function (resolve) {
      try {
        if (!global.indexedDB) {
          resolve(null);
          return;
        }
        var req = indexedDB.open(IDB_NAME, 1);
        req.onerror = function () {
          resolve(null);
        };
        req.onupgradeneeded = function () {
          var db = req.result;
          if (!db.objectStoreNames.contains(IDB_STORE)) db.createObjectStore(IDB_STORE);
        };
        req.onsuccess = function () {
          var db = req.result;
          try {
            var tx = db.transaction(IDB_STORE, "readonly");
            var getReq = tx.objectStore(IDB_STORE).get("default");
            getReq.onsuccess = function () {
              resolve(getReq.result || null);
            };
            getReq.onerror = function () {
              resolve(null);
            };
          } catch (_) {
            resolve(null);
          }
        };
      } catch (_) {
        resolve(null);
      }
    });
  }

  function injectStyles() {
    var css =
      "#debugPerfGraph{position:fixed;right:0.75rem;bottom:0.75rem;left:auto;top:auto;z-index:94;width:min(20rem,calc(100vw - 1.5rem));max-height:min(72vh,32rem);overflow:auto;padding:0.55rem 0.65rem 0.65rem;border-radius:10px;border:1px solid #6b4a12;background:rgba(22,16,6,0.96);color:#f5e6c8;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:0.68rem;line-height:1.35;box-shadow:0 8px 22px rgba(0,0,0,0.4);pointer-events:auto;touch-action:none}" +
      "#debugPerfGraph[hidden]{display:none!important}" +
      "#debugPerfGraph.debug-panel-moved{right:auto;bottom:auto}" +
      "#debugPerfGraph .debug-perf-head{display:flex;align-items:center;justify-content:space-between;gap:0.45rem;margin-bottom:0.35rem;cursor:grab;user-select:none;-webkit-user-select:none}" +
      "#debugPerfGraph .debug-perf-head:active{cursor:grabbing}" +
      "#debugPerfGraph .debug-perf-title{color:#ffd27a;font-weight:700}" +
      "#debugPerfGraph .debug-panel-drag-hint{color:#a89878;font-size:0.6rem;white-space:nowrap}" +
      "#debugPerfGraph .debug-perf-chart{margin-top:0.45rem}" +
      "#debugPerfGraph .debug-perf-chart-label{display:flex;justify-content:space-between;gap:0.5rem;color:#d8c9a8;margin-bottom:0.15rem}" +
      "#debugPerfGraph .debug-perf-chart-label strong{color:#f5e6c8;font-weight:600}" +
      "#debugPerfGraph canvas{display:block;width:100%;height:48px;border-radius:4px;background:rgba(0,0,0,0.25)}" +
      "#debugPerfGraph .debug-perf-scripts{margin-top:0.55rem;border-top:1px solid #6b4a12;padding-top:0.45rem}" +
      "#debugPerfGraph .debug-perf-scripts-title{color:#ffd27a;font-weight:700;margin-bottom:0.3rem}" +
      "#debugPerfGraph .debug-perf-scripts-hint{color:#a89878;margin:0 0 0.35rem;font-size:0.62rem}" +
      "#debugPerfGraph .debug-perf-script-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:0.3rem}" +
      "#debugPerfGraph .debug-perf-script-list li{display:grid;grid-template-columns:1fr auto;gap:0.15rem 0.45rem;align-items:baseline}" +
      "#debugPerfGraph .debug-perf-script-name{color:#f5e6c8;overflow-wrap:anywhere;word-break:break-word}" +
      "#debugPerfGraph .debug-perf-script-meta{color:#9be7ff;white-space:nowrap;font-variant-numeric:tabular-nums}" +
      "#debugPerfGraph .debug-perf-script-sub{grid-column:1 / -1;color:#a89878;font-size:0.62rem}" +
      "#debugPerfGraph .debug-perf-scripts-empty{color:#a89878;margin:0}" +
      "#debugHudBar{position:fixed;top:0;left:0;right:0;z-index:95;display:flex;align-items:flex-start;gap:0.55rem;padding:0.35rem 0.65rem;background:rgba(18,14,6,0.96);border-bottom:1px solid #6b4a12;color:#f5e6c8;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:0.68rem;line-height:1.35;pointer-events:none}" +
      "#debugHudBar[hidden]{display:none!important}" +
      "#debugHudBar .debug-hud-body{flex:1;min-width:0}" +
      "#debugHudBar .debug-hud-row{display:block;overflow-wrap:anywhere;word-break:break-word}" +
      "#debugHudBar .debug-hud-label{color:#ffd27a;font-weight:600}" +
      "#debugHudBar .debug-hud-toggle{pointer-events:auto;flex:0 0 auto;margin-top:0.05rem;padding:0.2rem 0.45rem;border-radius:6px;border:1px solid #6b4a12;background:#241c0c;color:#f5e6c8;font:inherit;font-size:0.64rem;cursor:pointer;line-height:1.2}" +
      "#debugHudBar .debug-hud-toggle:hover{border-color:#ffd27a}" +
      "#debugHudBar.debug-hud-minimized{align-items:center;padding:0.2rem 0.55rem}" +
      "#debugHudBar.debug-hud-minimized .debug-hud-body{display:none}" +
      "#debugHudBar.debug-hud-minimized .debug-hud-mini-label{display:inline;pointer-events:none;color:#ffd27a;font-weight:600;font-size:0.64rem}" +
      "#debugHudBar .debug-hud-mini-label{display:none}" +
      "html.debug-mode-on{scroll-padding-top:3.5rem}" +
      "html.debug-mode-on body{padding-top:3.25rem}" +
      "html.debug-mode-on.debug-hud-compact{scroll-padding-top:2rem}" +
      "html.debug-mode-on.debug-hud-compact body{padding-top:1.75rem}" +
      ".debug-toast-stack{position:fixed;left:0.75rem;bottom:0.75rem;z-index:96;display:flex;flex-direction:column-reverse;gap:0.45rem;width:min(24rem,calc(100vw - 1.5rem));max-height:min(50vh,22rem);overflow:hidden;pointer-events:none}" +
      ".debug-toast{pointer-events:none;padding:0.55rem 0.65rem;border-radius:10px;border:1px solid #6b4a12;background:rgba(22,16,6,0.96);box-shadow:0 8px 22px rgba(0,0,0,0.4);color:#f5e6c8;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:0.72rem;line-height:1.35;overflow-wrap:anywhere;word-break:break-word;opacity:0;transform:translateY(8px);transition:opacity 0.18s ease,transform 0.18s ease}" +
      ".debug-toast.visible{opacity:1;transform:translateY(0)}" +
      ".debug-toast.debug-toast-error{border-color:#a83d3d;background:rgba(42,16,16,0.96);color:#ffb4b4}" +
      ".debug-toast.debug-toast-chunk{border-color:#2d6aa8;background:rgba(12,24,36,0.96);color:#9be7ff}" +
      ".debug-toast.debug-toast-info{border-color:#6b4a12;color:#f5e6c8}" +
      ".debug-toast-kind{display:block;font-weight:700;margin-bottom:0.15rem;text-transform:uppercase;letter-spacing:0.03em;font-size:0.66rem;opacity:0.9}" +
      'html[data-animations="disabled"] .debug-toast{transition:none!important}' +
      "#debugQuickMenu{position:fixed;top:0.65rem;right:0.65rem;left:auto;bottom:auto;z-index:120;width:min(22rem,calc(100vw - 1.3rem));max-height:min(78vh,36rem);overflow:auto;padding:0.7rem 0.75rem 0.8rem;border-radius:10px;border:1px solid #6b4a12;background:rgba(18,14,6,0.98);color:#f5e6c8;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:0.74rem;line-height:1.4;box-shadow:0 10px 28px rgba(0,0,0,0.5);touch-action:none}" +
      "#debugQuickMenu[hidden]{display:none!important}" +
      "#debugQuickMenu.debug-panel-moved{right:auto;bottom:auto}" +
      "html.debug-mode-on #debugQuickMenu:not(.debug-panel-moved){top:3.6rem}" +
      "html.debug-mode-on.debug-hud-compact #debugQuickMenu:not(.debug-panel-moved){top:2.1rem}" +
      "#debugQuickMenu .debug-menu-head{display:flex;align-items:center;justify-content:space-between;gap:0.5rem;margin-bottom:0.55rem;cursor:grab;user-select:none;-webkit-user-select:none}" +
      "#debugQuickMenu .debug-menu-head:active{cursor:grabbing}" +
      "#debugQuickMenu .debug-menu-title{color:#ffd27a;font-weight:700;font-size:0.8rem}" +
      "#debugQuickMenu .debug-menu-head-actions{display:flex;align-items:center;gap:0.35rem;flex:0 0 auto}" +
      "#debugQuickMenu .debug-panel-drag-hint{color:#a89878;font-size:0.6rem;white-space:nowrap}" +
      "#debugQuickMenu .debug-menu-hint{color:#a89878;font-size:0.66rem;margin:0 0 0.65rem}" +
      "#debugQuickMenu .debug-menu-field{margin:0 0 0.55rem}" +
      "#debugQuickMenu .debug-menu-field label{display:block;color:#d8c9a8;margin-bottom:0.2rem;font-size:0.68rem}" +
      "#debugQuickMenu .debug-menu-field select,#debugQuickMenu .debug-menu-field button{width:100%;box-sizing:border-box;font:inherit;padding:0.4rem 0.5rem;border-radius:6px;border:1px solid #6b4a12;background:#241c0c;color:#f5e6c8}" +
      "#debugQuickMenu .debug-menu-field button{cursor:pointer;text-align:left}" +
      "#debugQuickMenu .debug-menu-field button:hover{border-color:#ffd27a}" +
      "#debugQuickMenu .debug-menu-actions{display:flex;flex-direction:column;gap:0.35rem;margin-top:0.35rem}" +
      "#debugQuickMenu .debug-menu-close{flex:0 0 auto;width:auto;padding:0.25rem 0.45rem;cursor:pointer;border-radius:6px;border:1px solid #6b4a12;background:#241c0c;color:#f5e6c8;font:inherit;font-size:0.68rem}" +
      "#debugQuickMenu .debug-menu-meta{margin-top:0.65rem;padding-top:0.5rem;border-top:1px solid #6b4a12;color:#a89878;font-size:0.64rem}" +
      "#debugQuickMenuFab{position:fixed;top:0.55rem;right:0.55rem;z-index:119;width:2rem;height:2rem;border-radius:999px;border:1px solid #6b4a12;background:rgba(22,16,6,0.94);color:#ffd27a;font:inherit;font-size:0.85rem;line-height:1;cursor:pointer;box-shadow:0 4px 14px rgba(0,0,0,0.35)}" +
      "#debugQuickMenuFab[hidden]{display:none!important}" +
      "html.debug-mode-on #debugQuickMenuFab{top:3.5rem}" +
      "html.debug-mode-on.debug-hud-compact #debugQuickMenuFab{top:2rem}" +
      /* Zoom the page via transform, but expand layout size so scroll/virtualization
         stay in document space. Overlay UI lives on <html> and is not scaled. */
      "html.debug-culling-test{overflow:auto}" +
      "html.debug-culling-test body{transform:scale(var(--debug-culling-scale,0.75));transform-origin:0 0;width:calc(100% / var(--debug-culling-scale,0.75));min-height:calc(100% / var(--debug-culling-scale,0.75));overflow:visible}" +
      "#debugCullingRoot{position:fixed;inset:0;z-index:200;pointer-events:none;overflow:hidden}" +
      "#debugCullingRoot[hidden]{display:none!important}" +
      "#debugCullingViewport{position:absolute;border:3px solid #3ecf8e;box-shadow:0 0 0 1px rgba(62,207,142,0.35),inset 0 0 0 1px rgba(62,207,142,0.2);background:rgba(62,207,142,0.04);box-sizing:border-box}" +
      "#debugCullingViewportLabel{position:absolute;left:0;top:0;transform:translateY(-100%);margin-top:-0.2rem;padding:0.15rem 0.4rem;border-radius:4px 4px 0 0;background:rgba(12,40,24,0.95);border:1px solid #3ecf8e;border-bottom:0;color:#9be7a8;font:600 0.68rem/1.2 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;white-space:nowrap}" +
      "#debugCullingHud{position:absolute;right:0.65rem;top:0.65rem;pointer-events:auto;display:flex;align-items:center;gap:0.35rem;padding:0.35rem 0.5rem;border-radius:999px;border:1px solid #6b4a12;background:rgba(22,16,6,0.94);color:#f5e6c8;font:600 0.72rem/1 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;box-shadow:0 4px 14px rgba(0,0,0,0.35)}" +
      "#debugCullingHud button{pointer-events:auto;min-width:1.7rem;height:1.55rem;padding:0 0.4rem;border-radius:6px;border:1px solid #6b4a12;background:#241c0c;color:#f5e6c8;font:inherit;cursor:pointer}" +
      "#debugCullingHud button:hover{border-color:#ffd27a}" +
      "#debugCullingGhostLayer{position:absolute;inset:0;overflow:hidden}" +
      ".debug-culling-ghost{position:absolute;border:2px solid #ff5a5a;box-sizing:border-box;pointer-events:none;background:rgba(255,90,90,0.08)}" +
      ".debug-culling-in{outline:2px solid #3ecf8e!important;outline-offset:-2px}" +
      ".debug-culling-out{outline:2px solid #ff5a5a!important;outline-offset:-2px;visibility:hidden!important;pointer-events:none!important}";
    var style = $(STYLE_ID);
    if (!style) {
      style = document.createElement("style");
      style.id = STYLE_ID;
      (document.head || document.documentElement).appendChild(style);
    }
    style.textContent = css;
  }

  function readLayoutPrefs() {
    try {
      var raw = global.sessionStorage && global.sessionStorage.getItem(SS_LAYOUT_KEY);
      if (!raw) return;
      var parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") {
        if (parsed.perf && typeof parsed.perf.x === "number" && typeof parsed.perf.y === "number") {
          panelPositions.perf = { x: parsed.perf.x, y: parsed.perf.y };
        }
        if (parsed.menu && typeof parsed.menu.x === "number" && typeof parsed.menu.y === "number") {
          panelPositions.menu = { x: parsed.menu.x, y: parsed.menu.y };
        }
        uaHudMinimized = parsed.uaMinimized === true;
      }
    } catch (_) {}
  }

  function writeLayoutPrefs() {
    try {
      if (!global.sessionStorage) return;
      global.sessionStorage.setItem(
        SS_LAYOUT_KEY,
        JSON.stringify({
          perf: panelPositions.perf,
          menu: panelPositions.menu,
          uaMinimized: uaHudMinimized === true,
        })
      );
    } catch (_) {}
  }

  function clampPanelPosition(el, x, y) {
    var margin = 8;
    var w = el.offsetWidth || 280;
    var h = el.offsetHeight || 120;
    var maxX = Math.max(margin, (global.innerWidth || document.documentElement.clientWidth || w) - w - margin);
    var maxY = Math.max(margin, (global.innerHeight || document.documentElement.clientHeight || h) - h - margin);
    return {
      x: Math.min(maxX, Math.max(margin, x)),
      y: Math.min(maxY, Math.max(margin, y)),
    };
  }

  function applyPanelPosition(el, posKey) {
    if (!el) return;
    var pos = panelPositions[posKey];
    if (!pos || typeof pos.x !== "number" || typeof pos.y !== "number") {
      el.classList.remove("debug-panel-moved");
      el.style.left = "";
      el.style.top = "";
      return;
    }
    var clamped = clampPanelPosition(el, pos.x, pos.y);
    panelPositions[posKey] = clamped;
    el.classList.add("debug-panel-moved");
    el.style.left = clamped.x + "px";
    el.style.top = clamped.y + "px";
  }

  function makePanelDraggable(el, handle, posKey) {
    if (!el || !handle || handle.dataset.dragWired === "1") return;
    handle.dataset.dragWired = "1";
    handle.addEventListener("pointerdown", function (ev) {
      if (!ev || ev.button != null && ev.button !== 0) return;
      if (ev.target && ev.target.closest && ev.target.closest("button, select, a, input, textarea, label")) return;
      ev.preventDefault();
      var rect = el.getBoundingClientRect();
      var startX = ev.clientX;
      var startY = ev.clientY;
      var origX = rect.left;
      var origY = rect.top;
      var pointerId = ev.pointerId;
      try {
        handle.setPointerCapture(pointerId);
      } catch (_) {}
      el.classList.add("debug-panel-moved");
      el.style.left = origX + "px";
      el.style.top = origY + "px";
      el.style.right = "auto";
      el.style.bottom = "auto";

      function onMove(moveEv) {
        var next = clampPanelPosition(el, origX + (moveEv.clientX - startX), origY + (moveEv.clientY - startY));
        el.style.left = next.x + "px";
        el.style.top = next.y + "px";
      }

      function onUp(upEv) {
        try {
          handle.releasePointerCapture(pointerId);
        } catch (_) {}
        handle.removeEventListener("pointermove", onMove);
        handle.removeEventListener("pointerup", onUp);
        handle.removeEventListener("pointercancel", onUp);
        var finalRect = el.getBoundingClientRect();
        panelPositions[posKey] = clampPanelPosition(el, finalRect.left, finalRect.top);
        applyPanelPosition(el, posKey);
        writeLayoutPrefs();
        if (upEv) upEv.preventDefault();
      }

      handle.addEventListener("pointermove", onMove);
      handle.addEventListener("pointerup", onUp);
      handle.addEventListener("pointercancel", onUp);
    });
  }

  function setUaHudMinimized(minimized) {
    uaHudMinimized = !!minimized;
    writeLayoutPrefs();
    syncHudBar();
  }

  function wireLayoutControls() {
    if (layoutWired) return;
    layoutWired = true;
    readLayoutPrefs();
    global.addEventListener("resize", function () {
      applyPanelPosition($("debugPerfGraph"), "perf");
      applyPanelPosition($("debugQuickMenu"), "menu");
    });
  }

  function ensureHudStructure(hud) {
    if (!hud) return;
    if (!$("debugHudUa") || !hud.querySelector(".debug-hud-body")) {
      hud.innerHTML =
        '<div class="debug-hud-body">' +
        '<span class="debug-hud-row"><span class="debug-hud-label">UA:</span> <span id="debugHudUa"></span></span>' +
        '<span class="debug-hud-row"><span class="debug-hud-label">Host:</span> <span id="debugHudHost"></span></span>' +
        "</div>" +
        '<span class="debug-hud-mini-label">UA / Host</span>' +
        '<button type="button" class="debug-hud-toggle" id="debugHudMinimizeBtn" aria-expanded="true">Minimize</button>';
    } else if (!$("debugHudMinimizeBtn")) {
      var mini = document.createElement("span");
      mini.className = "debug-hud-mini-label";
      mini.textContent = "UA / Host";
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "debug-hud-toggle";
      btn.id = "debugHudMinimizeBtn";
      btn.setAttribute("aria-expanded", "true");
      btn.textContent = "Minimize";
      if (!hud.querySelector(".debug-hud-body")) {
        var body = document.createElement("div");
        body.className = "debug-hud-body";
        while (hud.firstChild) body.appendChild(hud.firstChild);
        hud.appendChild(body);
      }
      hud.appendChild(mini);
      hud.appendChild(btn);
    }
    var toggle = $("debugHudMinimizeBtn");
    if (toggle && toggle.dataset.wired !== "1") {
      toggle.dataset.wired = "1";
      toggle.addEventListener("click", function () {
        setUaHudMinimized(!uaHudMinimized);
      });
    }
  }

  function ensurePerfHead(panel) {
    if (!panel) return;
    var head = panel.querySelector(".debug-perf-head");
    if (!head) {
      var oldTitle = panel.querySelector(".debug-perf-title");
      head = document.createElement("div");
      head.className = "debug-perf-head";
      head.setAttribute("title", "Drag to move");
      var title = document.createElement("div");
      title.className = "debug-perf-title";
      title.textContent = "Performance";
      var hint = document.createElement("span");
      hint.className = "debug-panel-drag-hint";
      hint.textContent = "drag";
      head.appendChild(title);
      head.appendChild(hint);
      if (oldTitle && oldTitle.parentNode === panel) {
        panel.replaceChild(head, oldTitle);
      } else {
        panel.insertBefore(head, panel.firstChild);
      }
    }
    makePanelDraggable(panel, head, "perf");
    applyPanelPosition(panel, "perf");
  }

  function ensureMenuHead(menu) {
    if (!menu) return;
    var head = menu.querySelector(".debug-menu-head");
    if (head && !head.querySelector(".debug-menu-head-actions")) {
      var closeBtn = $("debugQuickMenuCloseBtn");
      var actions = document.createElement("div");
      actions.className = "debug-menu-head-actions";
      var hint = document.createElement("span");
      hint.className = "debug-panel-drag-hint";
      hint.textContent = "drag";
      actions.appendChild(hint);
      if (closeBtn) actions.appendChild(closeBtn);
      head.appendChild(actions);
      head.setAttribute("title", "Drag to move");
    }
    if (head) {
      makePanelDraggable(menu, head, "menu");
      applyPanelPosition(menu, "menu");
    }
  }

  function ensureDom() {
    if (!document.body) return false;
    wireLayoutControls();
    if (!$("debugHudBar")) {
      var hud = document.createElement("div");
      hud.id = "debugHudBar";
      hud.hidden = true;
      hud.setAttribute("aria-live", "polite");
      document.body.appendChild(hud);
    }
    ensureHudStructure($("debugHudBar"));
    if (!$("debugToastStack")) {
      var stack = document.createElement("div");
      stack.id = "debugToastStack";
      stack.className = "debug-toast-stack";
      stack.setAttribute("aria-live", "polite");
      stack.setAttribute("aria-relevant", "additions");
      document.body.appendChild(stack);
    }
    if (!$("debugPerfGraph")) {
      var panel = document.createElement("aside");
      panel.id = "debugPerfGraph";
      panel.hidden = true;
      panel.setAttribute("aria-label", "Performance graph");
      panel.innerHTML =
        '<div class="debug-perf-head" title="Drag to move">' +
        '<div class="debug-perf-title">Performance</div>' +
        '<span class="debug-panel-drag-hint">drag</span>' +
        "</div>" +
        '<div class="debug-perf-chart"><div class="debug-perf-chart-label"><span>CPU pressure</span><strong id="debugPerfCpuValue">—</strong></div>' +
        '<canvas id="debugPerfCpuCanvas" width="300" height="48" aria-hidden="true"></canvas></div>' +
        '<div class="debug-perf-chart"><div class="debug-perf-chart-label"><span>JS heap</span><strong id="debugPerfRamValue">—</strong></div>' +
        '<canvas id="debugPerfRamCanvas" width="300" height="48" aria-hidden="true"></canvas></div>' +
        '<div class="debug-perf-scripts">' +
        '<div class="debug-perf-scripts-title">Top scripts</div>' +
        '<p class="debug-perf-scripts-hint">Ranked by transfer size, load time, and long-task time when available.</p>' +
        '<ul class="debug-perf-script-list" id="debugPerfScriptList"></ul>' +
        '<p class="debug-perf-scripts-empty" id="debugPerfScriptsEmpty">Collecting…</p>' +
        "</div>";
      document.body.appendChild(panel);
    } else if (!$("debugPerfScriptList")) {
      var existing = $("debugPerfGraph");
      var scriptsWrap = document.createElement("div");
      scriptsWrap.className = "debug-perf-scripts";
      scriptsWrap.innerHTML =
        '<div class="debug-perf-scripts-title">Top scripts</div>' +
        '<p class="debug-perf-scripts-hint">Ranked by transfer size, load time, and long-task time when available.</p>' +
        '<ul class="debug-perf-script-list" id="debugPerfScriptList"></ul>' +
        '<p class="debug-perf-scripts-empty" id="debugPerfScriptsEmpty">Collecting…</p>';
      existing.appendChild(scriptsWrap);
    }
    ensurePerfHead($("debugPerfGraph"));
    if (!$("debugQuickMenuFab")) {
      var fab = document.createElement("button");
      fab.id = "debugQuickMenuFab";
      fab.type = "button";
      fab.hidden = true;
      fab.title = "Debug menu (`)";
      fab.setAttribute("aria-label", "Open debug menu");
      fab.textContent = "`";
      fab.addEventListener("click", function () {
        setDebugMenuOpen(true);
      });
      document.body.appendChild(fab);
    }
    if (!$("debugQuickMenu")) {
      var menu = document.createElement("aside");
      menu.id = "debugQuickMenu";
      menu.hidden = true;
      menu.setAttribute("role", "dialog");
      menu.setAttribute("aria-label", "Debug settings");
      menu.innerHTML =
        '<div class="debug-menu-head" title="Drag to move">' +
        '<div class="debug-menu-title">Debug menu</div>' +
        '<div class="debug-menu-head-actions">' +
        '<span class="debug-panel-drag-hint">drag</span>' +
        '<button type="button" class="debug-menu-close" id="debugQuickMenuCloseBtn" aria-label="Close">Close</button>' +
        "</div>" +
        "</div>" +
        '<p class="debug-menu-hint">Toggle with <kbd>`</kbd>. Drag the header to move. Logs persist across pages in this tab.</p>' +
        '<div class="debug-menu-field">' +
        '<label for="debugMenuErudaSelect">Eruda DevTools</label>' +
        '<select id="debugMenuErudaSelect"><option value="enabled">Enabled</option><option value="disabled">Disabled</option></select>' +
        "</div>" +
        '<div class="debug-menu-field">' +
        '<label for="debugMenuUaSelect">User agent HUD</label>' +
        '<select id="debugMenuUaSelect"><option value="show">Show</option><option value="hide">Hide</option></select>' +
        "</div>" +
        '<div class="debug-menu-field">' +
        '<label for="debugMenuPerfSelect">Performance graph</label>' +
        '<select id="debugMenuPerfSelect"><option value="disabled">Disabled</option><option value="enabled">Enabled</option></select>' +
        "</div>" +
        '<div class="debug-menu-field">' +
        '<label for="debugMenuCullingSelect">Culling testing</label>' +
        '<select id="debugMenuCullingSelect"><option value="disabled">Disabled</option><option value="enabled">Enabled</option></select>' +
        '<p class="debug-menu-hint" style="margin:0.25rem 0 0">Requires refresh. Zooms out and outlines the live viewport.</p>' +
        "</div>" +
        '<div class="debug-menu-actions">' +
        '<button type="button" id="debugMenuExportConsoleBtn">Export console logs</button>' +
        '<button type="button" id="debugMenuExportChunkBtn">Export chunk load data</button>' +
        '<button type="button" id="debugMenuExportUaBtn">Export UA / host</button>' +
        '<button type="button" id="debugMenuClearLogsBtn">Clear persisted logs</button>' +
        "</div>" +
        '<div class="debug-menu-meta" id="debugQuickMenuMeta"></div>';
      document.body.appendChild(menu);
      wireDebugMenuOnce();
    } else {
      wireDebugMenuOnce();
    }
    ensureMenuHead($("debugQuickMenu"));
    return true;
  }

  function downloadJson(filename, payload) {
    try {
      var blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
      var url = URL.createObjectURL(blob);
      var a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(function () {
        try {
          URL.revokeObjectURL(url);
        } catch (_) {}
      }, 1000);
    } catch (_) {}
  }

  function patchDebugSettings(partial) {
    settings = normalizeDebugSettings(Object.assign({}, settings, partial || {}));
    writeDebugMirror(settings);
    try {
      var cur = readLocalStorageSettings() || {};
      cur.debugMode = settings.debugMode === true;
      cur.debugShowUserAgent = settings.debugShowUserAgent !== false;
      cur.debugEruda = settings.debugEruda !== false;
      cur.debugPerfGraph = settings.debugPerfGraph === true;
      cur.debugCullingTest = settings.debugCullingTest === true;
      localStorage.setItem(LS_KEY, JSON.stringify(cur));
    } catch (_) {}
    try {
      global.dispatchEvent(
        new CustomEvent("proxylist-debug-settings", { detail: Object.assign({}, settings) })
      );
    } catch (_) {}
    sync();
    syncDebugMenuForm();
  }

  function syncDebugMenuForm() {
    var ua = $("debugMenuUaSelect");
    var erudaSel = $("debugMenuErudaSelect");
    var perf = $("debugMenuPerfSelect");
    var cull = $("debugMenuCullingSelect");
    var meta = $("debugQuickMenuMeta");
    if (ua) ua.value = settings.debugShowUserAgent === false ? "hide" : "show";
    if (erudaSel) erudaSel.value = settings.debugEruda === false ? "disabled" : "enabled";
    if (perf) perf.value = settings.debugPerfGraph === true ? "enabled" : "disabled";
    if (cull) cull.value = settings.debugCullingTest === true ? "enabled" : "disabled";
    if (meta) {
      meta.textContent =
        "Console logs: " +
        consoleLogBuffer.length +
        " · Chunk logs: " +
        chunkLogBuffer.length +
        " · Full options: Settings → Debug on the main list.";
    }
  }

  function setDebugMenuOpen(open) {
    debugMenuOpen = !!open && isDebugMode();
    ensureDom();
    var menu = $("debugQuickMenu");
    var fab = $("debugQuickMenuFab");
    if (menu) {
      menu.hidden = !debugMenuOpen;
      if (debugMenuOpen) applyPanelPosition(menu, "menu");
    }
    if (fab) fab.hidden = !isDebugMode() || debugMenuOpen;
    if (debugMenuOpen) syncDebugMenuForm();
  }

  function wireDebugMenuOnce() {
    var closeBtn = $("debugQuickMenuCloseBtn");
    if (closeBtn && closeBtn.dataset.wired !== "1") {
      closeBtn.dataset.wired = "1";
      closeBtn.addEventListener("click", function () {
        setDebugMenuOpen(false);
      });
    }
    var erudaSel = $("debugMenuErudaSelect");
    if (erudaSel && erudaSel.dataset.wired !== "1") {
      erudaSel.dataset.wired = "1";
      erudaSel.addEventListener("change", function () {
        patchDebugSettings({ debugEruda: erudaSel.value !== "disabled" });
      });
    }
    var ua = $("debugMenuUaSelect");
    if (ua && ua.dataset.wired !== "1") {
      ua.dataset.wired = "1";
      ua.addEventListener("change", function () {
        patchDebugSettings({ debugShowUserAgent: ua.value !== "hide" });
      });
    }
    var perf = $("debugMenuPerfSelect");
    if (perf && perf.dataset.wired !== "1") {
      perf.dataset.wired = "1";
      perf.addEventListener("change", function () {
        patchDebugSettings({ debugPerfGraph: perf.value === "enabled" });
      });
    }
    var cull = $("debugMenuCullingSelect");
    if (cull && cull.dataset.wired !== "1") {
      cull.dataset.wired = "1";
      cull.addEventListener("change", function () {
        var enabled = cull.value === "enabled";
        var ok = global.confirm(
          (enabled ? "Enable" : "Disable") +
            " culling testing? This requires refreshing the site."
        );
        if (!ok) {
          syncDebugMenuForm();
          return;
        }
        patchDebugSettings({ debugCullingTest: enabled });
        global.location.reload();
      });
    }
    var exportConsole = $("debugMenuExportConsoleBtn");
    if (exportConsole && exportConsole.dataset.wired !== "1") {
      exportConsole.dataset.wired = "1";
      exportConsole.addEventListener("click", function () {
        downloadJson("proxy-list-console-logs.json", {
          exported_at: new Date().toISOString(),
          logs: consoleLogBuffer.slice(),
        });
      });
    }
    var exportChunk = $("debugMenuExportChunkBtn");
    if (exportChunk && exportChunk.dataset.wired !== "1") {
      exportChunk.dataset.wired = "1";
      exportChunk.addEventListener("click", function () {
        downloadJson("proxy-list-chunk-logs.json", {
          exported_at: new Date().toISOString(),
          logs: chunkLogBuffer.slice(),
        });
      });
    }
    var exportUa = $("debugMenuExportUaBtn");
    if (exportUa && exportUa.dataset.wired !== "1") {
      exportUa.dataset.wired = "1";
      exportUa.addEventListener("click", function () {
        downloadJson("proxy-list-ua-host.json", {
          exported_at: new Date().toISOString(),
          userAgent: navigator.userAgent || "",
          host: describePageHostContext(),
          href: String((global.location && global.location.href) || ""),
        });
      });
    }
    var clearLogs = $("debugMenuClearLogsBtn");
    if (clearLogs && clearLogs.dataset.wired !== "1") {
      clearLogs.dataset.wired = "1";
      clearLogs.addEventListener("click", function () {
        clearPersistedLogs();
        syncDebugMenuForm();
        showToast("info", "Persisted debug logs cleared.");
      });
    }
  }

  function isTypingTarget(el) {
    if (!el) return false;
    var tag = String(el.tagName || "").toLowerCase();
    if (tag === "input" || tag === "textarea" || tag === "select") return true;
    if (el.isContentEditable) return true;
    return false;
  }

  function wireDebugMenuHotkey() {
    if (debugMenuKeyWired) return;
    debugMenuKeyWired = true;
    global.addEventListener(
      "keydown",
      function (ev) {
        if (!ev) return;
        if (ev.key !== "`" && ev.code !== "Backquote") return;
        if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
        if (isTypingTarget(ev.target)) return;
        if (!isDebugMode()) return;
        ev.preventDefault();
        setDebugMenuOpen(!debugMenuOpen);
      },
      true
    );
    global.addEventListener("keydown", function (ev) {
      if (!debugMenuOpen) return;
      if (ev.key === "Escape") setDebugMenuOpen(false);
    });
  }

  function describePageHostContext() {
    try {
      var loc = global.location;
      var protocol = String(loc.protocol || "").toLowerCase();
      var host = String(loc.hostname || "").toLowerCase();
      if (protocol === "file:") return "Local page (file://)";
      if (
        host === "localhost" ||
        host === "127.0.0.1" ||
        host === "[::1]" ||
        host.endsWith(".localhost") ||
        host.endsWith(".local")
      ) {
        return "Local page (" + (loc.host || host || "localhost") + ")";
      }
      if (!host) return "Unknown host";
      return "Hosted externally (" + (loc.host || host) + ")";
    } catch (_) {
      return "Unknown host";
    }
  }

  function loadPersistedLogs() {
    try {
      var raw = global.sessionStorage && global.sessionStorage.getItem(SS_LOGS_KEY);
      if (!raw) return;
      var parsed = JSON.parse(raw);
      if (Array.isArray(parsed.console)) {
        consoleLogBuffer = parsed.console.slice(-MAX_LOG_ENTRIES);
      }
      if (Array.isArray(parsed.chunk)) {
        chunkLogBuffer = parsed.chunk.slice(-MAX_LOG_ENTRIES);
      }
    } catch (_) {}
  }

  function persistLogs() {
    try {
      if (!global.sessionStorage) return;
      global.sessionStorage.setItem(
        SS_LOGS_KEY,
        JSON.stringify({
          console: consoleLogBuffer.slice(-MAX_LOG_ENTRIES),
          chunk: chunkLogBuffer.slice(-MAX_LOG_ENTRIES),
        })
      );
    } catch (_) {}
  }

  function clearPersistedLogs() {
    consoleLogBuffer = [];
    chunkLogBuffer = [];
    try {
      if (global.sessionStorage) global.sessionStorage.removeItem(SS_LOGS_KEY);
    } catch (_) {}
  }

  function pushLogBuffer(kind, message) {
    var entry = {
      at: new Date().toISOString(),
      kind: kind,
      message: String(message || ""),
      page: "",
    };
    try {
      entry.page = String((global.location && global.location.pathname) || "");
    } catch (_) {}
    if (kind === "chunk") {
      chunkLogBuffer.push(entry);
      if (chunkLogBuffer.length > MAX_LOG_ENTRIES) chunkLogBuffer.shift();
    } else {
      consoleLogBuffer.push(entry);
      if (consoleLogBuffer.length > MAX_LOG_ENTRIES) consoleLogBuffer.shift();
    }
    persistLogs();
  }

  function formatDebugArg(arg) {
    if (arg == null) return String(arg);
    if (typeof arg === "string") return arg;
    if (arg instanceof Error) return arg.stack || arg.message || String(arg);
    try {
      return JSON.stringify(arg);
    } catch (_) {
      return String(arg);
    }
  }

  function showToast(kind, message) {
    if (!isDebugMode()) return;
    pushLogBuffer(
      kind === "chunk" ? "chunk" : kind === "error" ? "error" : kind === "warn" ? "warn" : "info",
      message
    );
    ensureDom();
    var stack = $("debugToastStack");
    if (!stack) return;
    var toast = document.createElement("div");
    var k = kind === "error" ? "error" : kind === "chunk" ? "chunk" : "info";
    toast.className = "debug-toast debug-toast-" + k;
    toast.setAttribute("role", k === "error" ? "alert" : "status");
    var label = document.createElement("span");
    label.className = "debug-toast-kind";
    label.textContent =
      kind === "error" ? "Error" : kind === "chunk" ? "Load time" : kind === "info" ? "Info" : "Warn";
    var body = document.createElement("div");
    var ts = new Date().toISOString().slice(11, 23);
    body.textContent = "[" + ts + "] " + String(message || "");
    toast.appendChild(label);
    toast.appendChild(body);
    stack.appendChild(toast);
    while (stack.childNodes.length > 8) stack.removeChild(stack.firstChild);
    requestAnimationFrame(function () {
      toast.classList.add("visible");
    });
    var holdMs = k === "error" ? 9000 : k === "chunk" ? 5500 : 7000;
    setTimeout(function () {
      toast.classList.remove("visible");
      setTimeout(function () {
        if (toast.parentNode) toast.parentNode.removeChild(toast);
      }, 220);
    }, holdMs);
  }

  function syncHudBar() {
    ensureDom();
    var bar = $("debugHudBar");
    if (!bar) return;
    var on = isDebugMode() && settings.debugShowUserAgent !== false;
    bar.hidden = !on;
    document.documentElement.classList.toggle("debug-mode-on", on);
    document.documentElement.classList.toggle("debug-hud-compact", on && uaHudMinimized);
    bar.classList.toggle("debug-hud-minimized", on && uaHudMinimized);
    var toggle = $("debugHudMinimizeBtn");
    if (toggle) {
      toggle.textContent = uaHudMinimized ? "Expand" : "Minimize";
      toggle.setAttribute("aria-expanded", uaHudMinimized ? "false" : "true");
      toggle.setAttribute("aria-label", uaHudMinimized ? "Expand user agent info" : "Minimize user agent info");
      toggle.title = uaHudMinimized ? "Expand UA / host info" : "Minimize UA / host info";
    }
    if (!on) return;
    var uaEl = $("debugHudUa");
    var hostEl = $("debugHudHost");
    if (uaEl) uaEl.textContent = navigator.userAgent || "(unavailable)";
    if (hostEl) hostEl.textContent = describePageHostContext();
  }

  function drawPerfSeries(canvas, samples, key, maxValue, color) {
    if (!canvas || !canvas.getContext) return;
    var ctx = canvas.getContext("2d");
    var w = canvas.width;
    var h = canvas.height;
    var maxV = Math.max(1, Number(maxValue) || 1);
    ctx.clearRect(0, 0, w, h);
    ctx.strokeStyle = "rgba(245, 230, 200, 0.12)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(1, h - 2);
    ctx.lineTo(w - 1, h - 2);
    ctx.stroke();
    if (!samples.length) return;
    ctx.beginPath();
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.6;
    samples.forEach(function (s, i) {
      var val = Math.max(0, Number(s[key]) || 0);
      var x = (i / Math.max(1, samples.length - 1)) * (w - 2) + 1;
      var y = h - 2 - (Math.min(maxV, val) / maxV) * (h - 4);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
  }

  function shortScriptLabel(url) {
    var raw = String(url || "");
    if (!raw) return "(unknown)";
    try {
      var u = new URL(raw, global.location.href);
      var parts = u.pathname.split("/").filter(Boolean);
      var file = parts.length ? parts[parts.length - 1] : u.hostname || raw;
      if (!file) file = u.hostname || raw;
      if (file.length > 42) file = file.slice(0, 20) + "…" + file.slice(-18);
      return file;
    } catch (_) {
      return raw.length > 42 ? raw.slice(0, 20) + "…" + raw.slice(-18) : raw;
    }
  }

  function formatBytes(n) {
    var v = Number(n) || 0;
    if (v <= 0) return "—";
    if (v < 1024) return v + " B";
    if (v < 1048576) return (v / 1024).toFixed(1) + " KB";
    return (v / 1048576).toFixed(2) + " MB";
  }

  function formatMs(n) {
    var v = Number(n) || 0;
    if (v <= 0) return "—";
    if (v < 10) return v.toFixed(1) + " ms";
    return Math.round(v) + " ms";
  }

  function normalizeScriptKey(url) {
    var raw = String(url || "");
    if (!raw) return "";
    try {
      var u = new URL(raw, global.location.href);
      u.hash = "";
      return u.href;
    } catch (_) {
      return raw.split("#")[0];
    }
  }

  function isScriptResourceEntry(entry) {
    if (!entry) return false;
    var type = String(entry.initiatorType || "").toLowerCase();
    if (type === "script") return true;
    var name = String(entry.name || "").toLowerCase();
    return /\.m?js(\?|$)/.test(name) || /\/[^/?]+\.m?js(\?|$)/.test(name);
  }

  function ensureLongTaskObserver() {
    if (longTaskObserverStarted) return;
    longTaskObserverStarted = true;
    if (typeof PerformanceObserver === "undefined") return;
    try {
      var obs = new PerformanceObserver(function (list) {
        var entries = list.getEntries ? list.getEntries() : [];
        for (var i = 0; i < entries.length; i++) {
          var entry = entries[i];
          var dur = Number(entry.duration) || 0;
          var attrs = entry.attribution || [];
          if (!attrs.length) {
            var key = "(unattributed)";
            longTaskMsByScript[key] = (longTaskMsByScript[key] || 0) + dur;
            continue;
          }
          for (var j = 0; j < attrs.length; j++) {
            var a = attrs[j] || {};
            var src =
              normalizeScriptKey(a.containerSrc || a.scriptUrl || a.name || "") ||
              String(a.containerType || "script");
            longTaskMsByScript[src] = (longTaskMsByScript[src] || 0) + dur;
          }
        }
      });
      obs.observe({ type: "longtask", buffered: true });
    } catch (_) {}
  }

  function collectTopScripts(limit) {
    var byKey = Object.create(null);
    try {
      var resources =
        performance && typeof performance.getEntriesByType === "function"
          ? performance.getEntriesByType("resource")
          : [];
      for (var i = 0; i < resources.length; i++) {
        var entry = resources[i];
        if (!isScriptResourceEntry(entry)) continue;
        var key = normalizeScriptKey(entry.name);
        if (!key) continue;
        var size = Number(entry.decodedBodySize) || Number(entry.transferSize) || 0;
        var duration = Number(entry.duration) || 0;
        if (!byKey[key]) {
          byKey[key] = { key: key, size: 0, duration: 0, longTaskMs: 0, hits: 0 };
        }
        byKey[key].size = Math.max(byKey[key].size, size);
        byKey[key].duration += duration;
        byKey[key].hits += 1;
      }
    } catch (_) {}

    Object.keys(longTaskMsByScript).forEach(function (ltKey) {
      var ltMs = Number(longTaskMsByScript[ltKey]) || 0;
      if (!ltMs) return;
      if (byKey[ltKey]) {
        byKey[ltKey].longTaskMs += ltMs;
        return;
      }
      var matched = false;
      Object.keys(byKey).forEach(function (resKey) {
        if (matched) return;
        if (resKey.indexOf(ltKey) !== -1 || (ltKey.length > 8 && ltKey.indexOf(resKey) !== -1)) {
          byKey[resKey].longTaskMs += ltMs;
          matched = true;
        }
      });
      if (!matched) {
        byKey[ltKey] = { key: ltKey, size: 0, duration: 0, longTaskMs: ltMs, hits: 0 };
      }
    });

    var rows = Object.keys(byKey).map(function (k) {
      return byKey[k];
    });
    rows.forEach(function (row) {
      // Weight: 1 point per KB + 2 points per load ms + 8 points per long-task ms.
      row.score = row.size / 1024 + row.duration * 2 + row.longTaskMs * 8;
    });
    rows.sort(function (a, b) {
      return b.score - a.score;
    });
    return rows.slice(0, Math.max(1, limit || 6));
  }

  function renderTopScripts() {
    ensureDom();
    var list = $("debugPerfScriptList");
    var empty = $("debugPerfScriptsEmpty");
    if (!list) return;
    var rows = collectTopScripts(6);
    list.replaceChildren();
    if (!rows.length || rows.every(function (r) { return r.score <= 0; })) {
      if (empty) {
        empty.hidden = false;
        empty.textContent = "No script timings yet.";
      }
      return;
    }
    if (empty) empty.hidden = true;
    rows.forEach(function (row, idx) {
      var li = document.createElement("li");
      var name = document.createElement("span");
      name.className = "debug-perf-script-name";
      name.textContent = idx + 1 + ". " + shortScriptLabel(row.key);
      name.title = row.key;
      var meta = document.createElement("span");
      meta.className = "debug-perf-script-meta";
      meta.textContent = formatBytes(row.size);
      var sub = document.createElement("span");
      sub.className = "debug-perf-script-sub";
      var bits = ["load " + formatMs(row.duration)];
      if (row.longTaskMs > 0) bits.push("long " + formatMs(row.longTaskMs));
      if (row.hits > 1) bits.push("×" + row.hits);
      sub.textContent = bits.join(" · ");
      li.appendChild(name);
      li.appendChild(meta);
      li.appendChild(sub);
      list.appendChild(li);
    });
  }

  function isCullingTestActive() {
    return isDebugMode() && settings.debugCullingTest === true;
  }

  function clearCullingMarks() {
    try {
      document.querySelectorAll(".debug-culling-in, .debug-culling-out").forEach(function (el) {
        el.classList.remove("debug-culling-in", "debug-culling-out");
      });
    } catch (_) {}
  }

  function ensureCullingDom() {
    var root = $("debugCullingRoot");
    if (root) return root;
    root = document.createElement("div");
    root.id = "debugCullingRoot";
    root.hidden = true;
    root.setAttribute("aria-hidden", "true");
    root.innerHTML =
      '<div id="debugCullingGhostLayer" aria-hidden="true"></div>' +
      '<div id="debugCullingViewport" aria-hidden="true">' +
      '<span id="debugCullingViewportLabel">Visible viewport</span>' +
      "</div>" +
      '<div id="debugCullingHud">' +
      '<button type="button" id="debugCullingZoomOutBtn" title="Zoom out further" aria-label="Zoom out">−</button>' +
      '<span id="debugCullingZoomLabel">75%</span>' +
      '<button type="button" id="debugCullingZoomInBtn" title="Zoom in" aria-label="Zoom in">+</button>' +
      '<button type="button" id="debugCullingZoomResetBtn" title="Reset zoom">Reset</button>' +
      "</div>";
    (document.documentElement || document.body).appendChild(root);
    return root;
  }

  function notifyCullingZoomChanged() {
    try {
      global.dispatchEvent(
        new CustomEvent("proxylist-culling-zoom", {
          detail: { scale: cullingScale, active: isCullingTestActive() },
        })
      );
    } catch (_) {}
    try {
      global.dispatchEvent(new Event("resize"));
    } catch (_) {}
  }

  function setCullingScale(next) {
    var clamped = Math.max(0.4, Math.min(1, Number(next) || cullingScale));
    cullingScale = Math.round(clamped * 100) / 100;
    document.documentElement.style.setProperty("--debug-culling-scale", String(cullingScale));
    var label = $("debugCullingZoomLabel");
    if (label) label.textContent = Math.round(cullingScale * 100) + "%";
    // Force layout with the new scale before measuring / virtualizing.
    try {
      void document.body.offsetHeight;
    } catch (_) {}
    notifyCullingZoomChanged();
    scheduleCullingPass();
    // Second pass after virtual table / layout settle.
    global.requestAnimationFrame(function () {
      scheduleCullingPass();
      global.setTimeout(scheduleCullingPass, 50);
    });
  }

  function wireCullingControlsOnce() {
    if (cullingWired) return;
    cullingWired = true;
    ensureCullingDom();
    var outBtn = $("debugCullingZoomOutBtn");
    var inBtn = $("debugCullingZoomInBtn");
    var resetBtn = $("debugCullingZoomResetBtn");
    if (outBtn) {
      outBtn.addEventListener("click", function () {
        setCullingScale(cullingScale - 0.05);
      });
    }
    if (inBtn) {
      inBtn.addEventListener("click", function () {
        setCullingScale(cullingScale + 0.05);
      });
    }
    if (resetBtn) {
      resetBtn.addEventListener("click", function () {
        setCullingScale(0.75);
      });
    }
    global.addEventListener(
      "scroll",
      function () {
        if (isCullingTestActive()) scheduleCullingPass();
      },
      true
    );
    global.addEventListener("resize", function () {
      if (isCullingTestActive()) scheduleCullingPass();
    });
    try {
      var mo = new MutationObserver(function () {
        if (isCullingTestActive()) scheduleCullingPass();
      });
      var observeTarget = function () {
        var tbody = $("linksTableBody") || document.querySelector("main");
        if (tbody && !tbody.dataset.cullingMo) {
          tbody.dataset.cullingMo = "1";
          mo.observe(tbody, { childList: true, subtree: true });
        }
      };
      observeTarget();
      setTimeout(observeTarget, 800);
    } catch (_) {}
  }

  function rectsIntersect(a, b) {
    return !(a.right <= b.left || a.left >= b.right || a.bottom <= b.top || a.top >= b.bottom);
  }

  function runCullingPass() {
    cullingRaf = 0;
    if (!isCullingTestActive()) return;
    var root = ensureCullingDom();
    var viewport = $("debugCullingViewport");
    var ghosts = $("debugCullingGhostLayer");
    if (!viewport || !ghosts) return;

    var vw = global.innerWidth || document.documentElement.clientWidth || 0;
    var vh = global.innerHeight || document.documentElement.clientHeight || 0;
    var scale = cullingScale > 0 ? cullingScale : 1;
    // Green FOV = the browser viewport mapped into the scaled (zoomed-out) view.
    var boxW = vw * scale;
    var boxH = vh * scale;
    viewport.style.left = "0px";
    viewport.style.top = "0px";
    viewport.style.width = boxW + "px";
    viewport.style.height = boxH + "px";

    var viewRect = {
      left: 0,
      top: 0,
      right: boxW,
      bottom: boxH,
      width: boxW,
      height: boxH,
    };

    ghosts.replaceChildren();
    var nodes;
    try {
      nodes = document.querySelectorAll(CULLING_SELECTOR);
    } catch (_) {
      nodes = [];
    }

    var frag = document.createDocumentFragment();
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      if (!el || !el.isConnected) continue;
      if (el.closest && el.closest("#debugCullingRoot, #debugPerfGraph, #debugQuickMenu, #debugQuickMenuFab, #debugHudBar, #debugToastStack")) {
        continue;
      }
      // Skip virtual pad spacer rows — they are not real content.
      if (el.classList && (el.classList.contains("virtual-pad-top") || el.classList.contains("virtual-pad-bottom"))) {
        continue;
      }
      // visibility:hidden (culled) still reports geometry via getBoundingClientRect.
      var r = el.getBoundingClientRect();
      if (!r || (r.width <= 0 && r.height <= 0)) continue;
      var visible = rectsIntersect(r, viewRect);
      el.classList.toggle("debug-culling-in", visible);
      el.classList.toggle("debug-culling-out", !visible);
      if (!visible) {
        var ghost = document.createElement("div");
        ghost.className = "debug-culling-ghost";
        ghost.style.left = r.left + "px";
        ghost.style.top = r.top + "px";
        ghost.style.width = Math.max(2, r.width) + "px";
        ghost.style.height = Math.max(2, r.height) + "px";
        frag.appendChild(ghost);
      }
    }
    ghosts.appendChild(frag);
  }

  function scheduleCullingPass() {
    if (cullingRaf) return;
    cullingRaf = global.requestAnimationFrame(runCullingPass);
  }

  function syncCullingTest() {
    injectStyles();
    var active = isCullingTestActive();
    var wasActive = document.documentElement.classList.contains("debug-culling-test");
    document.documentElement.classList.toggle("debug-culling-test", active);
    if (!active) {
      document.documentElement.style.removeProperty("--debug-culling-scale");
      clearCullingMarks();
      var rootOff = $("debugCullingRoot");
      if (rootOff) rootOff.hidden = true;
      if (wasActive) notifyCullingZoomChanged();
      return;
    }
    wireCullingControlsOnce();
    var root = ensureCullingDom();
    root.hidden = false;
    setCullingScale(cullingScale || 0.75);
    // Re-run after layout/virtual table paints.
    setTimeout(scheduleCullingPass, 250);
    setTimeout(scheduleCullingPass, 1000);
  }

  function syncPerfGraph() {
    ensureDom();
    var panel = $("debugPerfGraph");
    if (!panel) return;
    var on = isDebugMode() && settings.debugPerfGraph === true;
    panel.hidden = !on;
    if (on) applyPanelPosition(panel, "perf");
    if (!on) {
      if (perfTimer) {
        cancelAnimationFrame(perfTimer);
        perfTimer = null;
      }
      return;
    }
    ensureLongTaskObserver();
    if (perfTimer) return;
    lastFrameTs = performance.now();
    var tick = function (now) {
      perfTimer = null;
      if (!(isDebugMode() && settings.debugPerfGraph === true)) return;
      var dt = Math.max(1, now - lastFrameTs);
      lastFrameTs = now;
      var frameCost = Math.min(100, Math.max(0, ((dt - 16.7) / 16.7) * 100));
      cpuEma = cpuEma * 0.85 + frameCost * 0.15;
      var heapUsedMb = null;
      try {
        var mem = performance.memory;
        if (mem && mem.usedJSHeapSize) heapUsedMb = mem.usedJSHeapSize / 1048576;
      } catch (_) {}
      var cpuEl = $("debugPerfCpuValue");
      if (cpuEl) cpuEl.textContent = "~" + cpuEma.toFixed(0) + "%";
      var ramEl = $("debugPerfRamValue");
      if (ramEl) ramEl.textContent = heapUsedMb == null ? "n/a" : heapUsedMb.toFixed(1) + " MB";
      perfSamples.push({ cpu: cpuEma, heapMb: heapUsedMb == null ? 0 : heapUsedMb });
      if (perfSamples.length > 60) perfSamples.shift();
      var ramScale = Math.max((heapUsedMb || 0) * 1.25, 100);
      drawPerfSeries($("debugPerfCpuCanvas"), perfSamples, "cpu", 100, "#9be7ff");
      drawPerfSeries($("debugPerfRamCanvas"), perfSamples, "heapMb", ramScale, "#ffd27a");
      if (!lastScriptRankTs || now - lastScriptRankTs > 1000) {
        lastScriptRankTs = now;
        renderTopScripts();
      }
      perfTimer = requestAnimationFrame(tick);
    };
    perfTimer = requestAnimationFrame(tick);
  }

  function captureConsoleMessage(level, args) {
    if (!isDebugMode()) return;
    var text = Array.prototype.map.call(args || [], formatDebugArg).join(" ");
    if (!text) return;
    showToast(level === "error" ? "error" : "warn", text);
  }

  function installConsoleHooks() {
    if (consoleHooksInstalled) return;
    consoleHooksInstalled = true;
    var origError = console.error.bind(console);
    var origWarn = console.warn.bind(console);
    console.error = function () {
      try {
        captureConsoleMessage("error", arguments);
      } catch (_) {}
      return origError.apply(console, arguments);
    };
    console.warn = function () {
      try {
        captureConsoleMessage("warn", arguments);
      } catch (_) {}
      return origWarn.apply(console, arguments);
    };
    global.addEventListener("error", function (ev) {
      if (!isDebugMode()) return;
      var msg =
        (ev && ev.message ? ev.message : "window error") +
        (ev && ev.filename ? " @ " + ev.filename + ":" + (ev.lineno || "?") : "");
      showToast("error", msg);
    });
    global.addEventListener("unhandledrejection", function (ev) {
      if (!isDebugMode()) return;
      showToast("error", "unhandledrejection: " + formatDebugArg(ev && ev.reason));
    });
  }

  function erudaIsInit() {
    try {
      return !!(global.eruda && global.eruda._isInit);
    } catch (_) {
      return false;
    }
  }

  function initEruda() {
    if (!global.eruda || typeof global.eruda.init !== "function") return;
    if (erudaIsInit()) return;
    try {
      var ls = global.localStorage;
      var raw = JSON.parse((ls && ls.getItem("eruda-dev-tools")) || "{}") || {};
      var theme = String(raw.theme || "");
      if (!theme || theme.toLowerCase() === "dark") raw.theme = "Dark";
      if (ls) ls.setItem("eruda-dev-tools", JSON.stringify(raw));
    } catch (_) {}
    try {
      global.eruda.init({
        defaults: {
          theme: "Dark",
          displaySize: 50,
          transparency: 0.95,
        },
      });
    } catch (_) {
      return;
    }
    try {
      if (typeof global.eruda.position === "function") {
        var w = global.innerWidth || 360;
        var h = global.innerHeight || 640;
        global.eruda.position({ x: Math.max(16, w - 72), y: Math.max(16, h - 96) });
      }
    } catch (_) {}
  }

  function destroyEruda() {
    try {
      if (erudaIsInit() && typeof global.eruda.destroy === "function") global.eruda.destroy();
    } catch (_) {}
  }

  function loadErudaScript(src, onerror) {
    var s = document.createElement("script");
    s.src = src;
    s.async = true;
    s.onload = function () {
      erudaLoading = false;
      if (isErudaEnabled()) initEruda();
      else destroyEruda();
    };
    s.onerror = typeof onerror === "function" ? onerror : function () {
      erudaLoading = false;
    };
    (document.head || document.documentElement).appendChild(s);
  }

  function isErudaEnabled() {
    return isDebugMode() && settings.debugEruda !== false;
  }

  function ensureEruda() {
    if (!isErudaEnabled()) {
      destroyEruda();
      return;
    }
    if (global.eruda) {
      initEruda();
      return;
    }
    if (erudaLoading) return;
    erudaLoading = true;
    var localSrc = (SCRIPT_DIR || "") + "vendor/eruda.min.js";
    loadErudaScript(localSrc, function () {
      loadErudaScript(WORKER_ORIGIN + "/vendor/eruda.min.js", function () {
        erudaLoading = false;
      });
    });
  }

  function sync() {
    injectStyles();
    ensureDom();
    installConsoleHooks();
    wireDebugMenuHotkey();
    syncHudBar();
    syncCullingTest();
    ensureEruda();
    var stack = $("debugToastStack");
    if (stack && !isDebugMode()) stack.replaceChildren();
    if (!isDebugMode()) {
      debugMenuOpen = false;
      var menu = $("debugQuickMenu");
      var fab = $("debugQuickMenuFab");
      if (menu) menu.hidden = true;
      if (fab) fab.hidden = true;
    } else {
      var fabOn = $("debugQuickMenuFab");
      if (fabOn) fabOn.hidden = debugMenuOpen;
      if (debugMenuOpen) {
        var menuOn = $("debugQuickMenu");
        if (menuOn) menuOn.hidden = false;
        syncDebugMenuForm();
      }
    }
    syncPerfGraph();
  }

  function applySettings(raw) {
    settings = normalizeDebugSettings(raw);
    writeDebugMirror(settings);
    sync();
  }

  function mergeSettingsSources(fromLs, fromIdb, fromMirror) {
    var merged = {};
    if (fromLs && typeof fromLs === "object") merged = Object.assign(merged, fromLs);
    if (fromIdb && typeof fromIdb === "object") merged = Object.assign(merged, fromIdb);
    if (fromMirror && typeof fromMirror === "object") merged = Object.assign(merged, fromMirror);
    // Prefer whichever source explicitly enables debug mode / perf graph.
    if (fromLs && fromLs.debugMode === true) merged.debugMode = true;
    if (fromIdb && fromIdb.debugMode === true) merged.debugMode = true;
    if (fromMirror && fromMirror.debugMode === true) merged.debugMode = true;
    if (fromLs && fromLs.debugPerfGraph === true) merged.debugPerfGraph = true;
    if (fromIdb && fromIdb.debugPerfGraph === true) merged.debugPerfGraph = true;
    if (fromMirror && fromMirror.debugPerfGraph === true) merged.debugPerfGraph = true;
    if (fromLs && fromLs.debugCullingTest === true) merged.debugCullingTest = true;
    if (fromIdb && fromIdb.debugCullingTest === true) merged.debugCullingTest = true;
    if (fromMirror && fromMirror.debugCullingTest === true) merged.debugCullingTest = true;
    return merged;
  }

  function loadAndSync() {
    if (bootPromise) return bootPromise;
    loadPersistedLogs();
    bootPromise = Promise.resolve()
      .then(function () {
        var fromLs = readLocalStorageSettings();
        var fromMirror = readDebugMirror();
        // Always try IndexedDB as well — settings may live there even when the
        // "save locally" toggle is off, or when localStorage was cleared.
        return readIdbSettings().then(function (fromIdb) {
          return mergeSettingsSources(fromLs, fromIdb, fromMirror);
        });
      })
      .then(function (merged) {
        applySettings(merged);
        if (isDebugMode()) {
          showToast(
            "info",
            "Debug overlays active. Press ` for the debug menu (" +
              consoleLogBuffer.length +
              " persisted console logs)."
          );
        }
        return settings;
      })
      .catch(function () {
        applySettings(null);
        return settings;
      });
    return bootPromise;
  }

  function bootWhenReady() {
    injectStyles();
    function go() {
      ensureDom();
      loadAndSync().then(function () {
        // Re-assert DOM after late layout scripts (e.g. stats charts).
        setTimeout(function () {
          ensureDom();
          sync();
        }, 500);
      });
    }
    if (document.body) go();
    else document.addEventListener("DOMContentLoaded", go);

    try {
      global.addEventListener("storage", function (ev) {
        if (!ev || (ev.key !== LS_KEY && ev.key !== LS_DEBUG_KEY)) return;
        bootPromise = null;
        loadAndSync();
      });
    } catch (_) {}
  }

  var api = {
    __booted: true,
    applySettings: applySettings,
    sync: sync,
    showToast: showToast,
    isDebugMode: isDebugMode,
    isCullingTestActive: isCullingTestActive,
    getCullingScale: function () {
      return isCullingTestActive() ? cullingScale : 1;
    },
    describeHost: describePageHostContext,
    getConsoleLogs: function () {
      return consoleLogBuffer.slice();
    },
    getChunkLogs: function () {
      return chunkLogBuffer.slice();
    },
    clearLogs: clearPersistedLogs,
    openMenu: function () {
      setDebugMenuOpen(true);
    },
    closeMenu: function () {
      setDebugMenuOpen(false);
    },
    getSettings: function () {
      return Object.assign({}, settings);
    },
  };

  global.ProxyListDebug = api;
  bootWhenReady();
})(typeof window !== "undefined" ? window : this);
