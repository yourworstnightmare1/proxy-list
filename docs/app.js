    const $ = (id) => document.getElementById(id);

    /**
     * DOMPurify drops orphan <tr>/<th>/<td> (not under <table>), which broke "Most opened" rows.
     * Parse sanitized markup with DOMParser and apply nodes directly (no live innerHTML sinks).
     */
    function importSanitizedNodes(nodes) {
      return Array.from(nodes || []).map((node) => document.importNode(node, true));
    }

    function nodesFromSanitizedBodyHtml(raw) {
      if (!raw) return [];
      if (!window.DOMPurify) return nodesFromTrustedBodyHtml(raw);
      const clean = DOMPurify.sanitize(String(raw));
      if (!clean) return [];
      const doc = new DOMParser().parseFromString("<body>" + clean + "</body>", "text/html");
      return importSanitizedNodes(doc.body.childNodes);
    }

    function nodesFromTrustedBodyHtml(raw) {
      if (!raw) return [];
      const doc = new DOMParser().parseFromString("<body>" + String(raw) + "</body>", "text/html");
      return importSanitizedNodes(doc.body.childNodes);
    }

    function nodesFromTrustedTableSection(sectionTag, raw) {
      const tag = String(sectionTag || "").toLowerCase();
      if (!raw || (tag !== "thead" && tag !== "tbody")) return [];
      const doc = new DOMParser().parseFromString(
        "<table><" + tag + ">" + String(raw) + "</" + tag + "></table>",
        "text/html"
      );
      const section = doc.querySelector(tag);
      return section ? importSanitizedNodes(section.childNodes) : [];
    }

    function nodesFromTrustedSelectOptions(raw) {
      if (!raw) return [];
      const doc = new DOMParser().parseFromString("<select>" + String(raw) + "</select>", "text/html");
      const select = doc.querySelector("select");
      return select ? importSanitizedNodes(select.childNodes) : [];
    }

    function nodesFromSanitizedTableSection(sectionTag, raw) {
      const tag = String(sectionTag || "").toLowerCase();
      if (!raw || (tag !== "thead" && tag !== "tbody")) return [];
      if (!window.DOMPurify) return nodesFromTrustedTableSection(tag, raw);
      const clean = DOMPurify.sanitize("<table><" + tag + ">" + String(raw) + "</" + tag + "></table>");
      if (!clean) return [];
      const doc = new DOMParser().parseFromString(clean, "text/html");
      const section = doc.querySelector(tag);
      return section ? importSanitizedNodes(section.childNodes) : [];
    }

    function nodesFromSanitizedSelectOptions(raw) {
      if (!raw) return [];
      if (!window.DOMPurify) return nodesFromTrustedSelectOptions(raw);
      // Orphan <option> nodes are dropped outside <select>, same class of issue as <tr>/<td>.
      const clean = DOMPurify.sanitize("<select>" + String(raw) + "</select>");
      if (!clean) return [];
      const doc = new DOMParser().parseFromString(clean, "text/html");
      const select = doc.querySelector("select");
      return select ? importSanitizedNodes(select.childNodes) : [];
    }

    function htmlNodesForElement(el, raw) {
      const tag = el.tagName;
      if (tag === "THEAD") {
        return window.DOMPurify
          ? nodesFromSanitizedTableSection("thead", raw)
          : nodesFromTrustedTableSection("thead", raw);
      }
      if (tag === "TBODY") {
        return window.DOMPurify
          ? nodesFromSanitizedTableSection("tbody", raw)
          : nodesFromTrustedTableSection("tbody", raw);
      }
      if (tag === "SELECT") {
        return window.DOMPurify ? nodesFromSanitizedSelectOptions(raw) : nodesFromTrustedSelectOptions(raw);
      }
      return window.DOMPurify ? nodesFromSanitizedBodyHtml(raw) : nodesFromTrustedBodyHtml(raw);
    }

    /** Assign HTML after sanitization (or trusted DOMParser fallback when DOMPurify is unavailable). */
    function setHtml(el, html) {
      if (!el) return;
      const raw = html == null ? "" : String(html);
      const nodes = htmlNodesForElement(el, raw);
      el.replaceChildren(...nodes);
    }

    function insertAdjacentHtmlSafe(el, position, html) {
      if (!el) return;
      const raw = html == null ? "" : String(html);
      const nodes =
        el.tagName === "TBODY" && position === "beforeend"
          ? window.DOMPurify
            ? nodesFromSanitizedTableSection("tbody", raw)
            : nodesFromTrustedTableSection("tbody", raw)
          : window.DOMPurify
            ? nodesFromSanitizedBodyHtml(raw)
            : nodesFromTrustedBodyHtml(raw);
      if (!nodes.length) return;
      if (position === "beforeend") el.append(...nodes);
      else if (position === "afterbegin") el.prepend(...nodes);
    }

    function cssEscapeAttrValue(value) {
      const s = String(value == null ? "" : value);
      if (typeof CSS !== "undefined" && typeof CSS.escape === "function") return CSS.escape(s);
      return escapeAttr(s);
    }

    function embedPostMessageTargetOrigin() {
      try {
        if (window.parent === window) return window.location.origin;
        if (document.referrer) {
          const ref = new URL(document.referrer);
          if (ref.protocol === "https:" || ref.protocol === "http:") return ref.origin;
        }
      } catch (_) {}
      return window.location.origin;
    }
    let linkLensData = {};
    /** Set true after linklens.json has been fetched at least once (lazy). */
    let linkLensHydrated = false;
    let linkLensFetchPromise = null;
    /** Filled on main data load so we can re-render after lazy linklens arrives. */
    let pageContext = null;
    /** "full" (default table) or "popular" (curated hand-picked links). */
    let listViewMode = "full";

    function syncOfflineExportGlobals() {
      try {
        window.__proxyListPageContext = pageContext;
        window.__proxyListLinkLensData = linkLensData;
        window.__proxyListLinkLensHydrated = linkLensHydrated;
      } catch (_) {}
    }
    let contentLoadingHighWater = 0;
    /** In-memory only: disables click counts until the tab is closed/reopened. */
    let sessionDisableClickCounts = false;
    /** When set (e.g. "per_chunk"), overrides settings for this tab session. */
    let sessionClickLoadOverride = null;
    let clickBootLoadToken = 0;
    let clickBootSlowTimer = null;
    let summaryEntryCache = new Map();
    let lensDomainSignalFirst = new Map();
    let checkedDomains = new Set();
    let selectedGnMathFilter = "";
    let hideBlockedBySelectedFilter = false;
    let hideLinksWithoutLensCheck = false;
    let failingLinks = {};
    let failThreshold = 3;
    let useFirebaseClicks = false;
    let firebaseDb = null;
    /** Realtime DB: session nodes under presence/ (fallback if Worker count unavailable). */
    const PRESENCE_STALE_MS = 3 * 60 * 1000;
    const PRESENCE_HEARTBEAT_MS = 60 * 1000;
    let firebasePresenceDb = null;
    let activeSessionsCount = null;
    /** Live count from the Cloudflare Worker (works without Firebase / inside web proxies). */
    let workerActiveSessionsCount = null;
    let presenceListenerAttached = false;
    let presenceSessionRef = null;
    let presenceHeartbeatTimer = null;
    /** Worker presence pings (stats) — independent of Realtime DB. */
    let presenceWorkerPingTimer = null;
    let presenceWorkerStarted = false;

    const GITHUB_REPO_OWNER = "yourworstnightmare1";
    const GITHUB_REPO_NAME = "proxy-list";
    const GITHUB_REPO_SLUG = GITHUB_REPO_OWNER + "/" + GITHUB_REPO_NAME;
    const GITHUB_NOTIFICATIONS_SEEN_KEY = "proxyList_github_notifications_seen_v1";

    const LS_APP_SETTINGS_KEY = "proxyList_app_settings_v1";
    const LS_LIST_FILTERS_KEY = "proxyList_list_filters_v1";
    const LS_SIDEBAR_COLLAPSED_KEY = "proxyList_sidebar_collapsed_v1";
    const LS_MOBILE_AUTO_RESIZE_NOTICE_KEY = "proxyList_mobile_auto_resize_notice_v1";
    const IDB_APP_SETTINGS_DB = "proxyListSettings";
    const IDB_APP_SETTINGS_STORE = "appSettings";
    const TABLE_CHUNK_DEFAULT = 80;
    const APP_SETTINGS_DEFAULTS = {
      theme: "dark",
      deviceSizing: "auto",
      animations: true,
      debugMode: false,
      debugShowUserAgent: true,
      debugEruda: true,
      firebaseApiEnabled: true,
      debugPerfGraph: false,
      debugCullingTest: false,
      linkSelectionAction: "summary",
      additionalNotesVisibility: "show",
      renderEmojis: true,
      renderLoadPerChunk: "auto",
      grabLinkClicksPerChunk: "per_chunk",
      saveSettingsLocally: false,
      timezoneConversion: true,
      timezoneOverride: "",
      dateFormatOrder: "month,day,year",
      timeNotation: "auto",
      // null = all catalogs; otherwise only these gdb:* tags are searched/warmed.
      gdbSearchSelectedTags: null,
    };
    let appSettings = Object.assign({}, APP_SETTINGS_DEFAULTS);
    let appToastTimer = null;
    let appSettingsIdbPromise = null;
    let appSettingsLoadedFromIdb = false;
    const SAVE_DATA_FORMAT = "proxy-list-save-v1";

    function normalizeAppSettings(raw) {
      const out = Object.assign({}, APP_SETTINGS_DEFAULTS);
      if (!raw || typeof raw !== "object") return out;
      const theme = String(raw.theme || "");
      if (theme === "dark" || theme === "light" || theme === "auto" || theme === "moonlight") {
        out.theme = theme;
      }
      const device = String(raw.deviceSizing || "");
      if (device === "auto" || device === "desktop" || device === "mobile") {
        out.deviceSizing = device;
      }
      if (typeof raw.animations === "boolean") out.animations = raw.animations;
      else if (raw.animations === "enabled") out.animations = true;
      else if (raw.animations === "disabled") out.animations = false;
      if (typeof raw.debugMode === "boolean") out.debugMode = raw.debugMode;
      else if (raw.debugMode === "enabled") out.debugMode = true;
      else if (raw.debugMode === "disabled") out.debugMode = false;
      if (typeof raw.debugShowUserAgent === "boolean") out.debugShowUserAgent = raw.debugShowUserAgent;
      if (typeof raw.debugEruda === "boolean") out.debugEruda = raw.debugEruda;
      else if (raw.debugEruda === "enabled") out.debugEruda = true;
      else if (raw.debugEruda === "disabled") out.debugEruda = false;
      if (typeof raw.firebaseApiEnabled === "boolean") out.firebaseApiEnabled = raw.firebaseApiEnabled;
      if (typeof raw.debugPerfGraph === "boolean") out.debugPerfGraph = raw.debugPerfGraph;
      if (typeof raw.debugCullingTest === "boolean") out.debugCullingTest = raw.debugCullingTest;
      const action = String(raw.linkSelectionAction || "");
      if (action === "summary" || action === "open" || action === "copy") out.linkSelectionAction = action;
      const notesVis = String(raw.additionalNotesVisibility || "");
      if (notesVis === "show" || notesVis === "hide") out.additionalNotesVisibility = notesVis;
      if (typeof raw.renderEmojis === "boolean") out.renderEmojis = raw.renderEmojis;
      const chunk = String(raw.renderLoadPerChunk || "");
      if (
        chunk === "auto" ||
        chunk === "very_low" ||
        chunk === "low" ||
        chunk === "medium" ||
        chunk === "high" ||
        chunk === "very_high" ||
        chunk === "unoptimized"
      ) {
        out.renderLoadPerChunk = chunk;
      }
      const clickMode = String(raw.grabLinkClicksPerChunk || "");
      if (clickMode === "none" || clickMode === "per_chunk" || clickMode === "preload" || clickMode === "all") {
        out.grabLinkClicksPerChunk = clickMode;
      }
      if (typeof raw.saveSettingsLocally === "boolean") out.saveSettingsLocally = raw.saveSettingsLocally;
      if (typeof raw.timezoneConversion === "boolean") out.timezoneConversion = raw.timezoneConversion;
      else if (raw.timezoneConversion === "enabled") out.timezoneConversion = true;
      else if (raw.timezoneConversion === "disabled") out.timezoneConversion = false;
      const tzOverride = String(raw.timezoneOverride || "").trim();
      if (!tzOverride) out.timezoneOverride = "";
      else if (window.ProxyListDateTime && typeof window.ProxyListDateTime.isValidTimeZone === "function") {
        out.timezoneOverride = window.ProxyListDateTime.isValidTimeZone(tzOverride) ? tzOverride : "";
      } else {
        out.timezoneOverride = tzOverride;
      }
      if (window.ProxyListDateTime && typeof window.ProxyListDateTime.normalizeOrder === "function") {
        out.dateFormatOrder = window.ProxyListDateTime.normalizeOrder(
          raw.dateFormatOrder || raw.dateFormat
        ).join(",");
      } else if (typeof raw.dateFormatOrder === "string" && raw.dateFormatOrder) {
        out.dateFormatOrder = raw.dateFormatOrder;
      }
      if (window.ProxyListDateTime && typeof window.ProxyListDateTime.normalizeTimeNotation === "function") {
        out.timeNotation = window.ProxyListDateTime.normalizeTimeNotation(raw.timeNotation);
      } else {
        const notation = String(raw.timeNotation || "").trim().toLowerCase();
        if (notation === "12h" || notation === "12-hour" || notation === "12") out.timeNotation = "12h";
        else if (notation === "24h" || notation === "24-hour" || notation === "24") out.timeNotation = "24h";
        else if (notation === "auto") out.timeNotation = "auto";
      }
      if (Array.isArray(raw.gdbSearchSelectedTags)) {
        const tags = raw.gdbSearchSelectedTags
          .map((t) => String(t || "").trim().toLowerCase())
          .filter((t) => t.indexOf("gdb:") === 0);
        out.gdbSearchSelectedTags = Array.from(new Set(tags));
      } else if (raw.gdbSearchSelectedTags === null) {
        out.gdbSearchSelectedTags = null;
      }
      return out;
    }

    function estimatedDeviceMemoryGb() {
      try {
        const n = Number(navigator.deviceMemory);
        if (Number.isFinite(n) && n > 0) return n;
      } catch (_) {}
      return null;
    }

    function chunkPresetFromRam(gb) {
      if (gb == null) return "medium";
      if (gb <= 2) return "low";
      if (gb >= 16) return "high";
      return "medium";
    }

    function resolvedRenderLoadPerChunk() {
      const v = appSettings.renderLoadPerChunk || "auto";
      if (v === "auto") return chunkPresetFromRam(estimatedDeviceMemoryGb());
      return v;
    }

    function getTableChunkSize() {
      switch (resolvedRenderLoadPerChunk()) {
        case "very_low":
          return 10;
        case "low":
          return 20;
        case "high":
          return TABLE_CHUNK_DEFAULT * 2;
        case "very_high":
          return TABLE_CHUNK_DEFAULT * 4;
        case "unoptimized":
          return Number.MAX_SAFE_INTEGER;
        case "medium":
        default:
          return TABLE_CHUNK_DEFAULT;
      }
    }

    function isUnoptimizedTableRender() {
      return resolvedRenderLoadPerChunk() === "unoptimized";
    }

    function effectiveClickLoadMode() {
      if (sessionDisableClickCounts) return "none";
      if (sessionClickLoadOverride === "none" || sessionClickLoadOverride === "per_chunk") {
        return sessionClickLoadOverride;
      }
      return appSettings.grabLinkClicksPerChunk || "per_chunk";
    }

    function shouldLoadLinkClicks() {
      return effectiveClickLoadMode() !== "none";
    }

    function applyThemeSetting(theme) {
      const t = theme || appSettings.theme || "dark";
      document.documentElement.setAttribute("data-theme", t);
    }

    function parseClientPlatform(ua) {
      if (typeof window.__proxyListParseClientPlatform === "function") {
        return window.__proxyListParseClientPlatform(ua);
      }
      const raw = String(ua != null ? ua : navigator.userAgent || "");
      const android = raw.match(/\bAndroid[ \/](\d+(?:\.\d+)*)/i);
      if (android || /\bAndroid\b/i.test(raw)) {
        return { os: "android", version: android ? android[1] : "", isMobile: true };
      }
      const iosToken = /\b(?:iPhone|iPad|iPod)\b/i.test(raw);
      const ipadOsDesktopUa =
        /\bMacintosh\b/i.test(raw) && Number(navigator.maxTouchPoints || 0) > 1;
      if (iosToken || ipadOsDesktopUa) {
        const ios = raw.match(/\bOS (\d+)[_.](\d+)(?:[_.](\d+))?/i);
        const version = ios
          ? ios[1] + "." + ios[2] + (ios[3] ? "." + ios[3] : "")
          : "";
        return { os: "ios", version: version, isMobile: true };
      }
      return { os: "desktop", version: "", isMobile: false };
    }

    function resolveDeviceSizing(devicePref) {
      const pref = devicePref || appSettings.deviceSizing || "auto";
      if (pref === "desktop" || pref === "mobile") return pref;
      return parseClientPlatform().isMobile ? "mobile" : "desktop";
    }

    function applyDeviceSizingSetting(device) {
      const platform = parseClientPlatform();
      const next = resolveDeviceSizing(device);
      document.documentElement.setAttribute("data-device", next);
      document.documentElement.setAttribute("data-os", platform.os);
      if (platform.version) {
        document.documentElement.setAttribute("data-os-version", platform.version);
      } else {
        document.documentElement.removeAttribute("data-os-version");
      }
      if (document.body) {
        if (next === "mobile") document.body.classList.add("orientation-locked");
        else document.body.classList.remove("orientation-locked");
      }
    }

    function hasDismissedMobileAutoResizeNotice() {
      try {
        return localStorage.getItem(LS_MOBILE_AUTO_RESIZE_NOTICE_KEY) === "1";
      } catch (_) {
        return false;
      }
    }

    function dismissMobileAutoResizeNotice() {
      try {
        localStorage.setItem(LS_MOBILE_AUTO_RESIZE_NOTICE_KEY, "1");
      } catch (_) {}
      closeMobileAutoResizeNotice();
    }

    function isMobileAutoResizeNoticeOpen() {
      const bd = $("mobileAutoResizeBackdrop");
      return !!(bd && bd.classList.contains("open"));
    }

    function openMobileAutoResizeNotice() {
      const bd = $("mobileAutoResizeBackdrop");
      if (!bd) return;
      bd.classList.add("open");
      bd.setAttribute("aria-hidden", "false");
      const ok = $("mobileAutoResizeOkBtn");
      if (ok && typeof ok.focus === "function") {
        setTimeout(() => ok.focus(), 0);
      }
    }

    function closeMobileAutoResizeNotice() {
      const bd = $("mobileAutoResizeBackdrop");
      if (!bd) return;
      bd.classList.remove("open");
      bd.setAttribute("aria-hidden", "true");
    }

    function maybeShowMobileAutoResizeNotice() {
      if (typeof isEmbedMode === "function" && isEmbedMode()) return;
      if (typeof firstVisitConsentPending === "function" && firstVisitConsentPending()) {
        if (!window.__proxyListMobileNoticeWaitingOnConsent) {
          window.__proxyListMobileNoticeWaitingOnConsent = true;
          whenFirstVisitConsentDone(function () {
            window.__proxyListMobileNoticeWaitingOnConsent = false;
            maybeShowMobileAutoResizeNotice();
          });
        }
        return;
      }
      if (hasDismissedMobileAutoResizeNotice()) return;
      if ((appSettings.deviceSizing || "auto") !== "auto") return;
      if (!parseClientPlatform().isMobile) return;
      if (resolveDeviceSizing() !== "mobile") return;
      const updateBd = $("updateBackdrop");
      if (updateBd && updateBd.classList.contains("open")) return;
      if (isWelcomeTourOpen()) return;
      if (isMobileAutoResizeNoticeOpen()) return;
      openMobileAutoResizeNotice();
    }

    const LS_WELCOME_TOUR_KEY = "proxyList_welcomeTour_v1";
    const WELCOME_TOUR_VIDEO_BASE = "./welcome-demo/";
    let welcomeTourStepIndex = -1;
    let welcomeTourVideoCandidates = [];
    let welcomeTourVideoCandidateIdx = 0;
    let welcomeTourWired = false;

    function welcomeTourSearchShortcutPhrase() {
      if (isMobileQuickSearchHint()) {
        return "tap the Quick Search Palette control";
      }
      if (isMacLikeShortcutPlatform()) {
        return '<kbd class="welcome-tour-kbd">Cmd</kbd>+<kbd class="welcome-tour-kbd">Y</kbd>';
      }
      return '<kbd class="welcome-tour-kbd">Ctrl</kbd>+<kbd class="welcome-tour-kbd">Y</kbd>';
    }

    function welcomeTourSteps() {
      return [
        {
          id: "filter_select_demo",
          title: "Filters &amp; sorting",
          description:
            "Sort blocked from unblocked by choosing your web filter and other options to improve how the list sorts links.",
          highlight: ["#selectFilterBtn"],
        },
        {
          id: "normal_search_and_palette",
          title: "Search",
          descriptionHtml:
            "Want to search for links? Use the search bar next to the sorting filters or " +
            welcomeTourSearchShortcutPhrase() +
            " to open the Quick Search Palette at any time.",
          highlight: [".search-wrap", "#quickSearchPaletteHint"],
        },
        {
          id: "changelog_demo",
          title: "Update Notice",
          description:
            "Missed an update or didn't catch what was new? The Update Notice button will show the most recent update changelog, along with an archived list of all other changes since the site's creation.",
          highlight: ["#updateNoticeBtn"],
        },
        {
          id: "statistics_navigation_demo",
          title: "Statistics",
          description:
            "Want to get stats on providers or filters or databases? Visit statistics and get detailed info.",
          highlight: ["#sidebarStatsLink"],
        },
        {
          id: "settings_demo",
          title: "Settings",
          description:
            "Want to customize the list to your liking or get better performance on your device? Visit Settings and change them at any time.",
          highlight: ["#openSettingsBtn"],
        },
      ];
    }

    function welcomeTourOsSlug() {
      const ua = String(navigator.userAgent || "");
      const platform = String(navigator.platform || "");
      const hay = ua + " " + platform;
      if (/Mac|Macintosh/i.test(hay) && !/iPhone|iPad|iPod/i.test(hay)) {
        // iPadOS desktop UA looks like Mac; treat touch Macs as unknown → Windows videos.
        if (Number(navigator.maxTouchPoints || 0) > 1 && /\bMacintosh\b/i.test(ua)) {
          return "windows11";
        }
        return "macos26";
      }
      if (/Win/i.test(hay)) return "windows11";
      return "windows11";
    }

    function welcomeTourThemeSlug() {
      const t = (appSettings && appSettings.theme) || "dark";
      if (t === "light") return "light";
      if (t === "auto") {
        try {
          if (window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches) {
            return "light";
          }
        } catch (_) {}
        return "dark";
      }
      return "dark";
    }

    function welcomeTourVideoFileCandidates(stepId) {
      const os = welcomeTourOsSlug();
      const theme = welcomeTourThemeSlug();
      const otherTheme = theme === "light" ? "dark" : "light";
      const otherOs = os === "macos26" ? "windows11" : "macos26";
      const names = [
        stepId + "_" + os + "_" + theme + "_16x9.mp4",
        stepId + "_" + os + "_" + otherTheme + "_16x9.mp4",
        stepId + "_windows11_" + theme + "_16x9.mp4",
        stepId + "_windows11_" + otherTheme + "_16x9.mp4",
        stepId + "_" + otherOs + "_" + theme + "_16x9.mp4",
        stepId + "_" + otherOs + "_" + otherTheme + "_16x9.mp4",
      ];
      const seen = new Set();
      const out = [];
      for (const n of names) {
        if (seen.has(n)) continue;
        seen.add(n);
        out.push(WELCOME_TOUR_VIDEO_BASE + n);
      }
      return out;
    }

    function ensureWelcomeTourSidebarVisible() {
      if (!document.documentElement.classList.contains("sidebar-collapsed")) return;
      document.documentElement.classList.remove("sidebar-collapsed");
      try {
        localStorage.setItem(LS_SIDEBAR_COLLAPSED_KEY, "0");
      } catch (_) {}
      if (typeof syncSidebarToggleLabel === "function") syncSidebarToggleLabel();
    }

    let welcomeTourPlacementTimer = 0;
    let welcomeTourPlacementWired = false;

    function isWelcomeTourCompactViewport() {
      if (document.documentElement.getAttribute("data-device") === "mobile") return true;
      try {
        return !!(window.matchMedia && window.matchMedia("(max-width: 840px), (max-height: 560px)").matches);
      } catch (_) {
        return false;
      }
    }

    function placeWelcomeTourStepModal() {
      const bd = $("welcomeTourBackdrop");
      if (!bd || !bd.classList.contains("welcome-tour-backdrop--step")) return;
      const compact = isWelcomeTourCompactViewport();
      document.documentElement.classList.toggle("welcome-tour-compact", compact);
      const target = document.querySelector(".welcome-tour-highlight");
      let top = false;
      if (compact && target) {
        const r = target.getBoundingClientRect();
        top = r.top + r.height / 2 > window.innerHeight / 2;
      }
      bd.classList.toggle("welcome-tour-backdrop--top", top);
    }

    function scheduleWelcomeTourStepPlacement() {
      placeWelcomeTourStepModal();
      clearTimeout(welcomeTourPlacementTimer);
      welcomeTourPlacementTimer = setTimeout(placeWelcomeTourStepModal, 450);
      if (!welcomeTourPlacementWired) {
        welcomeTourPlacementWired = true;
        window.addEventListener("resize", () => {
          if (isWelcomeTourOpen()) scheduleWelcomeTourStepPlacement();
        });
      }
    }

    function clearWelcomeTourHighlights() {
      clearTimeout(welcomeTourPlacementTimer);
      document.documentElement.classList.remove("welcome-tour-spotlighting", "welcome-tour-compact");
      document.querySelectorAll(".welcome-tour-highlight").forEach((el) => {
        el.classList.remove("welcome-tour-highlight", "welcome-tour-highlight--secondary");
      });
      const bd = $("welcomeTourBackdrop");
      const modal = bd && bd.querySelector(".welcome-tour-modal");
      if (bd) bd.classList.remove("welcome-tour-backdrop--step", "welcome-tour-backdrop--top");
      if (modal) modal.classList.remove("welcome-tour-modal--step");
    }

    function applyWelcomeTourHighlights(selectors) {
      clearWelcomeTourHighlights();
      const list = Array.isArray(selectors) ? selectors : [];
      if (!list.length) return;
      ensureWelcomeTourSidebarVisible();
      document.documentElement.classList.add("welcome-tour-spotlighting");
      const bd = $("welcomeTourBackdrop");
      const modal = bd && bd.querySelector(".welcome-tour-modal");
      if (bd) bd.classList.add("welcome-tour-backdrop--step");
      if (modal) modal.classList.add("welcome-tour-modal--step");
      let first = null;
      let applied = 0;
      for (const sel of list) {
        if (!sel) continue;
        let el = null;
        try {
          el = document.querySelector(sel);
        } catch (_) {
          el = null;
        }
        if (!el) continue;
        el.classList.add("welcome-tour-highlight");
        if (applied > 0) el.classList.add("welcome-tour-highlight--secondary");
        if (!first) first = el;
        applied += 1;
      }
      const compact = isWelcomeTourCompactViewport();
      document.documentElement.classList.toggle("welcome-tour-compact", compact);
      if (first && typeof first.scrollIntoView === "function") {
        try {
          first.scrollIntoView({ block: compact ? "center" : "nearest", inline: "nearest", behavior: "smooth" });
        } catch (_) {
          try {
            first.scrollIntoView(true);
          } catch (__) {}
        }
      }
      scheduleWelcomeTourStepPlacement();
    }

    function hasCompletedWelcomeTour() {
      try {
        const v = localStorage.getItem(LS_WELCOME_TOUR_KEY);
        return v === "done" || v === "skipped";
      } catch (_) {
        return false;
      }
    }

    function markWelcomeTourComplete(status) {
      try {
        localStorage.setItem(LS_WELCOME_TOUR_KEY, status === "skipped" ? "skipped" : "done");
      } catch (_) {}
    }

    function isWelcomeTourOpen() {
      const bd = $("welcomeTourBackdrop");
      return !!(bd && bd.classList.contains("open"));
    }

    function stopWelcomeTourVideo() {
      const video = $("welcomeTourVideo");
      if (!video) return;
      try {
        video.pause();
        video.removeAttribute("src");
        video.load();
      } catch (_) {}
    }

    function loadWelcomeTourVideo(candidates) {
      const video = $("welcomeTourVideo");
      if (!video) return;
      welcomeTourVideoCandidates = candidates || [];
      welcomeTourVideoCandidateIdx = 0;
      const tryNext = () => {
        if (welcomeTourVideoCandidateIdx >= welcomeTourVideoCandidates.length) {
          video.removeAttribute("src");
          return;
        }
        const src = welcomeTourVideoCandidates[welcomeTourVideoCandidateIdx++];
        video.onerror = () => tryNext();
        video.onloadeddata = () => {
          video.onerror = null;
          const playPromise = video.play();
          if (playPromise && typeof playPromise.catch === "function") {
            playPromise.catch(() => {});
          }
        };
        video.src = src;
        video.load();
      };
      tryNext();
    }

    function showWelcomeTourIntro() {
      welcomeTourStepIndex = -1;
      const intro = $("welcomeTourIntro");
      const step = $("welcomeTourStep");
      const title = $("welcomeTourTitle");
      const label = $("welcomeTourStepLabel");
      if (intro) intro.hidden = false;
      if (step) step.hidden = true;
      if (title) title.textContent = "Welcome to the Proxy List";
      if (label) {
        label.hidden = true;
        label.textContent = "";
      }
      stopWelcomeTourVideo();
      clearWelcomeTourHighlights();
    }

    function renderWelcomeTourStep(index) {
      const steps = welcomeTourSteps();
      if (index < 0 || index >= steps.length) return;
      welcomeTourStepIndex = index;
      const item = steps[index];
      const intro = $("welcomeTourIntro");
      const stepEl = $("welcomeTourStep");
      const title = $("welcomeTourTitle");
      const label = $("welcomeTourStepLabel");
      const desc = $("welcomeTourDesc");
      const nextBtn = $("welcomeTourNextBtn");
      const backBtn = $("welcomeTourBackBtn");
      if (intro) intro.hidden = true;
      if (stepEl) stepEl.hidden = false;
      if (title) setHtml(title, item.title || "Welcome to the Proxy List");
      if (label) {
        label.hidden = false;
        label.textContent = "Step " + (index + 1) + " of " + steps.length;
      }
      if (desc) {
        if (item.descriptionHtml) setHtml(desc, item.descriptionHtml);
        else desc.textContent = item.description || "";
      }
      if (nextBtn) nextBtn.textContent = index >= steps.length - 1 ? "Finish" : "Next";
      if (backBtn) backBtn.disabled = false;
      loadWelcomeTourVideo(welcomeTourVideoFileCandidates(item.id));
      applyWelcomeTourHighlights(item.highlight);
    }

    function openWelcomeTour(opts) {
      const force = !!(opts && opts.force);
      const bd = $("welcomeTourBackdrop");
      if (!bd) return;
      wireWelcomeTourOnce();
      ensureWelcomeTourSidebarVisible();
      showWelcomeTourIntro();
      bd.classList.add("open");
      bd.setAttribute("aria-hidden", "false");
      const continueBtn = $("welcomeTourContinueBtn");
      if (continueBtn && typeof continueBtn.focus === "function") {
        setTimeout(() => continueBtn.focus(), 0);
      }
      if (force) {
        /* replay from settings — do not require first-visit */
      }
    }

    function closeWelcomeTour(status) {
      const bd = $("welcomeTourBackdrop");
      stopWelcomeTourVideo();
      clearWelcomeTourHighlights();
      if (bd) {
        bd.classList.remove("open");
        bd.setAttribute("aria-hidden", "true");
      }
      welcomeTourStepIndex = -1;
      if (status) markWelcomeTourComplete(status);
      maybeShowMobileAutoResizeNotice();
    }

    function wireWelcomeTourOnce() {
      if (welcomeTourWired) return;
      welcomeTourWired = true;
      const continueBtn = $("welcomeTourContinueBtn");
      const skipBtn = $("welcomeTourSkipBtn");
      const skipInStep = $("welcomeTourSkipInStepBtn");
      const nextBtn = $("welcomeTourNextBtn");
      const backBtn = $("welcomeTourBackBtn");
      if (continueBtn) {
        continueBtn.addEventListener("click", () => renderWelcomeTourStep(0));
      }
      if (skipBtn) {
        skipBtn.addEventListener("click", () => closeWelcomeTour("skipped"));
      }
      if (skipInStep) {
        skipInStep.addEventListener("click", () => closeWelcomeTour("skipped"));
      }
      if (nextBtn) {
        nextBtn.addEventListener("click", () => {
          const steps = welcomeTourSteps();
          if (welcomeTourStepIndex >= steps.length - 1) {
            closeWelcomeTour("done");
            return;
          }
          renderWelcomeTourStep(welcomeTourStepIndex + 1);
        });
      }
      if (backBtn) {
        backBtn.addEventListener("click", () => {
          if (welcomeTourStepIndex <= 0) {
            showWelcomeTourIntro();
            return;
          }
          renderWelcomeTourStep(welcomeTourStepIndex - 1);
        });
      }
    }

    function wireResetSavedDataButton() {
      const btn = $("settingsResetSavedDataBtn");
      if (!btn || btn.dataset.wired === "1") return;
      btn.dataset.wired = "1";
      btn.addEventListener("click", () => {
        if (!window.confirm("Reset this site's saved settings, filters, and caches, then reload? Your saved links are kept.")) return;
        try {
          clickCountCache.clear();
          clickCountFetchedAt.clear();
          topOpenedDocsCache = { at: 0, docs: null };
          localStorage.removeItem("proxyList_clickCountDisk_v1");
          localStorage.removeItem("proxyList_clickCountDisk_v2");
          localStorage.removeItem("proxyList_linkRatingAggDisk_v1");
          localStorage.removeItem("proxyList_linkRatingAggDisk_v2");
          localStorage.removeItem("proxyList_linkSaveCountDisk_v1");
          localStorage.removeItem("proxyList_topOpensDisk_v1");
          localStorage.removeItem("proxyList_topOpensDisk_v2");
          localStorage.removeItem("proxyList_stats_topOpens_v1");
        } catch (_) {}
        if (window.__proxyListBootGuard) window.__proxyListBootGuard.reset({ all: false });
        // Hard navigation so bfcache / in-memory maps cannot restore inflated counts.
        const u = new URL(location.href);
        u.searchParams.set("_reset", String(Date.now()));
        location.replace(u.toString());
      });
    }

    function wireWelcomeTourReplayButton() {
      const replayBtn = $("settingsReplayWelcomeTourBtn");
      if (!replayBtn || replayBtn.dataset.wired === "1") return;
      replayBtn.dataset.wired = "1";
      replayBtn.addEventListener("click", () => {
        closeSettingsModal();
        openWelcomeTour({ force: true });
      });
    }

    function sentryConsentPending() {
      try {
        if (window.ProxyListSentry && typeof window.ProxyListSentry.hasChoice === "function") {
          return !window.ProxyListSentry.hasChoice();
        }
      } catch (_) {}
      return false;
    }

    function hardwareConsentPending() {
      try {
        if (window.ProxyListHardware && typeof window.ProxyListHardware.hasChoice === "function") {
          return !window.ProxyListHardware.hasChoice();
        }
      } catch (_) {}
      return false;
    }

    function firstVisitConsentPending() {
      return sentryConsentPending() || hardwareConsentPending();
    }

    function whenFirstVisitConsentDone(cb) {
      if (!firstVisitConsentPending()) {
        cb();
        return;
      }
      function onChoice() {
        if (firstVisitConsentPending()) return;
        window.removeEventListener("proxy-list-sentry-consent", onChoice);
        window.removeEventListener("proxy-list-hardware-consent", onChoice);
        cb();
      }
      window.addEventListener("proxy-list-sentry-consent", onChoice);
      window.addEventListener("proxy-list-hardware-consent", onChoice);
    }

    function maybeStartWelcomeTour() {
      if (typeof isEmbedMode === "function" && isEmbedMode()) return;
      if (firstVisitConsentPending()) {
        if (!window.__proxyListWelcomeTourWaitingOnConsent) {
          window.__proxyListWelcomeTourWaitingOnConsent = true;
          whenFirstVisitConsentDone(function () {
            window.__proxyListWelcomeTourWaitingOnConsent = false;
            maybeStartWelcomeTour();
          });
        }
        return;
      }
      try {
        const params = new URLSearchParams(window.location.search || "");
        if (params.get("welcomeTour") === "1" || params.get("welcomeTour") === "true") {
          openWelcomeTour({ force: true });
          return;
        }
      } catch (_) {}
      if (hasCompletedWelcomeTour()) return;
      if (isWelcomeTourOpen()) return;
      const updateBd = $("updateBackdrop");
      if (updateBd && updateBd.classList.contains("open")) return;
      openWelcomeTour();
    }

    function applyAnimationsSetting(enabled) {
      const on = enabled == null ? appSettings.animations !== false : !!enabled;
      document.documentElement.setAttribute("data-animations", on ? "enabled" : "disabled");
    }

    function applyDateTimeSettings() {
      try {
        if (window.ProxyListDateTime && typeof window.ProxyListDateTime.refresh === "function") {
          window.ProxyListDateTime.refresh(appSettings);
        }
      } catch (_) {}
    }

    function populateTimezoneOverrideSelect() {
      const sel = $("settingsTimezoneOverrideSelect");
      const dt = window.ProxyListDateTime;
      if (!sel || !dt || sel.getAttribute("data-zones") === "1") return;
      const detected = dt.detectedTimeZone();
      const auto = sel.querySelector('option[value=""]');
      if (auto) {
        auto.textContent = "Auto (detected: " + detected.replace(/_/g, " ") + ")";
      }
      const zones = dt.listTimeZones();
      const frag = document.createDocumentFragment();
      zones.forEach((tz) => {
        const opt = document.createElement("option");
        opt.value = tz;
        opt.textContent = dt.zoneOptionLabel(tz);
        frag.appendChild(opt);
      });
      sel.appendChild(frag);
      sel.setAttribute("data-zones", "1");
    }

    function syncTimezoneOverrideEnabled() {
      const sel = $("settingsTimezoneOverrideSelect");
      if (!sel) return;
      sel.disabled = appSettings.timezoneConversion === false;
    }

    function currentDateFormatOrder() {
      if (window.ProxyListDateTime && typeof window.ProxyListDateTime.normalizeOrder === "function") {
        return window.ProxyListDateTime.normalizeOrder(appSettings.dateFormatOrder);
      }
      return ["month", "day", "year"];
    }

    function syncDateFormatSelects() {
      const order = currentDateFormatOrder();
      for (let i = 0; i < 3; i++) {
        const sel = $("settingsDateFormat" + i);
        if (sel) sel.value = order[i] || ["month", "day", "year"][i];
      }
    }

    function resolvedTimeNotation() {
      if (window.ProxyListDateTime && typeof window.ProxyListDateTime.resolvedTimeNotation === "function") {
        return window.ProxyListDateTime.resolvedTimeNotation(appSettings);
      }
      return appSettings.timeNotation === "12h" ? "12h" : "24h";
    }

    function syncTimeNotationSelect() {
      const sel = $("settingsTimeNotationSelect");
      if (!sel) return;
      sel.value = resolvedTimeNotation();
    }

    function onDateFormatPartChange(changedIndex) {
      const order = currentDateFormatOrder();
      const sel = $("settingsDateFormat" + changedIndex);
      if (!sel) return;
      const next = sel.value;
      const prev = order[changedIndex];
      if (next === prev) return;
      const swapIdx = order.findIndex((p, i) => i !== changedIndex && p === next);
      order[changedIndex] = next;
      if (swapIdx >= 0) order[swapIdx] = prev;
      void updateAppSetting({ dateFormatOrder: order.join(",") });
    }

    function isDebugMode() {
      return appSettings.debugMode === true;
    }

    function isFirebaseApiEnabled() {
      return appSettings.firebaseApiEnabled !== false;
    }

    function isFileProtocol() {
      try {
        return String(location.protocol || "") === "file:";
      } catch (_) {
        return false;
      }
    }

    function promiseWithTimeout(promise, ms, label) {
      const timeoutMs = Math.max(0, Number(ms) || 0);
      if (!timeoutMs) return promise;
      let timer = null;
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(label || "timeout after " + timeoutMs + "ms"));
        }, timeoutMs);
      });
      return Promise.race([promise, timeout]).then(
        (value) => {
          clearTimeout(timer);
          return value;
        },
        (err) => {
          clearTimeout(timer);
          throw err;
        }
      );
    }

    function loadExternalScript(src, timeoutMs) {
      const load = new Promise((resolve, reject) => {
        const s = document.createElement("script");
        s.src = src;
        s.onload = () => resolve();
        s.onerror = () => reject(new Error("Could not load " + src));
        document.head.appendChild(s);
      });
      return promiseWithTimeout(load, timeoutMs != null ? timeoutMs : 8000, "Could not load " + src);
    }

    let firebaseSdkPromise = null;
    const FIREBASE_COMPAT_BASE = "https://www.gstatic.com/firebasejs/10.7.1/";

    function firebaseSdkIsPresent() {
      return typeof firebase !== "undefined";
    }

    /** Load Firebase only after the list can render. gstatic scripts hang or error on UV/Scramjet. */
    function ensureFirebaseSdk() {
      if (firebaseSdkIsPresent()) return Promise.resolve(true);
      if (!isFirebaseApiEnabled()) return Promise.resolve(false);
      if (firebaseSdkPromise) return firebaseSdkPromise;
      firebaseSdkPromise = ["firebase-app-compat.js", "firebase-auth-compat.js", "firebase-firestore-compat.js", "firebase-database-compat.js"]
        .reduce(
          (p, file) => p.then(() => loadExternalScript(FIREBASE_COMPAT_BASE + file)),
          Promise.resolve()
        )
        .then(() => firebaseSdkIsPresent())
        .catch((err) => {
          console.warn(
            "[proxy-list] Firebase SDK did not load. The list still works; account/sync features stay offline. This is common inside web proxies.",
            err
          );
          firebaseSdkPromise = null;
          return false;
        });
      return firebaseSdkPromise;
    }

    const DEBUG_GITHUB_RAW_BASE =
      "https://raw.githubusercontent.com/" + GITHUB_REPO_OWNER + "/" + GITHUB_REPO_NAME + "/main/docs/";
    function downloadJsonFile(filename, payload) {
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(function () {
        try {
          URL.revokeObjectURL(url);
        } catch (_) {}
      }, 1500);
    }

    function describePageHostContext() {
      if (window.ProxyListDebug && typeof window.ProxyListDebug.describeHost === "function") {
        return window.ProxyListDebug.describeHost();
      }
      try {
        const loc = window.location;
        const protocol = String(loc.protocol || "").toLowerCase();
        const host = String(loc.hostname || "").toLowerCase();
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

    function syncDebugExtraSettingsVisibility() {
      const extra = $("debugExtraSettings");
      if (extra) extra.hidden = !isDebugMode();
    }

    function showDebugToast(kind, message) {
      if (window.ProxyListDebug && typeof window.ProxyListDebug.showToast === "function") {
        // Keep site settings as source of truth on the main page.
        window.ProxyListDebug.applySettings(appSettings);
        window.ProxyListDebug.showToast(kind, message);
        return;
      }
    }

    function appendDebugOverlayLine(kind, message) {
      showDebugToast(kind, message);
    }

    function syncDebugOverlayVisibility() {
      syncDebugExtraSettingsVisibility();
      if (window.ProxyListDebug && typeof window.ProxyListDebug.applySettings === "function") {
        window.ProxyListDebug.applySettings(appSettings);
      }
    }

    function applyDebugModeSetting() {
      syncDebugOverlayVisibility();
    }

    // Keep main-list appSettings in sync when the backtick debug menu patches overlays.
    window.addEventListener("proxylist-debug-settings", (ev) => {
      const detail = ev && ev.detail;
      if (!detail || typeof detail !== "object") return;
      const next = {
        debugShowUserAgent: detail.debugShowUserAgent !== false,
        debugEruda: detail.debugEruda !== false,
        debugPerfGraph: detail.debugPerfGraph === true,
        debugCullingTest: detail.debugCullingTest === true,
      };
      if (
        appSettings.debugShowUserAgent === next.debugShowUserAgent &&
        appSettings.debugEruda === next.debugEruda &&
        appSettings.debugPerfGraph === next.debugPerfGraph &&
        appSettings.debugCullingTest === next.debugCullingTest
      ) {
        return;
      }
      appSettings = normalizeAppSettings(Object.assign({}, appSettings, next));
      void persistAppSettings();
      syncSettingsFormFromState();
      // Overlays already applied the patch; avoid re-entering applySettings unless needed.
      syncDebugExtraSettingsVisibility();
    });

    function openDebugModeWarnModal() {
      const backdrop = $("debugModeWarnBackdrop");
      if (!backdrop) return;
      backdrop.classList.add("open");
      backdrop.setAttribute("aria-hidden", "false");
      const confirmBtn = $("debugModeWarnConfirmBtn");
      if (confirmBtn) confirmBtn.focus();
    }

    function closeDebugModeWarnModal() {
      const backdrop = $("debugModeWarnBackdrop");
      if (!backdrop) return;
      backdrop.classList.remove("open");
      backdrop.setAttribute("aria-hidden", "true");
    }

    function cancelDebugModeEnable() {
      closeDebugModeWarnModal();
      const sel = $("settingsDebugModeSelect");
      if (sel) sel.value = "disabled";
    }

    async function confirmDebugModeEnableAndRefresh() {
      closeDebugModeWarnModal();
      await updateAppSetting({ debugMode: true });
      location.reload();
    }

    let pendingDebugCullingTest = null;

    function openDebugCullingWarnModal(enabled) {
      pendingDebugCullingTest = !!enabled;
      const backdrop = $("debugCullingWarnBackdrop");
      if (!backdrop) return;
      const body = $("debugCullingWarnBody");
      if (body) {
        body.textContent = enabled
          ? "Enabling culling testing requires refreshing the site."
          : "Disabling culling testing requires refreshing the site.";
      }
      backdrop.classList.add("open");
      backdrop.setAttribute("aria-hidden", "false");
      const confirmBtn = $("debugCullingWarnConfirmBtn");
      if (confirmBtn) confirmBtn.focus();
    }

    function closeDebugCullingWarnModal() {
      const backdrop = $("debugCullingWarnBackdrop");
      if (!backdrop) return;
      backdrop.classList.remove("open");
      backdrop.setAttribute("aria-hidden", "true");
    }

    function cancelDebugCullingChange() {
      closeDebugCullingWarnModal();
      pendingDebugCullingTest = null;
      const sel = $("settingsDebugCullingTestSelect");
      if (sel) sel.value = appSettings.debugCullingTest === true ? "enabled" : "disabled";
    }

    async function confirmDebugCullingChangeAndRefresh() {
      const next = pendingDebugCullingTest === true;
      pendingDebugCullingTest = null;
      closeDebugCullingWarnModal();
      await updateAppSetting({ debugCullingTest: next });
      location.reload();
    }

    function exportDebugConsoleLogs() {
      const entries =
        window.ProxyListDebug && typeof window.ProxyListDebug.getConsoleLogs === "function"
          ? window.ProxyListDebug.getConsoleLogs()
          : [];
      downloadJsonFile("proxy-list-console-logs.json", {
        exportedAt: new Date().toISOString(),
        entries: entries,
      });
      showAppToast("Console logs exported.");
    }

    function exportDebugChunkLogs() {
      const entries =
        window.ProxyListDebug && typeof window.ProxyListDebug.getChunkLogs === "function"
          ? window.ProxyListDebug.getChunkLogs()
          : [];
      downloadJsonFile("proxy-list-chunk-loadtimes.json", {
        exportedAt: new Date().toISOString(),
        entries: entries,
      });
      showAppToast("Chunk load data exported.");
    }

    function exportDebugUaHostData() {
      downloadJsonFile("proxy-list-ua-host.json", {
        exportedAt: new Date().toISOString(),
        userAgent: navigator.userAgent || "",
        host: describePageHostContext(),
        href: String(location.href || ""),
        protocol: String(location.protocol || ""),
        hostname: String(location.hostname || ""),
      });
      showAppToast("UA/host data exported.");
    }

    function disableFirebaseApiRuntime() {
      try {
        stopUserNotificationsListener();
      } catch (_) {}
      try {
        if (presenceHeartbeatTimer) {
          clearInterval(presenceHeartbeatTimer);
          presenceHeartbeatTimer = null;
        }
      } catch (_) {}
      try {
        if (presenceSessionRef) {
          presenceSessionRef.remove().catch(function () {});
          presenceSessionRef = null;
        }
      } catch (_) {}
      useFirebaseClicks = false;
      firebaseDb = null;
      activeSessionsCount = null;
      updateActiveUsersDisplay();
      showAppToast("Firebase API disabled.");
    }

    async function applyFirebaseApiSetting(enabled) {
      if (!enabled) {
        disableFirebaseApiRuntime();
        return;
      }
      showAppToast("Re-enabling Firebase…");
      const loaded = await ensureFirebaseSdk();
      if (!loaded) {
        showAppToast("Firebase SDK could not load in this browser.");
        return;
      }
      await initClickTracking();
      showAppToast("Firebase API enabled.");
    }

    async function debugFetchGithubDocs(path) {
      const url = DEBUG_GITHUB_RAW_BASE + String(path || "").replace(/^\//, "") + "?_=" + Date.now();
      const res = await fetch(url, { cache: "no-store" });
      if (!res.ok) throw new Error("GitHub fetch failed (" + res.status + ") for " + path);
      return res;
    }

    async function debugCheckScriptUpdates() {
      showDebugToast("info", "Checking GitHub for script updates…");
      try {
        const localRes = await fetch("index.html", { cache: "no-store" });
        const remoteRes = await debugFetchGithubDocs("index.html");
        const localText = await localRes.text();
        const remoteText = await remoteRes.text();
        if (localText === remoteText) {
          showAppToast("Scripts are up to date.");
          showDebugToast("info", "Scripts match GitHub main.");
          return;
        }
        if (
          window.confirm(
            "Newer scripts were found on GitHub. Refresh now with a cache bypass to download them?"
          )
        ) {
          hardReloadBypassCache();
        } else {
          showDebugToast("info", "Script update available — refresh skipped.");
        }
      } catch (err) {
        console.warn("[proxy-list] Script update check failed", err);
        window.alert("Could not check for script updates.");
      }
    }

    async function debugCheckListUpdates() {
      showDebugToast("info", "Checking GitHub for list updates…");
      try {
        const remoteRes = await debugFetchGithubDocs("data.json");
        const remoteJson = await remoteRes.json();
        const remoteMeta = remoteJson && remoteJson.meta ? remoteJson.meta : {};
        const remoteStamp = versionStamp(remoteMeta);
        const localStamp = pageContext && pageContext.meta ? versionStamp(pageContext.meta) : "";
        if (remoteStamp && remoteStamp === localStamp) {
          showAppToast("List data is up to date.");
          showDebugToast("info", "List stamp matches GitHub: " + humanStamp(remoteStamp));
          return;
        }
        if (
          !window.confirm(
            "Newer list data found on GitHub (" +
              humanStamp(remoteStamp || "unknown") +
              "). Apply it in this tab now?"
          )
        ) {
          showDebugToast("info", "List update skipped.");
          return;
        }
        const { meta, link_check, links } = normalizePayload(remoteJson);
        pageContext = { links, meta, link_check };
        syncFeaturedGdbButtons();
        syncOfflineExportGlobals();
        currentListVersionStamp = versionStamp(meta) || "";
        applyImportantNotices(meta);
        setFooter(meta);
        syncMostOpenedProviderOptions(links);
        void renderMostOpenedForList(links);
        void renderAfterHeavyFilter(links, meta, link_check);
        showAppToast("List data updated from GitHub.");
        showDebugToast("info", "Applied GitHub list " + humanStamp(currentListVersionStamp));
      } catch (err) {
        console.warn("[proxy-list] List update check failed", err);
        window.alert("Could not check for list updates.");
      }
    }

    async function debugCheckFilterUpdates() {
      showDebugToast("info", "Checking GitHub for filter data…");
      try {
        const [lensRes, domainsRes, filterRes] = await Promise.all([
          debugFetchGithubDocs("linklens.json"),
          debugFetchGithubDocs("checked_domains.txt"),
          debugFetchGithubDocs("filter_stats.json").catch(function () {
            return null;
          }),
        ]);
        const lensJson = await lensRes.json();
        const domainsText = await domainsRes.text();
        if (typeof window !== "undefined") {
          window.__LINK_LENS__ = lensJson;
        }
        linkLensData = lensJson && typeof lensJson === "object" ? lensJson : {};
        linkLensHydrated = true;
        syncOfflineExportGlobals();
        rebuildLinkLensIndexes();
        populateKnownFilters();
        checkedDomains = new Set(
          String(domainsText || "")
            .split(/\r?\n/)
            .map((s) => s.trim().toLowerCase().replace(/^www\./, ""))
            .filter(Boolean)
        );
        if (filterRes && filterRes.ok) {
          try {
            await filterRes.json();
          } catch (_) {}
        }
        updateSelectedFilterUI();
        if (pageContext) void renderAfterHeavyFilter(pageContext.links, pageContext.meta, pageContext.link_check);
        showAppToast("Filter data updated from GitHub.");
        showDebugToast("info", "Filter / gn-math data refreshed from GitHub.");
      } catch (err) {
        console.warn("[proxy-list] Filter update check failed", err);
        window.alert("Could not check for filter data updates.");
      }
    }

    function fireDebugTestNotification(type) {
      if (!window.SiteNotifications || typeof window.SiteNotifications.show !== "function") {
        window.alert("Notification system is not loaded.");
        return;
      }
      const id = "debug-test-" + type + "-" + Date.now();
      const tempUntil = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
      const permUntil = new Date("9999-12-31T00:00:00.000Z");
      let item = null;
      switch (type) {
        case "pr":
          item = {
            id: id,
            kind: "pr_merged",
            number: 9999,
            url: "https://github.com/" + GITHUB_REPO_SLUG + "/pull/1",
          };
          break;
        case "issue_qol":
          item = {
            id: id,
            kind: "feature_approved",
            date: Date.now(),
            url: "https://github.com/" + GITHUB_REPO_SLUG + "/issues/1",
          };
          break;
        case "suspension_temp_account":
          item = { id: id, kind: "account_suspended", until: tempUntil, reason: "Debug test (temporary account)." };
          break;
        case "suspension_perm_account":
          item = { id: id, kind: "account_suspended", until: permUntil, reason: "Debug test (permanent account)." };
          break;
        case "suspension_temp_forms":
          item = { id: id, kind: "form_suspended", until: tempUntil, reason: "Debug test (temporary forms)." };
          break;
        case "suspension_perm_forms":
          item = { id: id, kind: "form_suspended", until: permUntil, reason: "Debug test (permanent forms)." };
          break;
        default:
          window.alert("Choose a notification type first.");
          return;
      }
      window.SiteNotifications.show(item);
      showDebugToast("info", "Fired test notification: " + type);
    }

    function fireDebugUpdateRefreshBanner() {
      const textEl = $("siteUpdateBannerText");
      if (textEl) {
        textEl.textContent =
          "A new site update is available (debug). Refresh to load the latest list and scripts.";
      }
      try {
        sessionStorage.removeItem(BANNER_DISMISS_SESSION_KEY);
      } catch (_) {}
      setSiteUpdateBannerVisible(true);
      showDebugToast("info", "Update refresh banner fired.");
    }

    function applyDebugVersionVisual(nextVersion, nextRevision) {
      if (!pageContext || !pageContext.meta) {
        window.alert("List metadata is not loaded yet.");
        return;
      }
      const meta = pageContext.meta;
      if (nextVersion) meta.version = String(nextVersion);
      if (nextRevision) meta.revision = String(nextRevision);
      setFooter(meta);
      currentListVersionStamp = versionStamp(meta) || "";
      showAppToast("Version set to " + humanStamp(currentListVersionStamp));
      showDebugToast("info", "Version manipulator → " + humanStamp(currentListVersionStamp));
    }

    function debugDowngradeToLastVersion() {
      if (!pageContext || !pageContext.meta) {
        window.alert("List metadata is not loaded yet.");
        return;
      }
      const cur = String(pageContext.meta.version || "0").trim() || "0";
      const parts = cur.replace(/^v/i, "").split(".");
      const nums = parts.map(function (p) {
        const n = parseInt(p, 10);
        return Number.isFinite(n) ? n : 0;
      });
      while (nums.length < 3) nums.push(0);
      if (nums[2] > 0) nums[2] -= 1;
      else if (nums[1] > 0) {
        nums[1] -= 1;
        nums[2] = 9;
      } else if (nums[0] > 0) {
        nums[0] -= 1;
        nums[1] = 9;
        nums[2] = 9;
      } else {
        nums[2] = 0;
      }
      const nextVer = nums.slice(0, 3).join(".");
      let rev = String(pageContext.meta.revision || "r0");
      const rm = rev.match(/(\d+)/);
      if (rm) rev = "r" + Math.max(0, Number(rm[1]) - 1);
      applyDebugVersionVisual(nextVer, rev);
    }

    function debugSetCustomVersion() {
      const cur = pageContext && pageContext.meta ? String(pageContext.meta.version || "") : "";
      const entered = window.prompt("Set custom version (visual only):", cur || "0.0.0");
      if (entered == null) return;
      const v = String(entered).trim();
      if (!v) return;
      applyDebugVersionVisual(v, null);
    }

    function stripEmojisFromText(text) {
      return String(text || "")
        .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE00}-\u{FE0F}\u{200D}\u{20E3}\u{E0020}-\u{E007F}]/gu, "")
        .replace(/\s{2,}/g, " ")
        .trim();
    }

    function providerGithubUrl(rowOrUrl) {
      if (!rowOrUrl) return "";
      if (typeof rowOrUrl === "string") {
        const s = rowOrUrl.trim();
        return /^https?:\/\/(?:www\.)?github\.com\//i.test(s) ? s : "";
      }
      const u = rowOrUrl.github_url != null ? String(rowOrUrl.github_url).trim() : "";
      return /^https?:\/\/(?:www\.)?github\.com\//i.test(u) ? u : "";
    }

    function formatProviderGithubLink(githubUrl) {
      const href = providerGithubUrl(githubUrl);
      if (!href) return "";
      return (
        '<a class="provider-github-link" href="' +
        escapeAttr(href) +
        '" rel="noopener noreferrer" target="_blank" title="Open GitHub source (self-host / browse code)">GitHub</a>'
      );
    }

    function formatProviderCell(provider, githubUrl) {
      const text = String(provider || "");
      const shown = appSettings.renderEmojis === false ? stripEmojisFromText(text) : text;
      return escapeHtml(shown) + formatProviderGithubLink(githubUrl);
    }

    function showAppToast(message) {
      const el = $("appToast");
      if (!el) return;
      el.textContent = String(message || "");
      el.hidden = false;
      el.classList.add("visible");
      if (appToastTimer) clearTimeout(appToastTimer);
      appToastTimer = setTimeout(() => {
        appToastTimer = null;
        el.classList.remove("visible");
        setTimeout(() => {
          el.hidden = true;
        }, 240);
      }, 2200);
    }

    function openSettingsDb() {
      if (!appSettings.saveSettingsLocally) return Promise.resolve(null);
      if (appSettingsIdbPromise) return appSettingsIdbPromise;
      appSettingsIdbPromise = new Promise((resolve) => {
        if (!window.indexedDB) {
          resolve(null);
          return;
        }
        let settled = false;
        const finish = (db) => {
          if (settled) return;
          settled = true;
          resolve(db || null);
        };
        const timer = setTimeout(() => finish(null), 1500);
        try {
          const req = indexedDB.open(IDB_APP_SETTINGS_DB, 1);
          req.onupgradeneeded = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains(IDB_APP_SETTINGS_STORE)) {
              db.createObjectStore(IDB_APP_SETTINGS_STORE);
            }
          };
          req.onsuccess = () => {
            clearTimeout(timer);
            finish(req.result);
          };
          req.onerror = () => {
            clearTimeout(timer);
            finish(null);
          };
          req.onblocked = () => {
            clearTimeout(timer);
            finish(null);
          };
        } catch (_) {
          clearTimeout(timer);
          finish(null);
        }
      });
      return appSettingsIdbPromise;
    }

    async function readAppSettingsFromIdb() {
      const db = await openSettingsDb();
      if (!db) return null;
      return new Promise((resolve) => {
        try {
          const tx = db.transaction(IDB_APP_SETTINGS_STORE, "readonly");
          const store = tx.objectStore(IDB_APP_SETTINGS_STORE);
          const getReq = store.get("default");
          getReq.onsuccess = () => resolve(getReq.result || null);
          getReq.onerror = () => resolve(null);
        } catch (_) {
          resolve(null);
        }
      });
    }

    async function writeAppSettingsToIdb(settings) {
      if (!appSettings.saveSettingsLocally) return;
      const db = await openSettingsDb();
      if (!db) return;
      await new Promise((resolve) => {
        try {
          const tx = db.transaction(IDB_APP_SETTINGS_STORE, "readwrite");
          tx.objectStore(IDB_APP_SETTINGS_STORE).put(settings, "default");
          tx.oncomplete = () => resolve();
          tx.onerror = () => resolve();
          tx.onabort = () => resolve();
        } catch (_) {
          resolve();
        }
      });
    }

    function writeAppSettingsToLocalStorage(settings) {
      try {
        localStorage.setItem(LS_APP_SETTINGS_KEY, JSON.stringify(settings));
      } catch (_) {}
      try {
        localStorage.setItem(
          "proxyList_debug_overlays_v1",
          JSON.stringify({
            debugMode: settings && settings.debugMode === true,
            debugShowUserAgent: !(settings && settings.debugShowUserAgent === false),
            debugEruda: !(settings && settings.debugEruda === false),
            debugPerfGraph: settings && settings.debugPerfGraph === true,
            debugCullingTest: settings && settings.debugCullingTest === true,
          })
        );
      } catch (_) {}
    }

    function readAppSettingsFromLocalStorage() {
      try {
        const raw = localStorage.getItem(LS_APP_SETTINGS_KEY);
        return raw ? JSON.parse(raw) : null;
      } catch (_) {
        return null;
      }
    }

    async function persistAppSettings() {
      writeAppSettingsToLocalStorage(appSettings);
      await writeAppSettingsToIdb(appSettings);
      scheduleUserProfileWrite();
    }

    function applyAppSettings(raw, options) {
      appSettings = normalizeAppSettings(raw);
      applyThemeSetting(appSettings.theme);
      applyDeviceSizingSetting(appSettings.deviceSizing);
      applyAnimationsSetting(appSettings.animations);
      applyDebugModeSetting();
      applyDateTimeSettings();
      // Keep localStorage in sync so other pages (about, stats, …) can read debug overlays.
      writeAppSettingsToLocalStorage(appSettings);
      if (!options || !options.skipUi) syncSettingsFormFromState();
    }

    async function loadAppSettings() {
      let merged = null;
      const fromLs = readAppSettingsFromLocalStorage();
      if (fromLs) merged = fromLs;
      if (fromLs && fromLs.saveSettingsLocally) {
        const fromIdb = await readAppSettingsFromIdb();
        if (fromIdb && typeof fromIdb === "object") {
          // localStorage is written synchronously; IndexedDB can lag a reload.
          merged = Object.assign({}, fromIdb, fromLs);
          if (fromLs.debugMode === true || fromIdb.debugMode === true) merged.debugMode = true;
          if (fromLs.debugPerfGraph === true || fromIdb.debugPerfGraph === true) {
            merged.debugPerfGraph = true;
          }
          if (fromLs.debugCullingTest === true || fromIdb.debugCullingTest === true) {
            merged.debugCullingTest = true;
          }
          appSettingsLoadedFromIdb = true;
        }
      }
      applyAppSettings(merged || APP_SETTINGS_DEFAULTS, { skipUi: true });
    }

    function collectAppSettingsSnapshot() {
      return Object.assign({}, appSettings);
    }

    function syncSettingsFormFromState() {
      const themeSel = $("settingsThemeSelect");
      if (themeSel) themeSel.value = appSettings.theme || "dark";
      const deviceSel = $("settingsDeviceSizingSelect");
      if (deviceSel) deviceSel.value = appSettings.deviceSizing || "auto";
      const animSel = $("settingsAnimationsSelect");
      if (animSel) animSel.value = appSettings.animations === false ? "disabled" : "enabled";
      const debugSel = $("settingsDebugModeSelect");
      if (debugSel) debugSel.value = appSettings.debugMode === true ? "enabled" : "disabled";
      const debugUaSel = $("settingsDebugUaVisibilitySelect");
      if (debugUaSel) debugUaSel.value = appSettings.debugShowUserAgent === false ? "hide" : "show";
      const debugErudaSel = $("settingsDebugErudaSelect");
      if (debugErudaSel) debugErudaSel.value = appSettings.debugEruda === false ? "disabled" : "enabled";
      const debugFbSel = $("settingsDebugFirebaseApiSelect");
      if (debugFbSel) debugFbSel.value = appSettings.firebaseApiEnabled === false ? "disabled" : "enabled";
      const debugPerfSel = $("settingsDebugPerfGraphSelect");
      if (debugPerfSel) debugPerfSel.value = appSettings.debugPerfGraph === true ? "enabled" : "disabled";
      const debugCullSel = $("settingsDebugCullingTestSelect");
      if (debugCullSel) debugCullSel.value = appSettings.debugCullingTest === true ? "enabled" : "disabled";
      syncDebugExtraSettingsVisibility();
      const actionSel = $("settingsLinkActionSelect");
      if (actionSel) actionSel.value = appSettings.linkSelectionAction || "summary";
      const notesSel = $("settingsAdditionalNotesSelect");
      if (notesSel) notesSel.value = appSettings.additionalNotesVisibility === "hide" ? "hide" : "show";
      const emojiSel = $("settingsRenderEmojisSelect");
      if (emojiSel) emojiSel.value = appSettings.renderEmojis === false ? "disabled" : "enabled";
      const chunkSel = $("settingsChunkSizeSelect");
      if (chunkSel) chunkSel.value = appSettings.renderLoadPerChunk || "auto";
      const clickSel = $("settingsClickLoadSelect");
      if (clickSel) clickSel.value = appSettings.grabLinkClicksPerChunk || "per_chunk";
      const saveSel = $("settingsSaveLocalSelect");
      if (saveSel) saveSel.value = appSettings.saveSettingsLocally ? "enabled" : "disabled";
      populateTimezoneOverrideSelect();
      const tzConvSel = $("settingsTimezoneConversionSelect");
      if (tzConvSel) tzConvSel.value = appSettings.timezoneConversion === false ? "disabled" : "enabled";
      const tzOverSel = $("settingsTimezoneOverrideSelect");
      if (tzOverSel) {
        const want = appSettings.timezoneOverride || "";
        if (want && !Array.from(tzOverSel.options).some((o) => o.value === want)) {
          const opt = document.createElement("option");
          opt.value = want;
          opt.textContent = want.replace(/_/g, " ");
          tzOverSel.appendChild(opt);
        }
        tzOverSel.value = want;
      }
      syncTimezoneOverrideEnabled();
      syncDateFormatSelects();
      syncTimeNotationSelect();
      const sentrySel = $("settingsSentryConsentSelect");
      if (sentrySel) {
        let sentryConsent = "disabled";
        try {
          if (window.ProxyListSentry && typeof window.ProxyListSentry.getConsent === "function") {
            sentryConsent = window.ProxyListSentry.getConsent() || "disabled";
          }
        } catch (_) {}
        sentrySel.value = sentryConsent === "enabled" ? "enabled" : "disabled";
      }
      const hardwareSel = $("settingsHardwareConsentSelect");
      if (hardwareSel) {
        let hardwareConsent = "disabled";
        try {
          if (window.ProxyListHardware && typeof window.ProxyListHardware.getConsent === "function") {
            hardwareConsent = window.ProxyListHardware.getConsent() || "disabled";
          }
        } catch (_) {}
        hardwareSel.value = hardwareConsent === "enabled" ? "enabled" : "disabled";
      }
      syncGdbSettingsList();
      const chunkDesc = $("settingsChunkSizeDesc");
      if (chunkDesc) {
        const ram = estimatedDeviceMemoryGb();
        const resolved = resolvedRenderLoadPerChunk();
        const autoNote =
          " Auto picks Low at 2 GB or less, Medium at 4–8 GB, High at 16 GB or more, and Medium if RAM cannot be read" +
          (ram != null ? " (this device reports ~" + ram + " GB → " + resolved.replace("_", " ") + ")" : " (RAM unknown → medium)") +
          ".";
        chunkDesc.textContent =
          "Amount of links loaded each time you scroll the list. Lowering this can significantly improve performance and increase system memory available." +
          autoNote;
      }
      markSettingsWarnOptions();
      syncFilterControlsToUi();
    }

    function listKnownGdbCatalogs() {
      const api = window.ProxyListGameDbSearch;
      if (!api || typeof api.listCatalogs !== "function") return [];
      return api.listCatalogs().slice().sort((a, b) => String(a.label || "").localeCompare(String(b.label || "")));
    }

    /** null = search all catalogs; [] = none; otherwise only these gdb:* tags. */
    function getSelectedGdbSearchTags() {
      const selected = appSettings.gdbSearchSelectedTags;
      if (selected === null || selected === undefined) return null;
      if (!Array.isArray(selected)) return null;
      if (!selected.length) return [];
      const known = new Set(listKnownGdbCatalogs().map((c) => c.tag));
      const filtered = selected.filter((t) => !known.size || known.has(t));
      if (known.size && filtered.length >= known.size) return null;
      return filtered;
    }

    function syncGdbSettingsList() {
      const wrap = $("settingsGdbList");
      if (!wrap) return;
      const catalogs = listKnownGdbCatalogs();
      const selected = appSettings.gdbSearchSelectedTags;
      const allSelected = selected === null || selected === undefined;
      const noneSelected = Array.isArray(selected) && selected.length === 0;
      const selectedSet = !allSelected && !noneSelected ? new Set(selected) : null;
      wrap.innerHTML = catalogs
        .map((cat) => {
          const checked = allSelected || (selectedSet && selectedSet.has(cat.tag));
          return (
            '<label class="check"><input type="checkbox" data-gdb-tag="' +
            escapeAttr(cat.tag) +
            '"' +
            (checked ? " checked" : "") +
            " />" +
            escapeHtml(cat.label) +
            "</label>"
          );
        })
        .join("");
      if (!catalogs.length) {
        wrap.innerHTML = '<p class="settings-desc" style="margin:0;">No game databases available yet.</p>';
      }
    }

    async function commitGdbSettingsFromUi() {
      const wrap = $("settingsGdbList");
      if (!wrap) return;
      const catalogs = listKnownGdbCatalogs();
      const checked = Array.from(wrap.querySelectorAll('input[type="checkbox"][data-gdb-tag]:checked')).map((inp) =>
        String(inp.getAttribute("data-gdb-tag") || "").toLowerCase()
      );
      let next = null;
      if (!checked.length) next = [];
      else if (checked.length >= catalogs.length) next = null;
      else next = checked;
      await updateAppSetting({ gdbSearchSelectedTags: next });
    }

    function markSettingsWarnOptions() {
      const chunkSel = $("settingsChunkSizeSelect");
      if (chunkSel) {
        Array.from(chunkSel.options).forEach((opt) => {
          opt.classList.toggle("settings-warn-option", opt.value === "unoptimized");
        });
      }
      const clickSel = $("settingsClickLoadSelect");
      if (clickSel) {
        Array.from(clickSel.options).forEach((opt) => {
          opt.classList.toggle("settings-warn-option", opt.value === "all");
        });
      }
    }

    function syncFilterControlsToUi() {
      const filterSel = $("filterSelect");
      const settingsFilterSel = $("settingsFilterSelect");
      if (filterSel && settingsFilterSel && settingsFilterSel.value !== filterSel.value) {
        settingsFilterSel.value = filterSel.value;
      }
      if (settingsFilterSel && filterSel && filterSel.value !== settingsFilterSel.value) {
        filterSel.value = settingsFilterSel.value;
      }
      updateSelectedFilterUI();
    }

    async function openSettingsModal() {
      syncSettingsFormFromState();
      const backdrop = $("settingsBackdrop");
      if (!backdrop) return;
      backdrop.classList.add("open");
      backdrop.setAttribute("aria-hidden", "false");
      try {
        await ensureLinkLensLoaded();
      } catch (_) {}
      syncFilterControlsToUi();
      syncGdbSettingsList();
    }

    function closeSettingsModal() {
      const backdrop = $("settingsBackdrop");
      if (!backdrop) return;
      backdrop.classList.remove("open");
      backdrop.setAttribute("aria-hidden", "true");
    }

    async function updateAppSetting(patch) {
      appSettings = normalizeAppSettings(Object.assign({}, appSettings, patch || {}));
      applyThemeSetting(appSettings.theme);
      applyDeviceSizingSetting(appSettings.deviceSizing);
      applyAnimationsSetting(appSettings.animations);
      applyDebugModeSetting();
      applyDateTimeSettings();
      await persistAppSettings();
      syncSettingsFormFromState();
      if (pageContext) scheduleRenderFromPageContext();
    }

    function collectSaveDataPayload() {
      let localClicks = {};
      try {
        const raw = localStorage.getItem(LS_CLICK_KEY);
        const parsed = raw ? JSON.parse(raw) : null;
        if (parsed && typeof parsed === "object") localClicks = parsed;
      } catch (_) {}
      return {
        format: SAVE_DATA_FORMAT,
        exportedAt: new Date().toISOString(),
        settings: collectSettingsSnapshot(),
        savedLinks: [...savedLinks],
        localClicks: localClicks,
      };
    }

    function exportSaveDataFile() {
      try {
        const payload = collectSaveDataPayload();
        const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json;charset=utf-8" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        const stamp = new Date().toISOString().slice(0, 10);
        a.href = url;
        a.download = "proxy-list-save-" + stamp + ".json";
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(function () {
          try {
            URL.revokeObjectURL(url);
          } catch (_) {}
        }, 1500);
        showAppToast("Save data exported.");
      } catch (err) {
        console.warn("[proxy-list] Save data export failed", err);
        window.alert("Could not export save data.");
      }
    }

    async function importSaveDataObject(data) {
      if (!data || typeof data !== "object") throw new Error("invalid_payload");
      const format = String(data.format || "");
      if (format && format !== SAVE_DATA_FORMAT) {
        throw new Error("unsupported_format");
      }
      if (data.settings && typeof data.settings === "object") {
        applyUserSettings(data.settings, { applyDebugFromRemote: true });
      } else if (data.app && typeof data.app === "object") {
        applyAppSettings(data.app);
      }
      if (Array.isArray(data.savedLinks)) {
        applySavedLinks(data.savedLinks);
        const user = firebase.auth && firebase.auth().currentUser;
        if (user && !user.isAnonymous) {
          writeSavedLinksCache(user.uid, data.savedLinks);
        }
      }
      if (data.localClicks && typeof data.localClicks === "object") {
        try {
          localStorage.setItem(LS_CLICK_KEY, JSON.stringify(data.localClicks));
        } catch (_) {}
      }
      await persistAppSettings();
      scheduleUserProfileWrite();
      if (pageContext) {
        scheduleRenderFromPageContext();
        void renderMostOpenedForList(pageContext.links);
      }
      syncSettingsFormFromState();
      document.querySelectorAll(".save-link-btn[data-link]").forEach((btn) => {
        const norm = normalizeUrlKeyForClicks(btn.getAttribute("data-link"));
        const saved = !!(norm && savedLinks.has(norm));
        btn.classList.toggle("is-saved", saved);
        btn.setAttribute("aria-pressed", saved ? "true" : "false");
        btn.title = saved ? "Unsave link" : "Save link";
        btn.textContent = saved ? "★" : "☆";
      });
    }

    function promptUploadSaveData() {
      const input = $("settingsSaveDataUploadInput");
      if (!input) return;
      input.value = "";
      input.click();
    }

    async function handleSaveDataUploadFile(file) {
      if (!file) return;
      let text = "";
      try {
        text = await file.text();
      } catch (_) {
        window.alert("Could not read that file.");
        return;
      }
      let data = null;
      try {
        data = JSON.parse(text);
      } catch (_) {
        window.alert("That file is not valid JSON save data.");
        return;
      }
      if (
        !window.confirm(
          "Upload this save data? It will replace your current settings and saved links on this device" +
            (isSignedInUser() ? " and sync to your account if signed in" : "") +
            "."
        )
      ) {
        return;
      }
      try {
        await importSaveDataObject(data);
        showAppToast("Save data uploaded.");
      } catch (err) {
        console.warn("[proxy-list] Save data upload failed", err);
        window.alert("Could not import that save data file.");
      }
    }

    async function resetAllAppAndFilterSettings() {
      if (
        !window.confirm(
          "Reset all settings to their defaults? This includes theme, performance options, filters, and sort preferences."
        )
      ) {
        return;
      }
      appSettings = Object.assign({}, APP_SETTINGS_DEFAULTS);
      applyThemeSetting(appSettings.theme);
      applyDeviceSizingSetting(appSettings.deviceSizing);
      applyDateTimeSettings();
      applyAnimationsSetting(appSettings.animations);
      applyDebugModeSetting();
      writeAppSettingsToLocalStorage(appSettings);
      await writeAppSettingsToIdb(appSettings);
      selectedGnMathFilter = "";
      hideBlockedBySelectedFilter = false;
      hideLinksWithoutLensCheck = false;
      listSortMode = LINK_SORT_DEFAULT;
      try {
        localStorage.setItem(LS_LINK_LIST_SORT_KEY, listSortMode);
      } catch (_) {}
      const q = $("q");
      if (q) q.value = "";
      hideSearchSuggestions();
      setCheckboxGroup("providerTags", []);
      setCheckboxGroup("categoryTags", []);
      setCheckboxGroup("protocolTags", []);
      setCheckboxGroup("capTags", []);
      const capAny = document.querySelector('input[name="capMode"][value="any"]');
      if (capAny) capAny.checked = true;
      const moSortSel = $("mostOpenedSortSelect");
      if (moSortSel) moSortSel.value = "clicks";
      persistMostOpenedSortMode("clicks");
      const moProvSel = $("mostOpenedProviderSelect");
      if (moProvSel) moProvSel.value = "";
      persistMostOpenedProviderChoice("");
      const linkSortSel = $("linkListSortSelect");
      if (linkSortSel) linkSortSel.value = LINK_SORT_DEFAULT;
      updateSelectedFilterUI();
      syncSettingsFormFromState();
      scheduleUserProfileWrite();
      if (pageContext) {
        scheduleRenderFromPageContext();
        void renderMostOpenedForList(pageContext.links);
      }
    }

    async function handleLinkListSelection(link) {
      link = safeHttpUrl(link);
      if (!link) return;
      const action = appSettings.linkSelectionAction || "summary";
      if (action === "open") {
        if (!confirmMalwareAction(link, "open")) return;
        if (isJsDelivrUrl(link)) {
          openJsDelivrPicker(link);
          return;
        }
        void recordLinkClick(link);
        window.open(link, "_blank", "noopener,noreferrer");
        return;
      }
      if (action === "copy") {
        if (!confirmMalwareAction(link, "copy")) return;
        if (isJsDelivrUrl(link)) {
          openJsDelivrPicker(link, "copy");
          return;
        }
        const ok = await copyPlainTextToClipboard(link);
        if (ok) showAppToast("Link copied!");
        void recordLinkClick(link);
        return;
      }
      openSummary(link);
    }

    let randomLinkSpinning = false;
    let randomLinkPendingRow = null;
    const RANDOM_LOOT_ITEM_H = 40.8; // 2.55rem at default root

    function getFilteredSortedLinksForRandom() {
      if (!pageContext || !Array.isArray(pageContext.links)) return [];
      const folderOpts = {};
      if (viewingFolderId && folderViewState === "ready") {
        const set = new Set(folderItemsOrderedRaw());
        folderOpts.folderNormSet = set;
      }
      return sortFilteredRowsByListSort(filterRows(pageContext.links, folderOpts));
    }

    function groupLinksByProvider(rows) {
      const map = new Map();
      for (const row of rows || []) {
        const provider = String((row && row.provider) || "").trim() || "(unknown)";
        if (!map.has(provider)) map.set(provider, []);
        map.get(provider).push(row);
      }
      return map;
    }

    function providerDisplayName(provider) {
      const raw = String(provider || "(unknown)");
      return appSettings.renderEmojis === false ? stripEmojisFromText(raw) : raw;
    }

    function setRandomLinkStatus(text) {
      const el = $("randomLinkStatus");
      if (el) el.textContent = String(text || "");
    }

    function setRandomLinkResult(text) {
      const el = $("randomLinkResult");
      if (!el) return;
      if (!text) {
        el.hidden = true;
        el.textContent = "";
        return;
      }
      el.hidden = false;
      el.textContent = String(text);
    }

    function setRandomLinkControls(spinning, hasResult) {
      randomLinkSpinning = !!spinning;
      const spinBtn = $("randomLinkSpinBtn");
      const openBtn = $("randomLinkOpenBtn");
      const sidebarBtn = $("randomLinkBtn");
      if (spinBtn) {
        spinBtn.disabled = !!spinning;
        spinBtn.textContent = spinning ? "Spinning…" : "Spin";
      }
      if (openBtn) openBtn.hidden = !hasResult;
      if (sidebarBtn) sidebarBtn.disabled = !!spinning;
    }

    function closeRandomLinkModal() {
      if (randomLinkSpinning) return;
      const backdrop = $("randomLinkBackdrop");
      if (!backdrop) return;
      backdrop.classList.remove("open");
      backdrop.setAttribute("aria-hidden", "true");
    }

    function openRandomLinkModal() {
      const backdrop = $("randomLinkBackdrop");
      if (!backdrop) return;
      randomLinkPendingRow = null;
      setRandomLinkResult("");
      setRandomLinkStatus("Uses your current filters and sort. Press Spin to start.");
      setRandomLinkControls(false, false);
      const reel = $("randomLootboxReel");
      if (reel) {
        reel.style.transition = "none";
        reel.style.transform = "translateY(0px)";
        reel.replaceChildren();
      }
      backdrop.classList.add("open");
      backdrop.setAttribute("aria-hidden", "false");
      const spinBtn = $("randomLinkSpinBtn");
      if (spinBtn) spinBtn.focus();
    }

    function buildLootboxReel(providers, winnerIndex, loops) {
      const reel = $("randomLootboxReel");
      if (!reel) return 0;
      reel.replaceChildren();
      const sequence = [];
      const n = Math.max(1, providers.length);
      const loopCount = Math.max(2, loops || 6);
      for (let loop = 0; loop < loopCount; loop++) {
        for (let i = 0; i < n; i++) sequence.push(providers[i]);
      }
      // Ensure the final visible item is the winner.
      sequence.push(providers[winnerIndex]);
      sequence.forEach(function (name, idx) {
        const item = document.createElement("div");
        item.className = "random-lootbox-item";
        if (idx === sequence.length - 1) item.classList.add("is-winner");
        item.textContent = providerDisplayName(name);
        reel.appendChild(item);
      });
      return sequence.length - 1;
    }

    function waitMs(ms) {
      return new Promise(function (resolve) {
        setTimeout(resolve, ms);
      });
    }

    function animateLootboxToIndex(finalIndex, durationMs) {
      const reel = $("randomLootboxReel");
      if (!reel) return Promise.resolve();
      const itemH =
        (reel.firstElementChild && reel.firstElementChild.getBoundingClientRect().height) ||
        RANDOM_LOOT_ITEM_H;
      // Center the chosen item in the 9.5rem window (window center ≈ 4.75rem).
      const box = reel.parentElement;
      const boxH = box ? box.getBoundingClientRect().height : 152;
      const offset = boxH / 2 - itemH / 2 - finalIndex * itemH;
      const reduced =
        document.documentElement.getAttribute("data-animations") === "disabled" ||
        (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
      reel.style.transition = "none";
      reel.style.transform = "translateY(" + (boxH / 2 - itemH / 2) + "px)";
      if (reduced) {
        reel.style.transform = "translateY(" + offset + "px)";
        return Promise.resolve();
      }
      return new Promise(function (resolve) {
        requestAnimationFrame(function () {
          requestAnimationFrame(function () {
            reel.style.transition =
              "transform " + Math.max(900, durationMs || 3200) + "ms cubic-bezier(0.12, 0.75, 0.08, 1)";
            reel.style.transform = "translateY(" + offset + "px)";
            const done = function () {
              reel.removeEventListener("transitionend", done);
              resolve();
            };
            reel.addEventListener("transitionend", done);
            setTimeout(done, Math.max(900, durationMs || 3200) + 80);
          });
        });
      });
    }

    async function runRandomLinkSpin() {
      if (randomLinkSpinning) return;
      const rows = getFilteredSortedLinksForRandom();
      if (!rows.length) {
        setRandomLinkStatus("No links match your current filters/search.");
        setRandomLinkResult("");
        setRandomLinkControls(false, false);
        randomLinkPendingRow = null;
        return;
      }
      const byProvider = groupLinksByProvider(rows);
      const providers = [...byProvider.keys()];
      if (!providers.length) {
        setRandomLinkStatus("No providers available under the current filters.");
        return;
      }
      const winnerIndex = Math.floor(Math.random() * providers.length);
      const winnerProvider = providers[winnerIndex];
      const providerLinks = byProvider.get(winnerProvider) || [];
      const linkRow = providerLinks[Math.floor(Math.random() * providerLinks.length)];
      if (!linkRow || !linkRow.link) {
        setRandomLinkStatus("Could not pick a link for that provider.");
        return;
      }

      setRandomLinkControls(true, false);
      randomLinkPendingRow = null;
      setRandomLinkResult("");
      setRandomLinkStatus("Spinning providers…");

      const loops = Math.min(8, Math.max(4, Math.ceil(24 / Math.max(1, providers.length))));
      const finalIndex = buildLootboxReel(providers, winnerIndex, loops);
      await waitMs(40);
      await animateLootboxToIndex(finalIndex, 2800 + Math.floor(Math.random() * 900));

      setRandomLinkStatus("Landed on " + providerDisplayName(winnerProvider) + ". Picking a link…");
      await waitMs(
        document.documentElement.getAttribute("data-animations") === "disabled" ? 120 : 450
      );

      randomLinkPendingRow = linkRow;
      setRandomLinkResult(
        providerDisplayName(winnerProvider) + " → " + String(linkRow.link || "")
      );
      setRandomLinkStatus("Done. Open the result, or spin again.");
      setRandomLinkControls(false, true);
    }

    async function openRandomLinkResult() {
      if (!randomLinkPendingRow || !randomLinkPendingRow.link) return;
      const link = randomLinkPendingRow.link;
      closeRandomLinkModal();
      await handleLinkListSelection(link);
    }

    let savedLinksViewOnly = false;
    let viewingFolderId = "";
    let folderDocSnap = null;
    let folderViewState = "idle";
    let folderDocUnsub = null;
    let myFoldersQueryUnsub = null;
    let myFoldersList = [];
    let folderTrustedSearchTimer = null;
    let folderTrustedSearchLastQuery = "";
    let folderTrustedPickerMatches = [];
    let folderTrustedPickerOffset = 0;
    const FOLDER_TRUSTED_PICKER_CHUNK = 80;

    const LS_LINK_LIST_SORT_KEY = "proxyList_link_list_sort_v1";
    const LINK_SORT_DEFAULT = "default";
    const LINK_SORT_FOUND_DESC = "found_desc";
    const LINK_SORT_RATING_DESC = "rating_desc";
    const LINK_SORT_RATING_ASC = "rating_asc";
    const LINK_SORT_SAVED_DESC = "saved_desc";

    function isLinkListSortMode(v) {
      return (
        v === LINK_SORT_DEFAULT ||
        v === LINK_SORT_FOUND_DESC ||
        v === LINK_SORT_RATING_DESC ||
        v === LINK_SORT_RATING_ASC ||
        v === LINK_SORT_SAVED_DESC
      );
    }

    const RATING_THUMB_UP_IMG = "rating-thumb-up.png";
    const RATING_THUMB_DOWN_IMG = "rating-thumb-down.png";

    function readLinkListSortFromLS() {
      try {
        const v = localStorage.getItem(LS_LINK_LIST_SORT_KEY);
        if (isLinkListSortMode(v)) return v;
      } catch (_) {}
      return LINK_SORT_DEFAULT;
    }

    let listSortMode = readLinkListSortFromLS();
    let linkRatingAggByHash = new Map();
    let linkSaveCountByHash = new Map();
    let linkRatingSelfByHash = new Map();
    let hashToNormMap = new Map();
    let normToHashCache = new Map();
    /** Set each main `render()` from `data.json` meta — used for Firestore aggregate disk cache. */
    let currentListVersionStamp = "";

    const HEADER_SUB_DEFAULT_HTML =
      'Multi-select provider, category, protocol, and capability tags (parsed from <code>list.md</code>). Nothing checked means no filter on that group.';

    function sanitizeFolderDocId(raw) {
      const s = String(raw || "").trim();
      if (!s || s.length > 700) return "";
      if (!/^[a-zA-Z0-9_-]+$/.test(s)) return "";
      return s;
    }

    /** Backward-compatible: legacy docs only had isPublic (boolean). */
    function folderVisibilityFromDoc(data) {
      if (!data || typeof data !== "object") return "private";
      const v = data.visibility;
      if (v === "public" || v === "unlisted" || v === "private") return v;
      return data.isPublic === true ? "public" : "private";
    }

    function normalizeFolderVisibilityChoice(v) {
      return v === "public" || v === "unlisted" || v === "private" ? v : "private";
    }

    /** Firestore keeps isPublic in sync with visibility for the community listing query (isPublic == true means public-only). */
    function folderVisibilityFieldsForFirestore(visibility) {
      const v = normalizeFolderVisibilityChoice(visibility);
      return { visibility: v, isPublic: v === "public" };
    }

    function folderPrivacyPillInnerHtml(data) {
      const v = folderVisibilityFromDoc(data);
      if (v === "public") {
        return '<span class="folder-privacy-pill is-public">Public</span>';
      }
      if (v === "unlisted") {
        return '<span class="folder-privacy-pill is-unlisted">Unlisted</span>';
      }
      return '<span class="folder-privacy-pill">Private</span>';
    }

    function isEmbedMode() {
      return document.documentElement.classList.contains("embed-mode");
    }

    function withEmbedParam(url) {
      if (!isEmbedMode() || !url) return url;
      try {
        const u = new URL(url, window.location.href);
        if (u.origin !== window.location.origin) return url;
        if (!u.searchParams.has("embed")) u.searchParams.set("embed", "1");
        return u.pathname + u.search + u.hash;
      } catch (_) {
        return url;
      }
    }

    let embedResizeObserver = null;

    function notifyEmbedHeight() {
      if (!isEmbedMode() || window.parent === window) return;
      const h = Math.max(
        document.documentElement.scrollHeight,
        document.body ? document.body.scrollHeight : 0
      );
      try {
        window.parent.postMessage({ type: "proxy-list-embed", height: h }, embedPostMessageTargetOrigin());
      } catch (_) {}
    }

    function initEmbedMode() {
      if (!isEmbedMode()) return;
      document.body.classList.remove("orientation-locked");
      document.querySelectorAll("a[href]").forEach((a) => {
        const href = a.getAttribute("href");
        if (!href || href.startsWith("#") || /^javascript:/i.test(href)) return;
        const next = withEmbedParam(href);
        if (next && next !== href) a.setAttribute("href", next);
        if (a.classList.contains("embed-only")) return;
        if (!a.target && /^https?:\/\//i.test(next || href)) {
          try {
            const u = new URL(next || href, window.location.href);
            if (u.origin !== window.location.origin) a.target = "_blank";
          } catch (_) {}
        }
      });
      if (embedResizeObserver) embedResizeObserver.disconnect();
      if (typeof ResizeObserver !== "undefined") {
        embedResizeObserver = new ResizeObserver(() => notifyEmbedHeight());
        embedResizeObserver.observe(document.documentElement);
      }
      window.addEventListener("resize", notifyEmbedHeight);
      notifyEmbedHeight();
      setTimeout(notifyEmbedHeight, 400);
      setTimeout(notifyEmbedHeight, 1500);
    }

    function initSavedLinksView() {
      try {
        const params = new URLSearchParams(window.location.search);
        viewingFolderId = sanitizeFolderDocId(params.get("folder"));
        savedLinksViewOnly =
          !viewingFolderId &&
          (params.get("saved") === "1" || params.get("saved") === "true");
        folderViewState = viewingFolderId ? "loading" : "idle";
      } catch (_) {
        savedLinksViewOnly = false;
        viewingFolderId = "";
        folderViewState = "idle";
      }
      const subEl = $("headerSub");
      updateSavedViewUI();
    }

    function shouldHideMostOpenedSection() {
      return !!(viewingFolderId || savedLinksViewOnly);
    }

    function setListViewMode(mode) {
      listViewMode = "full";
      applyListViewModeUi();
    }

    function applyListViewModeUi() {
      const backMain = $("sidebarBackToMainList");
      if (backMain) {
        const onPlainMainList = !viewingFolderId && !savedLinksViewOnly;
        backMain.hidden = onPlainMainList;
      }
    }

    function hideMostOpenedSection() {
      const sec = $("mostOpenedSection");
      if (!sec) return;
      sec.hidden = true;
      const noteEl = $("mostOpenedNote");
      if (noteEl) {
        noteEl.textContent = "";
        noteEl.hidden = true;
      }
      const thead = $("mostOpenedThead");
      const tbody = $("mostOpenedTableBody");
      if (thead) setHtml(thead, "");
      if (tbody) setHtml(tbody, "");
      const moEmpty = $("mostOpenedEmptyState");
      if (moEmpty) {
        moEmpty.hidden = true;
        setHtml(moEmpty, "");
      }
      const moMount = $("mostOpenedTableMount");
      if (moMount) moMount.hidden = false;
    }

    function updateSavedViewUI() {
      const titleEl = $("headerTitle");
      const subEl = $("headerSub");
      if (viewingFolderId) {
        if (titleEl) {
          if (folderViewState === "loading") titleEl.textContent = "Folder";
          else if (folderViewState === "denied") titleEl.textContent = "Private folder";
          else if (folderViewState === "missing") titleEl.textContent = "Folder not found";
          else
            titleEl.textContent =
              folderDocSnap && folderDocSnap.title ? String(folderDocSnap.title) : "Folder";
        }
        if (subEl) {
          if (folderViewState === "loading") {
            setHtml(subEl, 'Loading folder… <a href="./">All links</a>');
          } else if (folderViewState === "denied") {
            setHtml(
              subEl,
              'This folder is private — only the owner can open it. <a href="./login/">Sign in</a> as the owner or ask them to set it to Public / Unlisted. <a href="./">Full list</a>.'
            );
          } else if (folderViewState === "missing") {
            setHtml(subEl, 'No such folder. <a href="./">Back to the list</a>');
          } else {
            const pub = folderDocSnap ? folderPrivacyPillInnerHtml(folderDocSnap) : "";
            setHtml(
              subEl,
              pub +
                ' <span class="folder-live-pill">Live</span> — updates from the owner appear automatically. <a href="./">Show all links</a>'
            );
          }
        }
        const ft =
          folderViewState === "ready" && folderDocSnap && folderDocSnap.title
            ? String(folderDocSnap.title).slice(0, 72) + " · "
            : "";
        document.title = ft + "Folder | Proxy list";
        hideMostOpenedSection();
      } else if (savedLinksViewOnly) {
        if (titleEl) titleEl.textContent = "Saved links";
        if (subEl) {
          setHtml(
            subEl,
            'Links you starred on the list. <a href="./">Show all links</a> · <span class="sub">Folders: use “Your folders” below when signed in.</span>'
          );
        }
        document.title = "Saved links | Proxy list";
        hideMostOpenedSection();
      } else {
        if (titleEl) titleEl.textContent = "Proxy list";
        if (subEl) setHtml(subEl, HEADER_SUB_DEFAULT_HTML);
        document.title = "Proxy list";
      }
      const backMain = $("sidebarBackToMainList");
      if (backMain) {
        const onPlainMainList = !viewingFolderId && !savedLinksViewOnly;
        backMain.hidden = onPlainMainList;
      }
      renderFolderChromeIntoHost();
    }

    let authUser = null;
    let communityFeaturesBlocked = false;
    let authDisplayName = "";
    let githubLogin = "";
    let githubRepoStarred = false;
    let savedLinks = new Set();
    let applyingUserSettings = false;
    let userSiteProfile = { siteUsername: "", profilePhotoDataUrl: "" };
    let userProfileWriteTimer = null;
    let accountMenuOpen = false;
    let githubNotificationsPollTimer = null;
    let userNotificationsUnsub = null;

    function mapFirestoreNotification(docSnap) {
      const d = docSnap.data() || {};
      return {
        id: "fs-" + docSnap.id,
        firestoreId: docSnap.id,
        kind: d.kind || "contribution",
        number: d.number || 0,
        count: d.count || 0,
        date: d.dateMs || (d.created && d.created.toMillis ? d.created.toMillis() : Date.now()),
        until: d.until || null,
        reason: d.reason || "",
        url: d.url || "",
        message: d.message || "",
      };
    }

    function stopUserNotificationsListener() {
      if (userNotificationsUnsub) {
        try {
          userNotificationsUnsub();
        } catch (_) {}
        userNotificationsUnsub = null;
      }
    }

    function startUserNotificationsListener() {
      stopUserNotificationsListener();
      if (!firebaseDb || !isSignedInUser() || !authUser) return;
      window.SiteNotificationsMarkRead = function (firestoreId) {
        if (!firebaseDb || !firestoreId) return;
        void firebaseDb
          .collection("userNotifications")
          .doc(firestoreId)
          .update({ read: true, readAt: firebase.firestore.FieldValue.serverTimestamp() })
          .catch(function () {});
      };
      try {
        userNotificationsUnsub = firebaseDb
          .collection("userNotifications")
          .where("uid", "==", authUser.uid)
          .limit(50)
          .onSnapshot(
            function (snap) {
              const items = snap.docs
                .map(mapFirestoreNotification)
                .filter(function (_item, idx) {
                  var d = snap.docs[idx].data() || {};
                  return d.read !== true;
                });
              if (window.SiteNotifications) window.SiteNotifications.showMany(items);
            },
            function (err) {
              console.warn("[proxy-list] userNotifications listener failed", err);
            }
          );
      } catch (err) {
        console.warn("[proxy-list] userNotifications setup failed", err);
      }
    }
    let authStateReady = false;
    let authStateReadyResolve = null;
    const authStateReadyPromise = new Promise((resolve) => {
      authStateReadyResolve = resolve;
    });

    function isSignedInUser() {
      return !!(authUser && !authUser.isAnonymous);
    }

    function accountUsername() {
      if (!isSignedInUser()) return "";
      if (userSiteProfile.siteUsername) return userSiteProfile.siteUsername;
      if (githubLogin) return githubLogin;
      if (authDisplayName) return authDisplayName;
      if (authUser.displayName) return authUser.displayName;
      if (authUser.email) return authUser.email.split("@")[0];
      return "Account";
    }

    /** Public-facing creator label stored on savedFolders for the community directory. */
    function folderOwnerLabelForFirestore(user) {
      if (!user || user.isAnonymous) return "";
      const gh = (user.providerData || []).find((p) => p && p.providerId === "github.com");
      if (gh && gh.displayName) return String(gh.displayName).trim().slice(0, 120);
      if (gh && gh.email) return String(gh.email).split("@")[0].slice(0, 120);
      if (user.displayName) return String(user.displayName).trim().slice(0, 120);
      if (user.email) return String(user.email).split("@")[0].slice(0, 120);
      return "Member";
    }

    function folderOwnerLabelForDirectory() {
      if (!isSignedInUser() || !authUser) return "";
      const fromProfile = userSiteProfile && userSiteProfile.siteUsername
        ? String(userSiteProfile.siteUsername).trim()
        : "";
      if (fromProfile) return fromProfile.slice(0, 120);
      return folderOwnerLabelForFirestore(authUser) || "Member";
    }

    function githubLoginFromUser(user) {
      if (!user) return "";
      const gh = (user.providerData || []).find((p) => p.providerId === "github.com");
      if (!gh) return "";
      if (gh.displayName) return String(gh.displayName).trim();
      const email = gh.email ? String(gh.email).split("@")[0] : "";
      return email;
    }

    function isGithubSignedInUser() {
      return !!(authUser && (authUser.providerData || []).some((p) => p.providerId === "github.com"));
    }

    function clearGithubAccessToken() {
      if (window.ProxyListAuthSecurity && typeof window.ProxyListAuthSecurity.clearGithubAccessToken === "function") {
        void window.ProxyListAuthSecurity.clearGithubAccessToken();
      }
      try {
        localStorage.removeItem("proxyList_github_access_token");
      } catch (_) {}
      try {
        sessionStorage.removeItem("proxyList_github_access_token");
      } catch (_) {}
    }

    function timeOfDayGreeting() {
      const hour = new Date().getHours();
      if (hour < 5) return "Night";
      if (hour < 12) return "Morning";
      if (hour < 17) return "Afternoon";
      return "Evening";
    }

    function updateHeaderGreeting() {
      const el = $("headerGreeting");
      if (!el) return;
      if (!isSignedInUser()) {
        el.hidden = true;
        el.textContent = "";
        return;
      }
      el.hidden = false;
      el.textContent = timeOfDayGreeting() + ", " + accountUsername();
    }

    function setAccountMenuOpen(open) {
      accountMenuOpen = !!open;
      const menu = $("accountMenu");
      const btn = $("accountMenuBtn");
      if (menu) {
        menu.hidden = !accountMenuOpen;
        menu.classList.toggle("open", accountMenuOpen);
      }
      if (btn) btn.setAttribute("aria-expanded", accountMenuOpen ? "true" : "false");
    }

    function updateAccountUI() {
      const btn = $("accountMenuBtn");
      const signInLink = $("headerSignInLink");
      const sidebarSignInLink = $("sidebarSignInLink");
      const sidebarAdminLink = $("sidebarAdminLink");
      const sidebarAppealLink = $("sidebarAppealLink");
      const cluster = $("accountSignedInCluster");
      if (!btn && !signInLink && !sidebarSignInLink) return;
      if (sidebarAdminLink) {
        const cachedAdmin =
          !!(window.SubmissionUtils && window.SubmissionUtils.isSubmissionAdminUser(authUser));
        sidebarAdminLink.hidden = !(isSignedInUser() && cachedAdmin);
        if (isSignedInUser() && window.SubmissionUtils && window.SubmissionUtils.checkSubmissionAdmin) {
          window.SubmissionUtils.checkSubmissionAdmin(authUser).then(function (ok) {
            if (sidebarAdminLink) sidebarAdminLink.hidden = !ok;
          });
        }
      }
      if (sidebarAppealLink && !isSignedInUser()) sidebarAppealLink.hidden = true;
      if (isSignedInUser()) {
        if (btn) {
          btn.textContent = accountUsername();
          btn.classList.toggle("account-trigger--repo-starred", !!(isGithubSignedInUser() && githubRepoStarred));
        }
        if (signInLink) signInLink.hidden = true;
        if (sidebarSignInLink) sidebarSignInLink.hidden = true;
        if (cluster) cluster.hidden = false;
        void refreshSidebarAppealVisibility();
      } else {
        communityFeaturesBlocked = false;
        if (btn) {
          btn.textContent = "Sign in";
          btn.classList.remove("account-trigger--repo-starred");
        }
        if (signInLink) signInLink.hidden = false;
        if (sidebarSignInLink) sidebarSignInLink.hidden = false;
        if (cluster) cluster.hidden = true;
        if (sidebarAppealLink) sidebarAppealLink.hidden = true;
        setAccountMenuOpen(false);
      }
      updateHeaderGreeting();
    }

    async function refreshSidebarAppealVisibility() {
      const sidebarAppealLink = $("sidebarAppealLink");
      communityFeaturesBlocked = false;
      if (!isSignedInUser() || !firebaseDb || !authUser) {
        if (sidebarAppealLink) sidebarAppealLink.hidden = true;
        return;
      }
      try {
        const snap = await firebaseDb.collection("contributorBans").doc(authUser.uid).get();
        if (!snap.exists) {
          if (sidebarAppealLink) sidebarAppealLink.hidden = true;
          return;
        }
        const data = snap.data() || {};
        if (data.until && typeof data.until.toMillis === "function" && data.until.toMillis() <= Date.now()) {
          if (sidebarAppealLink) sidebarAppealLink.hidden = true;
          return;
        }
        if (sidebarAppealLink) sidebarAppealLink.hidden = false;
        const scope = String(data.scope || "both");
        communityFeaturesBlocked = scope !== "form";
        if (communityFeaturesBlocked) {
          document.querySelectorAll("td.link-rating-cell").forEach((td) => {
            const tr = td.closest("tr");
            const a = tr && tr.querySelector("a.js-link-summary[data-link]");
            const linkUrl = a ? a.getAttribute("data-link") : "";
            if (linkUrl) setHtml(td, ratingCellInnerHtmlForLinkUrl(linkUrl));
          });
          const mount = $("folderRatingMount");
          if (mount && viewingFolderId) setHtml(mount, folderRatingBarInnerHtml(viewingFolderId));
        }
      } catch (_) {
        if (sidebarAppealLink) sidebarAppealLink.hidden = true;
      }
    }

    function alertIfCommunityFeaturesBlocked() {
      if (!communityFeaturesBlocked) return false;
      window.alert("Your account is suspended from community features, so you cannot rate links or folders.");
      return true;
    }

    async function ensureCommunityFeaturesAllowed() {
      if (!isSignedInUser() || !firebaseDb || !authUser) return true;
      try {
        const snap = await firebaseDb.collection("contributorBans").doc(authUser.uid).get();
        if (!snap.exists) {
          communityFeaturesBlocked = false;
          return true;
        }
        const data = snap.data() || {};
        if (data.until && typeof data.until.toMillis === "function" && data.until.toMillis() <= Date.now()) {
          communityFeaturesBlocked = false;
          return true;
        }
        const scope = String(data.scope || "both");
        communityFeaturesBlocked = scope !== "form";
      } catch (_) {
        /* keep cached flag */
      }
      return !alertIfCommunityFeaturesBlocked();
    }

    function contributorMatchesViewer(row) {
      if (!isGithubSignedInUser() || !githubLogin) return false;
      const login = githubLogin.toLowerCase();
      if (String(row.contributor || "").trim().toLowerCase() === login) return true;
      const href = String(row.contributor_url || "").toLowerCase();
      return href.includes("github.com/" + login);
    }

    function collectSettingsSnapshot() {
      return {
        webFilter: selectedGnMathFilter || "",
        hideBlocked: !!hideBlockedBySelectedFilter,
        hideUnchecked: !!hideLinksWithoutLensCheck,
        search: $("q") ? String($("q").value || "") : "",
        providers: selectedIn("providerTags"),
        categories: selectedIn("categoryTags"),
        protocols: selectedIn("protocolTags"),
        capabilities: selectedCaps(),
        capMode: capMode(),
        mostOpenedSort: getMostOpenedSortMode(),
        mostOpenedProvider: getMostOpenedProviderChoice(),
        linkListSort: listSortMode,
        app: collectAppSettingsSnapshot(),
      };
    }

    function collectListFiltersSnapshot() {
      return {
        webFilter: selectedGnMathFilter || "",
        hideBlocked: !!hideBlockedBySelectedFilter,
        hideUnchecked: !!hideLinksWithoutLensCheck,
        search: $("q") ? String($("q").value || "") : "",
        providers: selectedIn("providerTags"),
        categories: selectedIn("categoryTags"),
        protocols: selectedIn("protocolTags"),
        capabilities: selectedCaps(),
        capMode: capMode(),
        mostOpenedSort: getMostOpenedSortMode(),
        mostOpenedProvider: getMostOpenedProviderChoice(),
        linkListSort: listSortMode,
      };
    }

    function persistListFiltersLocally() {
      if (applyingUserSettings) return;
      try {
        localStorage.setItem(LS_LIST_FILTERS_KEY, JSON.stringify(collectListFiltersSnapshot()));
      } catch (_) {}
    }

    function readListFiltersLocally() {
      try {
        const raw = localStorage.getItem(LS_LIST_FILTERS_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === "object" ? parsed : null;
      } catch (_) {
        return null;
      }
    }

    function shouldSkipListFilterRestore() {
      try {
        const u = new URL(window.location.href);
        if (u.searchParams.has("folder") || u.searchParams.get("saved") === "1") return true;
      } catch (_) {}
      return false;
    }

    function restoreListFiltersLocally(options) {
      if (shouldSkipListFilterRestore()) return false;
      const settings = readListFiltersLocally();
      if (!settings) return false;
      const keepUrlSearch = !options || options.keepUrlSearch !== false;
      applyingUserSettings = true;
      try {
        selectedGnMathFilter = settings.webFilter ? String(settings.webFilter) : "";
        hideBlockedBySelectedFilter = !!settings.hideBlocked;
        hideLinksWithoutLensCheck = !!settings.hideUnchecked;
        const filterSel = $("filterSelect");
        if (filterSel) filterSel.value = selectedGnMathFilter;
        updateSelectedFilterUI();
        const q = $("q");
        if (q && settings.search != null) {
          let hasUrlQ = false;
          try {
            hasUrlQ = keepUrlSearch && new URL(window.location.href).searchParams.has("q");
          } catch (_) {}
          if (!hasUrlQ) q.value = String(settings.search);
        }
        setCheckboxGroup("providerTags", settings.providers);
        setCheckboxGroup("categoryTags", settings.categories);
        setCheckboxGroup("protocolTags", settings.protocols);
        setCheckboxGroup("capTags", settings.capabilities);
        const capRadio = document.querySelector(
          'input[name="capMode"][value="' + (settings.capMode === "all" ? "all" : "any") + '"]'
        );
        if (capRadio) capRadio.checked = true;
        const moSortSel = $("mostOpenedSortSelect");
        if (moSortSel && settings.mostOpenedSort) {
          moSortSel.value = settings.mostOpenedSort;
          persistMostOpenedSortMode(settings.mostOpenedSort);
        }
        const moProvSel = $("mostOpenedProviderSelect");
        if (moProvSel && settings.mostOpenedProvider != null) {
          moProvSel.value = settings.mostOpenedProvider || "";
          persistMostOpenedProviderChoice(settings.mostOpenedProvider || "");
        }
        const linkSortSel = $("linkListSortSelect");
        if (isLinkListSortMode(settings.linkListSort)) {
          listSortMode = settings.linkListSort;
          try {
            localStorage.setItem(LS_LINK_LIST_SORT_KEY, listSortMode);
          } catch (_) {}
          if (linkSortSel) linkSortSel.value = listSortMode;
        }
      } finally {
        applyingUserSettings = false;
      }
      return true;
    }

    function setCheckboxGroup(containerId, values) {
      const wanted = new Set((values || []).map((v) => String(v)));
      document.querySelectorAll("#" + containerId + " input[type=checkbox]").forEach((input) => {
        input.checked = wanted.has(input.value);
      });
    }

    function findProviderCheckboxValue(matchKey) {
      const key = String(matchKey || "")
        .toLowerCase()
        .replace(/['’]/g, "")
        .trim();
      if (!key) return "";
      const inputs = [...document.querySelectorAll("#providerTags input[type=checkbox]")];
      let best = "";
      let bestScore = -1;
      for (const input of inputs) {
        const raw = String(input.value || "");
        const cleaned = stripEmojisFromText(raw)
          .toLowerCase()
          .replace(/['’]/g, "")
          .trim();
        if (!cleaned) continue;
        let score = -1;
        if (cleaned === key) score = 100;
        else if (cleaned.includes(key)) score = 80 + Math.min(key.length, 19);
        else if (key.includes(cleaned) && cleaned.length >= 4) score = 60;
        if (score > bestScore) {
          bestScore = score;
          best = raw;
        }
      }
      return bestScore >= 60 ? best : "";
    }

    function autofillFeaturedProvider(matchKey) {
      const providerValue = findProviderCheckboxValue(matchKey);
      if (!providerValue) {
        showAppToast("That provider is not in the list yet.");
        return false;
      }
      const searchText = providerSuggestLabel(providerValue) || stripEmojisFromText(providerValue) || String(matchKey || "");
      setCheckboxGroup("providerTags", []);
      setCheckboxGroup("categoryTags", []);
      setCheckboxGroup("protocolTags", []);
      setCheckboxGroup("capTags", []);
      const q = $("q");
      if (q) {
        q.value = searchText;
        rememberRecentSearch(searchText);
        hideSearchSuggestions();
        try {
          q.focus();
          q.select();
        } catch (_) {}
      }
      if (pageContext) {
        scheduleRenderFromPageContext();
      }
      scheduleUserProfileWrite();
      const label = stripEmojisFromText(providerValue) || searchText;
      showAppToast("Showing " + label + " links — clear search to see all");
      const target = $("stats") || $("tableWrap");
      if (target && typeof target.scrollIntoView === "function") {
        target.scrollIntoView({ behavior: "smooth", block: "start" });
      }
      return true;
    }

    function featuredProviderKey(value) {
      return stripEmojisFromText(value || "")
        .toLowerCase()
        .replace(/['’]/g, "")
        .trim();
    }

    function gdbTagsForFeaturedProvider(matchKey) {
      const key = featuredProviderKey(matchKey);
      if (!key || !pageContext || !Array.isArray(pageContext.links)) return [];
      let bestTags = [];
      let bestScore = -1;
      for (const row of pageContext.links) {
        const cleaned = featuredProviderKey(row && row.provider);
        if (!cleaned) continue;
        let score = -1;
        if (cleaned === key) score = 100;
        else if (cleaned.includes(key)) score = 80 + Math.min(key.length, 19);
        else if (key.includes(cleaned) && cleaned.length >= 4) score = 60;
        if (score <= bestScore) continue;
        bestScore = score;
        bestTags = (row.capability_tags || [])
          .map((t) => String(t || "").toLowerCase())
          .filter((t) => t.indexOf("gdb:") === 0);
        if (score === 100) break;
      }
      return bestScore >= 60 ? [...new Set(bestTags)] : [];
    }

    function gamesBrowserHrefForGdbTags(tags) {
      const unique = [...new Set((tags || []).map((t) => String(t || "").toLowerCase()).filter(Boolean))];
      if (!unique.length) return "./games-browser/";
      return "./games-browser/?gdb=" + encodeURIComponent(unique.join(","));
    }

    function syncFeaturedGdbButtons() {
      const slides = document.querySelectorAll(".featured-slide");
      slides.forEach((slide) => {
        const providerBtn = slide.querySelector("[data-featured-provider]");
        const gdbBtn = slide.querySelector("[data-featured-gdb]");
        if (!gdbBtn) return;
        const matchKey = providerBtn ? providerBtn.getAttribute("data-featured-provider") || "" : "";
        const tags = gdbTagsForFeaturedProvider(matchKey);
        if (!tags.length) {
          gdbBtn.hidden = true;
          gdbBtn.removeAttribute("href");
          gdbBtn.setAttribute("data-featured-gdb", "");
          return;
        }
        gdbBtn.hidden = false;
        gdbBtn.setAttribute("data-featured-gdb", tags.join(","));
        gdbBtn.setAttribute("href", gamesBrowserHrefForGdbTags(tags));
      });
    }

    function wireFeaturedProxyButtons() {
      const root = $("featuredProxiesSection");
      if (!root || root.dataset.wired === "1") return;
      root.dataset.wired = "1";

      const slides = [...root.querySelectorAll(".featured-slide")];
      const dotsWrap = $("featuredDots");
      const prevBtn = $("featuredPrevBtn");
      const nextBtn = $("featuredNextBtn");
      const stage = $("featuredStage");
      let index = Math.max(
        0,
        slides.findIndex((slide) => slide.classList.contains("is-active"))
      );
      if (!slides.length) return;
      if (index < 0) index = 0;

      const FEATURED_ROTATE_MS = 8000;
      let timer = null;
      let paused = false;

      function renderDots() {
        if (!dotsWrap) return;
        dotsWrap.replaceChildren();
        slides.forEach((slide, i) => {
          const dot = document.createElement("button");
          dot.type = "button";
          dot.className = "featured-dot" + (i === index ? " is-active" : "");
          dot.setAttribute("role", "tab");
          dot.setAttribute("aria-label", "Show featured proxy " + (i + 1));
          dot.setAttribute("aria-selected", i === index ? "true" : "false");
          dot.addEventListener("click", () => goTo(i, true));
          dotsWrap.appendChild(dot);
        });
      }

      const FEATURED_PHOTO_KEYS = [
        "catclass",
        "duckmath",
        "studyhub",
        "voidnetwork",
        "c00lkidtech",
        "pgis3",
      ];

      function featuredPhotoSrc(photoIndex) {
        const key = FEATURED_PHOTO_KEYS[photoIndex];
        const photos = window.__proxyListFeaturedPhotos;
        if (key && photos && photos[key]) return photos[key];
        return "";
      }

      /** Allow only http(s) or data:image URLs so DOM attributes cannot inject javascript: into <img src>. */
      function sanitizeFeaturedPhotoSrc(raw) {
        const s = String(raw || "").trim();
        if (!s) return "";
        if (/^data:image\/[a-z0-9.+-]+(?:;charset=[^;,\s]+)?;base64,/i.test(s)) return s;
        try {
          const u = new URL(s, location.href);
          if (u.protocol === "http:" || u.protocol === "https:") return u.href;
        } catch (_) {}
        return "";
      }

      function ensureFeaturedPhoto(slide, photoIndex) {
        if (!slide) return;
        const src = sanitizeFeaturedPhotoSrc(featuredPhotoSrc(photoIndex));
        if (!src) return;
        let img = slide.querySelector(".featured-slide-photo");
        if (!img) {
          img = document.createElement("img");
          img.className = "featured-slide-photo";
          img.alt = "";
          img.width = 1920;
          img.height = 1000;
          img.decoding = "async";
          slide.insertBefore(img, slide.firstChild);
        }
        if (img.getAttribute("src") !== src) img.src = src;
      }

      function goTo(nextIndex, userInitiated) {
        if (!slides.length) return;
        const total = slides.length;
        index = ((nextIndex % total) + total) % total;
        slides.forEach((slide, i) => {
          const active = i === index;
          slide.classList.toggle("is-active", active);
          slide.setAttribute("aria-hidden", active ? "false" : "true");
          if (active) ensureFeaturedPhoto(slide, i);
        });
        const upcomingIndex = (index + 1) % total;
        const upcoming = slides[upcomingIndex];
        if (upcoming) ensureFeaturedPhoto(upcoming, upcomingIndex);
        renderDots();
        if (userInitiated) restartTimer();
      }

      function next() {
        goTo(index + 1, false);
      }

      function prev() {
        goTo(index - 1, true);
      }

      function stopTimer() {
        if (timer) {
          clearInterval(timer);
          timer = null;
        }
      }

      function startTimer() {
        stopTimer();
        if (paused || slides.length < 2) return;
        if (document.documentElement.getAttribute("data-animations") === "disabled") return;
        timer = setInterval(next, FEATURED_ROTATE_MS);
      }

      function restartTimer() {
        stopTimer();
        startTimer();
      }

      function setPaused(nextPaused) {
        paused = !!nextPaused;
        if (paused) stopTimer();
        else startTimer();
      }

      root.addEventListener("click", (ev) => {
        const btn = ev.target && ev.target.closest ? ev.target.closest("[data-featured-provider]") : null;
        if (!btn || !root.contains(btn)) return;
        autofillFeaturedProvider(btn.getAttribute("data-featured-provider") || "");
      });

      if (prevBtn) prevBtn.addEventListener("click", prev);
      if (nextBtn) nextBtn.addEventListener("click", () => goTo(index + 1, true));

      if (stage) {
        stage.addEventListener("mouseenter", () => setPaused(true));
        stage.addEventListener("mouseleave", () => setPaused(false));
        stage.addEventListener("focusin", () => setPaused(true));
        stage.addEventListener("focusout", (ev) => {
          if (!stage.contains(ev.relatedTarget)) setPaused(false);
        });
      }

      document.addEventListener("visibilitychange", () => {
        if (document.hidden) stopTimer();
        else if (!paused) startTimer();
      });

      goTo(index, false);
      startTimer();
      syncFeaturedGdbButtons();
    }

    function applyUserSettings(settings, options) {
      if (!settings || typeof settings !== "object") return;
      applyingUserSettings = true;
      try {
        selectedGnMathFilter = settings.webFilter ? String(settings.webFilter) : "";
        hideBlockedBySelectedFilter = !!settings.hideBlocked;
        hideLinksWithoutLensCheck = !!settings.hideUnchecked;
        const filterSel = $("filterSelect");
        if (filterSel) filterSel.value = selectedGnMathFilter;
        updateSelectedFilterUI();
        const q = $("q");
        if (q && settings.search != null) {
          try {
            const u = new URL(window.location.href);
            if (!u.searchParams.has("q")) q.value = String(settings.search);
          } catch (_) {
            q.value = String(settings.search);
          }
        }
        setCheckboxGroup("providerTags", settings.providers);
        setCheckboxGroup("categoryTags", settings.categories);
        setCheckboxGroup("protocolTags", settings.protocols);
        setCheckboxGroup("capTags", settings.capabilities);
        const capRadio = document.querySelector(
          'input[name="capMode"][value="' + (settings.capMode === "all" ? "all" : "any") + '"]'
        );
        if (capRadio) capRadio.checked = true;
        const moSortSel = $("mostOpenedSortSelect");
        if (moSortSel && settings.mostOpenedSort) {
          moSortSel.value = settings.mostOpenedSort;
          persistMostOpenedSortMode(settings.mostOpenedSort);
        }
        const moProvSel = $("mostOpenedProviderSelect");
        if (moProvSel) {
          moProvSel.value = settings.mostOpenedProvider || "";
          persistMostOpenedProviderChoice(settings.mostOpenedProvider || "");
        }
        const linkSortSel = $("linkListSortSelect");
        if (isLinkListSortMode(settings.linkListSort)) {
          listSortMode = settings.linkListSort;
          try {
            localStorage.setItem(LS_LINK_LIST_SORT_KEY, listSortMode);
          } catch (_) {}
          if (linkSortSel) linkSortSel.value = listSortMode;
        }
        if (settings.app && typeof settings.app === "object") {
          const remoteApp = settings.app;
          // Debug overlays are device-local. Cloud/profile settings must not turn
          // them off after Enable & Refresh (profile fetch lands after reload).
          const app =
            options && options.applyDebugFromRemote
              ? remoteApp
              : Object.assign({}, remoteApp, {
                  debugMode: appSettings.debugMode,
                  debugShowUserAgent: appSettings.debugShowUserAgent,
                  debugEruda: appSettings.debugEruda,
                  debugPerfGraph: appSettings.debugPerfGraph,
                  debugCullingTest: appSettings.debugCullingTest,
                });
          applyAppSettings(app, { skipUi: true });
        }
        restoreListFiltersLocally({ keepUrlSearch: true });
      } finally {
        applyingUserSettings = false;
      }
    }

    function applySavedLinks(list) {
      savedLinks = new Set();
      (list || []).forEach((url) => {
        const norm = normalizeUrlKeyForClicks(url);
        if (norm) savedLinks.add(norm);
      });
    }

    function applySiteProfileFromDoc(data) {
      const d = data || {};
      userSiteProfile = {
        siteUsername: d.siteUsername ? String(d.siteUsername).trim() : "",
        profilePhotoDataUrl: d.profilePhotoDataUrl ? String(d.profilePhotoDataUrl) : "",
      };
      const img = $("accountAvatarImg");
      if (img) {
        if (userSiteProfile.profilePhotoDataUrl) {
          img.src = userSiteProfile.profilePhotoDataUrl;
          img.hidden = false;
        } else {
          img.removeAttribute("src");
          img.hidden = true;
        }
      }
    }

    async function loadUserProfile() {
      if (!isSignedInUser() || !firebaseDb) return;
      const user = await ensureAuthForFirestore();
      if (!user) return;
      try {
        const snap = await firebaseDb.collection("users").doc(user.uid).get();
        const data = snap.exists ? snap.data() || {} : {};
        applySiteProfileFromDoc(data);
        applySavedLinks(data.savedLinks || []);
        writeSavedLinksCache(user.uid, data.savedLinks || []);
        applyUserSettings(data.settings || {});
        if (pageContext) {
          scheduleRenderFromPageContext();
          void renderMostOpenedForList(pageContext.links);
        }
        updateHeaderGreeting();
        updateAccountUI();
      } catch (err) {
        console.warn("[proxy-list] Failed to load user profile", err);
        applySiteProfileFromDoc({});
        applySavedLinks(readSavedLinksCache(user.uid));
        if (pageContext) scheduleRenderFromPageContext();
      }
    }

    function scheduleUserProfileWrite() {
      persistListFiltersLocally();
      if (!isSignedInUser() || !firebaseDb || applyingUserSettings) return;
      if (userProfileWriteTimer) clearTimeout(userProfileWriteTimer);
      userProfileWriteTimer = setTimeout(() => {
        userProfileWriteTimer = null;
        writeUserProfile();
      }, 450);
    }

    async function writeUserProfile() {
      if (!isSignedInUser() || !firebaseDb) return;
      const user = await ensureAuthForFirestore();
      if (!user) return;
      const payload = {
        githubLogin: githubLogin || null,
        savedLinks: [...savedLinks].map((norm) => norm),
        settings: collectSettingsSnapshot(),
        updated: firebase.firestore.FieldValue.serverTimestamp(),
      };
      writeSavedLinksCache(user.uid, payload.savedLinks);
      try {
        await firebaseDb.collection("users").doc(user.uid).set(payload, { merge: true });
      } catch (err) {
        console.warn("[proxy-list] Failed to save user profile", err);
        if (!isFirestorePermissionDenied(err)) return;
      }
    }

    async function toggleSavedLink(url) {
      if (!isSignedInUser()) return;
      const norm = normalizeUrlKeyForClicks(url);
      if (!norm) return;
      const wasSaved = savedLinks.has(norm);
      if (wasSaved) savedLinks.delete(norm);
      else savedLinks.add(norm);
      scheduleUserProfileWrite();
      await bumpLinkSaveCountForNorm(norm, wasSaved ? -1 : 1);
      scheduleRenderFromPageContext();
    }

    async function bumpLinkSaveCountForNorm(norm, delta) {
      if (!norm || !delta || !firebaseDb) return;
      let hash = "";
      try {
        hash = await sha256Hex(norm);
        const cur = Number(linkSaveCountByHash.get(hash)) || 0;
        linkSaveCountByHash.set(hash, Math.max(0, cur + delta));
        const user = firebase.auth().currentUser;
        if (!user || user.isAnonymous) return;
        await firebaseDb
          .collection("linkSaveCounts")
          .doc(hash)
          .set(
            {
              norm: norm,
              count: firebase.firestore.FieldValue.increment(delta),
              updated: firebase.firestore.FieldValue.serverTimestamp(),
            },
            { merge: true }
          );
        patchLinkSaveCountDiskCacheOne(hash, Number(linkSaveCountByHash.get(hash)) || 0);
      } catch (err) {
        if (hash) {
          const cur = Number(linkSaveCountByHash.get(hash)) || 0;
          linkSaveCountByHash.set(hash, Math.max(0, cur - delta));
        }
        if (!isFirestorePermissionDenied(err)) {
          console.warn("[proxy-list] linkSaveCounts update failed", err);
        }
      }
    }

    function buildSaveLinkButtonHtml(link) {
      const norm = normalizeUrlKeyForClicks(link);
      const signedIn = isSignedInUser();
      const saved = signedIn && norm && savedLinks.has(norm);
      return (
        '<button type="button" class="save-link-btn' +
        (saved ? " is-saved" : "") +
        '" data-link="' +
        escapeAttr(link) +
        '" aria-pressed="' +
        (saved ? "true" : "false") +
        '" title="' +
        (signedIn ? (saved ? "Unsave link" : "Save link") : "Sign in to save links") +
        '">' +
        (saved ? "★" : "☆") +
        "</button>"
      );
    }

    function openSignInRequiredModal(message) {
      const backdrop = $("signInRequiredBackdrop");
      if (!backdrop) return;
      const body = backdrop.querySelector(".summary-body .summary-muted");
      if (body) {
        body.textContent =
          message && String(message).trim()
            ? String(message).trim()
            : "You need to be signed in to save links to your account.";
      }
      backdrop.classList.add("open");
      backdrop.setAttribute("aria-hidden", "false");
    }

    function closeSignInRequiredModal() {
      const backdrop = $("signInRequiredBackdrop");
      if (!backdrop) return;
      backdrop.classList.remove("open");
      backdrop.setAttribute("aria-hidden", "true");
    }

    function readGithubNotificationsSeen() {
      try {
        const raw = localStorage.getItem(GITHUB_NOTIFICATIONS_SEEN_KEY);
        const parsed = raw ? JSON.parse(raw) : {};
        return parsed && typeof parsed === "object" ? parsed : {};
      } catch (_) {
        return {};
      }
    }

    function writeGithubNotificationsSeen(map) {
      try {
        localStorage.setItem(GITHUB_NOTIFICATIONS_SEEN_KEY, JSON.stringify(map || {}));
      } catch (_) {}
    }

    function renderGithubNotifications(items) {
      if (window.SiteNotifications) {
        if (!items || !items.length) return;
        window.SiteNotifications.showMany(items);
        return;
      }
      const wrap = $("githubNotificationList");
      if (!wrap) return;
      if (!items.length) {
        wrap.hidden = true;
        wrap.replaceChildren();
        return;
      }
      wrap.hidden = false;
      setHtml(
        wrap,
        items
          .map(
            (item) =>
              '<div class="github-notification" role="status">' +
              escapeHtml(item.title || item.message || "") +
              (item.url
                ? ' <a href="' + escapeAttr(item.url) + '" rel="noopener noreferrer" target="_blank">Open</a>'
                : "") +
              "</div>"
          )
          .join("")
      );
    }

    async function refreshGithubExtras() {
      if (!isGithubSignedInUser()) {
        githubRepoStarred = false;
        updateAccountUI();
        return;
      }
      if (!window.ProxyListAuthSecurity || typeof window.ProxyListAuthSecurity.fetchGithubExtras !== "function") {
        githubRepoStarred = false;
        updateAccountUI();
        return;
      }
      try {
        const extras = await window.ProxyListAuthSecurity.fetchGithubExtras();
        if (extras && extras.unauthorized) {
          clearGithubAccessToken();
          githubRepoStarred = false;
          if (githubNotificationsPollTimer) {
            clearInterval(githubNotificationsPollTimer);
            githubNotificationsPollTimer = null;
          }
          updateAccountUI();
          return;
        }
        githubRepoStarred = !!(extras && extras.starred);
        const seen = readGithubNotificationsSeen();
        const fresh = [];
        for (const note of (extras && extras.notifications) || []) {
          const id = String(note.githubId || note.id || "");
          if (!id || seen[id]) continue;
          seen[id] = Date.now();
          fresh.push(note);
        }
        if (fresh.length) {
          writeGithubNotificationsSeen(seen);
          renderGithubNotifications(fresh);
        }
      } catch (err) {
        console.warn("[proxy-list] GitHub extras unavailable", err);
        githubRepoStarred = false;
      }
      updateAccountUI();
    }

    function scheduleGithubNotificationsPoll() {
      if (githubNotificationsPollTimer) clearInterval(githubNotificationsPollTimer);
      if (!isGithubSignedInUser()) return;
      void refreshGithubExtras();
      githubNotificationsPollTimer = setInterval(() => {
        void refreshGithubExtras();
      }, 5 * 60 * 1000);
    }

    async function signOutAccount() {
      if (typeof firebase === "undefined") return;
      setAccountMenuOpen(false);
      clearGithubAccessToken();
      githubLogin = "";
      githubRepoStarred = false;
      savedLinks = new Set();
      renderGithubNotifications([]);
      try {
        await firebase.auth().signOut();
        await firebase.auth().signInAnonymously();
      } catch (err) {
        console.error("[proxy-list] Sign-out failed", err);
      }
    }

    function handleAuthUserChanged(user) {
      authUser = user || null;
      authDisplayName = user && user.displayName ? String(user.displayName) : "";
      githubLogin = githubLoginFromUser(user);
      if (!isSignedInUser()) {
        savedLinks = new Set();
        githubRepoStarred = false;
        userSiteProfile = { siteUsername: "", profilePhotoDataUrl: "" };
        linkRatingSelfByHash.clear();
        const img = $("accountAvatarImg");
        if (img) {
          img.removeAttribute("src");
          img.hidden = true;
        }
        if (window.SiteNotifications) window.SiteNotifications.clearAll();
        stopUserNotificationsListener();
        if (githubNotificationsPollTimer) {
          clearInterval(githubNotificationsPollTimer);
          githubNotificationsPollTimer = null;
        }
      } else {
        applySavedLinks(readSavedLinksCache(authUser.uid));
        void loadUserProfile();
        scheduleGithubNotificationsPoll();
        startUserNotificationsListener();
      }
      updateAccountUI();
      updateSavedViewUI();
      startFolderAndMyFoldersListeners();
      if (pageContext) scheduleRenderFromPageContext();
    }

    function setupAccountUI() {
      const btn = $("accountMenuBtn");
      const menu = $("accountMenu");
      const signOutBtn = $("accountSignOutBtn");
      const signInRequiredBackdrop = $("signInRequiredBackdrop");
      const signInRequiredCloseBtn = $("signInRequiredCloseBtn");
      const signInRequiredDismissBtn = $("signInRequiredDismissBtn");
      if (btn) {
        btn.addEventListener("click", (ev) => {
          ev.stopPropagation();
          setAccountMenuOpen(!accountMenuOpen);
        });
      }
      if (signOutBtn) signOutBtn.addEventListener("click", () => void signOutAccount());
      document.addEventListener("click", (ev) => {
        if (!accountMenuOpen) return;
        const corner = $("accountCorner");
        if (corner && !corner.contains(ev.target)) setAccountMenuOpen(false);
      });
      document.addEventListener("click", (ev) => {
        const saveBtn = ev.target && ev.target.closest ? ev.target.closest(".save-link-btn") : null;
        if (!saveBtn) return;
        ev.preventDefault();
        if (!isSignedInUser()) {
          openSignInRequiredModal();
          return;
        }
        const link = saveBtn.getAttribute("data-link");
        if (!link) return;
        const norm = normalizeUrlKeyForClicks(link);
        void toggleSavedLink(link);
        if (norm) {
          const saved = savedLinks.has(norm);
          saveBtn.classList.toggle("is-saved", saved);
          saveBtn.setAttribute("aria-pressed", saved ? "true" : "false");
          saveBtn.title = saved ? "Unsave link" : "Save link";
          saveBtn.textContent = saved ? "★" : "☆";
        }
      });
      if (signInRequiredCloseBtn) signInRequiredCloseBtn.addEventListener("click", closeSignInRequiredModal);
      if (signInRequiredDismissBtn) signInRequiredDismissBtn.addEventListener("click", closeSignInRequiredModal);
      if (signInRequiredBackdrop) {
        signInRequiredBackdrop.addEventListener("click", (ev) => {
          if (ev.target === signInRequiredBackdrop) closeSignInRequiredModal();
        });
      }
      document.addEventListener("click", (ev) => {
        const addL = ev.target && ev.target.closest ? ev.target.closest("[data-folder-add-link]") : null;
        if (addL) {
          ev.preventDefault();
          const u = addL.getAttribute("data-folder-add-link");
          if (u) void addTrustedLinkUrlToFolder(u);
          return;
        }
        const tool = ev.target && ev.target.closest ? ev.target.closest("[data-folder-tool]") : null;
        if (!tool) return;
        if (!viewingFolderId || !isViewingOwnFolder()) return;
        const idx = Number(tool.getAttribute("data-folder-idx"));
        if (!Number.isFinite(idx)) return;
        const kind = tool.getAttribute("data-folder-tool");
        if (kind === "up") void folderRowMove(idx, "up");
        else if (kind === "down") void folderRowMove(idx, "down");
        else if (kind === "remove") void folderRowRemove(idx);
      });
      document.addEventListener("click", (ev) => {
        const rateBtn = ev.target && ev.target.closest ? ev.target.closest("[data-link-rating-vote]") : null;
        if (rateBtn) {
          ev.preventDefault();
          const url = rateBtn.getAttribute("data-link-rating-url");
          const val = Number(rateBtn.getAttribute("data-link-rating-vote"));
          if (url && (val === 1 || val === -1)) void handleLinkRatingButtonClick(url, val);
          return;
        }
        const fr = ev.target && ev.target.closest ? ev.target.closest("[data-folder-rating-vote]") : null;
        if (fr) {
          ev.preventDefault();
          const fid = fr.getAttribute("data-folder-rating-id");
          const val = Number(fr.getAttribute("data-folder-rating-vote"));
          if (fid && (val === 1 || val === -1)) void handleFolderRatingButtonClick(fid, val);
        }
      });
      updateAccountUI();
    }

    const LS_CLICK_KEY = "proxyList_link_clicks_v1";
    const LS_SAVED_LINKS_KEY = "proxyList_saved_links_v1";
    // v2: ignore inflated v1 caches from the D1 preview seed that stored merged legacy+modern totals.
    const LS_CLICK_COUNT_DISK = "proxyList_clickCountDisk_v2";
    /** Latest counts returned by POST /api/link-click (before read quota catches up). */
    const clickCountCache = new Map();

    function isFirestorePermissionDenied(err) {
      const code = err && err.code ? String(err.code) : "";
      const message = err && err.message ? String(err.message) : "";
      return code === "permission-denied" || /insufficient permissions/i.test(message);
    }

    function isFirestoreResourceExhausted(err) {
      const code = err && err.code ? String(err.code) : "";
      const message = err && err.message ? String(err.message) : "";
      return (
        code === "resource-exhausted" ||
        code === "unavailable" ||
        /resource-exhausted|quota exceeded|too many requests|429/i.test(message)
      );
    }

    function firestoreRatingFailureUserHint(err) {
      if (isFirestorePermissionDenied(err)) {
        if (communityFeaturesBlocked) {
          return "Your account is suspended from community features, so ratings are blocked.";
        }
        return "Firestore refused the request. Deploy the rules from docs/firestore.rules to the same Firebase project as this site.";
      }
      if (isFirestoreResourceExhausted(err)) {
        return "Firebase hit a quota or rate limit (often after loading ratings for a very large list). Wait a few minutes and try again, reload less often, or upgrade the Firebase plan for higher limits.";
      }
      return "Sign in with a non-anonymous account, or deploy updated Firestore rules if this persists.";
    }

    function readSavedLinksCache(uid) {
      if (!uid) return [];
      try {
        const raw = localStorage.getItem(LS_SAVED_LINKS_KEY);
        const map = raw ? JSON.parse(raw) : {};
        return Array.isArray(map[uid]) ? map[uid].filter(Boolean) : [];
      } catch (_) {
        return [];
      }
    }

    function writeSavedLinksCache(uid, links) {
      if (!uid) return;
      try {
        const raw = localStorage.getItem(LS_SAVED_LINKS_KEY);
        const map = raw && typeof JSON.parse(raw) === "object" ? JSON.parse(raw) : {};
        map[uid] = (links || []).filter(Boolean);
        localStorage.setItem(LS_SAVED_LINKS_KEY, JSON.stringify(map));
      } catch (_) {}
    }

    async function ensureAuthForFirestore() {
      if (typeof firebase === "undefined" || !firebaseDb) return null;
      const user = firebase.auth().currentUser;
      if (!user || user.isAnonymous) return null;
      try {
        await user.getIdToken();
      } catch (_) {}
      return user;
    }

    function normalizeUrlKeyForClicks(u) {
      if (
        typeof window.ProxyListPresence !== "undefined" &&
        typeof window.ProxyListPresence.normalizeClickUrl === "function"
      ) {
        return window.ProxyListPresence.normalizeClickUrl(u);
      }
      let url = String(u || "").trim();
      if (!url) return "";
      if (!/^https?:\/\//i.test(url)) url = "https://" + url;
      try {
        const parsed = new URL(url);
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "";
        let out = parsed.href;
        if (out.endsWith("/") && (out.match(/\//g) || []).length > 3) out = out.replace(/\/+$/, "");
        return out.slice(0, 2048);
      } catch (_) {
        return "";
      }
    }

    function legacyNormalizeUrlKey(u) {
      if (
        typeof window.ProxyListPresence !== "undefined" &&
        typeof window.ProxyListPresence.legacyNormalizeClickUrl === "function"
      ) {
        return window.ProxyListPresence.legacyNormalizeClickUrl(u);
      }
      return String(u || "")
        .trim()
        .replace(/\/+$/, "")
        .toLowerCase();
    }

    function urlKeyVariants(u) {
      if (
        typeof window.ProxyListPresence !== "undefined" &&
        typeof window.ProxyListPresence.clickUrlVariants === "function"
      ) {
        return window.ProxyListPresence.clickUrlVariants(u);
      }
      const modern = normalizeUrlKeyForClicks(u);
      const legacy = legacyNormalizeUrlKey(u);
      const out = [];
      if (modern) out.push(modern);
      if (legacy && legacy !== modern) out.push(legacy);
      return out;
    }

    function clicksAreSharedGlobally() {
      if (typeof window.ProxyListPresence !== "undefined" && window.ProxyListPresence.apiUrl) {
        return true;
      }
      return !!firebaseDb;
    }

    function localClickGet(norm) {
      try {
        const raw = localStorage.getItem(LS_CLICK_KEY);
        if (!raw) return 0;
        const o = JSON.parse(raw);
        return Number(o[norm]) || 0;
      } catch (_) {
        return 0;
      }
    }

    function localClickInc(norm) {
      try {
        const raw = localStorage.getItem(LS_CLICK_KEY);
        const o = raw ? JSON.parse(raw) : {};
        o[norm] = (Number(o[norm]) || 0) + 1;
        localStorage.setItem(LS_CLICK_KEY, JSON.stringify(o));
        return o[norm];
      } catch (_) {
        return 0;
      }
    }

    async function sha256Hex(text) {
      const buf = new TextEncoder().encode(text);
      const hash = await crypto.subtle.digest("SHA-256", buf);
      return Array.from(new Uint8Array(hash))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
    }

    function persistLinkListSortMode(mode) {
      if (!isLinkListSortMode(mode)) return;
      listSortMode = mode;
      try {
        localStorage.setItem(LS_LINK_LIST_SORT_KEY, mode);
      } catch (_) {}
      scheduleUserProfileWrite();
    }

    function linkNetScoreFromHash(hash) {
      if (!hash) return 0;
      const o = linkRatingAggByHash.get(hash);
      if (!o) return 0;
      return (Number(o.up) || 0) - (Number(o.down) || 0);
    }

    function linkSaveCountFromHash(hash) {
      if (!hash) return 0;
      const v = linkSaveCountByHash.get(hash);
      return Number(v) || 0;
    }

    function foundDateMs(row) {
      if (row && Number.isFinite(row._foundMs)) return row._foundMs;
      const m = String((row && row.found) || "")
        .trim()
        .match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
      const ms = m ? Date.UTC(Number(m[3]), Number(m[1]) - 1, Number(m[2])) : 0;
      if (row) row._foundMs = ms;
      return ms;
    }

    function sortFilteredRowsByListSort(filteredRows) {
      if (!filteredRows || !filteredRows.length) return filteredRows;
      if (listSortMode === LINK_SORT_DEFAULT) return filteredRows;
      if (listSortMode === LINK_SORT_FOUND_DESC) {
        return filteredRows.slice().sort((a, b) => {
          const sa = foundDateMs(a);
          const sb = foundDateMs(b);
          if (sa !== sb) {
            if (!sa) return 1;
            if (!sb) return -1;
            return sb - sa;
          }
          const pa = String((a && a.provider) || "").localeCompare(String((b && b.provider) || ""), undefined, {
            sensitivity: "base",
          });
          if (pa !== 0) return pa;
          return String((a && a.link) || "").localeCompare(String((b && b.link) || ""));
        });
      }
      if (listSortMode === LINK_SORT_SAVED_DESC) {
        return filteredRows.slice().sort((a, b) => {
          const na = normalizeUrlKeyForClicks(a && a.link);
          const nb = normalizeUrlKeyForClicks(b && b.link);
          const ha = na ? normToHashCache.get(na) : "";
          const hb = nb ? normToHashCache.get(nb) : "";
          const sa = linkSaveCountFromHash(ha);
          const sb = linkSaveCountFromHash(hb);
          const diff = sb - sa;
          if (diff !== 0) return diff;
          const pa = String((a && a.provider) || "").localeCompare(String((b && b.provider) || ""), undefined, {
            sensitivity: "base",
          });
          if (pa !== 0) return pa;
          return String((a && a.link) || "").localeCompare(String((b && b.link) || ""));
        });
      }
      const desc = listSortMode === LINK_SORT_RATING_DESC;
      return filteredRows.slice().sort((a, b) => {
        const na = normalizeUrlKeyForClicks(a && a.link);
        const nb = normalizeUrlKeyForClicks(b && b.link);
        const ha = na ? normToHashCache.get(na) : "";
        const hb = nb ? normToHashCache.get(nb) : "";
        const sa = linkNetScoreFromHash(ha);
        const sb = linkNetScoreFromHash(hb);
        const diff = sa - sb;
        if (diff !== 0) return desc ? -diff : diff;
        const pa = String((a && a.provider) || "").localeCompare(String((b && b.provider) || ""), undefined, {
          sensitivity: "base",
        });
        if (pa !== 0) return pa;
        return String((a && a.link) || "").localeCompare(String((b && b.link) || ""));
      });
    }

    function linkSortNeedsFullFirestoreForLinks() {
      return (
        listSortMode === LINK_SORT_RATING_DESC ||
        listSortMode === LINK_SORT_RATING_ASC ||
        listSortMode === LINK_SORT_SAVED_DESC
      );
    }

    // v2: do not hydrate 0/0 from disk (v1 poisoned maps after Worker failures and skipped Firestore).
    const LS_LINK_RATING_AGG_DISK = "proxyList_linkRatingAggDisk_v2";
    const LS_LINK_SAVE_COUNT_DISK = "proxyList_linkSaveCountDisk_v1";
    const LS_DISK_CACHE_MAX_CHARS = 750000;

    function isStorageQuotaError(err) {
      return !!(
        err &&
        (err.name === "QuotaExceededError" ||
          err.code === 22 ||
          err.code === 1014 ||
          /quota/i.test(String(err.message || "")))
      );
    }

    function evictLocalStorageDiskCaches() {
      [
        LS_CLICK_COUNT_DISK,
        "proxyList_clickCountDisk_v1",
        LS_LINK_RATING_AGG_DISK,
        "proxyList_linkRatingAggDisk_v1",
        LS_LINK_SAVE_COUNT_DISK,
        "proxyList_topOpensDisk_v1",
        "proxyList_topOpensDisk_v2",
        "proxyList_stats_topOpens_v1",
      ].forEach((k) => {
        try {
          localStorage.removeItem(k);
        } catch (_) {}
      });
    }

    function stringifyWithinCharLimit(obj, maxChars, dropKeys) {
      let s = JSON.stringify(obj);
      if (s.length <= maxChars) return s;
      const slim = { ...obj };
      (dropKeys || []).forEach((k) => {
        if (k in slim) slim[k] = {};
      });
      s = JSON.stringify(slim);
      if (s.length <= maxChars) return s;
      const mapKey =
        slim.byNorm && typeof slim.byNorm === "object"
          ? "byNorm"
          : slim.byHash && typeof slim.byHash === "object"
            ? "byHash"
            : "";
      if (!mapKey) return "";
      const keys = Object.keys(slim[mapKey]);
      let lo = 0;
      let hi = keys.length;
      let best = "";
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const subset = {};
        for (let i = 0; i < mid; i++) subset[keys[i]] = slim[mapKey][keys[i]];
        const candidate = JSON.stringify(Object.assign({}, slim, { [mapKey]: subset }));
        if (candidate.length <= maxChars) {
          best = candidate;
          lo = mid + 1;
        } else {
          hi = mid - 1;
        }
      }
      return best;
    }

    function writeLocalStorageDisk(key, str) {
      if (!str) return;
      try {
        localStorage.setItem(key, str);
      } catch (err) {
        if (!isStorageQuotaError(err)) return;
        evictLocalStorageDiskCaches();
        try {
          localStorage.setItem(key, str);
        } catch (_) {}
      }
    }
    /** Reuse aggregates across reloads until the list version changes or this TTL passes (saves Spark read quota). */
    const LINK_AGG_DISK_CACHE_MAX_MS = 48 * 60 * 60 * 1000;

    function readJsonLocalDisk(key) {
      try {
        const raw = localStorage.getItem(key);
        if (!raw) return null;
        return JSON.parse(raw);
      } catch (_) {
        return null;
      }
    }

    /**
     * Hashes whose linkRatings doc was actually read (Firestore or Worker batch OK) → ms timestamp.
     * Unrated links are ~all rows; without this every chunk / scroll window / reload re-read them.
     */
    const linkRatingConfirmedAt = new Map();
    /** Re-read a confirmed rating (incl. "no doc") at most this often per browser. */
    const LINK_RATING_REVALIDATE_MS = 30 * 60 * 1000;
    /** Confirmed-empty ratings persist on disk this long (keyed by 16-char hash prefix). */
    const LINK_RATING_ZERO_DISK_MS = 12 * 60 * 60 * 1000;

    function markLinkRatingConfirmed(hash, at) {
      if (hash) linkRatingConfirmedAt.set(hash, Number.isFinite(at) ? at : Date.now());
    }

    function linkRatingRecentlyConfirmed(hash) {
      const at = linkRatingConfirmedAt.get(hash);
      return Number.isFinite(at) && Date.now() - at < LINK_RATING_REVALIDATE_MS;
    }

    function hydrateLinkRatingAggFromDiskCache(stamp, hashes) {
      if (!stamp || !hashes || !hashes.length) return;
      const o = readJsonLocalDisk(LS_LINK_RATING_AGG_DISK);
      if (!o || o.stamp !== stamp || typeof o.savedAt !== "number") return;
      if (Date.now() - o.savedAt > LINK_AGG_DISK_CACHE_MAX_MS) return;
      const byHash = o.byHash;
      if (!byHash || typeof byHash !== "object") return;
      const zeros = o.zeros && typeof o.zeros === "object" ? o.zeros : null;
      const nowMin = Math.floor(Date.now() / 60000);
      for (const h of hashes) {
        if (linkRatingAggByHash.has(h)) continue;
        const row = byHash[h];
        if (row && typeof row === "object") {
          const up = Number(row.u);
          const down = Number(row.d);
          if (Number.isFinite(up) && Number.isFinite(down) && (up > 0 || down > 0)) {
            linkRatingAggByHash.set(h, { up, down });
            continue;
          }
        }
        // Only zeros confirmed by a live read are stored here (never Worker-failure fill-ins).
        const zMin = zeros ? Number(zeros[h.slice(0, 16)]) : NaN;
        if (Number.isFinite(zMin) && (nowMin - zMin) * 60000 < LINK_RATING_ZERO_DISK_MS) {
          linkRatingAggByHash.set(h, { up: 0, down: 0 });
          markLinkRatingConfirmed(h, zMin * 60000);
        }
      }
    }

    /** When Firestore reads are paused, reuse the last cached rating aggregates by hash. */
    function hydrateLinkRatingAggFromDiskCacheRelaxed(hashes) {
      if (!hashes || !hashes.length) return;
      const o = readJsonLocalDisk(LS_LINK_RATING_AGG_DISK);
      if (!o || !o.byHash || typeof o.byHash !== "object") return;
      if (typeof o.savedAt === "number" && Date.now() - o.savedAt > LINK_AGG_DISK_CACHE_MAX_MS) return;
      for (const h of hashes) {
        if (linkRatingAggByHash.has(h)) continue;
        const row = o.byHash[h];
        if (!row || typeof row !== "object") continue;
        const up = Number(row.u);
        const down = Number(row.d);
        if (!Number.isFinite(up) || !Number.isFinite(down)) continue;
        if (up > 0 || down > 0) linkRatingAggByHash.set(h, { up, down });
      }
    }

    /** norm → ms of the last successful Worker count fetch (session + disk `t` map, minutes). */
    const clickCountFetchedAt = new Map();
    /** Open counts are cosmetic; re-ask the Worker for the same URL at most this often. */
    const CLICK_COUNT_REVALIDATE_MS = 15 * 60 * 1000;

    function clickCountRecentlyFetched(norm) {
      const at = clickCountFetchedAt.get(norm);
      return Number.isFinite(at) && Date.now() - at < CLICK_COUNT_REVALIDATE_MS;
    }

    function hydrateClickCountDiskCache(stamp, norms) {
      if (!stamp || !norms || !norms.length) return;
      const o = readJsonLocalDisk(LS_CLICK_COUNT_DISK);
      if (!o || o.stamp !== stamp || typeof o.savedAt !== "number") return;
      if (Date.now() - o.savedAt > LINK_AGG_DISK_CACHE_MAX_MS) return;
      const byNorm = o.byNorm;
      if (!byNorm || typeof byNorm !== "object") return;
      const fetchedMin = o.t && typeof o.t === "object" ? o.t : null;
      for (const n of norms) {
        const c = Number(byNorm[n]);
        if (!Number.isFinite(c) || c < 0) continue;
        const prev = clickCountCache.has(n) ? clickCountCache.get(n) : 0;
        clickCountCache.set(n, Math.max(Number(prev) || 0, c));
        const m = fetchedMin ? Number(fetchedMin[n]) : NaN;
        if (Number.isFinite(m) && !clickCountFetchedAt.has(n)) clickCountFetchedAt.set(n, m * 60000);
      }
    }

    function hydrateClickCountDiskCacheRelaxed(norms) {
      if (!norms || !norms.length) return;
      const o = readJsonLocalDisk(LS_CLICK_COUNT_DISK);
      if (!o || !o.byNorm || typeof o.byNorm !== "object") return;
      if (typeof o.savedAt === "number" && Date.now() - o.savedAt > LINK_AGG_DISK_CACHE_MAX_MS) return;
      for (const n of norms) {
        const c = Number(o.byNorm[n]);
        if (!Number.isFinite(c) || c < 0) continue;
        const prev = clickCountCache.has(n) ? clickCountCache.get(n) : 0;
        clickCountCache.set(n, Math.max(Number(prev) || 0, c));
      }
    }

    function persistClickCountDiskCache(stamp, norms) {
      if (!stamp || !norms || !norms.length) return;
      try {
        const prev = readJsonLocalDisk(LS_CLICK_COUNT_DISK);
        const sameStamp = prev && prev.stamp === stamp;
        const byNorm =
          sameStamp && prev.byNorm && typeof prev.byNorm === "object"
            ? { ...prev.byNorm }
            : {};
        const t = sameStamp && prev.t && typeof prev.t === "object" ? { ...prev.t } : {};
        for (const n of norms) {
          const c = clickCountCache.get(n);
          if (!Number.isFinite(c) || c < 0) continue;
          // Overwrite for norms we just refreshed — do not ratchet upward forever.
          byNorm[n] = c;
          const at = clickCountFetchedAt.get(n);
          if (Number.isFinite(at)) t[n] = Math.floor(at / 60000);
        }
        const s = stringifyWithinCharLimit(
          { stamp, savedAt: Date.now(), byNorm, t },
          LS_DISK_CACHE_MAX_CHARS,
          ["t"]
        );
        writeLocalStorageDisk(LS_CLICK_COUNT_DISK, s);
      } catch (_) {}
    }

    function hydrateLinkSaveCountFromDiskCache(stamp, hashes) {
      if (!stamp || !hashes || !hashes.length) return;
      const o = readJsonLocalDisk(LS_LINK_SAVE_COUNT_DISK);
      if (!o || o.stamp !== stamp || typeof o.savedAt !== "number") return;
      if (Date.now() - o.savedAt > LINK_AGG_DISK_CACHE_MAX_MS) return;
      const byHash = o.byHash;
      if (!byHash || typeof byHash !== "object") return;
      for (const h of hashes) {
        if (linkSaveCountByHash.has(h)) continue;
        const c = Number(byHash[h]);
        if (!Number.isFinite(c)) continue;
        linkSaveCountByHash.set(h, c);
      }
    }

    function persistLinkRatingAggDiskCache(stamp, hashes) {
      if (!stamp || !hashes || !hashes.length) return;
      try {
        const prev = readJsonLocalDisk(LS_LINK_RATING_AGG_DISK);
        const sameStamp = prev && prev.stamp === stamp;
        const byHash =
          sameStamp && prev.byHash && typeof prev.byHash === "object" ? { ...prev.byHash } : {};
        const zeros = sameStamp && prev.zeros && typeof prev.zeros === "object" ? { ...prev.zeros } : {};
        for (const h of hashes) {
          const ag = linkRatingAggByHash.get(h);
          if (!ag) continue;
          const up = Number(ag.up) || 0;
          const down = Number(ag.down) || 0;
          if (up > 0 || down > 0) {
            byHash[h] = { u: up, d: down };
            delete zeros[h.slice(0, 16)];
          } else {
            delete byHash[h];
            const at = linkRatingConfirmedAt.get(h);
            if (Number.isFinite(at)) zeros[h.slice(0, 16)] = Math.floor(at / 60000);
          }
        }
        const s = stringifyWithinCharLimit(
          { stamp, savedAt: Date.now(), byHash, zeros },
          LS_DISK_CACHE_MAX_CHARS,
          ["zeros"]
        );
        writeLocalStorageDisk(LS_LINK_RATING_AGG_DISK, s);
      } catch (_) {}
    }

    function persistLinkSaveCountDiskCache(stamp, hashes) {
      if (!stamp || !hashes || !hashes.length) return;
      try {
        const prev = readJsonLocalDisk(LS_LINK_SAVE_COUNT_DISK);
        const byHash =
          prev && prev.stamp === stamp && prev.byHash && typeof prev.byHash === "object" ? { ...prev.byHash } : {};
        for (const h of hashes) {
          if (!linkSaveCountByHash.has(h)) continue;
          byHash[h] = Number(linkSaveCountByHash.get(h)) || 0;
        }
        const s = stringifyWithinCharLimit(
          { stamp, savedAt: Date.now(), byHash },
          LS_DISK_CACHE_MAX_CHARS
        );
        writeLocalStorageDisk(LS_LINK_SAVE_COUNT_DISK, s);
      } catch (_) {}
    }

    function patchLinkRatingAggDiskCacheOne(hash, up, down) {
      const stamp = currentListVersionStamp;
      if (!stamp || !hash) return;
      try {
        const o = readJsonLocalDisk(LS_LINK_RATING_AGG_DISK);
        if (!o || o.stamp !== stamp || typeof o.byHash !== "object") return;
        o.byHash[hash] = { u: Number(up) || 0, d: Number(down) || 0 };
        o.savedAt = Date.now();
        const s = stringifyWithinCharLimit(o, LS_DISK_CACHE_MAX_CHARS, ["zeros"]);
        writeLocalStorageDisk(LS_LINK_RATING_AGG_DISK, s);
      } catch (_) {}
    }

    function patchLinkSaveCountDiskCacheOne(hash, count) {
      const stamp = currentListVersionStamp;
      if (!stamp || !hash) return;
      try {
        const o = readJsonLocalDisk(LS_LINK_SAVE_COUNT_DISK);
        if (!o || o.stamp !== stamp || typeof o.byHash !== "object") return;
        o.byHash[hash] = Math.max(0, Number(count) || 0);
        o.savedAt = Date.now();
        const s = stringifyWithinCharLimit(o, LS_DISK_CACHE_MAX_CHARS);
        writeLocalStorageDisk(LS_LINK_SAVE_COUNT_DISK, s);
      } catch (_) {}
    }

    /**
     * Batched Firestore document reads. Keep concurrency modest: hundreds of parallel .get()
     * calls trigger 429 / resource-exhausted on small Firebase plans and break writes (ratings).
     */
    const FS_DOC_READ_CHUNK = 25;
    const FS_DOC_READ_LANES = 1;
    const FS_DOC_READ_WAVE_GAP_MS = 40;
    /** After a quota trip, skip bulk rating/save prefetches so likes/writes can recover. */
    let firestoreReadCooldownUntil = 0;
    let importantNoticesStaticHtml = "";
    let firebaseQuotaExceededVisible = false;
    let firebaseQuotaRecoveryTimer = null;
    const LS_FIREBASE_QUOTA_UNTIL = "proxyList_firebaseQuotaUntil_v1";

    function isFirestoreReadCooled() {
      return Date.now() < firestoreReadCooldownUntil;
    }

    function readPersistedFirebaseQuotaUntil() {
      try {
        const n = Number(sessionStorage.getItem(LS_FIREBASE_QUOTA_UNTIL) || 0);
        return Number.isFinite(n) && n > 0 ? n : 0;
      } catch (_) {
        return 0;
      }
    }

    function persistFirebaseQuotaUntil(until) {
      try {
        if (until > Date.now()) sessionStorage.setItem(LS_FIREBASE_QUOTA_UNTIL, String(until));
        else sessionStorage.removeItem(LS_FIREBASE_QUOTA_UNTIL);
      } catch (_) {}
    }

    function refreshImportantNoticesDom() {
      const el = $("importantNotices");
      if (!el) return;
      if (!importantNoticesStaticHtml) {
        setHtml(el, "");
        el.hidden = true;
        return;
      }
      setHtml(el, importantNoticesStaticHtml);
      el.hidden = false;
    }

    function syncFirebaseQuotaBanner() {
      const banner = $("firebaseQuotaBanner");
      if (!banner) return;
      banner.hidden = !firebaseQuotaExceededVisible;
      if (firebaseQuotaExceededVisible) {
        try {
          banner.scrollIntoView({ block: "nearest", behavior: "smooth" });
        } catch (_) {}
      }
    }

    function scheduleFirebaseQuotaRecoveryCheck() {
      if (firebaseQuotaRecoveryTimer) {
        clearTimeout(firebaseQuotaRecoveryTimer);
        firebaseQuotaRecoveryTimer = null;
      }
      if (!firebaseQuotaExceededVisible) return;
      const wait = Math.max(2500, firestoreReadCooldownUntil - Date.now() + 500);
      firebaseQuotaRecoveryTimer = setTimeout(function () {
        firebaseQuotaRecoveryTimer = null;
        void tryClearFirebaseQuotaAnnouncement();
      }, wait);
    }

    async function tryClearFirebaseQuotaAnnouncement() {
      if (!firebaseQuotaExceededVisible) return;
      if (isFirestoreReadCooled()) {
        scheduleFirebaseQuotaRecoveryCheck();
        return;
      }
      markFirestoreQuotaRecovered();
    }

    function markFirestoreQuotaRecovered() {
      firestoreReadCooldownUntil = 0;
      persistFirebaseQuotaUntil(0);
      if (!firebaseQuotaExceededVisible) return;
      firebaseQuotaExceededVisible = false;
      if (firebaseQuotaRecoveryTimer) {
        clearTimeout(firebaseQuotaRecoveryTimer);
        firebaseQuotaRecoveryTimer = null;
      }
      syncFirebaseQuotaBanner();
    }

    function tripFirestoreReadCooldown(ms) {
      const wait = Number(ms) > 0 ? Number(ms) : 3 * 60 * 1000;
      firestoreReadCooldownUntil = Math.max(firestoreReadCooldownUntil, Date.now() + wait);
      persistFirebaseQuotaUntil(firestoreReadCooldownUntil);
      firebaseQuotaExceededVisible = true;
      syncFirebaseQuotaBanner();
      scheduleFirebaseQuotaRecoveryCheck();
    }

    function restoreFirebaseQuotaBannerFromSession() {
      const until = readPersistedFirebaseQuotaUntil();
      if (until > Date.now()) {
        firestoreReadCooldownUntil = Math.max(firestoreReadCooldownUntil, until);
        firebaseQuotaExceededVisible = true;
        syncFirebaseQuotaBanner();
        scheduleFirebaseQuotaRecoveryCheck();
      } else if (until) {
        persistFirebaseQuotaUntil(0);
      }
    }

    function sleepMs(ms) {
      return new Promise((resolve) => setTimeout(resolve, ms));
    }

    async function parallelFirestoreDocGets(collectionName, docIds, onEach) {
      const ids = docIds.filter(Boolean);
      if (!ids.length) return;
      if (isFirestoreReadCooled()) return;
      const wave = FS_DOC_READ_CHUNK * FS_DOC_READ_LANES;
      for (let base = 0; base < ids.length; base += wave) {
        if (isFirestoreReadCooled()) return;
        if (base > 0 && FS_DOC_READ_WAVE_GAP_MS > 0) {
          await sleepMs(FS_DOC_READ_WAVE_GAP_MS);
        }
        const parts = [];
        for (let lane = 0; lane < FS_DOC_READ_LANES; lane++) {
          const lo = base + lane * FS_DOC_READ_CHUNK;
          if (lo >= ids.length) break;
          parts.push(ids.slice(lo, Math.min(lo + FS_DOC_READ_CHUNK, ids.length)));
        }
        try {
          await Promise.all(
            parts.map((part) =>
              Promise.all(part.map((id) => firebaseDb.collection(collectionName).doc(id).get())).then((snaps) => {
                snaps.forEach((snap, j) => onEach(part[j], snap));
              })
            )
          );
          if (firebaseQuotaExceededVisible) markFirestoreQuotaRecovered();
        } catch (err) {
          if (isFirestoreResourceExhausted(err)) {
            tripFirestoreReadCooldown(3 * 60 * 1000);
          }
          throw err;
        }
      }
    }

    async function fetchLinkRatingsViaWorker(rawNorms, stamp) {
      const sharedApiAvailable =
        typeof window.ProxyListPresence !== "undefined" &&
        typeof window.ProxyListPresence.apiUrl === "function";
      if (!sharedApiAvailable || !rawNorms.length) return { fetchedAny: false, via: "" };
      // Keep batches small: Worker Cache API + Firestore batchGet hit subrequest limits around ~50.
      const WORKER_RATING_BATCH = 25;
      let fetchedAny = false;
      let via = "";
      for (let offset = 0; offset < rawNorms.length; offset += WORKER_RATING_BATCH) {
        const batch = rawNorms.slice(offset, offset + WORKER_RATING_BATCH);
        try {
          const headers = { "Content-Type": "application/json" };
          try {
            const u = firebase.auth && firebase.auth().currentUser;
            if (u && !u.isAnonymous) {
              const tok = await u.getIdToken();
              if (tok) headers.Authorization = "Bearer " + tok;
            }
          } catch (_) {}
          const res = await fetch(window.ProxyListPresence.apiUrl("/api/link-ratings/get"), {
            method: "POST",
            headers,
            body: JSON.stringify({ urls: batch }),
            mode: "cors",
          });
          if (!res.ok) continue;
          const data = await res.json();
          if (!(data && data.ok && data.ratings && typeof data.ratings === "object")) continue;
          const workerVia = String(data.via || "");
          const ratingKeys = Object.keys(data.ratings);
          // Empty object usually means Worker Firebase read failed (quota/token) — don't treat as success.
          // D1 always returns a key per URL (including confirmed 0/0).
          if (!ratingKeys.length && workerVia !== "d1") continue;
          fetchedAny = true;
          if (workerVia) via = workerVia;
          if (data.self && typeof data.self === "object") {
            for (const [selfNorm, voteRaw] of Object.entries(data.self)) {
              const vote = Number(voteRaw) || 0;
              let h = normToHashCache.get(selfNorm);
              if (!h) {
                h = await sha256Hex(selfNorm);
                normToHashCache.set(selfNorm, h);
                hashToNormMap.set(h, selfNorm);
              }
              linkRatingSelfByHash.set(h, vote);
            }
          }
          for (const n of batch) {
            const workerKey = normalizeUrlKeyForClicks(n);
            let best = null;
            for (const v of urlKeyVariants(n)) {
              const k = normalizeUrlKeyForClicks(v);
              const r =
                data.ratings[k] != null
                  ? data.ratings[k]
                  : data.ratings[v] != null
                    ? data.ratings[v]
                    : null;
              if (!r || typeof r !== "object") continue;
              const ag = { up: Number(r.up) || 0, down: Number(r.down) || 0 };
              if (!best || ag.up > best.up || ag.down > best.down) best = ag;
            }
            if (!best && data.ratings[workerKey]) {
              const r = data.ratings[workerKey];
              best = { up: Number(r.up) || 0, down: Number(r.down) || 0 };
            }
            if (!best) {
              if (workerVia === "d1") best = { up: 0, down: 0 };
              else continue;
            }
            let primaryHash = normToHashCache.get(n);
            if (!primaryHash) {
              primaryHash = await sha256Hex(n);
              normToHashCache.set(n, primaryHash);
              hashToNormMap.set(primaryHash, n);
            }
            const prev = linkRatingAggByHash.get(primaryHash);
            if (!prev || best.up > prev.up || best.down > prev.down) {
              linkRatingAggByHash.set(primaryHash, best);
            }
            // Worker batchGets every URL variant, so a returned key confirms all of them.
            markLinkRatingConfirmed(primaryHash);
            for (const v of urlKeyVariants(n)) {
              const vh = normToHashCache.get(v);
              if (!vh) continue;
              markLinkRatingConfirmed(vh);
              if (!linkRatingAggByHash.has(vh)) linkRatingAggByHash.set(vh, best);
            }
          }
        } catch (_) {
          /* Worker ratings unavailable */
        }
      }
      if (fetchedAny && stamp) {
        const hashes = [];
        for (const n of rawNorms) {
          const h = normToHashCache.get(n);
          if (h) hashes.push(h);
        }
        persistLinkRatingAggDiskCache(stamp, hashes);
      }
      return { fetchedAny, via };
    }

    async function prefetchLinkRatingsForNorms(normsList, opts) {
      const rawNorms = [...new Set((normsList || []).map((n) => String(n || "").trim()).filter(Boolean))];
      if (!rawNorms.length) return;

      const stamp = ((opts && opts.listVersionStamp) || currentListVersionStamp || "").trim();

      try {
        const normToHashList = new Map();
        const modernHashes = [];
        const allHashSet = new Set();
        for (const n of rawNorms) {
          const variants = urlKeyVariants(n);
          const hashList = [];
          for (let vi = 0; vi < variants.length; vi++) {
            const v = variants[vi];
            let h = normToHashCache.get(v);
            if (!h) {
              h = await sha256Hex(v);
              normToHashCache.set(v, h);
              hashToNormMap.set(h, v);
            }
            hashList.push(h);
            allHashSet.add(h);
            if (vi === 0) modernHashes.push(h);
          }
          normToHashList.set(n, [...new Set(hashList)]);
        }
        const hashes = [...allHashSet];

        hydrateLinkRatingAggFromDiskCache(stamp, hashes);
        hydrateLinkRatingAggFromDiskCacheRelaxed(hashes);
        if (!opts || !opts.skipLinkSaveCounts) hydrateLinkSaveCountFromDiskCache(stamp, hashes);

        const hashNeedsFetch = (h) => {
          if (linkRatingRecentlyConfirmed(h)) return false;
          const ag = linkRatingAggByHash.get(h);
          if (!ag) return true;
          // Unconfirmed 0/0 may be a Worker-failure fill-in — revalidate those.
          return (Number(ag.up) || 0) === 0 && (Number(ag.down) || 0) === 0;
        };
        const normsNeedingFetch = rawNorms.filter((n) => (normToHashList.get(n) || []).some(hashNeedsFetch));

        // Clicks/ratings live on the Worker D1 store. Do not .get() linkRatings or
        // linkRatingVotes — those per-row reads were the bulk of Spark quota.
        if (normsNeedingFetch.length) {
          try {
            await fetchLinkRatingsViaWorker(normsNeedingFetch, stamp);
          } catch (_) {}
        }

        hashes.forEach((h) => {
          if (!linkRatingAggByHash.has(h)) linkRatingAggByHash.set(h, { up: 0, down: 0 });
          markLinkRatingConfirmed(h);
        });

        for (const n of rawNorms) {
          const list = normToHashList.get(n) || [];
          let best = null;
          for (const h of list) {
            const ag = linkRatingAggByHash.get(h);
            if (!ag) continue;
            if (!best || ag.up > best.up || ag.down > best.down) best = ag;
          }
          const primary = list[0];
          if (best && primary) linkRatingAggByHash.set(primary, best);
        }

        const toFetchSave =
          opts && opts.skipLinkSaveCounts
            ? []
            : [...new Set(modernHashes)].filter((h) => !linkSaveCountByHash.has(h));
        if (toFetchSave.length && firebaseDb && !isFirestoreReadCooled()) {
          await parallelFirestoreDocGets("linkSaveCounts", toFetchSave, (h, snap) => {
            if (snap.exists) {
              const d = snap.data() || {};
              linkSaveCountByHash.set(h, Number(d.count) || 0);
            } else {
              linkSaveCountByHash.set(h, 0);
            }
          });
        }

        if (stamp) {
          persistLinkRatingAggDiskCache(stamp, hashes);
          if (!opts || !opts.skipLinkSaveCounts) persistLinkSaveCountDiskCache(stamp, hashes);
        }
      } catch (err) {
        if (isFirestorePermissionDenied(err)) {
          console.warn(
            "[proxy-list] Link save counts skipped: Firestore permission denied. Deploy the rules in docs/firestore.rules (linkSaveCounts) to the same Firebase project as this site.",
            err
          );
        } else if (isFirestoreResourceExhausted(err)) {
          tripFirestoreReadCooldown(3 * 60 * 1000);
          console.warn(
            "[proxy-list] Link save-count prefetch hit Firestore quota/rate limits; pausing bulk reads.",
            err
          );
        } else {
          console.warn("[proxy-list] Link ratings prefetch failed; trying Worker ratings API", err);
        }
        try {
          await fetchLinkRatingsViaWorker(rawNorms, stamp);
        } catch (_) {}
      }
    }

    function ratingAggForNorm(norm) {
      if (!norm) return null;
      const variants = urlKeyVariants(norm);
      let best = null;
      for (const v of variants) {
        const h = normToHashCache.get(v);
        if (!h) continue;
        const ag = linkRatingAggByHash.get(h);
        if (!ag) continue;
        if (!best || ag.up > best.up || ag.down > best.down) best = ag;
      }
      const primary = normToHashCache.get(norm) || normToHashCache.get(variants[0] || "");
      if (best && primary && !linkRatingAggByHash.has(primary)) {
        linkRatingAggByHash.set(primary, best);
      }
      return best;
    }

    function ratingCellInnerHtmlForLinkUrl(link) {
      const norm = normalizeUrlKeyForClicks(link);
      if (!norm) return "—";
      const agg = ratingAggForNorm(norm);
      const up = agg ? Number(agg.up) || 0 : 0;
      const down = agg ? Number(agg.down) || 0 : 0;
      const primaryHash = normToHashCache.get(norm) || "";
      const self = primaryHash ? linkRatingSelfByHash.get(primaryHash) || 0 : 0;
      const upOn = self === 1 ? " is-active" : "";
      const dnOn = self === -1 ? " is-active" : "";
      const net = up - down;
      const netStr = net > 0 ? "+" + net : String(net);
      const blocked = communityFeaturesBlocked;
      const dis = blocked ? " disabled aria-disabled=\"true\"" : "";
      const titleExtra = blocked ? " (suspended — ratings disabled)" : "";
      return (
        '<button type="button" class="rating-vote-btn' +
        upOn +
        '" data-link-rating-vote="1" data-link-rating-url="' +
        escapeAttr(link) +
        '" title="Thumbs up' +
        titleExtra +
        '" aria-label="Thumbs up"' +
        dis +
        '><img src="' +
        escapeAttr(RATING_THUMB_UP_IMG) +
        '" alt="" width="18" height="18" decoding="async" /></button>' +
        '<span class="rating-score" title="Net score (up minus down)">' +
        escapeHtml(netStr) +
        "</span>" +
        '<button type="button" class="rating-vote-btn' +
        dnOn +
        '" data-link-rating-vote="-1" data-link-rating-url="' +
        escapeAttr(link) +
        '" title="Thumbs down' +
        titleExtra +
        '" aria-label="Thumbs down"' +
        dis +
        '><img src="' +
        escapeAttr(RATING_THUMB_DOWN_IMG) +
        '" alt="" width="18" height="18" decoding="async" /></button>' +
        '<span class="sub rating-count-hint" title="Up / down counts">' +
        escapeHtml(String(up)) +
        "/" +
        escapeHtml(String(down)) +
        "</span>"
      );
    }

    function ratingCellTdHtml(link) {
      const norm = normalizeUrlKeyForClicks(link);
      const hash = norm ? normToHashCache.get(norm) || "" : "";
      return (
        '<td class="link-rating-cell"' +
        (hash ? ' data-rating-hash="' + escapeAttr(hash) + '"' : "") +
        ">" +
        ratingCellInnerHtmlForLinkUrl(link) +
        "</td>"
      );
    }

    async function applyLinkRatingVoteViaWorker(norm, nextVote, user) {
      const sharedApiAvailable =
        typeof window.ProxyListPresence !== "undefined" &&
        typeof window.ProxyListPresence.apiUrl === "function";
      if (!sharedApiAvailable) return { handled: false };
      let idToken = "";
      try {
        idToken = await user.getIdToken();
      } catch (_) {
        return { handled: false };
      }
      if (!idToken) return { handled: false };
      try {
        const res = await fetch(window.ProxyListPresence.apiUrl("/api/link-rating"), {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer " + idToken,
          },
          body: JSON.stringify({ url: norm, vote: nextVote }),
          mode: "cors",
        });
        if (res.status === 503) {
          const data = await res.json().catch(() => ({}));
          if (data && data.error === "d1_required") return { handled: false };
        }
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !(data && data.ok)) {
          return {
            handled: true,
            error: new Error((data && data.error) || "worker_rating_failed"),
          };
        }
        return {
          handled: true,
          hash: data.hash || (await sha256Hex(norm)),
          up: Number(data.up) || 0,
          down: Number(data.down) || 0,
          vote: data.vote === 0 ? 0 : Number(data.vote) || nextVote,
        };
      } catch (err) {
        return { handled: false, softError: err };
      }
    }

    async function applyLinkRatingVote(norm, nextVote) {
      const user = await ensureAuthForFirestore();
      if (!user || user.isAnonymous) {
        openSignInRequiredModal("You need to be signed in to rate links.");
        return;
      }
      if (!(await ensureCommunityFeaturesAllowed())) return;
      const hash = await sha256Hex(norm);
      normToHashCache.set(norm, hash);
      hashToNormMap.set(hash, norm);

      // Prefer Worker D1 when available (preview / cutover); Firebase Auth still identifies the voter.
      const viaWorker = await applyLinkRatingVoteViaWorker(norm, nextVote, user);
      if (viaWorker.handled && !viaWorker.error) {
        const h = viaWorker.hash || hash;
        linkRatingAggByHash.set(h, { up: viaWorker.up, down: viaWorker.down });
        linkRatingSelfByHash.set(h, viaWorker.vote === 0 ? 0 : viaWorker.vote);
        patchLinkRatingAggDiskCacheOne(h, viaWorker.up, viaWorker.down);
        repaintLinkRatingCellsForHash(h);
        return;
      }
      if (viaWorker.handled && viaWorker.error) {
        console.warn("[proxy-list] Link rating (Worker) failed", viaWorker.error);
        window.alert("Could not save that rating. Try again in a moment.");
        return;
      }

      if (!firebaseDb) {
        openSignInRequiredModal("You need to be signed in to rate links.");
        return;
      }
      const voteRef = firebaseDb.collection("linkRatingVotes").doc(user.uid + "_" + hash);
      const aggRef = firebaseDb.collection("linkRatings").doc(hash);
      let finalUp = 0;
      let finalDown = 0;
      const maxAttempts = 4;
      let lastErr = null;
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        try {
          await firebaseDb.runTransaction(async (tx) => {
            const voteSnap = await tx.get(voteRef);
            const aggSnap = await tx.get(aggRef);
            const old = voteSnap.exists ? Number(voteSnap.data().vote) || 0 : 0;
            let up = aggSnap.exists ? Number(aggSnap.data().up) || 0 : 0;
            let down = aggSnap.exists ? Number(aggSnap.data().down) || 0 : 0;
            if (old === 1) up = Math.max(0, up - 1);
            if (old === -1) down = Math.max(0, down - 1);
            if (nextVote === 1) up++;
            if (nextVote === -1) down++;
            if (nextVote === 0) {
              if (voteSnap.exists) tx.delete(voteRef);
            } else {
              tx.set(
                voteRef,
                {
                  uid: user.uid,
                  linkHash: hash,
                  norm,
                  vote: nextVote,
                  updated: firebase.firestore.FieldValue.serverTimestamp(),
                },
                { merge: true }
              );
            }
            if (nextVote !== 0 || old !== 0) {
              tx.set(
                aggRef,
                {
                  up,
                  down,
                  norm,
                  updated: firebase.firestore.FieldValue.serverTimestamp(),
                },
                { merge: true }
              );
            }
            finalUp = up;
            finalDown = down;
          });
          lastErr = null;
          break;
        } catch (err) {
          lastErr = err;
          if (isFirestoreResourceExhausted(err)) {
            tripFirestoreReadQuota(2 * 60 * 1000);
            if (attempt < maxAttempts - 1) {
              await sleepMs(700 * (attempt + 1));
              continue;
            }
          }
          break;
        }
      }
      if (lastErr) {
        console.warn("[proxy-list] Link rating failed", lastErr);
        window.alert("Could not save that rating. " + firestoreRatingFailureUserHint(lastErr));
        // Keep banner visible after dismissing the alert (trip already ran above).
        if (isFirestoreResourceExhausted(lastErr)) syncFirebaseQuotaBanner();
        return;
      }
      if (firebaseQuotaExceededVisible) markFirestoreQuotaRecovered();
      linkRatingAggByHash.set(hash, { up: finalUp, down: finalDown });
      linkRatingSelfByHash.set(hash, nextVote === 0 ? 0 : nextVote);
      patchLinkRatingAggDiskCacheOne(hash, finalUp, finalDown);
      repaintLinkRatingCellsForHash(hash);
    }

    function repaintLinkRatingCellsForHash(hash) {
      if (!hash) return;
      const sel = 'td.link-rating-cell[data-rating-hash="' + cssEscapeAttrValue(hash) + '"]';
      withStableLinkRows(() => {
        document.querySelectorAll(sel).forEach((td) => {
          const tr = td.closest("tr");
          const a = tr && tr.querySelector("a.js-link-summary[data-link]");
          const linkUrl = a ? a.getAttribute("data-link") : "";
          setHtml(td, ratingCellInnerHtmlForLinkUrl(linkUrl));
        });
      });
    }

    async function handleLinkRatingButtonClick(url, clickedVal) {
      const norm = normalizeUrlKeyForClicks(url);
      if (!norm) return;
      const user = await ensureAuthForFirestore();
      if (!user || user.isAnonymous) {
        openSignInRequiredModal("You need to be signed in to rate links.");
        return;
      }
      let hash = normToHashCache.get(norm);
      if (!hash) {
        hash = await sha256Hex(norm);
        normToHashCache.set(norm, hash);
        hashToNormMap.set(hash, norm);
      }
      const self = linkRatingSelfByHash.get(hash) || 0;
      const nextVote = self === clickedVal ? 0 : clickedVal;
      await applyLinkRatingVote(norm, nextVote);
    }

    let folderViewRatingAgg = { up: 0, down: 0 };
    let folderViewRatingSelf = 0;

    function folderRatingBarInnerHtml(folderId) {
      const up = folderViewRatingAgg.up || 0;
      const down = folderViewRatingAgg.down || 0;
      const self = folderViewRatingSelf || 0;
      const net = up - down;
      const netStr = net > 0 ? "+" + net : String(net);
      const upOn = self === 1 ? " is-active" : "";
      const dnOn = self === -1 ? " is-active" : "";
      const blocked = communityFeaturesBlocked;
      const dis = blocked ? " disabled aria-disabled=\"true\"" : "";
      const titleExtra = blocked ? " (suspended — ratings disabled)" : "";
      return (
        '<span class="folder-rating-inline">' +
        '<button type="button" class="rating-vote-btn' +
        upOn +
        '" data-folder-rating-vote="1" data-folder-rating-id="' +
        escapeAttr(folderId) +
        '" title="Thumbs up this folder' +
        titleExtra +
        '" aria-label="Thumbs up folder"' +
        dis +
        '><img src="' +
        escapeAttr(RATING_THUMB_UP_IMG) +
        '" alt="" width="18" height="18" decoding="async" /></button>' +
        '<span class="rating-score" title="Net score">' +
        escapeHtml(netStr) +
        "</span>" +
        '<button type="button" class="rating-vote-btn' +
        dnOn +
        '" data-folder-rating-vote="-1" data-folder-rating-id="' +
        escapeAttr(folderId) +
        '" title="Thumbs down' +
        titleExtra +
        '" aria-label="Thumbs down folder"' +
        dis +
        '><img src="' +
        escapeAttr(RATING_THUMB_DOWN_IMG) +
        '" alt="" width="18" height="18" decoding="async" /></button>' +
        '<span class="sub rating-count-hint">' +
        escapeHtml(String(up)) +
        "/" +
        escapeHtml(String(down)) +
        "</span></span>"
      );
    }

    async function refreshFolderRatingMount(folderId) {
      const mount = $("folderRatingMount");
      if (!mount || !folderId || !firebaseDb) return;
      setHtml(mount, '<span class="sub">…</span>');
      try {
        const aggSnap = await firebaseDb.collection("folderRatings").doc(folderId).get();
        if (aggSnap.exists) {
          const d = aggSnap.data() || {};
          folderViewRatingAgg = { up: Number(d.up) || 0, down: Number(d.down) || 0 };
        } else {
          folderViewRatingAgg = { up: 0, down: 0 };
        }
        const user = firebase.auth().currentUser;
        folderViewRatingSelf = 0;
        if (user && !user.isAnonymous) {
          const vSnap = await firebaseDb.collection("folderRatingVotes").doc(user.uid + "_" + folderId).get();
          if (vSnap.exists) {
            const v = Number(vSnap.data().vote);
            folderViewRatingSelf = v === 1 ? 1 : v === -1 ? -1 : 0;
          }
        }
        setHtml(mount, folderRatingBarInnerHtml(folderId));
      } catch (err) {
        console.warn("[proxy-list] Folder rating load failed", err);
        setHtml(mount, '<span class="sub">—</span>');
      }
    }

    async function applyFolderRatingVote(folderId, nextVote) {
      const id = sanitizeFolderDocId(folderId);
      if (!id || !firebaseDb) return;
      const user = await ensureAuthForFirestore();
      if (!user || user.isAnonymous) {
        openSignInRequiredModal("You need to be signed in to rate folders.");
        return;
      }
      if (!(await ensureCommunityFeaturesAllowed())) return;
      const voteRef = firebaseDb.collection("folderRatingVotes").doc(user.uid + "_" + id);
      const aggRef = firebaseDb.collection("folderRatings").doc(id);
      let finalUp = 0;
      let finalDown = 0;
      try {
        await firebaseDb.runTransaction(async (tx) => {
          const voteSnap = await tx.get(voteRef);
          const aggSnap = await tx.get(aggRef);
          const old = voteSnap.exists ? Number(voteSnap.data().vote) || 0 : 0;
          let up = aggSnap.exists ? Number(aggSnap.data().up) || 0 : 0;
          let down = aggSnap.exists ? Number(aggSnap.data().down) || 0 : 0;
          if (old === 1) up = Math.max(0, up - 1);
          if (old === -1) down = Math.max(0, down - 1);
          if (nextVote === 1) up++;
          if (nextVote === -1) down++;
          if (nextVote === 0) {
            if (voteSnap.exists) tx.delete(voteRef);
          } else {
            tx.set(
              voteRef,
              {
                uid: user.uid,
                folderId: id,
                vote: nextVote,
                updated: firebase.firestore.FieldValue.serverTimestamp(),
              },
              { merge: true }
            );
          }
          if (nextVote !== 0 || old !== 0) {
            tx.set(
              aggRef,
              {
                up,
                down,
                updated: firebase.firestore.FieldValue.serverTimestamp(),
              },
              { merge: true }
            );
          }
          finalUp = up;
          finalDown = down;
        });
      } catch (err) {
        console.warn("[proxy-list] Folder rating failed", err);
        if (isFirestoreResourceExhausted(err)) tripFirestoreReadCooldown(2 * 60 * 1000);
        window.alert("Could not save folder rating. " + firestoreRatingFailureUserHint(err));
        return;
      }
      if (firebaseQuotaExceededVisible) markFirestoreQuotaRecovered();
      folderViewRatingAgg = { up: finalUp, down: finalDown };
      folderViewRatingSelf = nextVote === 0 ? 0 : nextVote;
      const mount = $("folderRatingMount");
      if (mount) setHtml(mount, folderRatingBarInnerHtml(id));
    }

    async function handleFolderRatingButtonClick(folderId, clickedVal) {
      const id = sanitizeFolderDocId(folderId);
      if (!id) return;
      const user = await ensureAuthForFirestore();
      if (!user || user.isAnonymous) {
        openSignInRequiredModal("You need to be signed in to rate folders.");
        return;
      }
      const self = folderViewRatingSelf || 0;
      const nextVote = self === clickedVal ? 0 : clickedVal;
      if (alertIfCommunityFeaturesBlocked()) return;
      await applyFolderRatingVote(id, nextVote);
    }

    function initClickTracking() {
      if (!isFirebaseApiEnabled()) {
        useFirebaseClicks = false;
        firebaseDb = null;
        authStateReady = true;
        if (authStateReadyResolve) authStateReadyResolve();
        startFolderAndMyFoldersListeners();
        startPresenceWorkerPings();
        return Promise.resolve(false);
      }
      const cfg = typeof window !== "undefined" && window.__FIREBASE_CONFIG__;
      if (!cfg || !cfg.apiKey || typeof firebase === "undefined") {
        useFirebaseClicks = false;
        firebaseDb = null;
        authStateReady = true;
        if (authStateReadyResolve) authStateReadyResolve();
        startFolderAndMyFoldersListeners();
        startPresenceWorkerPings();
        return Promise.resolve(false);
      }
      try {
        if (!firebase.apps.length) {
          firebase.initializeApp(cfg);
        }
        firebaseDb = firebase.firestore();
        /* Safari / WebKit: default WebChannel long-poll can fail with “access control checks” on Listen/channel. */
        try {
          firebaseDb.settings({
            experimentalAutoDetectLongPolling: true,
            merge: true,
          });
        } catch (_) {}

        const auth = firebase.auth();
        // Keep signed-in accounts across update refreshes / reloads / page navigations.
        if (!window.__proxyListAuthListenerAttached) {
          window.__proxyListAuthListenerAttached = true;
          auth.onAuthStateChanged((user) => {
            handleAuthUserChanged(user);
            if (!authStateReady) {
              authStateReady = true;
              if (authStateReadyResolve) authStateReadyResolve();
            }
          });
        }

        const prepareAuth =
          window.ProxyListAuth && typeof window.ProxyListAuth.prepare === "function"
            ? window.ProxyListAuth.prepare(auth)
            : Promise.resolve()
                .then(() => {
                  try {
                    return auth.setPersistence(firebase.auth.Auth.Persistence.LOCAL);
                  } catch (_) {
                    return null;
                  }
                })
                .then(() => {
                  if (typeof auth.authStateReady === "function") return auth.authStateReady();
                  return authStateReadyPromise;
                });

        return promiseWithTimeout(prepareAuth, 8000, "Firebase auth timed out")
          .then(() => {
            if (!authStateReady) {
              authStateReady = true;
              if (authStateReadyResolve) authStateReadyResolve();
            }
            let oauthPending = false;
            try {
              oauthPending = sessionStorage.getItem("proxyList_oauth_pending") === "1";
            } catch (_) {}

            // If login just finished a redirect OAuth round-trip, give IndexedDB a
            // moment to restore the provider session before creating anonymous.
            const settle =
              oauthPending
                ? new Promise((r) => setTimeout(r, 500)).then(() => {
                    if (typeof auth.authStateReady === "function") return auth.authStateReady();
                  })
                : Promise.resolve();

            return settle.then(() => {
              if (oauthPending) {
                try {
                  sessionStorage.removeItem("proxyList_oauth_pending");
                } catch (_) {}
              }
              const user = auth.currentUser;
              if (user) {
                useFirebaseClicks = true;
                startPresenceTracking();
                startFolderAndMyFoldersListeners();
                return true;
              }
              // Only create an anonymous session when nothing was restored.
              return promiseWithTimeout(auth.signInAnonymously(), 8000, "Firebase anonymous sign-in timed out")
                .then(() => {
                  useFirebaseClicks = true;
                  startPresenceTracking();
                  startFolderAndMyFoldersListeners();
                  return true;
                })
                .catch((err) => {
                  const msg = String(err?.message || err?.code || "");
                  const referrerBlocked = /referer|referrer/i.test(msg);
                  console.error(
                    "[proxy-list] Firebase anonymous sign-in failed — click counts stay in this browser only." +
                      (referrerBlocked
                        ? " This error usually means the browser API key has HTTP referrer restrictions that exclude this page. Google Cloud Console → APIs & Services → Credentials → your key → Application restrictions → HTTP referrers — add e.g. http://localhost:8080/* and your hosted site (https://….github.io/*)."
                        : " Firebase Console → Authentication → Sign-in method → enable Anonymous; Settings → Authorized domains must include this host."),
                    err
                  );
                  useFirebaseClicks = false;
                  activeSessionsCount = null;
                  updateActiveUsersDisplay();
                  startPresenceWorkerPings();
                  startFolderAndMyFoldersListeners();
                  return false;
                });
            });
          })
          .catch((err) => {
            console.warn("[proxy-list] Firebase auth did not finish; continuing without it.", err);
            useFirebaseClicks = false;
            authStateReady = true;
            if (authStateReadyResolve) authStateReadyResolve();
            startPresenceWorkerPings();
            startFolderAndMyFoldersListeners();
            return false;
          });
      } catch (e) {
        console.error("[proxy-list] Firebase initializeApp / firestore() failed:", e);
        useFirebaseClicks = false;
        firebaseDb = null;
        activeSessionsCount = null;
        updateActiveUsersDisplay();
        authStateReady = true;
        if (authStateReadyResolve) authStateReadyResolve();
        startPresenceWorkerPings();
        startFolderAndMyFoldersListeners();
        return Promise.resolve(false);
      }
    }

    function updateActiveUsersDisplay() {
      const line = $("activeUsersFooterLine");
      if (!line) return;
      // Prefer Worker edge count: Firebase RTDB often over-counts under Scramjet/UV
      // (new anonymous auth uids + failed onDisconnect leave stale presence nodes).
      const n = Number.isFinite(workerActiveSessionsCount)
        ? workerActiveSessionsCount
        : Number.isFinite(activeSessionsCount) && activeSessionsCount > 0
          ? activeSessionsCount
          : null;
      if (n == null) {
        line.hidden = true;
        line.textContent = "";
        return;
      }
      line.hidden = false;
      setHtml(
        line,
        'Active Users: <span class="active-users-count">' +
          escapeHtml(String(n)) +
          "</span>"
      );
      line.title =
        "Approximate browsers with a heartbeat in the last few minutes (Cloudflare Worker). Proxied and direct tabs for the same signed-in account count once.";
    }

    const LINK_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

    function startLinkCheckCountdown() {
      const timeEl = $("linkCheckCountdownTime");
      if (!timeEl) return;
      const pad = (v) => String(v).padStart(2, "0");
      const tick = () => {
        const left = LINK_CHECK_INTERVAL_MS - (Date.now() % LINK_CHECK_INTERVAL_MS);
        const total = Math.ceil(left / 1000);
        timeEl.textContent =
          pad(Math.floor(total / 3600)) + ":" + pad(Math.floor((total % 3600) / 60)) + ":" + pad(total % 60);
      };
      tick();
      setInterval(tick, 1000);
    }
    startLinkCheckCountdown();

    function countActivePresenceSessions(snap) {
      const val = snap && typeof snap.val === "function" ? snap.val() : null;
      if (!val || typeof val !== "object") return 0;
      const now = Date.now();
      let n = 0;
      for (const key of Object.keys(val)) {
        const row = val[key];
        if (!row || typeof row !== "object") continue;
        const ts = Number(row.ts);
        if (!Number.isFinite(ts) || ts > now + 60000) continue;
        if (now - ts <= PRESENCE_STALE_MS) n++;
      }
      return n;
    }

    function presencePingToWorker(force) {
      if (typeof window.ProxyListPresence === "undefined") return;
      const user = typeof firebase !== "undefined" && firebase.auth ? firebase.auth().currentUser : null;
      let anonymous = true;
      let uid = "";
      if (user) {
        uid = user.uid || "";
        try {
          anonymous = !!(user.isAnonymous || (user.providerData || []).length === 0);
        } catch (_) {
          anonymous = !!user.isAnonymous;
        }
      }
      const displayName = anonymous ? "" : accountUsername() || "";
      void window.ProxyListPresence.ping({
        uid: uid,
        anonymous: anonymous,
        displayName: displayName,
        force: !!force,
      }).then(function (data) {
        if (!data || data.ok === false) return;
        const n = Number(data.active);
        if (Number.isFinite(n) && n >= 0) {
          workerActiveSessionsCount = n;
          updateActiveUsersDisplay();
        }
      });
    }

    function startPresenceWorkerPings() {
      if (presenceWorkerStarted) return;
      presenceWorkerStarted = true;
      presencePingToWorker(true);
      if (presenceWorkerPingTimer) clearInterval(presenceWorkerPingTimer);
      presenceWorkerPingTimer = setInterval(function () {
        presencePingToWorker(false);
      }, PRESENCE_HEARTBEAT_MS);
      function applyWorkerActive(n) {
        if (n == null || !Number.isFinite(n) || n < 0) return;
        workerActiveSessionsCount = n;
        updateActiveUsersDisplay();
      }
      if (
        typeof window.ProxyListPresence !== "undefined" &&
        typeof window.ProxyListPresence.startActiveCountPolling === "function"
      ) {
        // Poll GET /api/presence-active on an interval so Scramjet/UV hosts that
        // drop keepalive POSTs still show a live count.
        window.ProxyListPresence.startActiveCountPolling(applyWorkerActive, PRESENCE_HEARTBEAT_MS);
      } else if (
        typeof window.ProxyListPresence !== "undefined" &&
        typeof window.ProxyListPresence.fetchActiveCount === "function"
      ) {
        void window.ProxyListPresence.fetchActiveCount().then(applyWorkerActive);
      }
      window.addEventListener("proxy-list-hardware-consent", function (ev) {
        try {
          if (ev && ev.detail && ev.detail.value === "enabled") presencePingToWorker(true);
        } catch (_) {}
      });
    }

    function presenceHeartbeat() {
      if (presenceSessionRef) {
        presenceSessionRef
          .update({ ts: firebase.database.ServerValue.TIMESTAMP })
          .catch(function () {});
      }
      presencePingToWorker(false);
    }

    function startPresenceTracking() {
      // Stats aggregates come from Worker pings — do not require Realtime DB.
      startPresenceWorkerPings();
      if (!useFirebaseClicks || typeof firebase === "undefined" || !firebase.auth().currentUser) return;
      if (presenceSessionRef) return;
      if (typeof firebase.database !== "function") {
        console.warn("[proxy-list] firebase-database-compat.js not loaded; skipping live active-user count.");
        return;
      }
      try {
        if (!firebasePresenceDb) {
          try {
            firebasePresenceDb = firebase.database();
          } catch (err) {
            if (!isStorageQuotaError(err)) throw err;
            evictLocalStorageDiskCaches();
            firebasePresenceDb = firebase.database();
          }
        }
        // One RTDB node per auth uid (not push()). Page navigations / reloads
        // must overwrite the same key or stale sessions inflate "Active Users".
        const uid = firebase.auth().currentUser.uid;
        const sessRef = firebasePresenceDb.ref("presence/" + uid);
        presenceSessionRef = sessRef;

        const bindPresenceSession = () => {
          sessRef
            .onDisconnect()
            .remove()
            .then(function () {
              return sessRef.set({
                uid: uid,
                ts: firebase.database.ServerValue.TIMESTAMP,
              });
            })
            .catch(function (err) {
              console.warn(
                "[proxy-list] Presence write failed — create Realtime Database in Firebase Console and add rules (see firebase-config.example.js).",
                err
              );
            });
        };

        firebasePresenceDb.ref(".info/connected").on("value", function (snap) {
          if (snap.val() === true) bindPresenceSession();
        });

        // Best-effort clear on in-site navigation so the next page does not race a ghost session.
        const clearOnLeave = function () {
          try {
            sessRef.onDisconnect().cancel();
          } catch (_) {}
          sessRef.remove().catch(function () {});
        };
        window.addEventListener("pagehide", clearOnLeave);
        window.addEventListener("beforeunload", clearOnLeave);
        window.addEventListener("pageshow", function (ev) {
          if (ev && ev.persisted) bindPresenceSession();
        });

        if (presenceHeartbeatTimer) clearInterval(presenceHeartbeatTimer);
        presenceHeartbeatTimer = setInterval(presenceHeartbeat, PRESENCE_HEARTBEAT_MS);

        if (!presenceListenerAttached) {
          presenceListenerAttached = true;
          firebasePresenceDb.ref("presence").on("value", function (snap) {
            activeSessionsCount = countActivePresenceSessions(snap);
            updateActiveUsersDisplay();
          });
        }
      } catch (err) {
        console.warn("[proxy-list] Realtime Database unavailable for presence:", err);
      }
    }

    function syncClickCountInUi(url, count) {
      const norm = normalizeUrlKeyForClicks(url);
      if (!norm || !Number.isFinite(count) || count < 0) return;
      // Never let a lower edge/local response overwrite a higher shared count.
      const next = Math.max(Number(clickCountCache.get(norm)) || 0, count);
      clickCountCache.set(norm, next);
      if (bulkClickCountCache) {
        bulkClickCountCache.set(norm, Math.max(Number(bulkClickCountCache.get(norm)) || 0, next));
      }
      const stamp = (currentListVersionStamp || "").trim();
      if (stamp) persistClickCountDiskCache(stamp, [norm]);
      withStableLinkRows(() => {
        document.querySelectorAll("td.click-cell[data-click-url]").forEach((td) => {
          const link = td.getAttribute("data-click-url") || "";
          if (normalizeUrlKeyForClicks(link) !== norm) return;
          td.textContent = String(next);
        });
      });
    }

    async function recordLinkClick(url) {
      const norm = normalizeUrlKeyForClicks(url);
      if (!norm) return null;

      // Prefer Cloudflare Worker IP-rate-limited API (no account required).
      try {
        const res = await fetch(
          typeof window.ProxyListPresence !== "undefined" && window.ProxyListPresence.apiUrl
            ? window.ProxyListPresence.apiUrl("/api/link-click")
            : "./api/link-click",
          {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url: norm }),
          mode: "cors",
          // keepalive POSTs often fail under Scramjet/Ultraviolet service workers.
          keepalive: !(
            window.ProxyListPresence && typeof window.ProxyListPresence.looksLikeWebProxy === "function"
              ? window.ProxyListPresence.looksLikeWebProxy()
              : /\/uv\/|ultraviolet|\/scramjet|\/sj\/|bare-mux|\/service\/|\/proxy\//i.test(
                  String(location.href || "") + String(location.pathname || "")
                )
          ),
          }
        );
        if (res.status === 429) {
          console.warn("[proxy-list] Click rate limit reached for this IP");
          return null;
        }
        if (res.ok) {
          const data = await res.json().catch(() => ({}));
          if (data && data.ok) {
            const key = normalizeUrlKeyForClicks(data.norm || norm);
            if (key && Number.isFinite(data.count)) {
              syncClickCountInUi(url, data.count);
              return data.count;
            }
            if (key) {
              const prev = clickCountCache.get(key);
              const next = (Number(prev) || 0) + 1;
              syncClickCountInUi(url, next);
              return next;
            }
            return true;
          }
        }
      } catch (_) {
        /* Worker unavailable (e.g. GitHub Pages) — fall back below */
      }

      // Fallback: local-only counter when the IP-rate-limited API is not deployed.
      const local = localClickInc(norm);
      syncClickCountInUi(url, local);
      return local;
    }

    async function fetchClickCounts(urls, onProgress, options) {
      const norms = [...new Set(urls.map((u) => normalizeUrlKeyForClicks(u)).filter(Boolean))];
      const map = new Map();
      const stamp = (currentListVersionStamp || "").trim();
      // Disk cache is optimistic; URLs not fetched within CLICK_COUNT_REVALIDATE_MS
      // are revalidated against the shared Worker.
      hydrateClickCountDiskCache(stamp, norms);
      hydrateClickCountDiskCacheRelaxed(norms);
      const mergeClickCountCache = () => {
        norms.forEach((n) => {
          if (!clickCountCache.has(n)) return;
          const cached = clickCountCache.get(n);
          const prev = map.has(n) ? map.get(n) : 0;
          map.set(n, Math.max(Number(prev) || 0, Number(cached) || 0));
        });
      };
      const shouldContinue = options && typeof options.shouldContinue === "function" ? options.shouldContinue : null;
      const stillGoing = () => !shouldContinue || shouldContinue();
      if (!norms.length) {
        if (onProgress) onProgress(0, 0);
        return map;
      }
      mergeClickCountCache();

      const sharedApiAvailable =
        typeof window.ProxyListPresence !== "undefined" &&
        typeof window.ProxyListPresence.apiUrl === "function";
      // When the shared API is available, refresh every URL not fetched recently
      // (not only disk misses). Otherwise keep the "uncached only" behavior for offline.
      const toFetch = sharedApiAvailable
        ? norms.filter((n) => !clickCountRecentlyFetched(n))
        : norms.filter((n) => !clickCountCache.has(n));
      if (!toFetch.length) {
        if (onProgress) onProgress(norms.length, norms.length);
        return map;
      }

      // Try Worker batch get first (same origin on Cloudflare / workers.dev on local+Pages).
      // Worker accepts at most 80 URLs per request — batch so "load all" still refreshes.
      const WORKER_CLICK_BATCH = 25;
      try {
        if (!stillGoing()) return map;
        let fetchedAny = false;
        for (let offset = 0; offset < toFetch.length; offset += WORKER_CLICK_BATCH) {
          if (!stillGoing()) return map;
          const displayUrls = toFetch.slice(offset, offset + WORKER_CLICK_BATCH);
          const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
          const abortTimer =
            controller && shouldContinue
              ? setInterval(() => {
                  if (!stillGoing()) {
                    try {
                      controller.abort();
                    } catch (_) {}
                  }
                }, 250)
              : null;
          let res;
          try {
            res = await fetch(
              sharedApiAvailable
                ? window.ProxyListPresence.apiUrl("/api/link-clicks/get")
                : "./api/link-clicks/get",
              {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ urls: displayUrls }),
              mode: "cors",
              signal: controller ? controller.signal : undefined,
              }
            );
          } finally {
            if (abortTimer) clearInterval(abortTimer);
          }
          if (!stillGoing()) return map;
          if (!res.ok) continue;
          const data = await res.json();
          if (!stillGoing()) return map;
          if (!(data && data.ok && data.counts && typeof data.counts === "object")) continue;
          fetchedAny = true;
          displayUrls.forEach((n) => {
            const workerKey = normalizeUrlKeyForClicks(n);
            let best = 0;
            let sawWorker = false;
            for (const v of urlKeyVariants(n)) {
              const k = normalizeUrlKeyForClicks(v);
              const val =
                data.counts[k] != null
                  ? data.counts[k]
                  : data.counts[v] != null
                    ? data.counts[v]
                    : null;
              if (Number.isFinite(val)) {
                sawWorker = true;
                best = Math.max(best, val);
              }
            }
            if (!sawWorker) {
              const v =
                data.counts[workerKey] != null
                  ? data.counts[workerKey]
                  : data.counts[n];
              if (Number.isFinite(v)) {
                sawWorker = true;
                best = v;
              }
            }
            // Worker omits keys when the store is unavailable — keep disk/cache.
            // When it does return a key, trust it (allows counts to drop after a bad seed).
            if (!sawWorker) return;
            clickCountFetchedAt.set(n, Date.now());
            map.set(n, best);
            clickCountCache.set(n, best);
          });
          if (onProgress) {
            onProgress(Math.min(offset + displayUrls.length, toFetch.length), toFetch.length);
          }
        }
        if (fetchedAny) {
          mergeClickCountCache();
          if (stamp) persistClickCountDiskCache(stamp, norms);
          if (onProgress) onProgress(norms.length, norms.length);
          return map;
        }
      } catch (_) {
        /* aborted or Worker unavailable — fall through */
      }

      if (!stillGoing()) return map;

      toFetch.forEach((n) => {
        if (!map.has(n)) map.set(n, localClickGet(n));
      });
      mergeClickCountCache();
      if (stamp) persistClickCountDiskCache(stamp, norms);
      if (onProgress) onProgress(norms.length, norms.length);
      return map;
    }

    function countForUrl(map, url) {
      const k = normalizeUrlKeyForClicks(url);
      if (clickCountCache.has(k)) {
        const cached = clickCountCache.get(k);
        const fetched = map.has(k) ? map.get(k) : 0;
        return Math.max(Number(cached) || 0, Number(fetched) || 0);
      }
      return map.has(k) ? map.get(k) : 0;
    }

    function canonicalCategory(value) {
      const raw = String(value == null ? "" : value).trim();
      const low = raw.toLowerCase();
      if (low === "proxy/games") return "Proxy/Games";
      if (low === "games") return "Games";
      if (low === "proxy") return "Proxy";
      if (low === "pending") return "pending";
      return raw;
    }

    function formatClickLineLabel() {
      return clicksAreSharedGlobally()
        ? "Opens (all visitors, IP rate-limited)"
        : "Opens (this browser only)";
    }

    const TOP_OPENS_DISPLAY = 10;
    const TOP_OPENS_FETCH_CAP = 80;
    const TOP_OPENS_CACHE_MS = 30 * 60 * 1000;
    // v2: same bust as clickCountDisk — old Most opened rows carried doubled counts.
    const LS_TOP_OPENS_DISK = "proxyList_topOpensDisk_v2";
    let topOpenedDocsCache = (() => {
      try {
        const o = JSON.parse(localStorage.getItem(LS_TOP_OPENS_DISK) || "null");
        if (o && typeof o.at === "number" && Array.isArray(o.docs) && o.docs.length) return o;
      } catch (_) {}
      return { at: 0, docs: null };
    })();

    function setTopOpenedDocsCache(docs) {
      topOpenedDocsCache = { at: Date.now(), docs };
      writeLocalStorageDisk(LS_TOP_OPENS_DISK, JSON.stringify(topOpenedDocsCache));
    }
    const MO_SORT_STORAGE_KEY = "proxyList_mostOpenedSort_v1";
    const MO_SORT_OPENS = "opens";
    const MO_SORT_FILTER = "filter";
    const MO_SORT_PROVIDER = "provider";
    const MO_PROVIDER_STORAGE_KEY = "proxyList_mostOpenedProvider_v1";

    function getMostOpenedSortMode() {
      try {
        const v = localStorage.getItem(MO_SORT_STORAGE_KEY);
        if (v === MO_SORT_FILTER || v === MO_SORT_PROVIDER || v === MO_SORT_OPENS) return v;
      } catch (_) {}
      return MO_SORT_OPENS;
    }

    function persistMostOpenedSortMode(mode) {
      try {
        localStorage.setItem(MO_SORT_STORAGE_KEY, mode);
      } catch (_) {}
    }

    function getMostOpenedProviderChoice() {
      try {
        return localStorage.getItem(MO_PROVIDER_STORAGE_KEY) || "";
      } catch (_) {
        return "";
      }
    }

    function persistMostOpenedProviderChoice(value) {
      try {
        localStorage.setItem(MO_PROVIDER_STORAGE_KEY, value || "");
      } catch (_) {}
    }

    function syncMostOpenedProviderOptions(links) {
      const sel = $("mostOpenedProviderSelect");
      if (!sel) return;
      const prev = getMostOpenedProviderChoice();
      const providers = uniq(links.map((d) => d.provider));
      setHtml(
        sel,
        '<option value="">All providers</option>' +
          providers
            .map(
              (p) =>
                '<option value="' + escapeAttr(p) + '">' + escapeHtml(p) + "</option>"
            )
            .join("")
      );
      const pick = prev && providers.includes(prev) ? prev : "";
      sel.value = pick;
      if (pick !== prev) persistMostOpenedProviderChoice(pick);
    }

    function buildLinkNormIndex(rows) {
      const m = new Map();
      for (const r of rows || []) {
        for (const k of urlKeyVariants(r.link)) {
          if (k && !m.has(k)) m.set(k, r);
        }
      }
      return m;
    }

    /** Collapse split click docs (legacy vs modern URL hashes) into one row. */
    function mergeMostOpenedCandidates(candidates) {
      const byKey = new Map();
      for (const c of candidates || []) {
        const row = c && c.row;
        const key = normalizeUrlKeyForClicks(row && row.link) || String((row && row.link) || "");
        if (!key) continue;
        const prev = byKey.get(key);
        const count = Number(c.count) || 0;
        if (!prev) {
          byKey.set(key, { row, count });
        } else {
          prev.count += count;
        }
      }
      return [...byKey.values()];
    }

    async function fetchTopOpenedFromFirestore(limit) {
      if (topOpenedDocsCache.docs && Date.now() - topOpenedDocsCache.at < TOP_OPENS_CACHE_MS) {
        return topOpenedDocsCache.docs;
      }
      const cap = Math.max(1, Math.min(limit, 50));
      let workerAnswered = false;
      try {
        const res = await fetch(
          typeof window.ProxyListPresence !== "undefined" && window.ProxyListPresence.apiUrl
            ? window.ProxyListPresence.apiUrl("/api/top-opens")
            : "./api/top-opens",
          { mode: "cors" }
        );
        if (res.ok) {
          const data = await res.json();
          if (data && data.ok) workerAnswered = true;
          if (data && data.ok && Array.isArray(data.links) && data.links.length) {
            const docs = data.links
              .map((x) => ({
                url: x && x.url != null ? String(x.url).trim() : "",
                count: Number(x && x.count),
              }))
              .filter((x) => x.url && Number.isFinite(x.count) && x.count > 0)
              .slice(0, cap);
            if (docs.length) {
              setTopOpenedDocsCache(docs);
              return docs;
            }
          }
        }
      } catch (_) {}
      return topOpenedDocsCache.docs || [];
    }

    function popularLinksFallbackCandidates(links, byNorm) {
      const meta = pageContext && pageContext.meta ? pageContext.meta : null;
      const entries = meta && Array.isArray(meta.popular_links) ? meta.popular_links : [];
      const out = [];
      for (const row of entries) {
        if (!row || !row.link) continue;
        const key = normalizeUrlKeyForClicks(row.link);
        const indexed = key ? byNorm.get(key) || byNorm.get(legacyNormalizeUrlKey(row.link)) : null;
        const resolved = indexed || row;
        const cached = key && clickCountCache.has(key) ? Number(clickCountCache.get(key)) || 0 : 0;
        out.push({ row: resolved, count: cached });
      }
      return out;
    }

    async function renderMostOpenedForList(links) {
      const sec = $("mostOpenedSection");
      const noteEl = $("mostOpenedNote");
      const thead = $("mostOpenedThead");
      const tbody = $("mostOpenedTableBody");
      const moEmpty = $("mostOpenedEmptyState");
      const moMount = $("mostOpenedTableMount");
      const sortEl = $("mostOpenedSortSelect");
      const provWrap = $("mostOpenedProviderWrap");
      const provSel = $("mostOpenedProviderSelect");
      if (!sec || !thead || !tbody) return;
      /* Folder (?folder=…) or saved links (?saved=1): global “most opened” is not relevant here. */
      if (shouldHideMostOpenedSection()) {
        hideMostOpenedSection();
        return;
      }
      if (moEmpty) {
        moEmpty.hidden = true;
        setHtml(moEmpty, "");
      }
      if (moMount) moMount.hidden = false;
      const mode =
        sortEl && sortEl.value && [MO_SORT_OPENS, MO_SORT_FILTER, MO_SORT_PROVIDER].includes(sortEl.value)
          ? sortEl.value
          : getMostOpenedSortMode();
      if (sortEl && sortEl.value !== mode) sortEl.value = mode;

      if (provWrap) provWrap.hidden = mode !== MO_SORT_PROVIDER;

      let providerFilter = "";
      if (mode === MO_SORT_PROVIDER && provSel && provSel.value) {
        providerFilter = String(provSel.value);
      }

      const byNorm = buildLinkNormIndex(links);
      const docs = await fetchTopOpenedFromFirestore(TOP_OPENS_FETCH_CAP);
      // Keep every matching Firestore/Worker doc so mergeMostOpenedCandidates can
      // sum legacy+modern hash splits (do not dedupe before merge).
      const candidates = [];
      for (const { url, count } of docs) {
        const row =
          byNorm.get(normalizeUrlKeyForClicks(url)) || byNorm.get(legacyNormalizeUrlKey(url));
        if (!row) continue;
        candidates.push({ row, count: Number(count) || 0 });
      }
      const merged = mergeMostOpenedCandidates(candidates);

      function fillMostOpenedPool(base) {
        const out = base.slice();
        const have = new Set(
          out.map((c) => normalizeUrlKeyForClicks(c.row && c.row.link) || String((c.row && c.row.link) || ""))
        );
        function pushRow(row, count) {
          const key = normalizeUrlKeyForClicks(row && row.link) || String((row && row.link) || "");
          if (!key || have.has(key)) return;
          have.add(key);
          out.push({ row, count: Number(count) || 0 });
        }
        if (out.length < TOP_OPENS_DISPLAY) {
          const ranked = (links || [])
            .map((row) => {
              const key = normalizeUrlKeyForClicks(row.link);
              const cached = key && clickCountCache.has(key) ? Number(clickCountCache.get(key)) || 0 : 0;
              const local = key ? Number(localClickGet(key)) || 0 : 0;
              return { row, count: Math.max(cached, local) };
            })
            .filter((c) => c.count > 0)
            .sort((a, b) => b.count - a.count);
          for (const c of ranked) {
            if (out.length >= TOP_OPENS_DISPLAY) break;
            pushRow(c.row, c.count);
          }
        }
        if (out.length < TOP_OPENS_DISPLAY) {
          const fallback = popularLinksFallbackCandidates(links, byNorm);
          for (const c of fallback) {
            if (out.length >= TOP_OPENS_DISPLAY) break;
            pushRow(c.row, c.count);
          }
        }
        return out;
      }

      let pool = fillMostOpenedPool(merged);
      if (mode === MO_SORT_PROVIDER && providerFilter) {
        pool = pool.filter((c) => String(c.row.provider || "") === providerFilter);
        if (pool.length < TOP_OPENS_DISPLAY) {
          const extra = (links || []).filter((row) => String(row.provider || "") === providerFilter);
          const have = new Set(
            pool.map((c) => normalizeUrlKeyForClicks(c.row && c.row.link) || String((c.row && c.row.link) || ""))
          );
          extra
            .map((row) => {
              const key = normalizeUrlKeyForClicks(row.link);
              const cached = key && clickCountCache.has(key) ? Number(clickCountCache.get(key)) || 0 : 0;
              return { row, count: cached };
            })
            .sort((a, b) => b.count - a.count)
            .forEach((c) => {
              if (pool.length >= TOP_OPENS_DISPLAY) return;
              const key = normalizeUrlKeyForClicks(c.row.link) || String(c.row.link || "");
              if (!key || have.has(key)) return;
              have.add(key);
              pool.push(c);
            });
        }
      }

      if (mode === MO_SORT_OPENS) {
        pool.sort((a, b) => b.count - a.count);
      } else if (mode === MO_SORT_FILTER) {
        pool.sort((a, b) => {
          const dr = mostOpenedFilterSortRank(a.row.link) - mostOpenedFilterSortRank(b.row.link);
          if (dr !== 0) return dr;
          return b.count - a.count;
        });
      } else if (mode === MO_SORT_PROVIDER) {
        if (providerFilter) {
          pool.sort((a, b) => b.count - a.count);
        } else {
          pool.sort((a, b) => {
            const pr = String(a.row.provider || "").localeCompare(String(b.row.provider || ""), undefined, {
              sensitivity: "base",
            });
            if (pr !== 0) return pr;
            return b.count - a.count;
          });
        }
      }

      const picked = pool.slice(0, TOP_OPENS_DISPLAY);
      let usingPopularFallback = false;
      if (!merged.length && picked.length) {
        const fallbackUrls = new Set(
          (pageContext && pageContext.meta && Array.isArray(pageContext.meta.popular_links)
            ? pageContext.meta.popular_links
            : []
          ).map((row) => normalizeUrlKeyForClicks(row && row.link))
        );
        usingPopularFallback = picked.every((c) => {
          const key = normalizeUrlKeyForClicks(c.row && c.row.link);
          return key && fallbackUrls.has(key);
        });
      }

      const finalPicked = picked;

      if (!finalPicked.length) {
        if (mode === MO_SORT_PROVIDER && providerFilter) {
          sec.hidden = false;
          if (noteEl) {
            noteEl.textContent = "";
            noteEl.hidden = true;
          }
          setHtml(thead, "");
          setHtml(tbody, "");
          if (moEmpty) {
            setHtml(moEmpty, emptyStateNoResultsInnerHtml());
            moEmpty.hidden = false;
          }
          if (moMount) moMount.hidden = true;
          return;
        }
        sec.hidden = true;
        if (noteEl) {
          noteEl.textContent = "";
          noteEl.hidden = true;
        }
        setHtml(thead, "");
        setHtml(tbody, "");
        return;
      }
      const headingEl = $("mostOpenedHeading");
      if (headingEl) {
        headingEl.textContent = "Most opened";
      }
      sec.hidden = false;
      if (noteEl) {
        let note =
          "Only URLs that appear in the sorted list below are shown. Counts are link-summary opens from all visitors.";
        if (usingPopularFallback) {
          note =
            ((pageContext && pageContext.meta && pageContext.meta.popular_note) ||
              "Hand-picked links that tend to work well.") +
            " Open counts appear when available.";
        } else if (mode === MO_SORT_OPENS) {
          note = "Ranked by opens (highest first). " + note;
        } else if (mode === MO_SORT_FILTER) {
          if (normalizeFilterKey(selectedGnMathFilter)) {
            note =
              "Sorted by your selected web filter: unblocked first, then warning, then blocked; links without that check rank last. Tie-break: opens. " +
              note;
          } else {
            note =
              "Choose a filter under Site → Select filter to rank by estimated status. Until then, order matches opens. " +
              note;
          }
        } else if (mode === MO_SORT_PROVIDER) {
          if (providerFilter) {
            note =
              "Provider: " +
              providerFilter +
              ". Ranked by opens within this provider (among the current top-opened scan). " +
              note;
          } else {
            note =
              "Sorted by provider name (A–Z). Pick a provider above to only show that provider’s top opens. Tie-break: opens. " +
              note;
          }
        }
        noteEl.textContent = note;
        noteEl.hidden = false;
      }
      await prefetchLinkRatingsForNorms(
        finalPicked.map(({ row }) => normalizeUrlKeyForClicks(row && row.link))
      );
      setHtml(thead, linkTableTheadRowHtml());
      setHtml(tbody, finalPicked.map(({ row, count }) => buildRowTrHtml(row, count)).join(""));
    }

    function uniq(arr) {
      return [...new Set(arr)].filter(Boolean).sort((a, b) => a.localeCompare(b));
    }

    function selectableFacetTags(arr) {
      return uniq(arr).filter((v) => {
        const s = String(v || "").trim().toLowerCase();
        return s && s !== "-" && s !== "—" && s !== "–" && s !== "n/a" && s !== "pending" && s !== "unknown";
      });
    }

    function buildHaystack(row) {
      const provider = String(row.provider || "");
      return [
        row.link,
        provider,
        providerSuggestLabel(provider),
        canonicalCategory(row.category),
        row.capabilities,
        row.protocols,
        row.contributor,
        row.contributor_url || "",
        row.found,
      ].join(" ").toLowerCase();
    }

    const haystackCache = new Map();
    const HAYSTACK_CACHE_MAX = 2500;

    function haystack(row) {
      const link = row && row.link;
      if (link && haystackCache.has(link)) return haystackCache.get(link);
      const hs = buildHaystack(row);
      if (link) {
        if (haystackCache.size >= HAYSTACK_CACHE_MAX) haystackCache.clear();
        haystackCache.set(link, hs);
      }
      return hs;
    }

    function clearHaystackCache() {
      haystackCache.clear();
    }

    const SEARCH_SUGGEST_LIMIT = 8;
    let searchSuggestItems = [];
    let searchSuggestActive = -1;
    let searchSuggestIndex = null;
    let gdbSuggestRefreshToken = 0;

    function providerSuggestLabel(provider) {
      const s = String(provider || "");
      // Drop leading emoji / symbols so typing "Selenite" matches "💜 Selenite".
      return s.replace(/^[^A-Za-z0-9#]+/, "").trim() || s;
    }

    function buildSearchSuggestIndex(rows) {
      const providers = new Map();
      const contributors = new Map();
      for (const row of rows || []) {
        const provider = String((row && row.provider) || "").trim();
        if (provider) {
          const key = provider.toLowerCase();
          if (!providers.has(key)) {
            providers.set(key, {
              kind: "provider",
              value: provider,
              label: provider,
              match: (provider + " " + providerSuggestLabel(provider)).toLowerCase(),
            });
          }
        }
        const contributor = String((row && row.contributor) || "").trim();
        if (contributor && contributor.toLowerCase() !== "n/a") {
          const key = contributor.toLowerCase();
          if (!contributors.has(key)) {
            contributors.set(key, {
              kind: "contributor",
              value: contributor,
              label: contributor,
              match: (contributor + " " + providerSuggestLabel(contributor)).toLowerCase(),
            });
          }
        }
      }
      searchSuggestIndex = {
        providers: [...providers.values()].sort((a, b) => a.label.localeCompare(b.label)),
        contributors: [...contributors.values()].sort((a, b) => a.label.localeCompare(b.label)),
        links: null,
        rowsRef: rows || null,
      };
    }

    function ensureUrlSuggestIndex() {
      if (!searchSuggestIndex || searchSuggestIndex.links) return;
      const rows = searchSuggestIndex.rowsRef || [];
      const links = [];
      const seenLinks = new Set();
      for (const row of rows) {
        const link = String((row && row.link) || "").trim();
        if (!link) continue;
        const nk = link.toLowerCase();
        if (seenLinks.has(nk)) continue;
        seenLinks.add(nk);
        links.push({
          kind: "url",
          value: link,
          label: link,
          match: nk,
        });
      }
      searchSuggestIndex.links = links;
      delete searchSuggestIndex.rowsRef;
    }

    function rankSuggestMatch(item, q) {
      const m = item.match || "";
      if (m === q) return 0;
      if (m.startsWith(q)) return 1;
      const bare =
        item.kind === "provider" || item.kind === "contributor"
          ? providerSuggestLabel(item.value).toLowerCase()
          : m;
      if (bare.startsWith(q)) return 2;
      if (m.includes(q)) return 3;
      return 9;
    }

    function collectGdbSuggestionItems(query, limit) {
      const api = window.ProxyListGameDbSearch;
      if (!api || typeof api.suggestFromCache !== "function") return [];
      const tags = getSelectedGdbSearchTags();
      return api.suggestFromCache(query, {
        limit: limit != null ? limit : 6,
        tags: tags === null ? undefined : tags,
      });
    }

    function scheduleGdbSuggestionRefresh(query, source) {
      const api = window.ProxyListGameDbSearch;
      if (!api || typeof api.warmAll !== "function") return;
      const q = String(query || "").trim();
      if (!q) return;
      const token = ++gdbSuggestRefreshToken;
      const tags = getSelectedGdbSearchTags();
      void api.warmAll(tags === null ? undefined : { tags: tags }).then(() => {
        if (token !== gdbSuggestRefreshToken) return;
        if (source === "palette") {
          if (!isSearchPaletteOpen()) return;
          const input = $("searchPaletteInput");
          if (!input || String(input.value || "").trim() !== q) return;
          renderSearchPaletteList();
          return;
        }
        const input = $("q");
        if (!input || document.activeElement !== input) return;
        if (String(input.value || "").trim() !== q) return;
        renderSearchSuggestions(q);
      });
    }

    function collectSearchSuggestions(query) {
      const q = String(query || "").trim().toLowerCase();
      if (!q || q.length < 1 || !searchSuggestIndex) return [];
      const scored = [];
      for (const item of searchSuggestIndex.providers) {
        const rank = rankSuggestMatch(item, q);
        if (rank < 9) scored.push({ item, rank, tie: 0 });
      }
      for (const item of searchSuggestIndex.contributors || []) {
        const rank = rankSuggestMatch(item, q);
        if (rank < 9) scored.push({ item, rank, tie: 1 });
      }
      const scanUrls = q.length >= 3 || q.includes(".") || q.includes("/");
      if (scanUrls) {
        ensureUrlSuggestIndex();
        for (const item of searchSuggestIndex.links || []) {
          const rank = rankSuggestMatch(item, q);
          if (rank < 9) scored.push({ item, rank, tie: 2 });
        }
      }
      for (const item of collectGdbSuggestionItems(query, 6)) {
        const rank = item.kind === "gdb-database" ? 1 : item.score >= 80 ? 1 : 2;
        scored.push({ item, rank, tie: item.kind === "gdb-database" ? 0.5 : 1.5 });
      }
      scored.sort((a, b) => a.rank - b.rank || a.tie - b.tie || a.item.label.localeCompare(b.item.label));
      return scored.slice(0, SEARCH_SUGGEST_LIMIT).map((x) => x.item);
    }

    function hideSearchSuggestions() {
      const list = $("qSuggest");
      const input = $("q");
      searchSuggestItems = [];
      searchSuggestActive = -1;
      if (list) {
        list.hidden = true;
        setHtml(list, "");
      }
      if (input) input.setAttribute("aria-expanded", "false");
    }

    function paintSearchSuggestActive() {
      const list = $("qSuggest");
      if (!list) return;
      const buttons = list.querySelectorAll(".search-suggest-item");
      buttons.forEach((btn, i) => {
        btn.setAttribute("aria-selected", i === searchSuggestActive ? "true" : "false");
      });
      const active = buttons[searchSuggestActive];
      if (active && typeof active.scrollIntoView === "function") {
        active.scrollIntoView({ block: "nearest" });
      }
    }

    function renderSearchSuggestions(query) {
      const list = $("qSuggest");
      const input = $("q");
      if (!list || !input) return;
      const items = collectSearchSuggestions(query);
      searchSuggestItems = items;
      if (!items.length) {
        hideSearchSuggestions();
        return;
      }
      if (searchSuggestActive >= items.length) searchSuggestActive = items.length - 1;
      setHtml(
        list,
        items
          .map((item, i) => {
            const kind =
              item.kind === "provider"
                ? "Provider"
                : item.kind === "contributor"
                  ? "Contributor"
                  : item.kind === "gdb-database"
                    ? "Game DB"
                    : item.kind === "gdb-game"
                      ? "Game"
                      : "URL";
            const selected = searchSuggestActive >= 0 && i === searchSuggestActive;
            return (
              '<li role="presentation">' +
              '<button type="button" class="search-suggest-item" role="option" id="qSuggestOpt' +
              i +
              '" data-suggest-index="' +
              i +
              '" aria-selected="' +
              (selected ? "true" : "false") +
              '">' +
              '<span class="search-suggest-kind">' +
              escapeHtml(kind) +
              "</span>" +
              '<span class="search-suggest-value">' +
              escapeHtml(item.label) +
              "</span>" +
              "</button></li>"
            );
          })
          .join("")
      );
      list.hidden = false;
      input.setAttribute("aria-expanded", "true");
      if (searchSuggestActive >= 0) {
        input.setAttribute("aria-activedescendant", "qSuggestOpt" + searchSuggestActive);
      } else {
        input.removeAttribute("aria-activedescendant");
      }
    }

    function applyGameDbCapabilityFilters(tags) {
      const wanted = new Set((tags || []).map((t) => String(t).toLowerCase()));
      document.querySelectorAll("#capTags input[type=checkbox]").forEach((input) => {
        input.checked = wanted.has(String(input.value || "").toLowerCase());
      });
      const anyCap = document.querySelector('input[name="capMode"][value="any"]');
      if (anyCap) anyCap.checked = true;
    }

    function applyGdbSearchSuggestion(item) {
      const tags = Array.isArray(item.tags) ? item.tags : item.tag ? [item.tag] : [];
      if (!tags.length) return false;
      const q = $("q");
      if (q) q.value = "";
      hideSearchSuggestions();
      applyGameDbCapabilityFilters(tags);
      if (pageContext) {
        scheduleRenderFromPageContext();
        scheduleUserProfileWrite();
      }
      const label =
        item.kind === "gdb-game"
          ? item.label + " (" + tags.length + " database" + (tags.length === 1 ? "" : "s") + ")"
          : item.label;
      showAppToast("Showing links with " + label);
      const target = $("stats") || $("tableWrap");
      if (target && typeof target.scrollIntoView === "function") {
        target.scrollIntoView({ behavior: "smooth", block: "start" });
      }
      return true;
    }

    function bestGdbSearchMatchForQuery(query, minGameScore) {
      const api = window.ProxyListGameDbSearch;
      if (!api || typeof api.suggestFromCache !== "function") return null;
      const q = String(query || "").trim();
      if (!q) return null;
      const minScore = minGameScore != null ? minGameScore : 80;
      const tags = getSelectedGdbSearchTags();
      const items = api.suggestFromCache(q, {
        limit: 12,
        tags: tags === null ? undefined : tags,
      });
      if (!items.length) return null;
      const normQ = typeof api.normalizeQuery === "function" ? api.normalizeQuery(q) : q.toLowerCase();
      let bestGame = null;
      for (const item of items) {
        if (item.kind !== "gdb-game" || !Array.isArray(item.tags) || !item.tags.length) continue;
        const score = item.score != null ? item.score : 0;
        const normLabel =
          typeof api.normalizeQuery === "function"
            ? api.normalizeQuery(item.label)
            : String(item.label).toLowerCase();
        if (normLabel === normQ || score >= minScore) {
          if (!bestGame || score > (bestGame.score || 0)) bestGame = item;
        }
      }
      if (bestGame) return bestGame;
      for (const item of items) {
        if (item.kind === "gdb-database" && Array.isArray(item.tags) && item.tags.length) return item;
      }
      return null;
    }

    async function tryApplyGameSearchFromQuery(query, options) {
      const opts = options || {};
      const q = String(query || "").trim();
      if (!q) return false;
      const api = window.ProxyListGameDbSearch;
      if (!api) return false;
      const minScore = opts.fromUrl ? 50 : 80;

      let match = bestGdbSearchMatchForQuery(q, minScore);
      if (!match || !(match.tags && match.tags.length)) {
        if (typeof api.warmAll === "function") {
          const tags = getSelectedGdbSearchTags();
          await api.warmAll(tags === null ? undefined : { tags: tags });
        }
        match = bestGdbSearchMatchForQuery(q, minScore);
      }
      if (match && match.tags && match.tags.length) {
        return applyGdbSearchSuggestion(match);
      }
      return false;
    }

    function applySearchSuggestion(item) {
      if (!item) return;
      if (item.kind === "gdb-database" || item.kind === "gdb-game") {
        applyGdbSearchSuggestion(item);
        return;
      }
      const input = $("q");
      if (!input) return;
      input.value = item.value;
      rememberRecentSearch(item.value);
      hideSearchSuggestions();
      if (pageContext) {
        render(pageContext.links, pageContext.meta, pageContext.link_check);
        scheduleUserProfileWrite();
      }
      input.focus();
    }

    const LS_RECENT_SEARCHES_KEY = "proxyList_recent_searches_v1";
    const RECENT_SEARCH_LIMIT = 8;
    let searchPaletteItems = [];
    let searchPaletteActive = -1;

    function isMacLikeShortcutPlatform() {
      const platform = parseClientPlatform();
      if (platform.os === "ios") return true;
      const p = String(navigator.platform || "") + " " + String(navigator.userAgent || "");
      return /Mac/i.test(p) && platform.os !== "android";
    }

    function isMobileQuickSearchHint() {
      return parseClientPlatform().isMobile;
    }

    function updateQuickSearchPaletteHint() {
      const el = $("quickSearchPaletteHint");
      if (!el) return;
      if (isMobileQuickSearchHint()) {
        el.textContent = "Tap for Quick Search Palette";
        return;
      }
      el.innerHTML = isMacLikeShortcutPlatform()
        ? "<kbd>Cmd</kbd><kbd>Y</kbd> Quick Search Palette"
        : "<kbd>Ctrl</kbd><kbd>Y</kbd> Quick Search Palette";
    }

    function updateSearchPaletteCloseHint() {
      const hint = $("searchPaletteShortcutHint");
      if (!hint) return;
      if (isMobileQuickSearchHint()) {
        hint.textContent = "×";
        hint.classList.add("is-close");
        hint.setAttribute("aria-label", "Close search");
        hint.setAttribute("title", "Close");
        return;
      }
      hint.textContent = isMacLikeShortcutPlatform() ? "⌘Y" : "Ctrl+Y";
      hint.classList.remove("is-close");
      hint.setAttribute("aria-label", "Close search");
      hint.setAttribute("title", isMacLikeShortcutPlatform() ? "⌘Y" : "Ctrl+Y");
    }

    function readRecentSearches() {
      try {
        const raw = JSON.parse(localStorage.getItem(LS_RECENT_SEARCHES_KEY) || "[]");
        if (!Array.isArray(raw)) return [];
        return raw
          .map((v) => String(v || "").trim())
          .filter(Boolean)
          .slice(0, RECENT_SEARCH_LIMIT);
      } catch (_) {
        return [];
      }
    }

    function rememberRecentSearch(query) {
      const q = String(query || "").trim();
      if (!q) return;
      const next = [q, ...readRecentSearches().filter((v) => v.toLowerCase() !== q.toLowerCase())].slice(
        0,
        RECENT_SEARCH_LIMIT
      );
      try {
        localStorage.setItem(LS_RECENT_SEARCHES_KEY, JSON.stringify(next));
      } catch (_) {}
    }

    function isSearchPaletteOpen() {
      const bd = $("searchPaletteBackdrop");
      return !!(bd && bd.classList.contains("open"));
    }

    function closeSearchPalette() {
      const bd = $("searchPaletteBackdrop");
      if (!bd) return;
      bd.classList.remove("open");
      bd.setAttribute("aria-hidden", "true");
    }

    function collectPaletteItems(query) {
      const q = String(query || "").trim().toLowerCase();
      const recents = readRecentSearches().map((value) => ({
        kind: "recent",
        value,
        label: value,
        meta: "Recent",
      }));
      if (!q) {
        const providers = ((searchSuggestIndex && searchSuggestIndex.providers) || []).slice(0, 8).map((item) => ({
          kind: "provider",
          value: item.value,
          label: item.label,
          meta: "Provider",
        }));
        const api = window.ProxyListGameDbSearch;
        const selectedTags = getSelectedGdbSearchTags();
        const selectedSet = selectedTags === null ? null : new Set(selectedTags);
        const gdbDbs =
          api && typeof api.listCatalogs === "function"
            ? api
                .listCatalogs()
                .filter((cat) => selectedSet === null || selectedSet.has(cat.tag))
                .map((cat) => ({
                  kind: "gdb-database",
                  value: cat.tag,
                  label: cat.label,
                  meta: "Game DB",
                  tags: [cat.tag],
                  tag: cat.tag,
                }))
            : [];
        // Empty query: show recents, else providers + known game databases.
        if (recents.length) return recents;
        return providers.concat(gdbDbs).slice(0, 12);
      }
      const fromRecent = recents.filter((item) => item.label.toLowerCase().includes(q));
      const matches = collectSearchSuggestions(query).map((item) => ({
        kind: item.kind,
        value: item.value,
        label: item.label,
        meta:
          item.kind === "provider"
            ? "Provider"
            : item.kind === "contributor"
              ? "Contributor"
              : item.kind === "gdb-database"
                ? "Game DB"
                : item.kind === "gdb-game"
                  ? item.tags && item.tags.length > 1
                    ? item.tags.length + " databases"
                    : "Game"
                  : item.value,
        tags: item.tags,
        tag: item.tag,
      }));
      const seen = new Set();
      const out = [];
      for (const item of fromRecent.concat(matches)) {
        const key = item.kind + ":" + String(item.value).toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(item);
      }
      return out.slice(0, 12);
    }

    function renderSearchPaletteList() {
      const input = $("searchPaletteInput");
      const list = $("searchPaletteList");
      const heading = $("searchPaletteHeading");
      const empty = $("searchPaletteEmpty");
      if (!input || !list) return;
      const query = String(input.value || "").trim();
      searchPaletteItems = collectPaletteItems(query);
      if (searchPaletteActive >= searchPaletteItems.length) searchPaletteActive = searchPaletteItems.length - 1;
      if (heading) {
        heading.textContent = query
          ? "Results"
          : readRecentSearches().length
            ? "Recent searches"
            : "Providers & game databases";
      }
      if (empty) empty.hidden = searchPaletteItems.length > 0;
      list.innerHTML = searchPaletteItems
        .map((item, i) => {
          return (
            '<li role="presentation">' +
            '<button type="button" class="search-palette-item' +
            (i === searchPaletteActive ? " is-active" : "") +
            '" role="option" data-palette-index="' +
            i +
            '" aria-selected="' +
            (i === searchPaletteActive ? "true" : "false") +
            '">' +
            '<span class="search-palette-item-name">' +
            escapeHtml(item.label) +
            "</span>" +
            '<span class="search-palette-item-meta">' +
            escapeHtml(item.meta || "") +
            "</span>" +
            "</button></li>"
          );
        })
        .join("");
    }

    function applyPaletteQuery(query) {
      const q = String(query || "").trim();
      const input = $("q");
      if (input) input.value = q;
      if (q) rememberRecentSearch(q);
      hideSearchSuggestions();
      closeSearchPalette();
      if (pageContext) {
        scheduleRenderFromPageContext();
        scheduleUserProfileWrite();
      }
      const target = $("stats") || $("tableWrap");
      if (target && typeof target.scrollIntoView === "function") {
        target.scrollIntoView({ behavior: "smooth", block: "start" });
      }
    }

    function applyPaletteActiveOrQuery() {
      const input = $("searchPaletteInput");
      const typed = input ? String(input.value || "").trim() : "";
      if (searchPaletteActive >= 0 && searchPaletteItems[searchPaletteActive]) {
        const item = searchPaletteItems[searchPaletteActive];
        if (item.kind === "gdb-database" || item.kind === "gdb-game") {
          closeSearchPalette();
          applyGdbSearchSuggestion(item);
          rememberRecentSearch(item.label);
          return;
        }
        applyPaletteQuery(item.value);
        return;
      }
      void (async () => {
        if (!typed) {
          applyPaletteQuery("");
          return;
        }
        const applied = await tryApplyGameSearchFromQuery(typed);
        if (applied) {
          rememberRecentSearch(typed);
          closeSearchPalette();
          return;
        }
        applyPaletteQuery(typed);
      })();
    }

    function openSearchPalette() {
      const bd = $("searchPaletteBackdrop");
      const input = $("searchPaletteInput");
      if (!bd || !input) return;
      const sidebarQ = $("q");
      input.value = sidebarQ ? String(sidebarQ.value || "") : "";
      searchPaletteActive = -1;
      renderSearchPaletteList();
      bd.classList.add("open");
      bd.setAttribute("aria-hidden", "false");
      setTimeout(() => {
        input.focus();
        input.select();
      }, 0);
    }

    function wireSearchPalette() {
      const bd = $("searchPaletteBackdrop");
      const input = $("searchPaletteInput");
      const list = $("searchPaletteList");
      const hint = $("searchPaletteShortcutHint");
      const hintBtn = $("quickSearchPaletteHint");
      if (!bd || !input || bd.dataset.wired === "1") return;
      bd.dataset.wired = "1";
      updateSearchPaletteCloseHint();
      updateQuickSearchPaletteHint();
      if (hint) {
        hint.addEventListener("click", (ev) => {
          ev.preventDefault();
          closeSearchPalette();
        });
      }
      if (hintBtn) {
        hintBtn.addEventListener("click", () => {
          if (isSearchPaletteOpen()) closeSearchPalette();
          else openSearchPalette();
        });
      }

      document.addEventListener(
        "keydown",
        (ev) => {
          const key = String(ev.key || "").toLowerCase();
          if ((ev.ctrlKey || ev.metaKey) && !ev.altKey && key === "y") {
            ev.preventDefault();
            if (isSearchPaletteOpen()) closeSearchPalette();
            else openSearchPalette();
            return;
          }
          if (!isSearchPaletteOpen()) return;
          if (ev.key === "Escape") {
            ev.preventDefault();
            ev.stopPropagation();
            closeSearchPalette();
            return;
          }
          if (ev.target !== $("searchPaletteInput") && ev.target && ev.target.closest && ev.target.closest(".search-palette")) {
            return;
          }
          if (ev.key === "ArrowDown") {
            if (!searchPaletteItems.length) return;
            ev.preventDefault();
            if (searchPaletteActive < 0) searchPaletteActive = 0;
            else searchPaletteActive = Math.min(searchPaletteItems.length - 1, searchPaletteActive + 1);
            renderSearchPaletteList();
            return;
          }
          if (ev.key === "ArrowUp") {
            if (!searchPaletteItems.length) return;
            ev.preventDefault();
            if (searchPaletteActive < 0) searchPaletteActive = searchPaletteItems.length - 1;
            else searchPaletteActive = Math.max(0, searchPaletteActive - 1);
            renderSearchPaletteList();
            return;
          }
          if (ev.key === "Enter") {
            ev.preventDefault();
            applyPaletteActiveOrQuery();
          }
        },
        true
      );

      input.addEventListener("input", () => {
        searchPaletteActive = -1;
        renderSearchPaletteList();
        scheduleGdbSuggestionRefresh(input.value, "palette");
      });
      list.addEventListener("mousedown", (ev) => {
        const btn = ev.target && ev.target.closest ? ev.target.closest(".search-palette-item") : null;
        if (!btn) return;
        ev.preventDefault();
        const idx = Number(btn.getAttribute("data-palette-index"));
        searchPaletteActive = Number.isFinite(idx) ? idx : 0;
        applyPaletteActiveOrQuery();
      });
      bd.addEventListener("click", (ev) => {
        if (ev.target === bd) closeSearchPalette();
      });
    }

    wireSearchPalette();
    wireFacetHoverTips();

    function wireSearchAutocomplete(rows) {
      buildSearchSuggestIndex(rows);
      const input = $("q");
      const list = $("qSuggest");
      if (!input || !list || input.dataset.suggestWired === "1") return;
      input.dataset.suggestWired = "1";

      input.addEventListener("input", () => {
        searchSuggestActive = -1;
        renderSearchSuggestions(input.value);
        scheduleGdbSuggestionRefresh(input.value, "sidebar");
      });
      input.addEventListener("keydown", (ev) => {
        const open = list && !list.hidden && searchSuggestItems.length > 0;
        if (ev.key === "ArrowDown") {
          if (!open) {
            renderSearchSuggestions(input.value);
            if (!searchSuggestItems.length) return;
          }
          ev.preventDefault();
          if (searchSuggestActive < 0) searchSuggestActive = 0;
          else searchSuggestActive = Math.min(searchSuggestItems.length - 1, searchSuggestActive + 1);
          paintSearchSuggestActive();
          input.setAttribute("aria-activedescendant", "qSuggestOpt" + searchSuggestActive);
          return;
        }
        if (ev.key === "ArrowUp") {
          if (!open) return;
          ev.preventDefault();
          if (searchSuggestActive < 0) searchSuggestActive = searchSuggestItems.length - 1;
          else searchSuggestActive = Math.max(0, searchSuggestActive - 1);
          paintSearchSuggestActive();
          input.setAttribute("aria-activedescendant", "qSuggestOpt" + searchSuggestActive);
          return;
        }
        if (ev.key === "Escape") {
          if (open) {
            ev.preventDefault();
            hideSearchSuggestions();
          }
          return;
        }
        if (ev.key === "Tab" && open && searchSuggestActive >= 0) {
          const item = searchSuggestItems[searchSuggestActive];
          if (!item) return;
          ev.preventDefault();
          applySearchSuggestion(item);
          return;
        }
        if (ev.key === "Enter") {
          if (open && searchSuggestActive >= 0) {
            const item = searchSuggestItems[searchSuggestActive];
            if (item) {
              ev.preventDefault();
              applySearchSuggestion(item);
              return;
            }
          }
          ev.preventDefault();
          hideSearchSuggestions();
          const typed = String(input.value || "").trim();
          if (!typed) return;
          void (async () => {
            const applied = await tryApplyGameSearchFromQuery(typed);
            rememberRecentSearch(typed);
            if (!applied && pageContext) {
              scheduleRenderFromPageContext();
              scheduleUserProfileWrite();
            }
          })();
        }
      });
      input.addEventListener("blur", () => {
        // Allow click on a suggestion to register before hiding.
        setTimeout(() => {
          if (document.activeElement && list.contains(document.activeElement)) return;
          hideSearchSuggestions();
        }, 120);
      });
      list.addEventListener("mousedown", (ev) => {
        const btn = ev.target && ev.target.closest ? ev.target.closest(".search-suggest-item") : null;
        if (!btn) return;
        ev.preventDefault();
        const idx = Number(btn.getAttribute("data-suggest-index"));
        const item = searchSuggestItems[idx];
        if (item) applySearchSuggestion(item);
      });
    }

    function trustedListRowsByNorm() {
      const map = new Map();
      if (!pageContext || !Array.isArray(pageContext.links)) return map;
      for (const row of pageContext.links) {
        const n = normalizeUrlKeyForClicks(row && row.link);
        if (n && !map.has(n)) map.set(n, row);
      }
      return map;
    }

    /** Keep only URLs that exist on the loaded sorted list (same normalization as the table). */
    function sanitizeFolderItemsToTrustedOrder(items) {
      const trusted = trustedListRowsByNorm();
      if (!trusted.size) {
        return normalizeFolderItemsList(items);
      }
      const out = [];
      const seen = new Set();
      for (const u of items || []) {
        const n = normalizeUrlKeyForClicks(u);
        if (!n || !trusted.has(n) || seen.has(n)) continue;
        seen.add(n);
        out.push(n);
      }
      return out;
    }

    function scheduleRenderFromPageContext() {
      if (!pageContext) return;
      void renderAfterHeavyFilter(pageContext.links, pageContext.meta, pageContext.link_check);
    }

    function applyContributorSearch(name) {
      const query = String(name || "").trim();
      const q = $("q");
      if (q) {
        q.value = query;
        if (query) rememberRecentSearch(query);
        hideSearchSuggestions();
        try {
          q.focus();
        } catch (_) {}
      }
      if (pageContext) {
        scheduleRenderFromPageContext();
        scheduleUserProfileWrite();
      }
      const target = $("stats") || $("tableWrap");
      if (target && typeof target.scrollIntoView === "function") {
        target.scrollIntoView({ behavior: "smooth", block: "start" });
      }
    }

    function formatContributorCell(r) {
      const label = r.contributor != null ? String(r.contributor) : "";
      const href = r.contributor_url && String(r.contributor_url).trim();
      const youMark = contributorMatchesViewer(r) ? ' <span class="contributor-you">YOU</span>' : "";
      if (href) {
        return (
          '<a href="' +
          escapeAttr(href) +
          '" rel="noopener noreferrer" target="_blank">' +
          escapeHtml(label) +
          "</a>" +
          youMark
        );
      }
      if (!label || label.toLowerCase() === "n/a") return escapeHtml(label) + youMark;
      return (
        '<button type="button" class="contributor-search-btn" data-contributor-query="' +
        escapeAttr(label) +
        '" title="Show links contributed by ' +
        escapeAttr(label) +
        '">' +
        escapeHtml(label) +
        "</button>" +
        youMark
      );
    }

    function selectedCaps() {
      return [...document.querySelectorAll("#capTags input:checked")].map((i) => i.value);
    }

    function selectedIn(containerId) {
      return [...document.querySelectorAll("#" + containerId + " input:checked")].map((i) => i.value);
    }

    function capMode() {
      const m = document.querySelector('input[name="capMode"]:checked');
      return m ? m.value : "any";
    }

    function rowMatchesCaps(row, selected) {
      if (!selected.length) return true;
      const tags = new Set(row.capability_tags || []);
      if (capMode() === "all") {
        return selected.every((s) => tags.has(s));
      }
      return selected.some((s) => tags.has(s));
    }

    function rowMatchesGroup(row, group, selected, mode) {
      if (!selected.length) return true;
      if (group === "providerTags") return selected.includes(row.provider || "");
      if (group === "categoryTags") return selected.includes(canonicalCategory(row.category));
      if (group === "protocolTags") {
        const pt = row.protocol_tags || [];
        return selected.some((p) => pt.includes(p));
      }
      if (group === "capTags") {
        const tags = new Set(row.capability_tags || []);
        if (mode === "all") return selected.every((s) => tags.has(s));
        return selected.some((s) => tags.has(s));
      }
      return true;
    }

    function tsMs(ts) {
      if (!ts) return 0;
      if (typeof ts.toMillis === "function") return ts.toMillis();
      if (typeof ts.seconds === "number") return ts.seconds * 1000;
      return 0;
    }

    function normalizeFolderItemsList(items) {
      const out = [];
      const seen = new Set();
      (items || []).forEach((u) => {
        const n = normalizeUrlKeyForClicks(u);
        if (n && !seen.has(n)) {
          seen.add(n);
          out.push(n);
        }
      });
      return out;
    }

    function folderItemsOrderedRaw() {
      return ((folderDocSnap && folderDocSnap.items) || [])
        .map((u) => normalizeUrlKeyForClicks(u))
        .filter(Boolean);
    }

    function orderRowsByFolderNorms(rows, normsOrdered) {
      const map = new Map();
      for (const row of rows) {
        const n = normalizeUrlKeyForClicks(row.link);
        if (n) map.set(n, row);
      }
      const out = [];
      for (const n of normsOrdered) {
        if (map.has(n)) out.push(map.get(n));
      }
      return out;
    }

    function buildFolderShareUrl(folderId) {
      const id = sanitizeFolderDocId(folderId);
      if (!id) return "./";
      try {
        const u = new URL(window.location.href);
        u.search = "";
        u.searchParams.set("folder", id);
        return u.toString();
      } catch (_) {
        return "./?folder=" + encodeURIComponent(id);
      }
    }

    function isViewingOwnFolder() {
      return (
        !!viewingFolderId &&
        !!folderDocSnap &&
        !!authUser &&
        !authUser.isAnonymous &&
        authUser.uid === folderDocSnap.ownerUid
      );
    }

    function detachFolderDocListener() {
      if (folderDocUnsub) {
        try {
          folderDocUnsub();
        } catch (_) {}
        folderDocUnsub = null;
      }
    }

    function detachMyFoldersListener() {
      if (myFoldersQueryUnsub) {
        try {
          myFoldersQueryUnsub();
        } catch (_) {}
        myFoldersQueryUnsub = null;
      }
    }

    function attachFolderDocListener() {
      detachFolderDocListener();
      if (!viewingFolderId) {
        folderViewState = "idle";
        folderDocSnap = null;
        return;
      }
      if (!firebaseDb) {
        folderViewState = viewingFolderId ? "missing" : "idle";
        folderDocSnap = null;
        updateSavedViewUI();
        return;
      }
      folderViewState = "loading";
      folderDocSnap = null;
      const ref = firebaseDb.collection("savedFolders").doc(viewingFolderId);
      folderDocUnsub = ref.onSnapshot(
        (snap) => {
          if (!snap.exists) {
            folderViewState = "missing";
            folderDocSnap = null;
          } else {
            folderViewState = "ready";
            folderDocSnap = snap.data() || {};
          }
          updateSavedViewUI();
          if (pageContext) scheduleRenderFromPageContext();
        },
        (err) => {
          console.warn("[proxy-list] Folder snapshot failed", err);
          folderViewState = isFirestorePermissionDenied(err) ? "denied" : "missing";
          folderDocSnap = null;
          updateSavedViewUI();
          if (pageContext) scheduleRenderFromPageContext();
        }
      );
    }

    function startFolderAndMyFoldersListeners() {
      if (viewingFolderId) attachFolderDocListener();
      else detachFolderDocListener();
      detachMyFoldersListener();
      if (!savedLinksViewOnly || viewingFolderId || !isSignedInUser() || !firebaseDb) {
        myFoldersList = [];
        renderFolderChromeIntoHost();
        return;
      }
      void ensureAuthForFirestore().then((user) => {
        if (!user || !savedLinksViewOnly || viewingFolderId || !firebaseDb) return;
        const q = firebaseDb.collection("savedFolders").where("ownerUid", "==", user.uid);
        myFoldersQueryUnsub = q.onSnapshot(
          (snap) => {
            myFoldersList = snap.docs.map((d) => ({ id: d.id, data: d.data() || {} }));
            myFoldersList.sort((a, b) => tsMs(b.data.updated) - tsMs(a.data.updated));
            renderFolderChromeIntoHost();
          },
          (err) => {
            console.warn("[proxy-list] Folder list query failed", err);
            myFoldersList = [];
            renderFolderChromeIntoHost();
          }
        );
      });
    }

    async function persistFolderItemsUpdate(newItems) {
      if (!viewingFolderId || !isViewingOwnFolder() || !firebaseDb) return;
      const user = await ensureAuthForFirestore();
      if (!user) return;
      const norms = sanitizeFolderItemsToTrustedOrder(newItems);
      await firebaseDb
        .collection("savedFolders")
        .doc(viewingFolderId)
        .update({
          items: norms,
          updated: firebase.firestore.FieldValue.serverTimestamp(),
        });
    }

    async function folderRowMove(idx, dir) {
      const arr = folderItemsOrderedRaw();
      const j = idx + (dir === "up" ? -1 : 1);
      if (idx < 0 || idx >= arr.length || j < 0 || j >= arr.length) return;
      const t = arr[idx];
      arr[idx] = arr[j];
      arr[j] = t;
      await persistFolderItemsUpdate(arr);
    }

    async function folderRowRemove(idx) {
      const arr = folderItemsOrderedRaw();
      if (idx < 0 || idx >= arr.length) return;
      arr.splice(idx, 1);
      await persistFolderItemsUpdate(arr);
    }

    async function copyFolderShareLink() {
      if (!viewingFolderId) return;
      const url = buildFolderShareUrl(viewingFolderId);
      const ok = await copyPlainTextToClipboard(url);
      if (!ok) window.prompt("Copy this link", url);
    }

    async function createUserFolder() {
      const user = await ensureAuthForFirestore();
      if (!user || !firebaseDb) {
        window.alert("Sign in to create folders.");
        return;
      }
      const title = window.prompt("Folder name", "My folder");
      if (title == null) return;
      const t = String(title).trim().slice(0, 200);
      if (!t) return;
      try {
        const ref = await firebaseDb.collection("savedFolders").add({
          ownerUid: user.uid,
          ownerLabel: folderOwnerLabelForFirestore(user) || "Member",
          title: t,
          ...folderVisibilityFieldsForFirestore("private"),
          items: [],
          created: firebase.firestore.FieldValue.serverTimestamp(),
          updated: firebase.firestore.FieldValue.serverTimestamp(),
        });
        window.location.href = buildFolderShareUrl(ref.id);
      } catch (err) {
        console.warn("[proxy-list] Create folder failed", err);
        window.alert("Could not create folder. Deploy updated Firestore rules if this persists.");
      }
    }

    async function saveFolderMetaFromForm() {
      if (!viewingFolderId || !isViewingOwnFolder() || !firebaseDb) return;
      const titleEl = $("folderMetaTitle");
      const title = titleEl ? String(titleEl.value || "").trim().slice(0, 200) : "";
      if (!title) {
        window.alert("Title is required.");
        return;
      }
      const sel = typeof document !== "undefined"
        ? document.querySelector('input[name="folderMetaVisibility"]:checked')
        : null;
      const vis = normalizeFolderVisibilityChoice(sel ? sel.value : "");
      const user = await ensureAuthForFirestore();
      if (!user) return;
      try {
        await firebaseDb.collection("savedFolders").doc(viewingFolderId).update({
          title,
          ...folderVisibilityFieldsForFirestore(vis),
          ownerLabel: folderOwnerLabelForDirectory(),
          updated: firebase.firestore.FieldValue.serverTimestamp(),
        });
      } catch (err) {
        console.warn("[proxy-list] Save folder meta failed", err);
        window.alert("Could not save folder settings.");
      }
    }

    async function importStarredIntoFolder() {
      if (!viewingFolderId || !isViewingOwnFolder() || !firebaseDb) return;
      const trusted = trustedListRowsByNorm();
      const merged = folderItemsOrderedRaw();
      const have = new Set(merged);
      let added = 0;
      for (const n of savedLinks) {
        if (!trusted.has(n)) continue;
        if (!have.has(n)) {
          have.add(n);
          merged.push(n);
          added++;
        }
      }
      if (!added) {
        window.alert("No starred links from the list to import, or the folder already has them.");
        return;
      }
      await persistFolderItemsUpdate(merged);
    }

    async function deleteFolderDoc() {
      if (!viewingFolderId || !isViewingOwnFolder() || !firebaseDb) return;
      if (!window.confirm("Delete this folder permanently?")) return;
      try {
        await firebaseDb.collection("savedFolders").doc(viewingFolderId).delete();
        window.location.href = new URL("./?saved=1", window.location.href).href;
      } catch (err) {
        console.warn("[proxy-list] Delete folder failed", err);
        window.alert("Could not delete folder.");
      }
    }

    function folderTrustedPickerRowHtml(r) {
      const link = String(r.link || "");
      return (
        '<div class="folder-trusted-row">' +
        '<span class="folder-trusted-row-main">' +
        formatProviderCell(r.provider, r.github_url) +
        '<span class="folder-trusted-row-url">' +
        escapeHtml(link) +
        "</span></span>" +
        '<button type="button" class="btn" data-folder-add-link="' +
        escapeAttr(link) +
        '">Add</button></div>'
      );
    }

    function appendFolderTrustedPickerRows(inner) {
      if (!inner) return;
      const chunk = FOLDER_TRUSTED_PICKER_CHUNK;
      const start = folderTrustedPickerOffset;
      const end = Math.min(start + chunk, folderTrustedPickerMatches.length);
      if (start >= end) return;
      const slice = folderTrustedPickerMatches.slice(start, end);
      folderTrustedPickerOffset = end;
      insertAdjacentHtmlSafe(inner, "beforeend", slice.map(folderTrustedPickerRowHtml).join(""));
    }

    function updateFolderTrustedPickerMeta() {
      const meta = $("folderTrustedPickerMeta");
      if (!meta) return;
      const total = folderTrustedPickerMatches.length;
      const shown = Math.min(folderTrustedPickerOffset, total);
      if (!total) {
        meta.textContent = "";
        return;
      }
      const rest = total - shown;
      meta.textContent =
        shown +
        " of " +
        total +
        " shown" +
        (rest > 0 ? " · scroll for more" : " · end of list");
    }

    function maybeLoadMoreFolderTrustedRows(scroller, inner) {
      if (!scroller || !inner) return;
      let guard = 0;
      while (
        guard++ < 48 &&
        folderTrustedPickerOffset < folderTrustedPickerMatches.length &&
        scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 72
      ) {
        appendFolderTrustedPickerRows(inner);
      }
      updateFolderTrustedPickerMeta();
    }

    function ensureFolderTrustedPickerFilledViewport(scroller, inner) {
      if (!scroller || !inner) return;
      let attempts = 0;
      function tick() {
        if (folderTrustedPickerOffset >= folderTrustedPickerMatches.length) {
          updateFolderTrustedPickerMeta();
          return;
        }
        if (inner.scrollHeight > scroller.clientHeight + 8 || attempts++ > 240) {
          updateFolderTrustedPickerMeta();
          return;
        }
        appendFolderTrustedPickerRows(inner);
        requestAnimationFrame(tick);
      }
      requestAnimationFrame(tick);
    }

    function refreshFolderTrustedSearchUI(query) {
      const wrap = $("folderTrustedResults");
      if (!wrap) return;
      folderTrustedSearchLastQuery = String(query != null ? query : "");
      const q = folderTrustedSearchLastQuery.trim().toLowerCase();
      const inFolder = new Set(folderItemsOrderedRaw());
      const rows = pageContext && Array.isArray(pageContext.links) ? pageContext.links : [];
      if (!rows.length) {
        folderTrustedPickerMatches = [];
        folderTrustedPickerOffset = 0;
        setHtml(
          wrap,
          "<p class=\"sub\" style=\"padding:0.45rem 0.55rem\">The sorted link list is not loaded yet — refresh the page.</p>"
        );
        return;
      }
      const matches = [];
      if (!q) {
        for (const r of rows) {
          const n = normalizeUrlKeyForClicks(r.link);
          if (n && !inFolder.has(n)) matches.push(r);
        }
      } else {
        for (const r of rows) {
          const n = normalizeUrlKeyForClicks(r.link);
          if (!n || inFolder.has(n)) continue;
          if (haystack(r).includes(q)) matches.push(r);
        }
      }
      if (!matches.length) {
        folderTrustedPickerMatches = [];
        folderTrustedPickerOffset = 0;
        setHtml(
          wrap,
          "<p class=\"sub\" style=\"padding:0.45rem 0.55rem\">" +
            (q
              ? "No list rows match that search (or every match is already in this folder)."
              : "No more rows to suggest, or every list row is already in this folder.") +
            "</p>"
        );
        return;
      }
      folderTrustedPickerMatches = matches;
      folderTrustedPickerOffset = 0;
      setHtml(
        wrap,
        '<div id="folderTrustedPickerMeta" class="folder-trusted-results-meta sub"></div>' +
          '<div id="folderTrustedRowsScroller" class="folder-trusted-results-scroll">' +
          '<div id="folderTrustedRowsInner"></div></div>'
      );
      const inner = $("folderTrustedRowsInner");
      const scroller = $("folderTrustedRowsScroller");
      appendFolderTrustedPickerRows(inner);
      updateFolderTrustedPickerMeta();
      ensureFolderTrustedPickerFilledViewport(scroller, inner);
      if (scroller) {
        scroller.onscroll = () => {
          maybeLoadMoreFolderTrustedRows(scroller, inner);
        };
      }
    }

    function scheduleFolderTrustedSearchRefresh() {
      if (folderTrustedSearchTimer) clearTimeout(folderTrustedSearchTimer);
      folderTrustedSearchTimer = setTimeout(() => {
        folderTrustedSearchTimer = null;
        const el = $("folderTrustedSearch");
        refreshFolderTrustedSearchUI(el ? el.value : folderTrustedSearchLastQuery);
      }, 140);
    }

    async function addTrustedLinkUrlToFolder(url) {
      if (!viewingFolderId || !isViewingOwnFolder() || !firebaseDb) return;
      const trusted = trustedListRowsByNorm();
      const n = normalizeUrlKeyForClicks(url);
      if (!n || !trusted.has(n)) {
        window.alert("Only links that appear on this site’s sorted list can be added.");
        return;
      }
      const merged = folderItemsOrderedRaw();
      if (merged.includes(n)) {
        window.alert("That link is already in this folder.");
        return;
      }
      merged.push(n);
      await persistFolderItemsUpdate(merged);
      const sIn = $("folderTrustedSearch");
      refreshFolderTrustedSearchUI(sIn ? sIn.value : folderTrustedSearchLastQuery);
    }

    function wireFolderChromeButtons() {
      const copyBtn = $("folderCopyShareBtn");
      if (copyBtn) copyBtn.onclick = () => void copyFolderShareLink();
      const createBtn = $("folderCreateNewBtn");
      if (createBtn) createBtn.onclick = () => void createUserFolder();
      const saveMeta = $("folderSaveMetaBtn");
      if (saveMeta) saveMeta.onclick = () => void saveFolderMetaFromForm();
      const delBtn = $("folderDeleteBtn");
      if (delBtn) delBtn.onclick = () => void deleteFolderDoc();
      const reportBtn = $("folderReportBtn");
      if (reportBtn) {
        reportBtn.onclick = () => {
          if (!folderDocSnap || !viewingFolderId) return;
          openFolderReportModal({
            folderId: viewingFolderId,
            title: String(folderDocSnap.title || "Folder"),
            ownerUid: String(folderDocSnap.ownerUid || ""),
            ownerLabel: String(folderDocSnap.ownerLabel || "—"),
          });
        };
      }
      const searchIn = $("folderTrustedSearch");
      if (searchIn) {
        searchIn.value = folderTrustedSearchLastQuery;
        searchIn.oninput = () => {
          folderTrustedSearchLastQuery = String(searchIn.value || "");
          scheduleFolderTrustedSearchRefresh();
        };
        refreshFolderTrustedSearchUI(folderTrustedSearchLastQuery);
      }
      const impBtn = $("folderImportSavedBtn");
      if (impBtn) impBtn.onclick = () => void importStarredIntoFolder();
    }

    let folderReportContext = null;

    function closeFolderReportModal() {
      folderReportContext = null;
      const modal = $("folderReportModal");
      if (modal) {
        modal.classList.remove("open");
        modal.setAttribute("aria-hidden", "true");
      }
    }

    function openFolderReportModal(ctx) {
      if (!ctx || !ctx.folderId) return;
      if (!isSignedInUser()) {
        openSignInRequiredModal("You need to be signed in to report a folder.");
        return;
      }
      if (communityFeaturesBlocked) {
        window.alert("Your account is suspended from community features, so you cannot submit reports.");
        return;
      }
      if (authUser && ctx.ownerUid && authUser.uid === ctx.ownerUid) {
        window.alert("You cannot report your own folder.");
        return;
      }
      folderReportContext = ctx;
      const summary = $("folderReportSummary");
      if (summary) {
        summary.textContent =
          "Folder: “" +
          String(ctx.title || "").slice(0, 200) +
          "” · Creator: " +
          String(ctx.ownerLabel || "—").slice(0, 120);
      }
      const nameCb = $("folderReportNameCb");
      const creatorCb = $("folderReportCreatorCb");
      const reason = $("folderReportReason");
      if (nameCb) nameCb.checked = true;
      if (creatorCb) creatorCb.checked = false;
      if (reason) reason.value = "";
      const modal = $("folderReportModal");
      if (modal) {
        modal.classList.add("open");
        modal.setAttribute("aria-hidden", "false");
      }
    }

    async function submitFolderReport() {
      if (!folderReportContext || !firebaseDb) return;
      const user = await ensureAuthForFirestore();
      if (!user || user.isAnonymous) {
        openSignInRequiredModal("You need to be signed in to report a folder.");
        return;
      }
      if (!(await ensureCommunityFeaturesAllowed())) return;
      const ctx = folderReportContext;
      if (ctx.ownerUid && user.uid === ctx.ownerUid) {
        window.alert("You cannot report your own folder.");
        return;
      }
      const reportName = !!($("folderReportNameCb") && $("folderReportNameCb").checked);
      const reportCreator = !!($("folderReportCreatorCb") && $("folderReportCreatorCb").checked);
      if (!reportName && !reportCreator) {
        window.alert("Select at least one: folder name or creator’s name.");
        return;
      }
      const reason = String(($("folderReportReason") && $("folderReportReason").value) || "").trim();
      if (!reason || reason.length > 2000) {
        window.alert("Enter a reason (1–2000 characters).");
        return;
      }
      const folderId = sanitizeFolderDocId(ctx.folderId);
      if (!folderId) return;
      const reportId = user.uid + "_" + folderId;
      const label =
        (window.SubmissionUtils && window.SubmissionUtils.submitterLabelFromUser
          ? window.SubmissionUtils.submitterLabelFromUser(user)
          : "") ||
        (user.displayName && String(user.displayName).trim()) ||
        "Signed-in user";
      const gh =
        (window.SubmissionUtils && window.SubmissionUtils.githubLoginFromUser
          ? window.SubmissionUtils.githubLoginFromUser(user)
          : "") || "";
      const submitBtn = $("folderReportSubmitBtn");
      if (submitBtn) submitBtn.disabled = true;
      try {
        await firebaseDb.collection("folderReports").doc(reportId).set({
          folderId: folderId,
          folderTitle: String(ctx.title || "Folder").slice(0, 200),
          folderOwnerUid: String(ctx.ownerUid || "").slice(0, 128),
          folderOwnerLabel: String(ctx.ownerLabel || "").slice(0, 120),
          reportFolderName: reportName,
          reportCreatorName: reportCreator,
          reason: reason,
          status: "pending",
          reporterUid: user.uid,
          reporterLabel: String(label).slice(0, 120),
          reporterGithub: String(gh).slice(0, 39),
          created: firebase.firestore.FieldValue.serverTimestamp(),
          updated: firebase.firestore.FieldValue.serverTimestamp(),
        });
        closeFolderReportModal();
        window.alert("Report submitted. The maintainer will review it.");
      } catch (err) {
        console.warn("[proxy-list] folder report failed", err);
        const msg = (err && err.message) || "";
        if (/already exists|permission/i.test(msg) || (err && err.code === "permission-denied")) {
          window.alert(
            "Could not submit report. You may have already reported this folder, or your account cannot report right now."
          );
        } else {
          window.alert("Could not submit report. Try again.");
        }
      } finally {
        if (submitBtn) submitBtn.disabled = false;
      }
    }

    function initFolderReportModal() {
      const cancel = $("folderReportCancelBtn");
      const submit = $("folderReportSubmitBtn");
      const modal = $("folderReportModal");
      if (cancel) cancel.onclick = () => closeFolderReportModal();
      if (submit) submit.onclick = () => void submitFolderReport();
      if (modal) {
        modal.addEventListener("click", (ev) => {
          if (ev.target === modal) closeFolderReportModal();
        });
      }
    }

    function renderFolderChromeIntoHost() {
      const host = $("folderChromeHost");
      if (!host) return;
      let show = false;
      let html = "";
      if (viewingFolderId) {
        show = true;
        if (folderViewState === "loading") {
          html = "<h2>Folder</h2><p class=\"sub\">Loading…</p>";
        } else if (folderViewState === "denied") {
          html =
            "<h2>Private folder</h2><p class=\"sub\">Only the owner account can open this folder (not visible with the share link unless you switch it to Public or Unlisted).</p>";
        } else if (folderViewState === "missing") {
          html = "<h2>Not found</h2><p class=\"sub\">This folder ID does not exist.</p>";
        } else if (folderViewState === "ready" && folderDocSnap) {
          const shareUrl = buildFolderShareUrl(viewingFolderId);
          const owner = isViewingOwnFolder();
          const curVis = folderVisibilityFromDoc(folderDocSnap);
          if (owner) {
            html =
              "<h2>Manage folder</h2>" +
              '<div class="folder-chrome-row"><label>Title <input class="folder-meta-input" id="folderMetaTitle" type="text" maxlength="200" value="' +
              escapeAttr(String(folderDocSnap.title || "")) +
              '" /></label></div>' +
              '<div class="folder-chrome-row folder-vis-choice"><span class="sub">Who can view</span></div>' +
              '<label class="folder-vis-label"><input type="radio" name="folderMetaVisibility" value="public" ' +
              (curVis === "public" ? "checked" : "") +
              ' /> Public — listed on the Community page; anyone can open.</label>' +
              '<label class="folder-vis-label"><input type="radio" name="folderMetaVisibility" value="unlisted" ' +
              (curVis === "unlisted" ? "checked" : "") +
              ' /> Unlisted — not listed; anyone with this link can open.</label>' +
              '<label class="folder-vis-label"><input type="radio" name="folderMetaVisibility" value="private" ' +
              (curVis === "private" ? "checked" : "") +
              ' /> Private — only you (others get “access denied”).</label>' +
              '<div class="folder-chrome-row"><span class="sub">Share</span> <code style="font-size:0.78rem;word-break:break-all">' +
              escapeHtml(shareUrl) +
              '</code> <button type="button" class="btn" id="folderCopyShareBtn">Copy link</button></div>' +
              '<div class="folder-chrome-row"><button type="button" class="btn btn-primary" id="folderSaveMetaBtn">Save title &amp; visibility</button> ' +
              '<button type="button" class="btn" id="folderDeleteBtn">Delete folder</button></div>' +
              '<p class="sub" style="margin:0.35rem 0 0">Edits sync live for everyone who can view this folder.</p>' +
              '<div class="folder-chrome-row" id="folderRatingRow"><span class="sub">Community rating</span> <span id="folderRatingMount"></span></div>' +
              "<h2 style=\"margin-top:0.85rem;font-size:0.95rem\">Add links</h2>" +
              '<p class="sub">Only rows from this site’s sorted list can be added. Search by URL, provider, or contributor — anything not on the list is rejected.</p>' +
              '<label class="sub" for="folderTrustedSearch">Search the list</label>' +
              '<input type="search" class="folder-meta-input" id="folderTrustedSearch" placeholder="Provider, URL, contributor…" autocomplete="off" style="margin-top:0.25rem;display:block;width:100%;max-width:40rem" />' +
              '<div class="folder-trusted-results" id="folderTrustedResults" role="listbox" aria-label="Matching list links"></div>' +
              '<div class="folder-chrome-row"><button type="button" class="btn" id="folderImportSavedBtn">Import starred links (list only)</button></div>';
          } else {
            const ev = folderVisibilityFromDoc(folderDocSnap);
            html =
              "<h2>" +
              escapeHtml(String(folderDocSnap.title || "Folder")) +
              "</h2>" +
              '<p class="sub">Read-only view · ' +
              escapeHtml(ev) +
              ". Live updates from the owner.</p>" +
              '<div class="folder-chrome-row" id="folderRatingRow"><span class="sub">Community rating</span> <span id="folderRatingMount"></span></div>' +
              '<div class="folder-chrome-row"><code style="font-size:0.78rem;word-break:break-all">' +
              escapeHtml(shareUrl) +
              "</code> " +
              '<button type="button" class="btn" id="folderCopyShareBtn">Copy link</button> ' +
              '<button type="button" class="btn" id="folderReportBtn">Report</button></div>';
          }
        }
      } else if (savedLinksViewOnly && isSignedInUser()) {
        show = true;
        html =
          "<h2>Your folders</h2><p class=\"sub\">Create folders, add links, and share with <code>?folder=…</code>. Edits sync live for everyone with access.</p>";
        html +=
          '<div class="folder-chrome-row"><button type="button" class="btn btn-primary" id="folderCreateNewBtn">New folder</button> <a class="btn" href="./">Full list</a></div>';
        if (myFoldersList.length) {
          html += "<ul class=\"folder-my-list\">";
          for (const row of myFoldersList) {
            const t = escapeHtml(String(row.data.title || "(untitled)"));
            const n = (row.data.items && row.data.items.length) || 0;
            html +=
              "<li><a href=\"./?folder=" +
              escapeAttr(row.id) +
              '">' +
              t +
              "</a> <span class=\"sub\">(" +
              n +
              ")</span></li>";
          }
          html += "</ul>";
        } else {
          html += "<p class=\"sub\">No folders yet.</p>";
        }
      }
      host.hidden = !show;
      setHtml(host, html);
      if (!show) return;
      wireFolderChromeButtons();
      if (viewingFolderId && folderViewState === "ready" && firebaseDb) {
        void refreshFolderRatingMount(viewingFolderId);
      }
    }

    function filterRowsBase(rows, opts) {
      const q = $("q").value.trim().toLowerCase();
      const applyHideUnchecked =
        hideLinksWithoutLensCheck &&
        linkLensHydrated &&
        !q &&
        !(opts && opts.selections && opts.selections.providerTags && opts.selections.providerTags.length);
      return rows.filter((row) => {
        if (q && !haystack(row).includes(q)) return false;
        if (hideBlockedBySelectedFilter && isBlockedBySelectedFilter(row.link)) return false;
        if (applyHideUnchecked && !linkHasParsableLensCheck(row.link)) return false;
        const folderNormSet = opts && opts.folderNormSet;
        if (folderNormSet) {
          const norm = normalizeUrlKeyForClicks(row.link);
          if (!norm || !folderNormSet.has(norm)) return false;
        }
        if (savedLinksViewOnly) {
          if (!isSignedInUser()) return false;
          const norm = normalizeUrlKeyForClicks(row.link);
          if (!norm || !savedLinks.has(norm)) return false;
        }
        return true;
      });
    }

    function filterRows(rows, opts) {
      const exclude = (opts && opts.excludeGroup) || "";
      const selections = {
        providerTags: selectedIn("providerTags"),
        categoryTags: selectedIn("categoryTags"),
        protocolTags: selectedIn("protocolTags"),
        capTags: selectedCaps(),
      };
      const mode = capMode();
      const applyHideUnchecked =
        hideLinksWithoutLensCheck &&
        linkLensHydrated &&
        !$("q").value.trim() &&
        !selections.providerTags.length;
      return rows.filter((row) => {
        const q = $("q").value.trim().toLowerCase();
        if (q && !haystack(row).includes(q)) return false;
        if (hideBlockedBySelectedFilter && isBlockedBySelectedFilter(row.link)) return false;
        if (applyHideUnchecked && !linkHasParsableLensCheck(row.link)) return false;
        for (const group of ["providerTags", "categoryTags", "protocolTags", "capTags"]) {
          if (group === exclude) continue;
          if (!rowMatchesGroup(row, group, selections[group], mode)) return false;
        }
        const folderNormSet = opts && opts.folderNormSet;
        if (folderNormSet) {
          const norm = normalizeUrlKeyForClicks(row.link);
          if (!norm || !folderNormSet.has(norm)) return false;
        }
        if (savedLinksViewOnly) {
          if (!isSignedInUser()) return false;
          const norm = normalizeUrlKeyForClicks(row.link);
          if (!norm || !savedLinks.has(norm)) return false;
        }
        return true;
      });
    }

    const FILTER_GROUP_VALUES = {
      providerTags: (r) => [r.provider || ""],
      categoryTags: (r) => [canonicalCategory(r.category)],
      protocolTags: (r) => r.protocol_tags || [],
      capTags: (r) => r.capability_tags || [],
    };

    function updateFilterCounts(rows) {
      const selections = {
        providerTags: selectedIn("providerTags"),
        categoryTags: selectedIn("categoryTags"),
        protocolTags: selectedIn("protocolTags"),
        capTags: selectedCaps(),
      };
      const mode = capMode();
      const base = filterRowsBase(rows, { selections });
      for (const containerId of Object.keys(FILTER_GROUP_VALUES)) {
        const wrap = $(containerId);
        if (!wrap) continue;
        const counts = new Map();
        const valuesOf = FILTER_GROUP_VALUES[containerId];
        for (const row of base) {
          let ok = true;
          for (const group of ["providerTags", "categoryTags", "protocolTags", "capTags"]) {
            if (group === containerId) continue;
            if (!rowMatchesGroup(row, group, selections[group], mode)) {
              ok = false;
              break;
            }
          }
          if (!ok) continue;
          for (const v of valuesOf(row)) {
            counts.set(v, (counts.get(v) || 0) + 1);
          }
        }
        wrap.querySelectorAll(".tag").forEach((label) => {
          const inp = label.querySelector("input");
          const cEl = label.querySelector(".tag-count");
          if (!inp || !cEl) return;
          const n = counts.get(inp.value) || 0;
          cEl.textContent = "(" + n + ") ";
        });
      }
    }

    function scheduleUpdateFilterCounts(rows) {
      if (typeof requestIdleCallback === "function") {
        if (filterCountsIdleHandle) cancelIdleCallback(filterCountsIdleHandle);
        filterCountsIdleHandle = requestIdleCallback(
          () => {
            filterCountsIdleHandle = null;
            updateFilterCounts(rows);
          },
          { timeout: 400 }
        );
        return;
      }
      updateFilterCounts(rows);
    }

    function scheduleRender(rows, meta, linkCheck, options) {
      const opts = options || {};
      const delay = Number.isFinite(opts.debounceMs) ? Math.max(0, opts.debounceMs) : 0;
      if (renderDebounceTimer) clearTimeout(renderDebounceTimer);
      if (delay <= 0) {
        renderDebounceTimer = null;
        void render(rows, meta, linkCheck);
        return;
      }
      renderDebounceTimer = setTimeout(() => {
        renderDebounceTimer = null;
        void render(rows, meta, linkCheck);
      }, delay);
    }

    function formatListVersion(meta) {
      const v = (meta && meta.version) || "";
      const r = (meta && meta.revision) || "";
      if (v && r) return v + r;
      if (v) return v;
      if (r) return r;
      return "—";
    }

    function setFooter(meta) {
      const el = $("listVersionLine");
      if (!el) return;
      el.textContent = formatListVersion(meta);
    }

    /** Smaller batches so the main thread can paint skeleton rows between inserts. */
    const TABLE_ROW_APPEND_BATCH = 25;
    const TABLE_PREFETCH_PX = 400;
    /** Switch to windowed rendering above this many filtered rows. */
    const TABLE_VIRTUAL_THRESHOLD = 200;
    const TABLE_ROW_HEIGHT = 50;
    const TABLE_VIRTUAL_BUFFER = 30;
    let tableInfiniteObserver = null;
    let tableInfiniteState = null;
    let tableInfiniteScrollFallback = null;
    let tableVirtualState = null;
    let tableVirtualScrollHandler = null;
    let tableVirtualResizeHandler = null;
    let tableVirtualCullingZoomHandler = null;
    let renderDebounceTimer = null;
    let filterCountsIdleHandle = null;
    let bulkClickCountCache = null;

    function disconnectTableVirtual() {
      if (tableVirtualScrollHandler) {
        window.removeEventListener("scroll", tableVirtualScrollHandler);
        if (typeof window.removeEventListener === "function") {
          window.removeEventListener("scrollend", tableVirtualScrollHandler);
        }
        tableVirtualScrollHandler = null;
      }
      if (tableVirtualResizeHandler) {
        window.removeEventListener("resize", tableVirtualResizeHandler);
        tableVirtualResizeHandler = null;
      }
      if (tableVirtualCullingZoomHandler) {
        window.removeEventListener("proxylist-culling-zoom", tableVirtualCullingZoomHandler);
        tableVirtualCullingZoomHandler = null;
      }
      tableVirtualState = null;
    }

    function isSearchQueryActive() {
      const q = $("q");
      return !!(q && String(q.value || "").trim());
    }

    function shouldUseVirtualTable(filteredLen) {
      // Search used to hard-cap at 20 rows and disable virtualization; keep
      // windowed rendering for large match sets so every hit stays reachable.
      return !isUnoptimizedTableRender() && filteredLen > TABLE_VIRTUAL_THRESHOLD;
    }

    function getDebugCullingScale() {
      try {
        if (
          window.ProxyListDebug &&
          typeof window.ProxyListDebug.isCullingTestActive === "function" &&
          window.ProxyListDebug.isCullingTestActive() &&
          typeof window.ProxyListDebug.getCullingScale === "function"
        ) {
          const s = Number(window.ProxyListDebug.getCullingScale());
          if (s > 0 && s <= 1) return s;
        }
      } catch (_) {}
      if (document.documentElement.classList.contains("debug-culling-test")) {
        const raw = parseFloat(
          getComputedStyle(document.documentElement).getPropertyValue("--debug-culling-scale")
        );
        if (raw > 0 && raw <= 1) return raw;
      }
      return 1;
    }

    function layoutDocumentTop(el) {
      let y = 0;
      let node = el;
      while (node) {
        y += node.offsetTop || 0;
        node = node.offsetParent;
      }
      return y;
    }

    function getTableChunkWrapTop() {
      // Prefer the main list wrap tied to the virtual tbody. Never use a bare
      // `.table-chunk-wrap` query — "Most opened" renders another one first
      // (even while hidden), which pins the virtual window to the top and
      // makes scrolling through the list look broken.
      const st = tableVirtualState;
      const wrap =
        (st && st.tbody && st.tbody.closest && st.tbody.closest(".table-chunk-wrap")) ||
        document.querySelector("#tableWrap .table-chunk-wrap") ||
        document.querySelector("#mainLinksTableWrap");
      if (!wrap) return 0;
      // Under culling zoom, body is CSS-transformed — client rects are scaled but
      // scrollY is not. Use layout offsets so the virtual window stays aligned.
      if (getDebugCullingScale() < 1) {
        return layoutDocumentTop(wrap);
      }
      return wrap.getBoundingClientRect().top + window.scrollY;
    }

    function virtualTableDataRows(tbody) {
      return tbody.querySelectorAll(
        "tr:not(.virtual-pad-top):not(.virtual-pad-bottom):not(.table-row-skeleton)"
      );
    }

    /** First data row still visible below the sticky header, as { index, top }. */
    function captureVirtualTableAnchor(st) {
      if (!st || st.windowStart < 0) return null;
      const rows = virtualTableDataRows(st.tbody);
      const thead = st.tbody.closest("table") && st.tbody.closest("table").querySelector("thead");
      const minY = Math.max(0, thead ? thead.getBoundingClientRect().bottom : 0);
      for (let i = 0; i < rows.length; i++) {
        const rect = rows[i].getBoundingClientRect();
        if (rect.bottom > minY) return { index: st.windowStart + i, top: rect.top };
      }
      return null;
    }

    /**
     * Rows wrap to different heights, so `start * rowH` padding never matches the rows it
     * replaces. Without this, every repaint nudges rows under the pointer (clicks land on
     * the neighbouring row's rating buttons). Re-pin the anchor row to its old position.
     */
    function restoreVirtualTableAnchor(st, anchor) {
      if (!anchor || !st) return;
      const rows = virtualTableDataRows(st.tbody);
      const offset = anchor.index - st.windowStart;
      if (offset < 0 || offset >= rows.length) return;
      const delta = (rows[offset].getBoundingClientRect().top - anchor.top) / getDebugCullingScale();
      if (Math.abs(delta) < 0.5) return;
      const padTd = st.tbody.querySelector("tr.virtual-pad-top > td");
      if (!padTd) return;
      const nextPad = (parseFloat(padTd.style.height) || 0) - delta;
      padTd.style.height = Math.max(0, nextPad) + "px";
      if (nextPad < 0) window.scrollBy(0, -nextPad);
    }

    function captureLinkRowAnchor(tbody) {
      const rows = virtualTableDataRows(tbody);
      const table = tbody.closest("table");
      const thead = table && table.querySelector("thead");
      const minY = Math.max(0, thead ? thead.getBoundingClientRect().bottom : 0);
      for (let i = 0; i < rows.length; i++) {
        const rect = rows[i].getBoundingClientRect();
        if (rect.bottom > minY) return { row: rows[i], top: rect.top };
      }
      return null;
    }

    /**
     * Apply a cell update without moving rows under the pointer. Rating / open-count text
     * changes resize auto-width columns and re-wrap rows, which shifted neighbouring rows'
     * rating buttons under a click in progress.
     */
    function withStableLinkRows(update) {
      const tbody = $("linksTableBody");
      const anchor = tbody && tbody.isConnected ? captureLinkRowAnchor(tbody) : null;
      update();
      if (!anchor || !anchor.row.isConnected) return;
      const delta = (anchor.row.getBoundingClientRect().top - anchor.top) / getDebugCullingScale();
      if (Math.abs(delta) < 0.5) return;
      const padTd = tbody.querySelector("tr.virtual-pad-top > td");
      const pad = padTd ? parseFloat(padTd.style.height) || 0 : 0;
      if (padTd && pad - delta >= 0) padTd.style.height = pad - delta + "px";
      else window.scrollBy(0, delta);
    }

    /** Measure once from the first painted window, then lock — ongoing averaging
     *  made the virtual window and column wrap keep shifting while scrolling. */
    function refineVirtualTableRowHeight(st) {
      if (!st || st.rowHeightLocked) return;
      const rows = virtualTableDataRows(st.tbody);
      if (rows.length < 4) return;
      let sum = 0;
      for (let i = 0; i < rows.length; i++) sum += rows[i].offsetHeight;
      const avg = sum / rows.length;
      if (!(avg > 0)) return;
      st.rowHeight = Math.max(TABLE_ROW_HEIGHT, avg);
      st.rowHeightLocked = true;
    }

    function paintVirtualTableWindow(force, anchorIn) {
      const st = tableVirtualState;
      if (!st || !st.tbody || !st.tbody.isConnected) return;
      const anchor = anchorIn || captureVirtualTableAnchor(st);
      const wrapTop = getTableChunkWrapTop();
      const table = st.tbody.closest("table");
      const thead = table && table.querySelector("thead");
      const headerHeight = thead ? thead.offsetHeight : 40;
      const rowH = virtualTableRowHeight(st);
      const cullScale = getDebugCullingScale();
      // When zoomed out for culling tests, the screen shows ~1/scale screens of
      // document content — render enough rows to fill that region (then cull viz
      // hides the ones outside the green FOV).
      const viewH = window.innerHeight / Math.max(0.4, cullScale);
      const relativeScroll = Math.max(0, window.scrollY - wrapTop + headerHeight);
      const visibleCount = Math.ceil(viewH / rowH) + TABLE_VIRTUAL_BUFFER * 2;
      let start = Math.max(0, Math.floor(relativeScroll / rowH) - TABLE_VIRTUAL_BUFFER);
      let end = Math.min(st.filtered.length, start + visibleCount);
      const nearBottom =
        window.scrollY + viewH >=
        wrapTop + headerHeight + st.filtered.length * rowH - rowH * 2;
      if (nearBottom) {
        end = st.filtered.length;
        start = Math.max(0, end - visibleCount);
      }
      if (!force && st.windowStart === start && st.windowEnd === end) return;
      st.windowStart = start;
      st.windowEnd = end;
      const topPad = start * rowH;
      const bottomPad = Math.max(0, (st.filtered.length - end) * rowH);
      const slice = st.filtered.slice(start, end);
      const rowsHtml = slice
        .map((r, i) => buildRowTrHtml(r, undefined, folderRowOptsAt(start + i)))
        .join("");
      const html =
        '<tr class="virtual-pad-top" aria-hidden="true"><td colspan="8" style="height:' +
        topPad +
        'px"></td></tr>' +
        rowsHtml +
        '<tr class="virtual-pad-bottom" aria-hidden="true"><td colspan="8" style="height:' +
        bottomPad +
        'px"></td></tr>';
      setHtml(st.tbody, html);
      if (!st.rowHeightMeasured) {
        const sample = st.tbody.querySelector("tr:not(.virtual-pad-top):not(.virtual-pad-bottom)");
        if (sample && sample.offsetHeight > 0) {
          const measured = sample.offsetHeight;
          if (measured > TABLE_ROW_HEIGHT) {
            st.rowHeight = measured;
            st.rowHeightMeasured = true;
            paintVirtualTableWindow(true, anchor);
            return;
          }
          st.rowHeightMeasured = true;
        }
      }
      restoreVirtualTableAnchor(st, anchor);
      refineVirtualTableRowHeight(st);
      if (shouldLoadLinkClicks()) {
        void refreshClickCellsForSlice(slice, 0, { silent: true, virtualSlice: true });
      }
      notifyEmbedHeight();
    }

    function virtualTableRowHeight(st) {
      return st && st.rowHeight > 0 ? st.rowHeight : TABLE_ROW_HEIGHT;
    }

    function setupTableVirtualScroll(filtered) {
      const tbody = $("linksTableBody");
      if (!tbody) return;
      tableVirtualState = {
        filtered,
        windowStart: -1,
        windowEnd: -1,
        tbody,
        rowHeight: TABLE_ROW_HEIGHT,
        rowHeightMeasured: false,
        rowHeightLocked: false,
      };
      let raf = 0;
      tableVirtualScrollHandler = () => {
        if (raf) return;
        raf = requestAnimationFrame(() => {
          raf = 0;
          paintVirtualTableWindow(false);
        });
      };
      tableVirtualCullingZoomHandler = () => {
        paintVirtualTableWindow(true);
      };
      let lastInnerWidth = window.innerWidth;
      tableVirtualResizeHandler = () => {
        if (window.innerWidth === lastInnerWidth) return;
        lastInnerWidth = window.innerWidth;
        tableVirtualScrollHandler();
      };
      window.addEventListener("scroll", tableVirtualScrollHandler, { passive: true });
      window.addEventListener("resize", tableVirtualResizeHandler, { passive: true });
      if (typeof window.addEventListener === "function") {
        window.addEventListener("scrollend", tableVirtualScrollHandler, { passive: true });
      }
      window.addEventListener("proxylist-culling-zoom", tableVirtualCullingZoomHandler);
      paintVirtualTableWindow(true);
    }

    function disconnectTableInfinite() {
      disconnectTableVirtual();
      if (tableInfiniteScrollFallback) {
        window.removeEventListener("scroll", tableInfiniteScrollFallback);
        tableInfiniteScrollFallback = null;
      }
      if (tableInfiniteObserver) {
        tableInfiniteObserver.disconnect();
        tableInfiniteObserver = null;
      }
      tableInfiniteState = null;
    }

    function linkTableTheadRowHtml() {
      return (
        "<tr>" +
        ["Provider", "Link", "Clicks", "Rating", "Category", "Capabilities", "Protocols", "Contributor"]
          .map((h) => "<th>" + h + "</th>")
          .join("") +
        "</tr>"
      );
    }

    function buildSkeletonChunkHtml(rowCount) {
      const n = Math.max(0, Math.floor(Number(rowCount)) || 0);
      if (!n) return "";
      let out = "";
      for (let r = 0; r < n; r++) {
        out += '<tr class="table-row-skeleton" aria-hidden="true">';
        for (let c = 0; c < 8; c++) {
          out += '<td><span class="table-sk-line"></span></td>';
        }
        out += "</tr>";
      }
      return out;
    }

    function removeTableSkeletonRows(tbody) {
      if (!tbody || !tbody.querySelectorAll) return;
      tbody.querySelectorAll("tr.table-row-skeleton").forEach((tr) => tr.remove());
    }

    function folderRowOptsAt(idx) {
      if (viewingFolderId && folderViewState === "ready" && isViewingOwnFolder()) {
        return { folderOwnerManage: true, folderRowIndex: idx };
      }
      return null;
    }

    /** @param fixedClickCount if set, skips async click refresh for this row */
    function buildRowTrHtml(r, fixedClickCount, rowOpts) {
      const fro = rowOpts || {};
      const showFolderTools =
        viewingFolderId &&
        folderViewState === "ready" &&
        fro.folderOwnerManage === true &&
        typeof fro.folderRowIndex === "number";
      const folderToolsHtml = showFolderTools
        ? '<span class="folder-row-tools">' +
          '<button type="button" class="btn" data-folder-tool="up" data-folder-idx="' +
          fro.folderRowIndex +
          '" title="Move up" aria-label="Move up">↑</button>' +
          '<button type="button" class="btn" data-folder-tool="down" data-folder-idx="' +
          fro.folderRowIndex +
          '" title="Move down" aria-label="Move down">↓</button>' +
          '<button type="button" class="btn" data-folder-tool="remove" data-folder-idx="' +
          fro.folderRowIndex +
          '" title="Remove from folder" aria-label="Remove from folder">×</button>' +
          "</span>"
        : "";
      const clickCell =
        fixedClickCount !== undefined
          ? '<td class="click-cell">' + escapeHtml(String(fixedClickCount)) + "</td>"
          : !shouldLoadLinkClicks()
            ? '<td class="click-cell">—</td>'
            : '<td class="click-cell" data-click-url="' + escapeAttr(r.link) + '">…</td>';
      const ratingCell = ratingCellTdHtml(r.link);
      return (
        "<tr><td>" +
        formatProviderCell(r.provider, r.github_url) +
        '</td><td class="link-cell">' +
        buildSaveLinkButtonHtml(r.link) +
        folderToolsHtml +
        '<a href="' +
        escapeAttr(r.link) +
        '" rel="noopener noreferrer" target="_blank" class="link-url js-link-summary" data-link="' +
        escapeAttr(r.link) +
        '" title="' +
        escapeAttr(r.link) +
        '">' +
        escapeHtml(r.link) +
        "</a></td>" +
        clickCell +
        ratingCell +
        "<td>" +
        escapeHtml(canonicalCategory(r.category)) +
        "</td><td>" +
        formatTags(r.capability_tags) +
        "</td><td>" +
        formatTags(r.protocol_tags) +
        "</td><td>" +
        formatContributorCell(r) +
        "</td></tr>"
      );
    }

    async function refreshClickCellsForSlice(rowsSlice, startIndex, options) {
      if (!rowsSlice || !rowsSlice.length) return;
      const tbody = $("linksTableBody");
      if (!tbody || !tbody.isConnected) return;
      const start = Number.isFinite(startIndex) ? Math.max(0, startIndex) : 0;
      const shouldContinue = options && typeof options.shouldContinue === "function" ? options.shouldContinue : null;
      const virtualSlice = !!(options && options.virtualSlice);
      await prefetchLinkRatingsForNorms(
        rowsSlice.map((r) => normalizeUrlKeyForClicks(r && r.link)),
        { skipLinkSaveCounts: listSortMode !== LINK_SORT_SAVED_DESC }
      );
      if (shouldContinue && !shouldContinue()) return;
      if (!tbody.isConnected) return;
      const dataRows = virtualSlice
        ? tbody.querySelectorAll("tr:not(.virtual-pad-top):not(.virtual-pad-bottom):not(.table-row-skeleton)")
        : null;
      const rowAt = (i) => (virtualSlice ? dataRows[i] : tbody.children[start + i]);
      withStableLinkRows(() => {
        for (let i = 0; i < rowsSlice.length; i++) {
          const tr = rowAt(i);
          if (!tr || !tr.querySelector) continue;
          const ratingTd = tr.querySelector("td.link-rating-cell");
          const link = rowsSlice[i] && rowsSlice[i].link ? String(rowsSlice[i].link) : "";
          if (ratingTd && link) setHtml(ratingTd, ratingCellInnerHtmlForLinkUrl(link));
        }
      });
      if (!shouldLoadLinkClicks()) return;
      const targets = [];
      for (let i = 0; i < rowsSlice.length; i++) {
        let tr;
        if (virtualSlice) {
          const dataRows = tbody.querySelectorAll(
            "tr:not(.virtual-pad-top):not(.virtual-pad-bottom):not(.table-row-skeleton)"
          );
          tr = dataRows[i];
        } else {
          tr = tbody.children[start + i];
        }
        if (!tr || !tr.querySelector) continue;
        const td = tr.querySelector("td.click-cell");
        if (!td) continue;
        const link = rowsSlice[i] && rowsSlice[i].link ? String(rowsSlice[i].link) : "";
        if (!link) continue;
        targets.push({ td, link });
      }
      if (!targets.length) return;
      const onClickProgress = options && options.onClickProgress;
      let map;
      if (bulkClickCountCache && effectiveClickLoadMode() === "all") {
        map = bulkClickCountCache;
        if (onClickProgress) onClickProgress(targets.length, targets.length);
      } else {
        map = await fetchClickCounts(
          targets.map((t) => t.link),
          onClickProgress,
          { shouldContinue }
        );
      }
      if (shouldContinue && !shouldContinue()) return;
      if (!tbody.isConnected) return;
      withStableLinkRows(() => {
        for (const t of targets) {
          if (!t.td || !t.td.isConnected) continue;
          t.td.textContent = String(countForUrl(map, t.link));
        }
      });
    }

    async function appendNextTableChunk() {
      const st = tableInfiniteState;
      if (!st || st.chunkInFlight || st.rendered >= st.filtered.length) return;
      if (!st.tbody.isConnected) return;
      st.chunkInFlight = true;
      const tbody = st.tbody;
      const chunkStartedAt = performance.now();
      let sliceLen = 0;
      let startIndex = st.rendered;
      try {
        startIndex = st.rendered;
        const chunkSize = getTableChunkSize();
        const next = Math.min(st.rendered + chunkSize, st.filtered.length);
        const slice = st.filtered.slice(st.rendered, next);
        sliceLen = slice.length;
        const tPrefetch0 = performance.now();
        await prefetchLinkRatingsForNorms(
          slice.map((r) => normalizeUrlKeyForClicks(r && r.link)),
          { skipLinkSaveCounts: listSortMode !== LINK_SORT_SAVED_DESC }
        );
        const prefetchMs = performance.now() - tPrefetch0;
        insertAdjacentHtmlSafe(tbody, "beforeend", buildSkeletonChunkHtml(slice.length));
        await yieldForSkeletonPaint(tbody);
        const tRender0 = performance.now();
        for (let off = 0; off < slice.length; off += TABLE_ROW_APPEND_BATCH) {
          const part = slice.slice(off, off + TABLE_ROW_APPEND_BATCH);
          const html = part
            .map((r, k) => buildRowTrHtml(r, undefined, folderRowOptsAt(startIndex + off + k)))
            .join("");
          insertAdjacentHtmlSafe(tbody, "beforeend", html);
          if (off + TABLE_ROW_APPEND_BATCH < slice.length) {
            await waitNextPaint();
            await new Promise((resolve) => setTimeout(resolve, 0));
          }
        }
        const renderMs = performance.now() - tRender0;
        st.rendered = next;
        removeTableSkeletonRows(tbody);
        if (tableInfiniteState !== st) return;
        const tClicks0 = performance.now();
        await refreshClickCellsForSlice(slice, startIndex);
        const clicksMs = performance.now() - tClicks0;
        notifyEmbedHeight();
        if (effectiveClickLoadMode() === "preload" && tableInfiniteState === st) {
          const preloadSize = getTableChunkSize() * 3;
          const preloadEnd = Math.min(st.rendered + preloadSize, st.filtered.length);
          if (preloadEnd > st.rendered) {
            const preloadSlice = st.filtered.slice(st.rendered, preloadEnd);
            await refreshClickCellsForSlice(preloadSlice, st.rendered, { silent: true });
          }
        }
        if (tableInfiniteState !== st || !st.tbody.isConnected) return;
        if (st.rendered >= st.filtered.length && st.sentinel && st.sentinel.parentNode) {
          st.sentinel.remove();
        }
        if (st.rendered >= st.filtered.length && tableInfiniteObserver) {
          tableInfiniteObserver.disconnect();
          tableInfiniteObserver = null;
        }
        if (isDebugMode()) {
          const totalMs = performance.now() - chunkStartedAt;
          appendDebugOverlayLine(
            "chunk",
            "chunk rows=" +
              sliceLen +
              " range=" +
              startIndex +
              "-" +
              (next - 1) +
              " total=" +
              totalMs.toFixed(1) +
              "ms prefetch=" +
              prefetchMs.toFixed(1) +
              "ms render=" +
              renderMs.toFixed(1) +
              "ms clicks=" +
              clicksMs.toFixed(1) +
              "ms"
          );
        }
      } finally {
        if (tbody.isConnected) removeTableSkeletonRows(tbody);
        if (tableInfiniteState === st) {
          st.chunkInFlight = false;
          if (
            st.rendered < st.filtered.length &&
            st.sentinel &&
            st.sentinel.isConnected
          ) {
            const rect = st.sentinel.getBoundingClientRect();
            if (rect.top <= window.innerHeight + TABLE_PREFETCH_PX) {
              requestAnimationFrame(() => {
                if (tableInfiniteState === st) void appendNextTableChunk();
              });
            }
          }
        }
      }
    }

    function setupTableInfiniteScroll(filtered, initialRendered) {
      const sentinel = $("tableLoadSentinel");
      const tbody = $("linksTableBody");
      if (!sentinel || !tbody || initialRendered >= filtered.length) return;
      tableInfiniteState = {
        filtered,
        rendered: initialRendered,
        tbody,
        sentinel,
        chunkInFlight: false,
      };
      tableInfiniteObserver = new IntersectionObserver(
        (entries) => {
          for (const e of entries) {
            if (e.isIntersecting) void appendNextTableChunk();
          }
        },
        { root: null, rootMargin: TABLE_PREFETCH_PX + "px", threshold: 0 }
      );
      tableInfiniteObserver.observe(sentinel);
      tableInfiniteScrollFallback = () => {
        const s = tableInfiniteState;
        if (!s || s.chunkInFlight || s.rendered >= s.filtered.length) return;
        if (!s.sentinel || !s.sentinel.isConnected) return;
        const rect = s.sentinel.getBoundingClientRect();
        if (rect.top <= window.innerHeight + TABLE_PREFETCH_PX) {
          void appendNextTableChunk();
        }
      };
      window.addEventListener("scroll", tableInfiniteScrollFallback, { passive: true });
    }

    function setContentLoadingProgress(percent, message) {
      const requested = Math.max(0, Math.min(100, Math.round(Number(percent) || 0)));
      const overlay = $("contentLoadingOverlay");
      const pct =
        overlay && overlay.classList.contains("open")
          ? Math.max(contentLoadingHighWater, requested)
          : requested;
      contentLoadingHighWater = pct;
      const pctEl = $("contentLoadingPct");
      if (pctEl) {
        pctEl.textContent = pct + "%";
        pctEl.setAttribute("aria-valuenow", String(pct));
      }
      if (message !== undefined) {
        const loadMsg = overlay && overlay.querySelector(".content-loading-msg");
        if (loadMsg) loadMsg.textContent = message;
      }
    }

    function reportContentLoadingProgress(percent, message) {
      const el = $("contentLoadingOverlay");
      if (!el || !el.classList.contains("open")) return;
      setContentLoadingProgress(percent, message);
    }

    function hideClickLoadSlowPrompt() {
      const slow = $("contentLoadingClickSlow");
      if (slow) slow.hidden = true;
    }

    function showClickLoadSlowPrompt() {
      const overlay = $("contentLoadingOverlay");
      if (!overlay || !overlay.classList.contains("open")) return;
      const slow = $("contentLoadingClickSlow");
      if (slow) slow.hidden = false;
    }

    function clearClickBootSlowTimer() {
      if (clickBootSlowTimer) {
        clearTimeout(clickBootSlowTimer);
        clickBootSlowTimer = null;
      }
    }

    function beginClickBootLoad() {
      const token = ++clickBootLoadToken;
      clearClickBootSlowTimer();
      hideClickLoadSlowPrompt();
      clickBootSlowTimer = setTimeout(() => {
        clickBootSlowTimer = null;
        if (token !== clickBootLoadToken) return;
        showClickLoadSlowPrompt();
      }, 10000);
      return {
        token,
        isActive() {
          return token === clickBootLoadToken;
        },
        done() {
          if (token !== clickBootLoadToken) return;
          clearClickBootSlowTimer();
          hideClickLoadSlowPrompt();
        },
      };
    }

    function invalidateClickBootLoad() {
      clickBootLoadToken += 1;
      clearClickBootSlowTimer();
      hideClickLoadSlowPrompt();
    }

    function blankVisibleClickCells(placeholder) {
      const tbody = $("linksTableBody");
      if (!tbody) return;
      const text = placeholder == null ? "—" : String(placeholder);
      tbody.querySelectorAll("td.click-cell").forEach((td) => {
        td.textContent = text;
        td.removeAttribute("data-click-url");
      });
    }

    function skipClickBootLoadToScroll() {
      sessionClickLoadOverride = "per_chunk";
      bulkClickCountCache = null;
      invalidateClickBootLoad();
    }

    function disableClickCountsForSession() {
      sessionDisableClickCounts = true;
      sessionClickLoadOverride = "none";
      bulkClickCountCache = null;
      invalidateClickBootLoad();
      blankVisibleClickCells("—");
    }

    function bindClickLoadSlowPromptButtons() {
      const skipBtn = $("contentLoadingSkipClicksBtn");
      const disableBtn = $("contentLoadingDisableClicksBtn");
      if (skipBtn && !skipBtn.dataset.bound) {
        skipBtn.dataset.bound = "1";
        skipBtn.addEventListener("click", function () {
          skipClickBootLoadToScroll();
        });
      }
      if (disableBtn && !disableBtn.dataset.bound) {
        disableBtn.dataset.bound = "1";
        disableBtn.addEventListener("click", function () {
          disableClickCountsForSession();
        });
      }
    }

    function setContentLoading(on, options) {
      const el = $("contentLoadingOverlay");
      if (!el) return;
      el.classList.toggle("open", on);
      el.setAttribute("aria-hidden", on ? "false" : "true");
      if (on) {
        contentLoadingHighWater =
          options && options.progress != null ? Math.max(0, Math.min(100, options.progress)) : 0;
        setContentLoadingProgress(
          contentLoadingHighWater,
          options && options.message !== undefined ? options.message : "Getting data..."
        );
      } else {
        contentLoadingHighWater = 0;
        clearClickBootSlowTimer();
        hideClickLoadSlowPrompt();
        setContentLoadingProgress(0);
      }
    }

    function waitNextPaint() {
      return new Promise((resolve) => {
        requestAnimationFrame(() => {
          requestAnimationFrame(resolve);
        });
      });
    }

    /** Lets the browser flush layout and paint skeleton rows before heavy row HTML work. */
    async function yieldForSkeletonPaint(el) {
      if (el && el.isConnected) void el.offsetHeight;
      await waitNextPaint();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    async function finishContentLoading() {
      reportContentLoadingProgress(100, "Done");
      await waitNextPaint();
      setContentLoading(false);
    }

    async function renderAfterHeavyFilter(rows, meta, linkCheck) {
      setContentLoading(true, { progress: 0, message: "Updating list…" });
      await waitNextPaint();
      try {
        await render(rows, meta, linkCheck);
      } finally {
        await finishContentLoading();
      }
    }

    async function render(rows, meta, linkCheck) {
      currentListVersionStamp = versionStamp(meta) || "";
      bulkClickCountCache = null;
      clearHaystackCache();
      disconnectTableInfinite();
      reportContentLoadingProgress(12, "Filtering links…");
      let filtered;
      if (viewingFolderId) {
        if (folderViewState === "ready" && folderDocSnap) {
          const rawItems = Array.isArray(folderDocSnap.items) ? folderDocSnap.items : [];
          const normsOrdered = trustedListRowsByNorm().size
            ? sanitizeFolderItemsToTrustedOrder(rawItems.slice())
            : normalizeFolderItemsList(rawItems.slice());
          const folderSet = new Set(normsOrdered);
          filtered = orderRowsByFolderNorms(filterRows(rows, { folderNormSet: folderSet }), normsOrdered);
        } else {
          filtered = [];
        }
      } else {
        filtered = filterRows(rows, {});
      }
      if (linkSortNeedsFullFirestoreForLinks()) {
        reportContentLoadingProgress(22, "Loading link ratings…");
        // Cap bulk rating reads — fetching every row exhausts Spark quota and blocks likes.
        // Web proxies serialize each fetch; skip this on first paint so the table appears.
        if (!isWebProxyEnv()) {
          const ratingPrefetchCap = Math.min(24, getTableChunkSize(), filtered.length);
          await prefetchLinkRatingsForNorms(
            filtered.slice(0, ratingPrefetchCap).map((r) => normalizeUrlKeyForClicks(r && r.link)),
            {
              skipLinkSaveCounts: listSortMode !== LINK_SORT_SAVED_DESC,
            }
          );
        }
      } else {
        reportContentLoadingProgress(22, "Preparing list…");
        if (!isWebProxyEnv()) {
          const quickCount = Math.min(24, getTableChunkSize(), filtered.length);
          const quickNorms = filtered.slice(0, quickCount).map((r) => normalizeUrlKeyForClicks(r && r.link));
          await prefetchLinkRatingsForNorms(quickNorms, { skipLinkSaveCounts: true });
        }
      }
      filtered = sortFilteredRowsByListSort(filtered);
      scheduleUpdateFilterCounts(rows);

      const checkedAt = formatSiteWhen(
        (linkCheck && (linkCheck.checked_at || linkCheck.checked_at_display)) || ""
      ) || "—";
      const added = Number.isFinite(linkCheck && linkCheck.added_count) ? linkCheck.added_count : 0;
      const removed = Number.isFinite(linkCheck && linkCheck.removed_count) ? linkCheck.removed_count : 0;
      const changelog0 =
        meta && Array.isArray(meta.update_changelog) && meta.update_changelog[0]
          ? meta.update_changelog[0]
          : null;
      const lastUpdated = formatSiteWhen(
        ((meta && meta.last_updated) || "").trim() ||
          (changelog0 && String(changelog0.released || "").trim()) ||
          "",
        { dateOnly: true }
      ) || "—";
      const unsortedCount = Number.isFinite(meta && meta.unsorted_total) ? meta.unsorted_total : 0;
      const combinedTotal = rows.length + unsortedCount;

      let statsPrimary = "";
      if (viewingFolderId) {
        if (folderViewState === "loading") {
          statsPrimary = '<p class="stat-line">Loading folder…</p>';
        } else if (folderViewState === "denied") {
          statsPrimary = '<p class="stat-line">You do not have access to this private folder.</p>';
        } else if (folderViewState === "missing") {
          statsPrimary = '<p class="stat-line">This folder does not exist (or was deleted).</p>';
        } else {
          statsPrimary =
            '<p class="stat-line">Showing <strong>' +
            filtered.length +
            "</strong> link" +
            (filtered.length === 1 ? "" : "s") +
            " in this folder.</p>";
        }
      } else if (savedLinksViewOnly) {
        statsPrimary =
          '<p class="stat-line">Showing <strong>' +
          filtered.length +
          "</strong> saved link" +
          (filtered.length === 1 ? "" : "s") +
          (isSignedInUser() ? "" : " — sign in to load your saved links.") +
          ".</p>";
      } else {
        statsPrimary =
          '<p class="stat-line">Showing <strong>' +
          filtered.length +
          "</strong> of <strong>" +
          rows.length +
          "</strong> sorted links.";
      }

      const statsCombined =
        viewingFolderId || savedLinksViewOnly
          ? ""
          : '<p class="stat-line">Combined total: <strong>' +
            rows.length +
            "</strong> sorted + <strong>" +
            unsortedCount +
            "</strong> unsorted = <strong>" +
            combinedTotal +
            "</strong>.</p>";

      setHtml(
        $("stats"),
        statsPrimary +
        statsCombined +
        '<p class="stat-line">Since last link check: <strong>+' +
        added +
        '</strong> added, <strong class="removed">-' +
        removed +
        "</strong> removed.</p>" +
        '<p class="stat-line">Last list update: <strong>' +
        escapeHtml(lastUpdated) +
        '</strong> • Last link check run: <strong>' +
        escapeHtml(checkedAt) +
        "</strong></p>" +
        '<p class="stat-line">Open counts: <strong>' +
        (clicksAreSharedGlobally()
          ? "shared across visitors (Worker + Firestore)"
          : "this browser only — deploy the Cloudflare Worker or enable Firebase for shared counts.") +
        "</strong></p>" +
        (filtered.length > getTableChunkSize() && !isUnoptimizedTableRender() && !shouldUseVirtualTable(filtered.length)
          ? '<p class="stat-line">More rows load in chunks as you scroll down.</p>'
          : "") +
        (shouldUseVirtualTable(filtered.length)
          ? '<p class="stat-line">Large list — only visible rows are rendered while scrolling.</p>'
          : "")
      );

      if (!filtered.length) {
        setHtml($("tableWrap"), emptyStateNoResultsHtml());
        reportContentLoadingProgress(100, "Done");
        notifyEmbedHeight();
        return;
      }

      reportContentLoadingProgress(45, "Building table…");
      const chunkSize = getTableChunkSize();
      const useVirtual = shouldUseVirtualTable(filtered.length);
      const theadRow = linkTableTheadRowHtml();

      if (useVirtual) {
        setHtml(
          $("tableWrap"),
          '<div class="table-chunk-wrap" id="mainLinksTableWrap"><table><thead>' +
            theadRow +
            '</thead><tbody id="linksTableBody"></tbody></table></div>'
        );
        reportContentLoadingProgress(90, "Building table…");
        setupTableVirtualScroll(filtered);
        notifyEmbedHeight();
        if (shouldLoadLinkClicks()) {
          const st = tableVirtualState;
          if (st) {
            const slice = st.filtered.slice(st.windowStart, st.windowEnd);
            void refreshClickCellsForSlice(slice, st.windowStart, { silent: true });
          }
        }
        return;
      }

      const initial = isUnoptimizedTableRender() ? filtered.length : Math.min(chunkSize, filtered.length);
      const firstChunk = filtered.slice(0, initial);
      const firstHtml = firstChunk.map((r, i) => buildRowTrHtml(r, undefined, folderRowOptsAt(i))).join("");
      const sentinelHtml =
        !isUnoptimizedTableRender() && filtered.length > initial
          ? '<div id="tableLoadSentinel" class="table-load-sentinel" aria-hidden="true"></div>'
          : "";

      setHtml(
        $("tableWrap"),
        '<div class="table-chunk-wrap" id="mainLinksTableWrap"><table><thead>' +
          theadRow +
          '</thead><tbody id="linksTableBody">' +
          firstHtml +
          "</tbody></table>" +
          sentinelHtml +
          "</div>"
      );

      reportContentLoadingProgress(90, "Building table…");
      setupTableInfiniteScroll(filtered, initial);
      notifyEmbedHeight();
      if (shouldLoadLinkClicks()) {
        void refreshClickCellsForSlice(firstChunk, 0, { silent: true });
      }
    }

    function domainOf(link) {
      try {
        return new URL(link).hostname.toLowerCase();
      } catch (_) {
        return "";
      }
    }

    /** Only allow http(s) URLs from DOM attributes / untrusted strings (blocks javascript: etc.). */
    function safeHttpUrl(raw) {
      const s = String(raw == null ? "" : raw).trim();
      if (!s) return "";
      try {
        const u = new URL(s, location.href);
        if (u.protocol !== "http:" && u.protocol !== "https:") return "";
        return u.href;
      } catch (_) {
        return "";
      }
    }

    function statusClass(status) {
      if (status === "blocked") return "blocked";
      if (status === "unblocked") return "unblocked";
      return "warning";
    }

    function cleanSummaryText(value) {
      return String(value == null ? "" : value).replace(/\*\*/g, "").replace(/\s{2,}/g, " ").trim();
    }

    function normalizeFilterKey(value) {
      return cleanSummaryText(value).toLowerCase().replace(/[^a-z0-9]+/g, "");
    }

    /** Strip gn-math status suffixes like " (Timed out) ⚠" so one product = one filter row. */
    function canonicalProviderLabel(raw) {
      let s = cleanSummaryText(raw);
      if (!s) return "";
      s = s.replace(/[\s\uFEFF]*(?:⚠️|⚠)\s*$/gu, "").trim();
      while (/\([^)]*\)\s*$/.test(s)) {
        s = s.replace(/\s*\([^)]*\)\s*$/, "").trim();
      }
      return s;
    }

    function providerFilterKey(raw) {
      return normalizeFilterKey(canonicalProviderLabel(raw));
    }

    function updateSelectedFilterUI() {
      const label = $("selectedFilterLabel");
      const btn = $("selectFilterBtn");
      const hideBtn = $("hideBlockedBtn");
      const hideUncheckedBtn = $("hideUncheckedBtn");
      const settingsHideBtn = $("settingsHideBlockedBtn");
      const settingsHideUncheckedBtn = $("settingsHideUncheckedBtn");
      const settingsFilterSel = $("settingsFilterSelect");
      const filterSel = $("filterSelect");
      const selected = selectedGnMathFilter ? cleanSummaryText(selectedGnMathFilter) : "Any / Not selected";
      if (label) label.textContent = "Selected web filter: " + selected;
      if (btn) {
        if (selectedGnMathFilter) btn.classList.add("btn-active");
        else btn.classList.remove("btn-active");
      }
      if (hideBtn) {
        hideBtn.textContent = "Hide blocked links: " + (hideBlockedBySelectedFilter ? "On" : "Off");
        if (hideBlockedBySelectedFilter) hideBtn.classList.add("btn-active");
        else hideBtn.classList.remove("btn-active");
      }
      if (hideUncheckedBtn) {
        hideUncheckedBtn.textContent =
          "Hide unchecked links: " + (hideLinksWithoutLensCheck ? "On" : "Off");
        if (hideLinksWithoutLensCheck) hideUncheckedBtn.classList.add("btn-active");
        else hideUncheckedBtn.classList.remove("btn-active");
      }
      if (settingsHideBtn) {
        settingsHideBtn.textContent = "Hide blocked links: " + (hideBlockedBySelectedFilter ? "On" : "Off");
        if (hideBlockedBySelectedFilter) settingsHideBtn.classList.add("btn-active");
        else settingsHideBtn.classList.remove("btn-active");
      }
      if (settingsHideUncheckedBtn) {
        settingsHideUncheckedBtn.textContent =
          "Hide unchecked links: " + (hideLinksWithoutLensCheck ? "On" : "Off");
        if (hideLinksWithoutLensCheck) settingsHideUncheckedBtn.classList.add("btn-active");
        else settingsHideUncheckedBtn.classList.remove("btn-active");
      }
      if (filterSel && settingsFilterSel && settingsFilterSel.value !== filterSel.value) {
        settingsFilterSel.value = filterSel.value;
      }
    }

    function ensureLinkLensLoaded() {
      if (linkLensHydrated) return Promise.resolve();
      if (!linkLensFetchPromise) {
        linkLensFetchPromise = fetch("linklens.json")
          .then((r) => (r.ok ? r.json() : {}))
          .catch(() => ({}))
          .then((linkLens) => {
            if (linkLens && typeof linkLens === "object") {
              linkLensData = linkLens;
            }
            rebuildLinkLensIndexes();
            populateKnownFilters();
            updateSelectedFilterUI();
            const wasFirstHydrate = !linkLensHydrated;
            linkLensHydrated = true;
            syncOfflineExportGlobals();
            linkLensFetchPromise = null;
            if (wasFirstHydrate && pageContext) {
              void render(pageContext.links, pageContext.meta, pageContext.link_check);
              void renderMostOpenedForList(pageContext.links);
            }
          });
      }
      return linkLensFetchPromise;
    }

    async function openFilterModal() {
      await ensureLinkLensLoaded();
      $("filterBackdrop").classList.add("open");
      $("filterBackdrop").setAttribute("aria-hidden", "false");
    }

    function closeFilterModal() {
      $("filterBackdrop").classList.remove("open");
      $("filterBackdrop").setAttribute("aria-hidden", "true");
    }

    function populateKnownFilters() {
      const select = $("filterSelect");
      const settingsSelect = $("settingsFilterSelect");
      if (!select) return;
      const byKey = new Map();
      for (const entry of Object.values(linkLensData || {})) {
        if (!entry || typeof entry !== "object") continue;
        const providers = Array.isArray(entry.providers) ? entry.providers : [];
        for (const p of providers) {
          const raw = cleanSummaryText(p && p.provider ? p.provider : "");
          if (!raw) continue;
          const canon = canonicalProviderLabel(raw);
          if (!canon) continue;
          const k = normalizeFilterKey(canon);
          if (!byKey.has(k)) byKey.set(k, canon);
        }
      }
      const sorted = [...byKey.values()].sort((a, b) => a.localeCompare(b));
      const optionsHtml =
        '<option value="">Any / Not selected</option>' +
        sorted.map((name) => '<option value="' + escapeAttr(name) + '">' + escapeHtml(name) + "</option>").join("");
      setHtml(select, optionsHtml);
      if (settingsSelect) setHtml(settingsSelect, optionsHtml);
      if (selectedGnMathFilter) {
        const selKey = providerFilterKey(selectedGnMathFilter);
        const hit = sorted.find((x) => normalizeFilterKey(x) === selKey);
        if (hit) {
          selectedGnMathFilter = hit;
          select.value = hit;
          if (settingsSelect) settingsSelect.value = hit;
        } else {
          selectedGnMathFilter = "";
          select.value = "";
          if (settingsSelect) settingsSelect.value = "";
        }
      }
    }

    function lensHasSignal(entry) {
      if (!entry || typeof entry !== "object") return false;
      const total = Number(entry.summary && entry.summary.total);
      const providers = Array.isArray(entry.providers) ? entry.providers.length : 0;
      return total > 0 || providers > 0 || entry.status === "ok";
    }

    let lensByDomainFast = null;

    function rebuildLinkLensIndexes() {
      summaryEntryCache = new Map();
      lensDomainSignalFirst = new Map();
      lensByDomainFast = new Map();
      for (const [k, v] of Object.entries(linkLensData || {})) {
        if (!v || typeof v !== "object") continue;
        if (k.startsWith("domain:")) {
          const d = k.slice(7).toLowerCase();
          if (d && lensHasSignal(v)) lensByDomainFast.set(d, v);
        }
        const d = String(v.domain || "").toLowerCase();
        if (!d || !lensHasSignal(v)) continue;
        if (!lensDomainSignalFirst.has(d)) lensDomainSignalFirst.set(d, v);
      }
    }

    function summaryEntryFor(link) {
      if (summaryEntryCache.has(link)) return summaryEntryCache.get(link);
      const byExact = linkLensData[link];
      if (lensHasSignal(byExact)) {
        summaryEntryCache.set(link, byExact);
        return byExact;
      }
      const domain = domainOf(link);
      if (!domain) {
        summaryEntryCache.set(link, byExact || null);
        return byExact || null;
      }
      const byDomain =
        (lensByDomainFast && lensByDomainFast.get(domain)) ||
        linkLensData["domain:" + domain] ||
        linkLensData[domain] ||
        lensDomainSignalFirst.get(domain) ||
        null;
      const out = lensHasSignal(byDomain) ? byDomain : byExact || byDomain || null;
      summaryEntryCache.set(link, out);
      return out;
    }

    function listRowForLink(link) {
      const rows = pageContext && Array.isArray(pageContext.links) ? pageContext.links : [];
      const norm = normalizeUrlKeyForClicks(link);
      if (!norm) return null;
      for (const row of rows) {
        if (normalizeUrlKeyForClicks(row && row.link) === norm) return row;
      }
      return null;
    }

    function additionalNotesText(link) {
      const row = listRowForLink(link);
      return row && String(row.additional_notes || "").trim() ? String(row.additional_notes).trim() : "";
    }

    function shouldShowAdditionalNotes() {
      return appSettings.additionalNotesVisibility !== "hide";
    }

    function setSummaryProviderMeta(link) {
      const el = $("summaryProviderMeta");
      if (!el) return;
      const row = listRowForLink(link);
      if (!row) {
        el.innerHTML = "";
        el.hidden = true;
        return;
      }
      const provider = String(row.provider || "").trim();
      const shownProvider =
        appSettings.renderEmojis === false ? stripEmojisFromText(provider) : provider;
      const category = String(row.category || "").trim() || "—";
      const capabilities = String(row.capabilities || "").trim() || "—";
      const protocols = String(row.protocols || "").trim() || "—";
      if (!shownProvider) {
        el.innerHTML = "";
        el.hidden = true;
        return;
      }
      el.innerHTML =
        '<div class="summary-provider-name">' +
        escapeHtml(shownProvider) +
        formatProviderGithubLink(row.github_url) +
        "</div>" +
        '<div class="summary-provider-details">' +
        "Category: " +
        escapeHtml(category) +
        " · Capabilities: " +
        escapeHtml(capabilities) +
        " · Protocols: " +
        escapeHtml(protocols) +
        "</div>";
      el.hidden = false;
    }

    function additionalNotesPanelHtml(link) {
      if (!shouldShowAdditionalNotes()) return "";
      const notes = additionalNotesText(link);
      if (!notes) return "";
      return (
        '<section class="summary-panel" aria-label="Additional notes">' +
        "<h3>Additional Notes</h3>" +
        '<div class="summary-panel-body">' +
        '<p class="summary-notes-body">' +
        escapeHtml(notes) +
        "</p></div></section>"
      );
    }

    /** True when linklens has a parsed gn-math summary (provider rows or totals), not only a stub. */
    function linkHasParsableLensCheck(link) {
      return lensHasSignal(summaryEntryFor(link));
    }

    const MALWARE_CATEGORY_RX = /\b(malware|phish(?:ing)?|spyware|virus(?:es)?|trojan|ransom(?:ware)?|botnet|adware|exploit|c2|command[- ]and[- ]control|spam[ _-]?urls?|threat|malicious)\b/i;

    function malwareCategoryFor(link) {
      const selectedFilterKey = normalizeFilterKey(selectedGnMathFilter);
      if (!selectedFilterKey) return "";
      const entry = summaryEntryFor(link);
      if (!entry || typeof entry !== "object") return "";
      const providers = Array.isArray(entry.providers) ? entry.providers : [];
      const matches = providers.filter((p) => providerFilterKey(p.provider || "") === selectedFilterKey);
      for (const m of matches) {
        const cat = cleanSummaryText(m.category || "");
        if (MALWARE_CATEGORY_RX.test(cat)) return cat;
      }
      return "";
    }

    function malwareWarningMessage(action) {
      const filterName = cleanSummaryText(selectedGnMathFilter) || "The selected filter";
      return (
        filterName +
        " has detected that this site may have malware. " +
        "If you go to this site, your network administrator may be notified. Visit at your own risk." +
        "\n\nDo you still want to " + action + " this link?"
      );
    }

    function confirmMalwareAction(link, action) {
      if (!malwareCategoryFor(link)) return true;
      return window.confirm(malwareWarningMessage(action));
    }

    function isBlockedBySelectedFilter(link) {
      const selectedFilterKey = normalizeFilterKey(selectedGnMathFilter);
      if (!selectedFilterKey) return false;
      const entry = summaryEntryFor(link);
      if (!entry || typeof entry !== "object") return false;
      const providers = Array.isArray(entry.providers) ? entry.providers : [];
      return providers.some(
        (p) => providerFilterKey(p.provider || "") === selectedFilterKey && p.status === "blocked"
      );
    }

    /** Lower sorts first: unblocked → warning → blocked → unknown (for most-opened filter sort). */
    function mostOpenedFilterSortRank(link) {
      const selectedFilterKey = normalizeFilterKey(selectedGnMathFilter);
      if (!selectedFilterKey) return 0;
      const entry = summaryEntryFor(link);
      if (!entry || typeof entry !== "object") return 4;
      const providers = Array.isArray(entry.providers) ? entry.providers : [];
      const match = providers.find((p) => providerFilterKey(p.provider || "") === selectedFilterKey);
      if (!match) return 3;
      const s = String(match.status || "warning").toLowerCase();
      if (s === "unblocked") return 0;
      if (s === "warning") return 1;
      if (s === "blocked") return 2;
      return 3;
    }

    function hasCheckedDomain(link) {
      const d = domainOf(link);
      if (!d) return false;
      return checkedDomains.has(d) || checkedDomains.has(d.replace(/^www\./, ""));
    }

    function normalizeLinkForCheck(link) {
      return String(link || "").trim().replace(/\/+$/, "");
    }

    function failCountFor(link) {
      const key = normalizeLinkForCheck(link);
      if (!key) return 0;
      const v = failingLinks[key];
      return Number.isFinite(v) ? Math.max(0, v) : 0;
    }

    function removalNoticeHtml(link) {
      const fails = failCountFor(link);
      if (fails <= 0) return "";
      const threshold = Number.isFinite(failThreshold) && failThreshold > 0 ? failThreshold : 3;
      const remaining = Math.max(0, threshold - fails);
      const severe = remaining <= 1;
      const cls = severe ? "removal-notice severe" : "removal-notice warn";
      const failsLabel = fails === 1 ? "1 link check" : fails + " consecutive link checks";
      const remainingLabel = remaining === 0
        ? "It will be removed on the next failed link check run."
        : remaining === 1
          ? "It will be removed if it fails <strong>1 more link check</strong>."
          : "It will be removed if it fails <strong>" + remaining + " more link checks</strong>.";
      return (
        '<div class="' + cls + '"><strong>Heads up:</strong> this link has failed <strong>' +
        failsLabel +
        "</strong> in a row. " +
        remainingLabel +
        "</div>"
      );
    }

    function setSummaryFooterLink(link) {
      const openBtn = $("summaryOpenBtn");
      const copyBtn = $("summaryCopyBtn");
      const href = safeHttpUrl(link) || "#";
      if (openBtn) openBtn.setAttribute("href", href);
      if (copyBtn) {
        copyBtn.dataset.link = href === "#" ? "" : href;
        copyBtn.classList.remove("copied");
        copyBtn.textContent = "Copy link";
      }
    }

    async function openSummary(link) {
      const overlay = $("contentLoadingOverlay");
      const loadMsg = overlay && overlay.querySelector(".content-loading-msg");
      const prevLoadMsg = loadMsg ? loadMsg.textContent : "";
      if (loadMsg) loadMsg.textContent = "Loading summary…";
      try {
        setContentLoading(true, { progress: 0, message: "Loading summary…" });
        await waitNextPaint();
        reportContentLoadingProgress(20, "Recording visit…");
        await recordLinkClick(link);
        reportContentLoadingProgress(55, "Loading filter data…");
        await ensureLinkLensLoaded();
        reportContentLoadingProgress(85, "Building summary…");
        const entry = summaryEntryFor(link);
        const body = $("summaryBody");
        setSummaryFooterLink(link);
        const removalHtml = removalNoticeHtml(link);
        setSummaryProviderMeta(link);
        const notesPanel = additionalNotesPanelHtml(link);
        const clickStub = '<p class="summary-muted" id="summaryClickLine">…</p>';
        let summaryInner = "";
        let riskNoticeHtml = "";
        if (!entry) {
          const pendingText = hasCheckedDomain(link)
            ? "This link was checked, but no parsable gn-math summary message was captured yet."
            : "No gn-math data found for this link yet.";
          summaryInner =
            clickStub + '<p class="summary-muted">' + escapeHtml(pendingText) + "</p>";
        } else {
          const summary = entry.summary || {};
          const providers = Array.isArray(entry.providers) ? entry.providers : [];
          const checkedAt = formatSiteWhen(entry.checked_at || "") || "—";
          const status = entry.status || "unknown";
          const selectedFilterKey = normalizeFilterKey(selectedGnMathFilter);
          if (selectedFilterKey) {
            const matches = providers.filter((p) => providerFilterKey(p.provider || "") === selectedFilterKey);
            const rank = (s) => (s === "blocked" ? 0 : s === "warning" ? 1 : 2);
            matches.sort((a, b) => rank(String(a.status)) - rank(String(b.status)));
            const match = matches[0];
            if (match && (match.status === "blocked" || match.status === "warning")) {
              riskNoticeHtml =
                '<div class="risk-notice">This link may be blocked on <strong>' +
                escapeHtml(canonicalProviderLabel(match.provider || "") || cleanSummaryText(selectedGnMathFilter)) +
                "</strong> for <strong>" +
                escapeHtml(cleanSummaryText(match.category || "Unknown reason")) +
                "</strong>.</div>";
            }
          }
          const providerRows = providers.length
            ? providers
                .map(
                  (p) =>
                    "<tr><td>" +
                    escapeHtml(cleanSummaryText(p.provider || "—")) +
                    "</td><td>" +
                    escapeHtml(cleanSummaryText(p.category || "—")) +
                    '</td><td><span class="status-pill ' +
                    statusClass(p.status) +
                    '">' +
                    escapeHtml(p.status || "warning") +
                    "</span></td></tr>"
                )
                .join("")
            : '<tr><td colspan="3" class="summary-muted">No provider lines parsed from source message.</td></tr>';

          summaryInner =
            clickStub +
            '<p class="summary-muted">Domain: <strong>' +
            escapeHtml(entry.domain || domainOf(link) || "—") +
            '</strong> • Checked: <strong>' +
            escapeHtml(checkedAt) +
            '</strong> • Status: <strong>' +
            escapeHtml(status) +
            "</strong></p>" +
            '<div class="summary-grid">' +
            '<div class="summary-card"><span class="summary-k">Blocked</span><span class="summary-v">' +
            escapeHtml(String(summary.blocked ?? 0)) +
            '</span></div><div class="summary-card"><span class="summary-k">Unblocked</span><span class="summary-v">' +
            escapeHtml(String(summary.unblocked ?? 0)) +
            '</span></div><div class="summary-card"><span class="summary-k">Warning</span><span class="summary-v">' +
            escapeHtml(String(summary.warning ?? 0)) +
            '</span></div><div class="summary-card"><span class="summary-k">Total</span><span class="summary-v">' +
            escapeHtml(String(summary.total ?? providers.length)) +
            "</span></div></div>" +
            '<table class="provider-table"><thead><tr><th>Provider</th><th>Category</th><th>Result</th></tr></thead><tbody>' +
            providerRows +
            "</tbody></table>";
        }

        setHtml(
          body,
          removalHtml +
            riskNoticeHtml +
            '<div class="summary-content">' +
            '<div class="summary-panels' +
            (notesPanel ? " has-notes" : "") +
            '">' +
            '<section class="summary-panel" aria-label="Link summary details">' +
            "<h3>Link Summary</h3>" +
            '<div class="summary-panel-body">' +
            summaryInner +
            "</div></section>" +
            notesPanel +
            "</div></div>"
        );
        $("summaryTitle").textContent = "Link summary";
        $("summaryBackdrop").classList.add("open");
        $("summaryBackdrop").setAttribute("aria-hidden", "false");
        reportContentLoadingProgress(100, "Done");
      } finally {
        setContentLoading(false);
        if (loadMsg) loadMsg.textContent = prevLoadMsg;
      }
      try {
        const map = await fetchClickCounts([link]);
        const line = $("summaryClickLine");
        if (line) {
          line.textContent = formatClickLineLabel() + ": " + countForUrl(map, link);
        }
      } catch (_) {
        const line = $("summaryClickLine");
        if (line) line.textContent = formatClickLineLabel() + ": —";
      }
    }

    function closeSummary() {
      $("summaryBackdrop").classList.remove("open");
      $("summaryBackdrop").setAttribute("aria-hidden", "true");
      const meta = $("summaryProviderMeta");
      if (meta) {
        meta.innerHTML = "";
        meta.hidden = true;
      }
    }

    const JSDELIVR_PREF_STORAGE = "proxyList_jsdelivrHost_v1";
    const JSDELIVR_HOST_OPTIONS = [
      {
        host: "cdn.jsdelivr.net",
        label: "cdn (default)",
        backend: "jsDelivr auto-balanced entry",
        regions: "Global",
        notes:
          "Usually the best overall default: jsDelivr picks among Fastly, Gcore, Bunny, and Cloudflare-related paths based on health and latency. Forcing another alias can help during outages or odd routing—or hurt you if conditions change.",
      },
      {
        host: "fastly.jsdelivr.net",
        label: "fastly",
        backend: "Fastly CDN",
        regions: "North America, Europe",
        notes: "Very strong peering and low latency in the US and EU.",
      },
      {
        host: "gcore.jsdelivr.net",
        label: "gcore",
        backend: "Gcore CDN",
        regions: "Eastern Europe, CIS, parts of Asia",
        notes: "Often faster in Russia / Eastern Europe; sometimes competitive in Southeast Asia depending on ISP.",
      },
      {
        host: "testingcf.jsdelivr.net",
        label: "testingcf",
        backend: "Cloudflare-style testing endpoint",
        regions: "Globally variable",
        notes: "Not intended as a stable public endpoint. On some mobile networks, Cloudflare-style routing can win due to carrier peering.",
      },
      {
        host: "origin2.jsdelivr.net",
        label: "origin2",
        backend: "Origin / backend-style path",
        regions: "Usually nowhere ideally",
        notes: "Often slower because traffic stays closer to origin-style infrastructure; useful mainly for debugging or rare routing experiments.",
      },
      {
        host: "quantil.jsdelivr.net",
        label: "quantil",
        backend: "Quantil CDN",
        regions: "Historically China / East Asia",
        notes: "Older infrastructure; can be inconsistent today. Modern access to jsDelivr from China is often messy (filtering, TLS, routing) regardless of alias.",
      },
      {
        host: "originfastly.jsdelivr.net",
        label: "originfastly",
        backend: "Fastly-origin route",
        regions: "Varies",
        notes: "Can bypass some CDN layers (useful when caches or edges misbehave) but may add latency.",
      },
    ];

    let jsDelivrPickerBaseUrl = "";
    let jsDelivrPickerMode = "open";

    function inferUserRegionFromTimezone() {
      let tz = "";
      try {
        tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "";
      } catch (_) {}
      const t = String(tz || "").toLowerCase();
      const base = { tz, t };
      if (!t) return { ...base, key: "unknown", label: "Unknown" };

      if (/\/(shanghai|chongqing|urumqi|harbin|kashgar|hong_kong|macau|macao|taipei)$/.test(t)) {
        return { ...base, key: "china", label: "Greater China" };
      }
      if (
        /europe\/(moscow|simferopol|kyiv|kiev|minsk|chisinau|kishinev|tiraspol|volgograd|astrakhan|samara|saratov|ulyanovsk|kirov)$/.test(t) ||
        /asia\/(yekaterinburg|omsk|novosibirsk|barnaul|tomsk|novokuznetsk|krasnoyarsk|irkutsk|chita|yakutsk|khandyga|vladivostok|ussuriysk|magadan|sakhalin|kamchatka|anadyr|almaty|tashkent|bishkek|ashgabat|dushanbe|baku|yerevan|tbilisi|oral|atyrau|aktobe|aqtobe|aqtau|qyzylorda|qostanay)$/.test(t)
      ) {
        return { ...base, key: "cis", label: "Russia / CIS" };
      }
      if (
        /asia\/(bangkok|jakarta|pontianak|manila|singapore|ho_chi_minh|hanoi|kuala_lumpur|phnom_penh|vientiane|brunei|rangoon|yangon|jayapura|makassar)$/.test(t)
      ) {
        return { ...base, key: "sea", label: "Southeast Asia" };
      }
      if (/^(australia|pacific)\//.test(t)) {
        return { ...base, key: "oceania", label: "Oceania / Pacific" };
      }
      if (
        /america\/(argentina|santiago|lima|bogota|caracas|la_paz|sao_paulo|montevideo|asuncion|guayaquil|belem|fortaleza|recife|maceio|bahia|rio_branco|porto_velho|campo_grande|cuiaba|goiania|brasilia)$/.test(t)
      ) {
        return { ...base, key: "latam", label: "Latin America" };
      }
      if (t.startsWith("america/") || t.startsWith("us/") || t.startsWith("canada/")) {
        return { ...base, key: "na", label: "North America" };
      }
      if (t.startsWith("europe/") || t.startsWith("atlantic/") || t.startsWith("arctic/")) {
        return { ...base, key: "eu", label: "Europe" };
      }
      if (t.startsWith("asia/") || t.startsWith("indian/")) {
        return { ...base, key: "asia", label: "Asia" };
      }
      if (t.startsWith("africa/")) {
        return { ...base, key: "africa", label: "Africa" };
      }
      return { ...base, key: "unknown", label: "Unknown" };
    }

    function pickRegionTier(table, regionKey) {
      const rk = regionKey || "unknown";
      if (table[rk]) return table[rk];
      return table.default || { tier: "neutral", hint: "" };
    }

    function jsDelivrTierForHostAndRegion(host, regionKey) {
      const rk = regionKey || "unknown";
      if (host === "cdn.jsdelivr.net") {
        return {
          tier: "best",
          hint:
            "Best default for most people: jsDelivr balances providers automatically. Manual aliases are for outages, throttling, or odd ISP routing.",
        };
      }
      if (host === "fastly.jsdelivr.net") {
        return pickRegionTier(
          {
            na: { tier: "good", hint: "Often among the fastest mirrors in North America." },
            eu: { tier: "good", hint: "Strong peering and low latency across much of Europe." },
            cis: {
              tier: "neutral",
              hint: "Can be fast, but some ISPs route to Fastly poorly—compare with Gcore.",
            },
            china: {
              tier: "caution",
              hint: "International CDN paths into China are often inconsistent (filtering, routing, TLS).",
            },
            sea: {
              tier: "neutral",
              hint: "Highly ISP-dependent; Gcore or Cloudflare-style paths sometimes win here.",
            },
            asia: { tier: "good", hint: "Often strong where Fastly has dense presence." },
            oceania: { tier: "good", hint: "Usually reasonable to Pacific POPs." },
            africa: { tier: "good", hint: "Often usable where Fastly peers well." },
            latam: { tier: "neutral", hint: "Varies a lot by country, city, and carrier." },
            default: { tier: "good", hint: "Global Fastly edge; especially strong in North America and Europe." },
          },
          rk
        );
      }
      if (host === "gcore.jsdelivr.net") {
        return pickRegionTier(
          {
            cis: { tier: "good", hint: "Often the best unofficial choice in Russia / CIS." },
            eu: { tier: "good", hint: "Strong in Eastern Europe; worth comparing with Fastly." },
            sea: { tier: "good", hint: "Sometimes wins in Southeast Asia depending on ISP and path." },
            asia: { tier: "good", hint: "Can be competitive in parts of Asia vs other aliases." },
            na: { tier: "neutral", hint: "Usually fine but not the typical first pick in US/Canada." },
            china: { tier: "neutral", hint: "May help in some cases; overall China access to jsDelivr remains inconsistent." },
            oceania: { tier: "neutral", hint: "Try if Fastly or the default entry feels slow." },
            africa: { tier: "neutral", hint: "Try if default routing is poor on your network." },
            latam: { tier: "neutral", hint: "Worth testing if default or Fastly paths underperform." },
            default: { tier: "neutral", hint: "Good when you are geographically close to Gcore POPs or when Fastly routes oddly." },
          },
          rk
        );
      }
      if (host === "testingcf.jsdelivr.net") {
        return {
          tier: "caution",
          hint:
            rk === "sea" || rk === "latam"
              ? "Testing endpoint—not guaranteed stable. Mobile carriers sometimes peer better to Cloudflare-style paths."
              : "Testing endpoint—not intended as a stable public mirror; use only if you know why you need it.",
        };
      }
      if (host === "quantil.jsdelivr.net") {
        return pickRegionTier(
          {
            china: {
              tier: "good",
              hint: "Historically associated with China / East Asia, but quality is inconsistent today.",
            },
            na: { tier: "poor", hint: "Often slower in North America vs Fastly or the default entry." },
            eu: { tier: "poor", hint: "Often slower in Europe vs Fastly or the default entry." },
            cis: { tier: "caution", hint: "Rarely the first choice in CIS; compare with Gcore or the default entry." },
            sea: { tier: "caution", hint: "Can vary; usually not the first mirror to try in SEA." },
            asia: { tier: "neutral", hint: "Sometimes used for East Asia paths; verify with measurements." },
            default: { tier: "caution", hint: "Older Quantil path; behavior can be inconsistent outside historical China use." },
          },
          rk
        );
      }
      if (host === "originfastly.jsdelivr.net") {
        return {
          tier: "neutral",
          hint: "Bypasses some layers—can help with stale cache or edge bugs, but latency may rise.",
        };
      }
      if (host === "origin2.jsdelivr.net") {
        return {
          tier: "poor",
          hint: "Usually slower (closer to origin-style infra). Mostly for debugging or special routing cases.",
        };
      }
      return { tier: "neutral", hint: "" };
    }

    const JSDELIVR_TIER_ORDER = { best: 0, good: 1, neutral: 2, caution: 3, poor: 4 };

    function jsDelivrTierPillText(tier) {
      switch (tier) {
        case "best":
          return "Recommended default";
        case "good":
          return "Good choice";
        case "neutral":
          return "Neutral / situational";
        case "caution":
          return "Caution";
        case "poor":
          return "Often suboptimal";
        default:
          return "—";
      }
    }

    function isJsDelivrUrl(urlStr) {
      try {
        const u = new URL(urlStr);
        return /^https?:$/i.test(u.protocol) && u.hostname.toLowerCase().endsWith(".jsdelivr.net");
      } catch (_) {
        return false;
      }
    }

    function swapJsDelivrHost(urlStr, newHost) {
      const u = new URL(urlStr);
      u.hostname = String(newHost).toLowerCase();
      return u.toString();
    }

    function closeJsDelivrPicker() {
      const bd = $("jsDelivrBackdrop");
      if (!bd) return;
      bd.classList.remove("open");
      bd.setAttribute("aria-hidden", "true");
      jsDelivrPickerBaseUrl = "";
      jsDelivrPickerMode = "open";
    }

    async function copyPlainTextToClipboard(text) {
      let ok = false;
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          await navigator.clipboard.writeText(text);
          ok = true;
        } else {
          const ta = document.createElement("textarea");
          ta.value = text;
          ta.setAttribute("readonly", "");
          ta.style.position = "absolute";
          ta.style.left = "-9999px";
          document.body.appendChild(ta);
          ta.select();
          ok = document.execCommand("copy");
          document.body.removeChild(ta);
        }
      } catch (_) {
        ok = false;
      }
      if (!ok) {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        try {
          ok = document.execCommand("copy");
        } catch (_) {
          ok = false;
        }
        document.body.removeChild(ta);
      }
      return ok;
    }

    function flashSummaryCopyButtonState(ok) {
      const btn = $("summaryCopyBtn");
      if (!btn) return;
      btn.textContent = ok ? "Copied!" : "Copy failed";
      if (ok) btn.classList.add("copied");
      setTimeout(() => {
        btn.textContent = "Copy link";
        btn.classList.remove("copied");
      }, 1500);
    }

    function openJsDelivrPicker(baseUrl, mode) {
      jsDelivrPickerMode = mode === "copy" ? "copy" : "open";
      jsDelivrPickerBaseUrl = baseUrl;
      const bd = $("jsDelivrBackdrop");
      const grid = $("jsDelivrAliasGrid");
      const preview = $("jsDelivrUrlPreview");
      const intro = $("jsDelivrIntro");
      const regionLine = $("jsDelivrRegionLine");
      if (!bd || !grid) return;

      const region = inferUserRegionFromTimezone();
      const regionKey = region.key;

      let pref = "";
      try {
        pref = localStorage.getItem(JSDELIVR_PREF_STORAGE) || "";
      } catch (_) {}

      if (preview) preview.textContent = baseUrl;
      if (intro) {
        intro.textContent =
          jsDelivrPickerMode === "copy"
            ? "Choose a CDN hostname to copy. Path, query, and hash stay the same as in the list."
            : "Choose a CDN hostname to open in a new tab. Path, query, and hash stay the same as in the list.";
      }
      if (regionLine) {
        let msg = "Rough guess for where you are: " + region.label + ". Inferred from your browser timezone";
        if (region.tz) msg += " (" + region.tz + ")";
        msg +=
          ")—not GPS-accurate. VPNs, remote desktop, travel, or an unusual system timezone can skew these hints.";
        regionLine.textContent = msg;
      }

      const indexed = JSDELIVR_HOST_OPTIONS.map((opt, i) => {
        const { tier } = jsDelivrTierForHostAndRegion(opt.host, regionKey);
        return { opt, i, ord: JSDELIVR_TIER_ORDER[tier] ?? 9 };
      });
      indexed.sort((a, b) => {
        if (a.ord !== b.ord) return a.ord - b.ord;
        return a.i - b.i;
      });

      const frag = document.createDocumentFragment();
      for (const { opt } of indexed) {
        const tierInfo = jsDelivrTierForHostAndRegion(opt.host, regionKey);
        const card = document.createElement("article");
        card.className = "jsdelivr-alias-card";
        card.dataset.tier = tierInfo.tier;

        const top = document.createElement("div");
        top.className = "jsdelivr-alias-card-top";

        const pill = document.createElement("span");
        pill.className = "jsdelivr-pill";
        pill.textContent = jsDelivrTierPillText(tierInfo.tier);

        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "btn" + (opt.host === pref ? " btn-active" : "");
        if (tierInfo.tier === "best") btn.classList.add("btn-primary");
        btn.textContent =
          jsDelivrPickerMode === "copy" ? "Copy with this host" : "Open with this host";
        btn.title = opt.host;

        btn.addEventListener("click", async () => {
          const modeAtClick = jsDelivrPickerMode;
          const out = swapJsDelivrHost(jsDelivrPickerBaseUrl, opt.host);
          try {
            localStorage.setItem(JSDELIVR_PREF_STORAGE, opt.host);
          } catch (_) {}
          closeJsDelivrPicker();
          if (modeAtClick === "copy") {
            const ok = await copyPlainTextToClipboard(out);
            flashSummaryCopyButtonState(ok);
          } else {
            void recordLinkClick(out);
            window.open(out, "_blank", "noopener,noreferrer");
          }
        });

        top.appendChild(pill);
        top.appendChild(btn);

        const title = document.createElement("p");
        title.className = "jsdelivr-alias-title";
        const nameStrong = document.createElement("strong");
        nameStrong.textContent = opt.label;
        title.appendChild(nameStrong);
        title.appendChild(document.createTextNode(" · " + opt.backend));

        const ul = document.createElement("ul");
        ul.className = "jsdelivr-alias-lines";

        const liRegions = document.createElement("li");
        const sr = document.createElement("strong");
        sr.textContent = "Usually strongest in:";
        liRegions.appendChild(sr);
        liRegions.appendChild(document.createTextNode(" " + opt.regions));

        const liNotes = document.createElement("li");
        const sn = document.createElement("strong");
        sn.textContent = "General notes:";
        liNotes.appendChild(sn);
        liNotes.appendChild(document.createTextNode(" " + opt.notes));

        const liHint = document.createElement("li");
        const sh = document.createElement("strong");
        sh.textContent = "Hint for your guess:";
        liHint.appendChild(sh);
        liHint.appendChild(document.createTextNode(" " + (tierInfo.hint || "—")));

        ul.appendChild(liRegions);
        ul.appendChild(liNotes);
        ul.appendChild(liHint);

        card.appendChild(top);
        card.appendChild(title);
        card.appendChild(ul);
        frag.appendChild(card);
      }
      grid.replaceChildren(frag);

      bd.classList.add("open");
      bd.setAttribute("aria-hidden", "false");
    }

    function escapeHtml(s) {
      return String(s)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
    }

    function escapeAttr(s) {
      return escapeHtml(s).replace(/'/g, "&#39;");
    }

    const EMPTY_STATE_ICON_URL =
      "https://assets.streamlinehq.com/image/private/w_300,h_300,ar_1/f_auto/v1/icons/common-actions/question-mark-sqok8vg2o1dd9g07du59d.png/question-mark-fh239k9aqe5ayqfowratid.png?_a=DATAiZAAZAA0";

    function emptyStateNoResultsInnerHtml() {
      if (viewingFolderId) {
        if (folderViewState === "loading") {
          return (
            '<img class="empty-state-icon" src="' +
            escapeAttr(EMPTY_STATE_ICON_URL) +
            '" width="120" height="120" alt="" decoding="async" />' +
            '<h2 class="empty-state-title">Loading folder</h2>' +
            '<p class="empty-state-desc">Fetching the latest list from Firestore…</p>'
          );
        }
        if (folderViewState === "denied") {
          return (
            '<img class="empty-state-icon" src="' +
            escapeAttr(EMPTY_STATE_ICON_URL) +
            '" width="120" height="120" alt="" decoding="async" />' +
            '<h2 class="empty-state-title">Private folder</h2>' +
            '<p class="empty-state-desc">Only the owner account can open a private folder. Ask them to set it to Public or Unlisted so the link works, or sign in as the owner.</p>' +
            '<a class="btn btn-primary" href="./login/">Sign in</a> <a class="btn" href="./">All links</a>'
          );
        }
        if (folderViewState === "missing") {
          return (
            '<img class="empty-state-icon" src="' +
            escapeAttr(EMPTY_STATE_ICON_URL) +
            '" width="120" height="120" alt="" decoding="async" />' +
            '<h2 class="empty-state-title">Folder not found</h2>' +
            '<p class="empty-state-desc">This link may be wrong or the folder was deleted.</p>' +
            '<a class="btn btn-primary" href="./">Browse the list</a>'
          );
        }
        if (folderViewState === "ready" && isViewingOwnFolder()) {
          return (
            '<img class="empty-state-icon" src="' +
            escapeAttr(EMPTY_STATE_ICON_URL) +
            '" width="120" height="120" alt="" decoding="async" />' +
            '<h2 class="empty-state-title">Empty folder</h2>' +
            '<p class="empty-state-desc">Search the curated list in the panel above, import starred links, or star links on the full list then import.</p>' +
            '<a class="btn btn-primary" href="./">Browse the list</a>'
          );
        }
        return (
          '<img class="empty-state-icon" src="' +
          escapeAttr(EMPTY_STATE_ICON_URL) +
          '" width="120" height="120" alt="" decoding="async" />' +
          '<h2 class="empty-state-title">No matching rows</h2>' +
          '<p class="empty-state-desc">Nothing in this folder appears in the sorted list with your current filters — try resetting filters.</p>' +
          '<button type="button" class="btn btn-primary empty-state-reset-btn">Reset filters</button>'
        );
      }
      if (savedLinksViewOnly) {
        if (!isSignedInUser()) {
          return (
            '<img class="empty-state-icon" src="' +
            escapeAttr(EMPTY_STATE_ICON_URL) +
            '" width="120" height="120" alt="" decoding="async" />' +
            '<h2 class="empty-state-title">Sign in to view saved links</h2>' +
            '<p class="empty-state-desc">Saved links are tied to your account.</p>' +
            '<a class="btn btn-primary" href="./login/">Sign in</a>'
          );
        }
        return (
          '<img class="empty-state-icon" src="' +
          escapeAttr(EMPTY_STATE_ICON_URL) +
          '" width="120" height="120" alt="" decoding="async" />' +
          '<h2 class="empty-state-title">No saved links yet</h2>' +
          '<p class="empty-state-desc">Star links on the full list to add them here.</p>' +
          '<a class="btn btn-primary" href="./">Browse the list</a>'
        );
      }
      return (
        '<img class="empty-state-icon" src="' +
        escapeAttr(EMPTY_STATE_ICON_URL) +
        '" width="120" height="120" alt="" decoding="async" />' +
        '<h2 class="empty-state-title">No results found</h2>' +
        '<p class="empty-state-desc">' +
        (hideLinksWithoutLensCheck
          ? "Hide unchecked links is on, so new or unchecked URLs (including fresh submissions) are hidden. Turn it off or reset filters."
          : "What you&#39;re searching may not exist, too many sort filters may be selected (including saved protocol/capability filters), or blocked links may be hidden.") +
        "</p>" +
        '<button type="button" class="btn btn-primary empty-state-reset-btn">Reset filters</button>'
      );
    }

    function emptyStateNoResultsHtml() {
      return (
        '<div class="table-empty-host">' +
        '<div class="empty-state" role="status">' +
        emptyStateNoResultsInnerHtml() +
        "</div></div>"
      );
    }

    /** Markdown-lite: **bold**, `code`, [label](https…), bare https URLs. */
    function renderMarkdownInline(raw) {
      const s = String(raw);
      let out = "";
      let i = 0;
      while (i < s.length) {
        if (s.startsWith("**", i)) {
          const end = s.indexOf("**", i + 2);
          if (end !== -1) {
            out += "<strong>" + escapeHtml(s.slice(i + 2, end)) + "</strong>";
            i = end + 2;
            continue;
          }
        }
        if (s.charCodeAt(i) === 96) {
          const end = s.indexOf("`", i + 1);
          if (end !== -1) {
            out += "<code>" + escapeHtml(s.slice(i + 1, end)) + "</code>";
            i = end + 1;
            continue;
          }
        }
        const slice = s.slice(i);
        const lm = slice.match(/^\[([^\]]*)\]\(([^)]+)\)/);
        if (lm) {
          const href = lm[2].trim();
          const abs = /^https?:\/\//i.test(href);
          const local = !abs && href.indexOf(":") === -1 && (/^[./]/.test(href) || href.charAt(0) === "/");
          if (abs || local) {
            out +=
              '<a href="' +
              escapeAttr(href) +
              '"' +
              (abs ? ' rel="noopener noreferrer" target="_blank"' : "") +
              ">" +
              escapeHtml(lm[1]) +
              "</a>";
            i += lm[0].length;
            continue;
          }
        }
        const um = slice.match(/^https?:\/\/[^\s<)\]"']+/i);
        if (um) {
          const u = um[0];
          out +=
            '<a href="' +
            escapeAttr(u) +
            '" rel="noopener noreferrer" target="_blank">' +
            escapeHtml(u) +
            "</a>";
          i += u.length;
          continue;
        }
        out += escapeHtml(s[i]);
        i += 1;
      }
      return out;
    }

    function pushNoticeListItems(chunks, bullets) {
      if (!bullets.length) return;
      chunks.push(
        "<ul>" +
          bullets
            .map((line) => "<li>" + renderMarkdownInline(line.replace(/^[-*]\s+/, "")) + "</li>")
            .join("") +
          "</ul>"
      );
      bullets.length = 0;
    }

    function pushNoticeProseLines(chunks, proseLines) {
      if (!proseLines.length) return;
      // Preserve intentional single line breaks; blank lines make separate paragraphs upstream.
      const html = proseLines.map((line) => renderMarkdownInline(line)).join("<br>");
      if (html.trim()) chunks.push("<p>" + html + "</p>");
      proseLines.length = 0;
    }

    function renderNoticeSectionBody(chunks, body) {
      for (const para of String(body || "").replace(/\r\n/g, "\n").split(/\n{2,}/)) {
        const lines = para.split(/\n/).map((l) => l.trim()).filter(Boolean);
        if (!lines.length) continue;
        if (lines.every((l) => /^[-*]\s/.test(l))) {
          pushNoticeListItems(chunks, lines);
          continue;
        }
        const prose = [];
        const bullets = [];
        for (const line of lines) {
          if (/^[-*]\s/.test(line)) {
            pushNoticeProseLines(chunks, prose);
            bullets.push(line);
          } else {
            pushNoticeListItems(chunks, bullets);
            prose.push(line);
          }
        }
        pushNoticeListItems(chunks, bullets);
        pushNoticeProseLines(chunks, prose);
      }
    }

    function importantNoticeAlertClass(title) {
      const t = String(title || "").trim();
      if (/fern aws outage/i.test(t)) return "notice-alert-danger";
      if (/beware of fake sites/i.test(t)) return "notice-alert-warning";
      if (/slowing development temporarily/i.test(t)) return "notice-alert-info";
      if (/proxy connections fully operational/i.test(t)) return "notice-alert-success";
      if (/canary branch coming soon/i.test(t)) return "notice-alert-info";
      if (/link ratings back up/i.test(t)) return "notice-alert-info";
      if (/develop for proxies with ease/i.test(t)) return "notice-alert-info";
      if (/errors with link clicks and ratings/i.test(t)) return "notice-alert-warning";
      return "";
    }

    // Escaped so this inline script never contains a literal HTML comment open/close:
    // Scramjet's HTML rewriter strips those and breaks the whole script.
    const NOTICE_EXPIRES_RE = /<\!--\s*expires:\s*([^>]+?)\s*--\>/i;
    const NOTICE_ADDED_RE = /<\!--\s*added:\s*([^>]+?)\s*--\>/i;
    /** Earliest future "expires: ISO" notice comment seen in the last notices render (ms), or 0. */
    let nextImportantNoticeExpiryMs = 0;

    function formatSiteWhen(raw, opts) {
      const text = String(raw == null ? "" : raw).trim();
      if (!text || text === "—") return text;
      try {
        if (window.ProxyListDateTime && typeof window.ProxyListDateTime.formatLoose === "function") {
          return window.ProxyListDateTime.formatLoose(text, opts) || text;
        }
      } catch (_) {}
      return text;
    }

    function formatNoticeAddedAt(isoOrRaw) {
      const ms = Date.parse(String(isoOrRaw || "").trim());
      if (!Number.isFinite(ms)) return "";
      try {
        if (window.ProxyListDateTime && typeof window.ProxyListDateTime.formatDateTime === "function") {
          return "Added " + window.ProxyListDateTime.formatDateTime(new Date(ms));
        }
        return (
          "Added " +
          new Date(ms).toLocaleString(undefined, {
            dateStyle: "medium",
            timeStyle: "short",
            timeZone: "UTC",
          }) +
          " UTC"
        );
      } catch (_) {
        return "Added " + new Date(ms).toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC");
      }
    }

    function renderUpdateNoticeMarkdown(noticesText) {
      const text = String(noticesText || "").replace(/\r\n/g, "\n").trim();
      if (!text) return "";
      // Match changelog.html: treat # / ## / ### as real headings so "### Fixed"
      // does not show the markdown hashes as literal text in the Update Notice modal.
      const sections = text.split(/(?=^#{1,3} )/m);
      const chunks = [];
      for (const sec of sections) {
        const s = sec.trim();
        if (!s) continue;
        const hm = s.match(/^(#{1,3})\s+(.+?)(?:\n|$)([\s\S]*)$/);
        if (hm) {
          const level = hm[1].length;
          const title = hm[2].trim();
          const body = (hm[3] || "").trim();
          // Prefer h3 in the modal (same as changelog) so section labels stay compact.
          const tag = level >= 3 ? "h3" : "h2";
          chunks.push("<" + tag + ">" + renderMarkdownInline(title) + "</" + tag + ">");
          if (body) renderNoticeSectionBody(chunks, body);
        } else {
          renderNoticeSectionBody(chunks, s);
        }
      }
      return chunks.join("");
    }

    function renderMarkdownLiteNotices(noticesText) {
      const text = String(noticesText || "").replace(/\r\n/g, "\n").trim();
      if (!text) return "";
      // Support # / ## / ### headings so blank-line structure and section breaks render.
      const sections = text.split(/(?=^#{1,3} )/m);
      const chunks = [];
      for (const sec of sections) {
        const s = sec.trim();
        if (!s) continue;
        const hm = s.match(/^(#{1,3})\s+(.+?)(?:\n|$)([\s\S]*)$/);
        if (hm) {
          const level = hm[1].length;
          const title = hm[2].trim();
          let body = (hm[3] || "").trim();
          const em = body.match(NOTICE_EXPIRES_RE);
          if (em) {
            body = body.replace(NOTICE_EXPIRES_RE, "").trim();
            const expMs = Date.parse(em[1]);
            if (Number.isFinite(expMs)) {
              if (Date.now() >= expMs) continue;
              if (!nextImportantNoticeExpiryMs || expMs < nextImportantNoticeExpiryMs) {
                nextImportantNoticeExpiryMs = expMs;
              }
            }
          }
          const am = body.match(NOTICE_ADDED_RE);
          let addedLabel = "";
          if (am) {
            body = body.replace(NOTICE_ADDED_RE, "").trim();
            addedLabel = formatNoticeAddedAt(am[1]);
          }
          const tag = level <= 2 ? "h2" : "h3";
          const alertClass = importantNoticeAlertClass(title);
          if (alertClass) chunks.push('<div class="' + alertClass + '">');
          chunks.push("<" + tag + ">" + renderMarkdownInline(title) + "</" + tag + ">");
          if (addedLabel) {
            chunks.push(
              '<p class="notice-added-at"><time datetime="' +
                escapeAttr(String(am[1]).trim()) +
                '">' +
                escapeHtml(addedLabel) +
                "</time></p>"
            );
          }
          if (body) renderNoticeSectionBody(chunks, body);
          if (alertClass) chunks.push("</div>");
        } else {
          renderNoticeSectionBody(chunks, s);
        }
      }
      return chunks.join("");
    }

    const UPDATE_SEEN_KEY = "proxylist:last-seen-version";
    const UPDATE_SEEN_BANNER_KEY = "proxylist:last-seen-banner-stamp";
    const BANNER_DISMISS_SESSION_KEY = "proxylist:banner-dismiss-stamp";

    function versionOnly(meta) {
      return ((meta && meta.version) || "").trim();
    }

    /** Version + revision + date — detects list/deploy updates even when version string stays the same. */
    function versionStamp(meta) {
      const v = ((meta && meta.version) || "").trim();
      const r = ((meta && meta.revision) || "").trim();
      const d = ((meta && meta.last_updated) || "").trim();
      if (!v && !r && !d) return "";
      return [v, r, d].join("|");
    }

    function humanStamp(stamp) {
      if (!stamp) return "";
      const parts = stamp.split("|");
      const v = parts[0] || "";
      const r = parts[1] || "";
      if (v && r) return v + " · " + r;
      return v || stamp;
    }

    /** Cache-bypass reload so browsers fetch fresh HTML/scripts after a release. */
    function hardReloadBypassCache() {
      try {
        const u = new URL(window.location.href);
        u.searchParams.set("_plcb", String(Date.now()));
        window.location.replace(u.toString());
      } catch (_) {
        window.location.reload();
      }
    }

    function setSiteUpdateBannerVisible(visible) {
      const el = $("siteUpdateBanner");
      if (!el) return;
      if (visible) {
        el.hidden = false;
        document.body.classList.add("has-site-update-banner");
      } else {
        el.hidden = true;
        document.body.classList.remove("has-site-update-banner");
      }
    }

    function readSeenBannerStamp() {
      try {
        let raw = localStorage.getItem(UPDATE_SEEN_BANNER_KEY);
        if (raw === null) {
          const legacy = localStorage.getItem(UPDATE_SEEN_KEY);
          if (legacy && String(legacy).includes("|")) {
            raw = legacy;
            writeSeenBannerStamp(legacy);
          }
        }
        return raw;
      } catch (_) {
        return null;
      }
    }

    function writeSeenBannerStamp(value) {
      try {
        localStorage.setItem(UPDATE_SEEN_BANNER_KEY, value);
      } catch (_) {
        /* storage may be disabled; ignore */
      }
    }

    function maybeShowSiteUpdateBanner(meta) {
      const stamp = versionStamp(meta);
      const stored = readSeenBannerStamp();
      const curVer = versionOnly(meta);
      const seenVer = readSeenVersion();
      const textEl = $("siteUpdateBannerText");
      if (textEl && stamp) {
        textEl.textContent =
          "A new site update is available (" + humanStamp(stamp) + "). Refresh to load the latest list and scripts.";
      }
      if (!stamp) {
        setSiteUpdateBannerVisible(false);
        return;
      }
      // Version bump is handled by the update notice modal — avoid both at once.
      if (curVer && seenVer && seenVer !== curVer) {
        setSiteUpdateBannerVisible(false);
        return;
      }
      if (stored === null || stored === stamp) {
        setSiteUpdateBannerVisible(false);
        return;
      }
      try {
        if (sessionStorage.getItem(BANNER_DISMISS_SESSION_KEY) === stamp) {
          setSiteUpdateBannerVisible(false);
          return;
        }
      } catch (_) {}
      try {
        console.info(
          "[Proxy List] New site update available (" +
            humanStamp(stamp) +
            "). Refresh (banner or cache-bypass reload) to load the latest list and scripts."
        );
      } catch (_) {}
      setSiteUpdateBannerVisible(true);
    }

    function readSeenVersion() {
      try {
        const raw = localStorage.getItem(UPDATE_SEEN_KEY);
        if (raw === null) return null;
        // Legacy values were version|revision|date — only the version triggers the notice.
        const v = String(raw).split("|")[0].trim();
        return v || raw;
      } catch (_) {
        return null;
      }
    }

    function writeSeenVersion(value) {
      try {
        localStorage.setItem(UPDATE_SEEN_KEY, value);
      } catch (_) {
        /* storage may be disabled; ignore */
      }
    }

    function openUpdateModal(meta, fromVersion) {
      const titleEl = $("updateTitle");
      const introEl = $("updateIntro");
      const bodyEl = $("updateNoticesBody");
      const current = versionOnly(meta) || "the latest version";
      const prevVer =
        fromVersion && String(fromVersion).trim()
          ? String(fromVersion).split("|")[0].trim() || String(fromVersion).trim()
          : "";
      if (titleEl) titleEl.textContent = "What's new in " + current;
      if (introEl) {
        if (prevVer && prevVer !== current) {
          introEl.textContent =
            "The proxy list was updated from " + prevVer + " to " + current + ".";
        } else {
          introEl.textContent = "Currently on " + current + ".";
        }
      }
      if (bodyEl) {
        const md = meta && meta.update_notice;
        setHtml(
          bodyEl,
          md && String(md).trim()
            ? renderUpdateNoticeMarkdown(String(md))
            : '<p class="summary-muted">No update notice is available for this version.</p>'
        );
      }
      $("updateBackdrop").classList.add("open");
      $("updateBackdrop").setAttribute("aria-hidden", "false");
    }

    function closeUpdateModal(meta) {
      const ver = versionOnly(meta);
      if (ver) writeSeenVersion(ver);
      const stamp = versionStamp(meta);
      if (stamp) writeSeenBannerStamp(stamp);
      $("updateBackdrop").classList.remove("open");
      $("updateBackdrop").setAttribute("aria-hidden", "true");
      setSiteUpdateBannerVisible(false);
      maybeStartWelcomeTour();
      maybeShowMobileAutoResizeNotice();
    }

    function maybeShowUpdateModal(meta) {
      if (typeof firstVisitConsentPending === "function" && firstVisitConsentPending()) {
        if (!window.__proxyListUpdateModalWaitingOnConsent) {
          window.__proxyListUpdateModalWaitingOnConsent = true;
          whenFirstVisitConsentDone(function () {
            window.__proxyListUpdateModalWaitingOnConsent = false;
            maybeShowUpdateModal(meta);
          });
        }
        return;
      }
      const current = versionOnly(meta);
      if (!current) return;
      const stored = readSeenVersion();
      if (stored === current) return;
      if (stored === null) {
        // First-time visitor: mark current version so the modal only auto-opens on a version bump.
        writeSeenVersion(current);
        const stamp = versionStamp(meta);
        if (stamp) writeSeenBannerStamp(stamp);
        return;
      }
      openUpdateModal(meta, stored);
    }

    let importantNoticeExpiryTimer = null;

    function applyImportantNotices(meta) {
      const md = meta && meta.important_notices;
      nextImportantNoticeExpiryMs = 0;
      importantNoticesStaticHtml = md && String(md).trim() ? renderMarkdownLiteNotices(String(md)) : "";
      refreshImportantNoticesDom();
      if (importantNoticeExpiryTimer) clearTimeout(importantNoticeExpiryTimer);
      importantNoticeExpiryTimer = null;
      const waitMs = nextImportantNoticeExpiryMs - Date.now();
      // setTimeout overflows past ~24.8 days; far-off expiries are handled on the next load.
      if (nextImportantNoticeExpiryMs && waitMs > 0 && waitMs < 2 ** 31 - 1) {
        importantNoticeExpiryTimer = setTimeout(() => applyImportantNotices(meta), waitMs + 1000);
      }
    }

    const FACET_HOVER_TIPS = {
      bare:
        "TompHTTP Bare is the older HTTP transport used by Ultraviolet and early Scramjet setups. The proxy talks to a Bare server (v3+) instead of Wisp. Newer sites usually offer epoxy or libcurl over Wisp instead.",
      captcha: "This provider has support for reCAPTCHA on most sites.",
      epoxy:
        "EpoxyTransport (epoxy-tls) encrypts proxy traffic end-to-end and usually rides on Wisp. Titanium Network describes it as a lightweight, fast BareMux transport compared with older options.",
      libcurl:
        "CurlTransport uses libcurl.js plus Wisp for end-to-end TLS. It can chain through SOCKS5, SOCKS4a, or HTTP proxies (including Tor). Heavier than epoxy; some Ultraviolet + libcurl setups have been flaky.",
      reflux:
        "Reflux is a powerful, universal request/response middleware engine designed for any BareMux compatible web proxy. It features a dynamic plugin system that allows you to load and execute custom JavaScript code on specific websites, making it a transport wrapper rather than a traditional transport.",
      tor:
        "Tor is the most anonymous way to get on the web, which is made hard to track by design and allows access to the deep web/dark web. usually recommended you don't connect to this on some networks as ISPs will know if you connect to a Tor node without a VPN.",
      "user-agent": "This site allows you to change your user agent, which is data that tells websites what device you're on.",
      wisp:
        "Wisp multiplexes many TCP and UDP sockets over a single WebSocket. It is the low-overhead protocol epoxy, libcurl, and most modern proxy transports use instead of a classic Bare server.",
      "gdb:chicken-kings-vault":
        "Game database that uses HTML singlefiles to load games with thumbnail support.",
      "gdb:elite-games":
        "Another large game database that uses HTML singlefiles to load games, with basic descriptions and thumbnails.",
      "gdb:gn-math":
        "Highest-quality and most popular game database with hundreds of well known games and thumbnail and author info support.",
      "gdb:luminsdk":
        "Seems to be a clone or backup of gn-math's database as they both use the same domain.",
      "gdb:noahs-tutoring": "No info on this database yet.",
      "gdb:seraph": "Database with HTML singlefiles of games with thumbnail and genre info support.",
      "gdb:ultimate-game-stash": "Database with hundreds of archived HTML singlefiles of games.",
      "gdb:unblockedzone":
        "Database exclusive to Unblockedzone links with many high-quality games. Many games seem to be ported from the gn-math database.",
      "gdb:lucide":
        "Lucide's built-in game catalog, shipped via lucideproxy/svg (GamesPage assets). Used by Lucide and Lunar links.",
      "gdb:sdxp": "Rift vault pack (SDXP). No detailed info on this database yet.",
      "gdb:duckmath":
        "DuckMath game catalog (local docs/gdb-catalogs/duckmath.json, merged from current DuckMath deploys + Neruvy backup).",
      "gdb:ccported": "Rift vault pack (CCPorted). No detailed info on this database yet.",
      "gdb:selenite": "Selenite's game catalog (also exposed as a Rift vault pack). No detailed info on this database yet.",
      "gdb:radon": "Rift vault pack (Radon). No detailed info on this database yet.",
      "gdb:truffled":
        "Database made for and exclusively used by Truffled links.",
      "gdb:totally-science": "Rift vault pack (Totally Science). No detailed info on this database yet.",
      "gdb:petezah":
        "Database made for PetZah, with some games contributed from Selenite's database.",
      "gdb:frogies-arcade":
        "Database made for and used exclusively by frogie's arcade links.",
      "gdb:space":
        "Database made for and used exclusively by Space links.",
      "gdb:boredom":
        "Database made for and exclusively used by Boredom links.",
      "gdb:dogeub":
        "Database made for and exclusively used by dogeub links.",
      "gdb:utopia":
        "Database made for Utopia Education links with a few externally hosted games in the mix. External games loaded via Ultraviolet.",
      "gdb:nexora":
        "Nexora’s own game catalog (401 titles). Scraped from the site’s game-info.json; files live in nexorainteractives/Nexora-Assets.",
      eclipse:
        "An interception web proxy (not covered in Titanium Network’s docs). It rewrites pages in the browser and typically uses Wisp with libcurl or bare-mux. Newer and less common than Scramjet or Ultraviolet.",
      rammerhead:
        "A session-based proxy built on TestCafe Hammerhead — not a service-worker interception proxy. Cookies and localStorage sync in a named session so logins can persist across devices. Titanium Network says it is technically maintained but not actively worked on, because it is heavy on the server. Google login and Netflix generally do not work.",
      scramjet:
        "Mercury Workshop’s flagship interception proxy (often abbreviated SJ). A service worker rewrites pages in the browser. Titanium Network recommends it over Ultraviolet: it is stable enough for production and has broader site support.",
      ultraviolet:
        "Titanium Network’s older interception proxy. A service worker intercepts HTTP using a BareMux transport (Bare, epoxy, or libcurl). It is unmaintained — TN recommends switching to Scramjet — but a few sites still work better on UV. Historically included CAPTCHA/hCAPTCHA support.",
    };

    function facetTipFor(tag) {
      const key = String(tag || "").trim().toLowerCase();
      return FACET_HOVER_TIPS[key] || "";
    }

    function hideFacetTip() {
      const tip = $("facetTip");
      if (!tip) return;
      tip.hidden = true;
      tip.textContent = "";
    }

    function positionFacetTip(anchor, tip) {
      if (!anchor || !tip) return;
      const rect = anchor.getBoundingClientRect();
      const pad = 8;
      tip.hidden = false;
      const tipRect = tip.getBoundingClientRect();
      let left = rect.left;
      let top = rect.bottom + 6;
      if (left + tipRect.width > window.innerWidth - pad) {
        left = Math.max(pad, window.innerWidth - tipRect.width - pad);
      }
      if (top + tipRect.height > window.innerHeight - pad) {
        top = Math.max(pad, rect.top - tipRect.height - 6);
      }
      tip.style.left = left + "px";
      tip.style.top = top + "px";
    }

    function wireFacetHoverTips() {
      if (document.documentElement.dataset.facetTipsWired === "1") return;
      document.documentElement.dataset.facetTipsWired = "1";
      let active = null;
      document.addEventListener(
        "mouseover",
        (ev) => {
          const el = ev.target && ev.target.closest ? ev.target.closest("[data-facet-tip]") : null;
          if (!el) {
            if (active) {
              active = null;
              hideFacetTip();
            }
            return;
          }
          const tip = $("facetTip");
          const text = el.getAttribute("data-facet-tip") || "";
          if (!tip || !text) return;
          if (active === el) return;
          active = el;
          tip.textContent = text;
          positionFacetTip(el, tip);
        },
        true
      );
      document.addEventListener(
        "mouseout",
        (ev) => {
          const el = ev.target && ev.target.closest ? ev.target.closest("[data-facet-tip]") : null;
          if (!el || el !== active) return;
          const related = ev.relatedTarget;
          if (related && el.contains(related)) return;
          active = null;
          hideFacetTip();
        },
        true
      );
      window.addEventListener("scroll", hideFacetTip, true);
      window.addEventListener("resize", hideFacetTip);
    }

    function formatTags(tags) {
      if (!tags || !tags.length) return '<span class="pill">—</span>';
      return tags
        .map((t) => {
          const tip = facetTipFor(t);
          return (
            '<span class="pill"' +
            (tip ? ' data-facet-tip="' + escapeAttr(tip) + '"' : "") +
            ">" +
            escapeHtml(t) +
            "</span>"
          );
        })
        .join("");
    }

    function countRowsWithProvider(rows, value) {
      let n = 0;
      for (const row of rows) {
        if ((row.provider || "") === value) n += 1;
      }
      return n;
    }

    function countRowsWithCategory(rows, value) {
      let n = 0;
      for (const row of rows) {
        if (canonicalCategory(row.category) === value) n += 1;
      }
      return n;
    }

    function countRowsWithProtocol(rows, value) {
      let n = 0;
      for (const row of rows) {
        const pt = row.protocol_tags || [];
        if (pt.includes(value)) n += 1;
      }
      return n;
    }

    function countRowsWithCapability(rows, value) {
      let n = 0;
      for (const row of rows) {
        const ct = row.capability_tags || [];
        if (ct.includes(value)) n += 1;
      }
      return n;
    }

    function buildCheckboxGroup(containerId, values, rows, countForValue, meta, linkCheck) {
      const wrap = $(containerId);
      if (!wrap) return;
      setHtml(wrap, "");
      const useTips = containerId === "capTags" || containerId === "protocolTags";
      for (const v of values) {
        const lab = document.createElement("label");
        lab.className = "tag";
        if (useTips) {
          const tip = facetTipFor(v);
          if (tip) lab.setAttribute("data-facet-tip", tip);
        }
        const inp = document.createElement("input");
        inp.type = "checkbox";
        inp.value = v;
        inp.addEventListener("change", () => {
          render(rows, meta, linkCheck);
          scheduleUserProfileWrite();
        });
        const countEl = document.createElement("span");
        countEl.className = "tag-count";
        countEl.textContent = "(" + countForValue(v) + ") ";
        lab.appendChild(inp);
        lab.appendChild(countEl);
        lab.appendChild(document.createTextNode(v));
        wrap.appendChild(lab);
      }
    }

    function buildCapCheckboxes(rows, meta, linkCheck) {
      buildCheckboxGroup(
        "capTags",
        selectableFacetTags(rows.flatMap((r) => r.capability_tags || [])),
        rows,
        (v) => countRowsWithCapability(rows, v),
        meta,
        linkCheck
      );
    }

    function normalizePayload(json) {
      if (window.ProxyListData && typeof window.ProxyListData.normalizePayload === "function") {
        const normalized = window.ProxyListData.normalizePayload(json);
        if (normalized.compact) {
          const expanded = window.ProxyListData.expandAllLinks({
            format: 2,
            providers: normalized.compact.providers,
            contributors: normalized.compact.contributors,
            links: normalized.compact.links,
          });
          return {
            meta: normalized.meta,
            link_check: normalized.link_check,
            links: expanded,
            failing_links: normalized.failing_links,
          };
        }
        return {
          meta: normalized.meta,
          link_check: normalized.link_check,
          links: normalized.links || [],
          failing_links: normalized.failing_links,
        };
      }
      if (Array.isArray(json)) {
        return { meta: {}, link_check: {}, links: json };
      }
      const meta = Object.assign({}, json.meta || {});
      const changelog = Array.isArray(meta.update_changelog) ? meta.update_changelog : [];
      const latest = changelog[0] && typeof changelog[0] === "object" ? changelog[0] : null;
      if (latest) {
        if (!String(meta.version || "").trim() && latest.version) meta.version = latest.version;
        if (!String(meta.revision || "").trim() && latest.revision) meta.revision = latest.revision;
        if (!String(meta.last_updated || "").trim() && latest.released) meta.last_updated = latest.released;
        if (!String(meta.update_notice || "").trim() && latest.update_notice) {
          meta.update_notice = latest.update_notice;
        }
      }
      return {
        meta,
        link_check: json.link_check || {},
        links: json.links || [],
      };
    }

    function isWebProxyEnv() {
      try {
        return !!(
          window.ProxyListData &&
          typeof window.ProxyListData.looksLikeWebProxy === "function" &&
          window.ProxyListData.looksLikeWebProxy()
        );
      } catch (_) {
        return false;
      }
    }

    function compactPayloadFromNormalized(normalized) {
      return {
        format: 2,
        providers: normalized.compact.providers,
        contributors: normalized.compact.contributors,
        links: normalized.compact.links,
      };
    }

    function replaceLinksInPlace(target, next) {
      if (!target || !Array.isArray(next)) return target;
      target.length = 0;
      for (let i = 0; i < next.length; i++) target[i] = next[i];
      return target;
    }

    function fillSidebarFilterGroups(rowset, meta, linkCheck) {
      const providerCounts = new Map();
      const categoryCounts = new Map();
      const protocolCounts = new Map();
      const capCounts = new Map();
      for (let i = 0; i < rowset.length; i++) {
        const d = rowset[i];
        if (!d) continue;
        const p = d.provider;
        if (p) providerCounts.set(p, (providerCounts.get(p) || 0) + 1);
        const cat = canonicalCategory(d.category);
        if (cat) categoryCounts.set(cat, (categoryCounts.get(cat) || 0) + 1);
        const pts = d.protocol_tags;
        if (pts && pts.length) {
          for (let j = 0; j < pts.length; j++) {
            const t = pts[j];
            if (t) protocolCounts.set(t, (protocolCounts.get(t) || 0) + 1);
          }
        }
        const cts = d.capability_tags;
        if (cts && cts.length) {
          for (let j = 0; j < cts.length; j++) {
            const t = cts[j];
            if (t) capCounts.set(t, (capCounts.get(t) || 0) + 1);
          }
        }
      }
      const sortKeys = (m) => [...m.keys()].filter(Boolean).sort((a, b) => a.localeCompare(b));
      buildCheckboxGroup(
        "providerTags",
        sortKeys(providerCounts),
        rowset,
        (v) => providerCounts.get(v) || 0,
        meta,
        linkCheck
      );
      buildCheckboxGroup(
        "categoryTags",
        sortKeys(categoryCounts),
        rowset,
        (v) => categoryCounts.get(v) || 0,
        meta,
        linkCheck
      );
      buildCheckboxGroup(
        "protocolTags",
        selectableFacetTags(sortKeys(protocolCounts)),
        rowset,
        (v) => protocolCounts.get(v) || 0,
        meta,
        linkCheck
      );
      buildCheckboxGroup(
        "capTags",
        selectableFacetTags(sortKeys(capCounts)),
        rowset,
        (v) => capCounts.get(v) || 0,
        meta,
        linkCheck
      );
    }

    async function normalizePayloadAsync(json) {
      if (window.ProxyListData && typeof window.ProxyListData.normalizePayload === "function") {
        const normalized = window.ProxyListData.normalizePayload(json);
        if (normalized.compact && typeof window.ProxyListData.expandAllLinks === "function") {
          const compact = compactPayloadFromNormalized(normalized);
          const total = compact.links.length;
          const proxy = isWebProxyEnv();
          const firstN = proxy || total > 4000 ? Math.min(800, total) : total;
          if (firstN < total) {
            reportContentLoadingProgress(40, "Preparing list…");
            const head = Object.assign({}, compact, { links: compact.links.slice(0, firstN) });
            const expandedHead = window.ProxyListData.expandAllLinks(head, { shareProviderArrays: true });
            return {
              meta: normalized.meta,
              link_check: normalized.link_check,
              links: expandedHead,
              failing_links: normalized.failing_links,
              pendingCompact: compact,
              expandTotal: total,
            };
          }
          if (typeof window.ProxyListData.expandAllLinksAsync === "function") {
            const expanded = await window.ProxyListData.expandAllLinksAsync(compact, {
              onProgress: function (ratio) {
                const pct = 38 + Math.round(Math.max(0, Math.min(1, Number(ratio) || 0)) * 14);
                reportContentLoadingProgress(pct, "Preparing list…");
              },
            });
            return {
              meta: normalized.meta,
              link_check: normalized.link_check,
              links: expanded,
              failing_links: normalized.failing_links,
            };
          }
        }
        return normalizePayload(json);
      }
      return normalizePayload(json);
    }

    let offlineExportScriptPromise = null;
    function resolveDocsAssetUrl(name) {
      try {
        if (window.ProxyListData && typeof window.ProxyListData.listAssetUrlCandidates === "function") {
          const base =
            typeof window.ProxyListData.listAssetBaseUrl === "function"
              ? window.ProxyListData.listAssetBaseUrl()
              : "";
          const candidates = window.ProxyListData.listAssetUrlCandidates(name, base);
          if (candidates && candidates.length) return candidates[0];
        }
      } catch (_) {}
      return name;
    }
    function ensureOfflineExportScript() {
      if (window.ProxyListOfflineExport) return Promise.resolve(window.ProxyListOfflineExport);
      if (!offlineExportScriptPromise) {
        offlineExportScriptPromise = new Promise((resolve, reject) => {
          const s = document.createElement("script");
          s.src = resolveDocsAssetUrl("offline-export.js");
          s.onload = () => resolve(window.ProxyListOfflineExport);
          s.onerror = () => reject(new Error("Could not load offline-export.js"));
          document.head.appendChild(s);
        });
      }
      return offlineExportScriptPromise;
    }

    function wireOfflineExportOpen() {
      const btn = $("offlineExportOpenBtn");
      if (!btn || btn.dataset.wired === "1") return;
      btn.dataset.wired = "1";
      btn.addEventListener("click", () => {
        void ensureOfflineExportScript()
          .then((api) => {
            if (api && typeof api.open === "function") api.open();
            else showAppToast("Offline download is unavailable in this browser.");
          })
          .catch((err) => {
            console.warn("[proxy-list] Offline export failed to load", err);
            showAppToast("Could not open offline download on this host. Try Copy to clipboard after a refresh, or open the site outside a web proxy.");
          });
      });
    }

    function syncSidebarToggleLabel() {
      const btn = $("sidebarToggleBtn");
      const label = (btn && btn.querySelector("#sidebarToggleLabel")) || $("sidebarToggleLabel");
      const collapsed = document.documentElement.classList.contains("sidebar-collapsed");
      const text = collapsed ? "Show" : "Hide";
      if (btn) {
        btn.setAttribute("aria-expanded", collapsed ? "false" : "true");
        btn.setAttribute("aria-label", collapsed ? "Show sidebar" : "Hide sidebar");
        btn.dataset.sidebarState = collapsed ? "hidden" : "visible";
      }
      if (label) label.textContent = text;
    }

    function wireSidebarToggle() {
      const btn = $("sidebarToggleBtn");
      if (!btn || btn.dataset.wired === "1") return;
      btn.dataset.wired = "1";
      syncSidebarToggleLabel();
      btn.addEventListener("click", () => {
        const next = !document.documentElement.classList.contains("sidebar-collapsed");
        document.documentElement.classList.toggle("sidebar-collapsed", next);
        try {
          localStorage.setItem(LS_SIDEBAR_COLLAPSED_KEY, next ? "1" : "0");
        } catch (_) {}
        syncSidebarToggleLabel();
      });
    }

    function bootProxyListApp() {
      if (window.__proxyListAppBooted) return;
      window.__proxyListAppBooted = true;
    wireSidebarToggle();
    wireOfflineExportOpen();
    wireWelcomeTourReplayButton();
    wireResetSavedDataButton();

    setContentLoading(true, { progress: 0, message: "Getting data..." });
    applyImportantNotices({});
    bindClickLoadSlowPromptButtons();
    initSavedLinksView();
    initEmbedMode();
    setupAccountUI();
    restoreFirebaseQuotaBannerFromSession();
    startPresenceWorkerPings();
    if (isFileProtocol()) {
      setContentLoading(false);
      setHtml(
        $("tableWrap"),
        '<p class="err">This site must be served over HTTP — opening <code>index.html</code> directly will not work.<br><br>' +
          'Run a local server from the <code>docs</code> folder, for example:<br>' +
          "<code>python -m http.server 8080</code><br><br>" +
          'Then open <code>http://localhost:8080/</code> in your browser.</p>'
      );
    } else {
    try {
      window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
        if ((appSettings.theme || "dark") === "auto") applyThemeSetting("auto");
      });
    } catch (_) {}

    const settingsReady = loadAppSettings().catch((err) => {
      console.warn("[proxy-list] Settings load failed; using defaults.", err);
    });
    const listPayload = window.__proxyListDataPromise
      ? window.__proxyListDataPromise
      : window.ProxyListData && window.ProxyListData.fetchListPayload
      ? window.ProxyListData.fetchListPayload({
          onAttempt: function (file) {
            reportContentLoadingProgress(12, file && /\.gz$/.test(file) ? "Getting data (compressed)..." : "Getting data...");
          },
        })
      : fetch("data.json").then((r) => {
          if (!r.ok) throw new Error("Could not load data.json (" + r.status + ")");
          return r.json();
        });

    Promise.all([
      promiseWithTimeout(settingsReady, 2000, "settings timeout").catch(() => {}),
      listPayload.catch((err) => {
        throw err && err.message ? err : new Error("Could not load list data");
      }),
      (window.ProxyListData && window.ProxyListData.fetchTextAsset
        ? window.ProxyListData.fetchTextAsset("checked_domains.txt", { timeoutMs: 20000 })
        : fetch("checked_domains.txt").then((r) => (r.ok ? r.text() : ""))
      ).catch(() => ""),
    ])
      .then(([, json, checkedDomainsText]) => {
        reportContentLoadingProgress(35, "Getting data...");
        return normalizePayloadAsync(json).then((normalized) => {
        if (window.__proxyListBootGuard) window.__proxyListBootGuard.ok();
        initFolderReportModal();
        reportContentLoadingProgress(55, "Preparing list…");
        const { meta, link_check } = normalized;
        const links = normalized.links || [];
        rebuildLinkLensIndexes();
        populateKnownFilters();
        updateSelectedFilterUI();
        void ensureLinkLensLoaded();
        checkedDomains = new Set(
          String(checkedDomainsText || "")
            .split(/\r?\n/)
            .map((s) => s.trim().toLowerCase().replace(/^www\./, ""))
            .filter(Boolean)
        );
        pageContext = { links, meta, link_check };
        syncFeaturedGdbButtons();
        syncOfflineExportGlobals();
        currentListVersionStamp = versionStamp(meta) || "";
        if (json && typeof json.failing_links === "object" && json.failing_links) {
          failingLinks = json.failing_links;
        }
        if (meta && Number.isFinite(meta.fail_threshold) && meta.fail_threshold > 0) {
          failThreshold = meta.fail_threshold;
        }
        applyImportantNotices(meta);
        applyListViewModeUi();
        setFooter(meta);
        syncMostOpenedProviderOptions(links);
        const moSortSel = $("mostOpenedSortSelect");
        const moProvSel = $("mostOpenedProviderSelect");
        if (moSortSel) moSortSel.value = getMostOpenedSortMode();
        if (!isWebProxyEnv()) void renderMostOpenedForList(links);
        maybeShowUpdateModal(meta);
        maybeShowSiteUpdateBanner(meta);
        try {
          const u = new URL(window.location.href);
          if (u.searchParams.has("_plcb")) {
            u.searchParams.delete("_plcb");
            history.replaceState({}, "", u.search + u.hash || ".");
          }
        } catch (_) {}
        fillSidebarFilterGroups(links, meta, link_check);
        restoreListFiltersLocally({ keepUrlSearch: true });
        persistListFiltersLocally();
        reportContentLoadingProgress(82, "Rendering links…");

        function resetAllFilters() {
          const q = $("q");
          if (q) q.value = "";
          hideSearchSuggestions();
          for (const id of ["providerTags", "categoryTags", "protocolTags", "capTags"]) {
            const wrap = $(id);
            if (!wrap) continue;
            wrap.querySelectorAll('input[type="checkbox"]').forEach((inp) => {
              inp.checked = false;
            });
          }
          const anyCap = document.querySelector('input[name="capMode"][value="any"]');
          if (anyCap) anyCap.checked = true;
          selectedGnMathFilter = "";
          const filterSel = $("filterSelect");
          if (filterSel) filterSel.value = "";
          hideBlockedBySelectedFilter = false;
          hideLinksWithoutLensCheck = false;
          updateSelectedFilterUI();
          if (moProvSel) {
            moProvSel.value = "";
            persistMostOpenedProviderChoice("");
          }
          render(links, meta, link_check);
          void renderMostOpenedForList(links);
          persistListFiltersLocally();
          scheduleUserProfileWrite();
        }

        wireSearchAutocomplete(links);
        if (window.ProxyListGameDbSearch && typeof window.ProxyListGameDbSearch.warmAll === "function") {
          const tags = getSelectedGdbSearchTags();
          void window.ProxyListGameDbSearch.warmAll(tags === null ? undefined : { tags: tags });
        }
        const qInput = $("q");
        if (qInput) {
          qInput.addEventListener("input", () => {
            scheduleRender(links, meta, link_check, { debounceMs: 200 });
            scheduleUserProfileWrite();
          });
        }
        let initialSearchQuery = null;
        try {
          const u = new URL(window.location.href);
          initialSearchQuery = u.searchParams.get("q");
          const qIn = $("q");
          if (qIn && initialSearchQuery != null) qIn.value = initialSearchQuery;
        } catch (_) {}
        const resetFiltersBtn = $("resetFiltersBtn");
        if (resetFiltersBtn) resetFiltersBtn.addEventListener("click", resetAllFilters);
        document.querySelectorAll('input[name="capMode"]').forEach((el) => {
          el.addEventListener("change", () => {
            render(links, meta, link_check);
            scheduleUserProfileWrite();
          });
        });

        const mainContentEl = $("mainContent");
        if (mainContentEl) mainContentEl.addEventListener("click", (ev) => {
          const target = ev.target;
          if (!(target instanceof Element)) return;
          if (target.closest(".save-link-btn")) return;
          if (target.closest(".empty-state-reset-btn")) {
            ev.preventDefault();
            resetAllFilters();
            return;
          }
          const contribBtn = target.closest(".contributor-search-btn");
          if (contribBtn) {
            ev.preventDefault();
            applyContributorSearch(contribBtn.getAttribute("data-contributor-query") || "");
            return;
          }
          const linkEl = target.closest("a.js-link-summary");
          if (!linkEl) return;
          ev.preventDefault();
          const href = safeHttpUrl(
            linkEl.getAttribute("data-link") || linkEl.getAttribute("href")
          );
          if (!href) return;
          handleLinkListSelection(href);
        });

        const summaryCloseBtn = $("summaryCloseBtn");
        if (summaryCloseBtn) summaryCloseBtn.addEventListener("click", closeSummary);
        const summaryOpenBtn = $("summaryOpenBtn");
        if (summaryOpenBtn) summaryOpenBtn.addEventListener("click", (ev) => {
          const link = safeHttpUrl(ev.currentTarget.getAttribute("href") || "");
          if (!link) return;
          if (!confirmMalwareAction(link, "open")) {
            ev.preventDefault();
            return;
          }
          if (isJsDelivrUrl(link)) {
            ev.preventDefault();
            openJsDelivrPicker(link);
          }
        });
        const summaryCopyBtn = $("summaryCopyBtn");
        if (summaryCopyBtn) summaryCopyBtn.addEventListener("click", async (ev) => {
          const btn = ev.currentTarget;
          const link = safeHttpUrl((btn && btn.dataset && btn.dataset.link) || "");
          if (!link) return;
          if (!confirmMalwareAction(link, "copy")) return;
          if (isJsDelivrUrl(link)) {
            openJsDelivrPicker(link, "copy");
            return;
          }
          const ok = await copyPlainTextToClipboard(link);
          flashSummaryCopyButtonState(ok);
        });
        const selectFilterBtn = $("selectFilterBtn");
        if (selectFilterBtn) selectFilterBtn.addEventListener("click", () => void openFilterModal());
        wireFeaturedProxyButtons();
        wireSearchPalette();
        wireFacetHoverTips();
        const randomLinkBtn = $("randomLinkBtn");
        if (randomLinkBtn) {
          randomLinkBtn.addEventListener("click", () => openRandomLinkModal());
        }
        const randomLinkCloseBtn = $("randomLinkCloseBtn");
        if (randomLinkCloseBtn) {
          randomLinkCloseBtn.addEventListener("click", () => closeRandomLinkModal());
        }
        const randomLinkCancelBtn = $("randomLinkCancelBtn");
        if (randomLinkCancelBtn) {
          randomLinkCancelBtn.addEventListener("click", () => closeRandomLinkModal());
        }
        const randomLinkSpinBtn = $("randomLinkSpinBtn");
        if (randomLinkSpinBtn) {
          randomLinkSpinBtn.addEventListener("click", () => {
            void runRandomLinkSpin();
          });
        }
        const randomLinkOpenBtn = $("randomLinkOpenBtn");
        if (randomLinkOpenBtn) {
          randomLinkOpenBtn.addEventListener("click", () => {
            void openRandomLinkResult();
          });
        }
        const randomLinkBackdrop = $("randomLinkBackdrop");
        if (randomLinkBackdrop) {
          randomLinkBackdrop.addEventListener("click", (ev) => {
            if (ev.target === randomLinkBackdrop) closeRandomLinkModal();
          });
        }
        function onEl(id, type, fn) {
          const el = $(id);
          if (el) el.addEventListener(type, fn);
        }
        onEl("filterCloseBtn", "click", closeFilterModal);
        onEl("filterSelect", "change", (ev) => {
          selectedGnMathFilter = ev.target.value || "";
          updateSelectedFilterUI();
          void renderAfterHeavyFilter(links, meta, link_check);
          void renderMostOpenedForList(links);
          scheduleUserProfileWrite();
        });
        if (moSortSel) {
          moSortSel.addEventListener("change", () => {
            persistMostOpenedSortMode(moSortSel.value);
            void renderMostOpenedForList(links);
            scheduleUserProfileWrite();
          });
        }
        if (moProvSel) {
          moProvSel.addEventListener("change", () => {
            persistMostOpenedProviderChoice(moProvSel.value);
            void renderMostOpenedForList(links);
            scheduleUserProfileWrite();
          });
        }
        const linkListSortSelect = $("linkListSortSelect");
        if (linkListSortSelect) {
          linkListSortSelect.value = listSortMode;
          linkListSortSelect.addEventListener("change", () => {
            persistLinkListSortMode(linkListSortSelect.value);
            void renderAfterHeavyFilter(links, meta, link_check);
          });
        }
        onEl("hideBlockedBtn", "click", () => {
          hideBlockedBySelectedFilter = !hideBlockedBySelectedFilter;
          updateSelectedFilterUI();
          void renderAfterHeavyFilter(links, meta, link_check);
          scheduleUserProfileWrite();
        });
        onEl("hideUncheckedBtn", "click", () => {
          hideLinksWithoutLensCheck = !hideLinksWithoutLensCheck;
          updateSelectedFilterUI();
          void renderAfterHeavyFilter(links, meta, link_check);
          scheduleUserProfileWrite();
        });
        const openSettingsBtn = $("openSettingsBtn");
        if (openSettingsBtn) openSettingsBtn.addEventListener("click", () => openSettingsModal());
        const settingsCloseBtn = $("settingsCloseBtn");
        if (settingsCloseBtn) settingsCloseBtn.addEventListener("click", closeSettingsModal);
        const settingsBackdrop = $("settingsBackdrop");
        if (settingsBackdrop) {
          settingsBackdrop.addEventListener("click", (ev) => {
            if (ev.target === settingsBackdrop) closeSettingsModal();
          });
        }
        const settingsThemeSelect = $("settingsThemeSelect");
        if (settingsThemeSelect) {
          settingsThemeSelect.addEventListener("change", () => {
            void updateAppSetting({ theme: settingsThemeSelect.value || "dark" });
          });
        }
        const settingsDeviceSizingSelect = $("settingsDeviceSizingSelect");
        if (settingsDeviceSizingSelect) {
          settingsDeviceSizingSelect.addEventListener("change", () => {
            void updateAppSetting({ deviceSizing: settingsDeviceSizingSelect.value || "auto" });
          });
        }
        const settingsAnimationsSelect = $("settingsAnimationsSelect");
        if (settingsAnimationsSelect) {
          settingsAnimationsSelect.addEventListener("change", () => {
            void updateAppSetting({ animations: settingsAnimationsSelect.value !== "disabled" });
          });
        }
        const settingsDebugModeSelect = $("settingsDebugModeSelect");
        if (settingsDebugModeSelect) {
          settingsDebugModeSelect.addEventListener("change", () => {
            const enabled = settingsDebugModeSelect.value === "enabled";
            if (enabled) {
              // Revert the select until the user confirms; enabling requires a refresh.
              settingsDebugModeSelect.value = "disabled";
              openDebugModeWarnModal();
              return;
            }
            void updateAppSetting({ debugMode: false });
          });
        }
        const debugModeWarnCancelBtn = $("debugModeWarnCancelBtn");
        if (debugModeWarnCancelBtn) {
          debugModeWarnCancelBtn.addEventListener("click", () => cancelDebugModeEnable());
        }
        const debugModeWarnConfirmBtn = $("debugModeWarnConfirmBtn");
        if (debugModeWarnConfirmBtn) {
          debugModeWarnConfirmBtn.addEventListener("click", () => {
            void confirmDebugModeEnableAndRefresh();
          });
        }
        const debugModeWarnBackdrop = $("debugModeWarnBackdrop");
        if (debugModeWarnBackdrop) {
          debugModeWarnBackdrop.addEventListener("click", (ev) => {
            if (ev.target === debugModeWarnBackdrop) cancelDebugModeEnable();
          });
        }
        const settingsDebugErudaSelect = $("settingsDebugErudaSelect");
        if (settingsDebugErudaSelect) {
          settingsDebugErudaSelect.addEventListener("change", () => {
            void updateAppSetting({
              debugEruda: settingsDebugErudaSelect.value !== "disabled",
            });
          });
        }
        const settingsDebugUaVisibilitySelect = $("settingsDebugUaVisibilitySelect");
        if (settingsDebugUaVisibilitySelect) {
          settingsDebugUaVisibilitySelect.addEventListener("change", () => {
            void updateAppSetting({
              debugShowUserAgent: settingsDebugUaVisibilitySelect.value !== "hide",
            });
          });
        }
        const settingsDebugFirebaseApiSelect = $("settingsDebugFirebaseApiSelect");
        if (settingsDebugFirebaseApiSelect) {
          settingsDebugFirebaseApiSelect.addEventListener("change", () => {
            const enabled = settingsDebugFirebaseApiSelect.value !== "disabled";
            void updateAppSetting({ firebaseApiEnabled: enabled }).then(() => {
              void applyFirebaseApiSetting(enabled);
            });
          });
        }
        const settingsDebugPerfGraphSelect = $("settingsDebugPerfGraphSelect");
        if (settingsDebugPerfGraphSelect) {
          settingsDebugPerfGraphSelect.addEventListener("change", () => {
            void updateAppSetting({
              debugPerfGraph: settingsDebugPerfGraphSelect.value === "enabled",
            });
          });
        }
        const settingsDebugCullingTestSelect = $("settingsDebugCullingTestSelect");
        if (settingsDebugCullingTestSelect) {
          settingsDebugCullingTestSelect.addEventListener("change", () => {
            const enabled = settingsDebugCullingTestSelect.value === "enabled";
            // Revert until confirm; enable and disable both require a refresh.
            settingsDebugCullingTestSelect.value =
              appSettings.debugCullingTest === true ? "enabled" : "disabled";
            openDebugCullingWarnModal(enabled);
          });
        }
        const debugCullingWarnCancelBtn = $("debugCullingWarnCancelBtn");
        if (debugCullingWarnCancelBtn) {
          debugCullingWarnCancelBtn.addEventListener("click", () => cancelDebugCullingChange());
        }
        const debugCullingWarnConfirmBtn = $("debugCullingWarnConfirmBtn");
        if (debugCullingWarnConfirmBtn) {
          debugCullingWarnConfirmBtn.addEventListener("click", () => {
            void confirmDebugCullingChangeAndRefresh();
          });
        }
        const debugCullingWarnBackdrop = $("debugCullingWarnBackdrop");
        if (debugCullingWarnBackdrop) {
          debugCullingWarnBackdrop.addEventListener("click", (ev) => {
            if (ev.target === debugCullingWarnBackdrop) cancelDebugCullingChange();
          });
        }
        const debugExportConsoleBtn = $("debugExportConsoleBtn");
        if (debugExportConsoleBtn) {
          debugExportConsoleBtn.addEventListener("click", () => exportDebugConsoleLogs());
        }
        const debugExportChunkBtn = $("debugExportChunkBtn");
        if (debugExportChunkBtn) {
          debugExportChunkBtn.addEventListener("click", () => exportDebugChunkLogs());
        }
        const debugExportUaHostBtn = $("debugExportUaHostBtn");
        if (debugExportUaHostBtn) {
          debugExportUaHostBtn.addEventListener("click", () => exportDebugUaHostData());
        }
        const debugCheckScriptsBtn = $("debugCheckScriptsBtn");
        if (debugCheckScriptsBtn) {
          debugCheckScriptsBtn.addEventListener("click", () => void debugCheckScriptUpdates());
        }
        const debugCheckListBtn = $("debugCheckListBtn");
        if (debugCheckListBtn) {
          debugCheckListBtn.addEventListener("click", () => void debugCheckListUpdates());
        }
        const debugCheckFilterBtn = $("debugCheckFilterBtn");
        if (debugCheckFilterBtn) {
          debugCheckFilterBtn.addEventListener("click", () => void debugCheckFilterUpdates());
        }
        const debugFireTestNotificationBtn = $("debugFireTestNotificationBtn");
        if (debugFireTestNotificationBtn) {
          debugFireTestNotificationBtn.addEventListener("click", () => {
            const sel = $("settingsDebugTestNotificationSelect");
            fireDebugTestNotification(sel ? sel.value : "");
          });
        }
        const debugFireUpdateBannerBtn = $("debugFireUpdateBannerBtn");
        if (debugFireUpdateBannerBtn) {
          debugFireUpdateBannerBtn.addEventListener("click", () => fireDebugUpdateRefreshBanner());
        }
        const debugVersionDowngradeBtn = $("debugVersionDowngradeBtn");
        if (debugVersionDowngradeBtn) {
          debugVersionDowngradeBtn.addEventListener("click", () => debugDowngradeToLastVersion());
        }
        const debugVersionCustomBtn = $("debugVersionCustomBtn");
        if (debugVersionCustomBtn) {
          debugVersionCustomBtn.addEventListener("click", () => debugSetCustomVersion());
        }
        const settingsLinkActionSelect = $("settingsLinkActionSelect");
        if (settingsLinkActionSelect) {
          settingsLinkActionSelect.addEventListener("change", () => {
            void updateAppSetting({ linkSelectionAction: settingsLinkActionSelect.value || "summary" });
          });
        }
        const settingsAdditionalNotesSelect = $("settingsAdditionalNotesSelect");
        if (settingsAdditionalNotesSelect) {
          settingsAdditionalNotesSelect.addEventListener("change", () => {
            void updateAppSetting({
              additionalNotesVisibility: settingsAdditionalNotesSelect.value === "hide" ? "hide" : "show",
            });
          });
        }
        const settingsGdbList = $("settingsGdbList");
        if (settingsGdbList) {
          settingsGdbList.addEventListener("change", (ev) => {
            const t = ev && ev.target;
            if (!t || t.type !== "checkbox" || !t.getAttribute("data-gdb-tag")) return;
            void commitGdbSettingsFromUi();
          });
        }
        const settingsGdbSelectAllBtn = $("settingsGdbSelectAllBtn");
        if (settingsGdbSelectAllBtn) {
          settingsGdbSelectAllBtn.addEventListener("click", () => {
            void updateAppSetting({ gdbSearchSelectedTags: null });
          });
        }
        const settingsGdbClearBtn = $("settingsGdbClearBtn");
        if (settingsGdbClearBtn) {
          settingsGdbClearBtn.addEventListener("click", () => {
            void updateAppSetting({ gdbSearchSelectedTags: [] });
          });
        }
        const settingsRenderEmojisSelect = $("settingsRenderEmojisSelect");
        if (settingsRenderEmojisSelect) {
          settingsRenderEmojisSelect.addEventListener("change", () => {
            void updateAppSetting({ renderEmojis: settingsRenderEmojisSelect.value !== "disabled" });
          });
        }
        const settingsChunkSizeSelect = $("settingsChunkSizeSelect");
        if (settingsChunkSizeSelect) {
          settingsChunkSizeSelect.addEventListener("change", () => {
            void updateAppSetting({ renderLoadPerChunk: settingsChunkSizeSelect.value || "auto" });
          });
        }
        const settingsClickLoadSelect = $("settingsClickLoadSelect");
        if (settingsClickLoadSelect) {
          settingsClickLoadSelect.addEventListener("change", () => {
            void updateAppSetting({ grabLinkClicksPerChunk: settingsClickLoadSelect.value || "per_chunk" });
          });
        }
        const settingsSaveLocalSelect = $("settingsSaveLocalSelect");
        if (settingsSaveLocalSelect) {
          settingsSaveLocalSelect.addEventListener("change", () => {
            appSettingsIdbPromise = null;
            void updateAppSetting({ saveSettingsLocally: settingsSaveLocalSelect.value === "enabled" });
          });
        }
        const settingsTimezoneConversionSelect = $("settingsTimezoneConversionSelect");
        if (settingsTimezoneConversionSelect) {
          settingsTimezoneConversionSelect.addEventListener("change", () => {
            void updateAppSetting({
              timezoneConversion: settingsTimezoneConversionSelect.value !== "disabled",
            });
          });
        }
        const settingsTimezoneOverrideSelect = $("settingsTimezoneOverrideSelect");
        if (settingsTimezoneOverrideSelect) {
          settingsTimezoneOverrideSelect.addEventListener("change", () => {
            void updateAppSetting({
              timezoneOverride: settingsTimezoneOverrideSelect.value || "",
            });
          });
        }
        for (let i = 0; i < 3; i++) {
          const dateSel = $("settingsDateFormat" + i);
          if (!dateSel) continue;
          dateSel.addEventListener("change", () => onDateFormatPartChange(i));
        }
        const settingsTimeNotationSelect = $("settingsTimeNotationSelect");
        if (settingsTimeNotationSelect) {
          settingsTimeNotationSelect.addEventListener("change", () => {
            void updateAppSetting({
              timeNotation: settingsTimeNotationSelect.value === "12h" ? "12h" : "24h",
            });
          });
        }
        if (window.ProxyListDateTime && typeof window.ProxyListDateTime.onChange === "function") {
          window.ProxyListDateTime.onChange(function () {
            if (!pageContext) return;
            applyImportantNotices(pageContext.meta);
            scheduleRenderFromPageContext();
          });
        }
        const settingsSentryConsentSelect = $("settingsSentryConsentSelect");
        if (settingsSentryConsentSelect) {
          settingsSentryConsentSelect.addEventListener("change", () => {
            try {
              if (window.ProxyListSentry && typeof window.ProxyListSentry.setConsent === "function") {
                window.ProxyListSentry.setConsent(settingsSentryConsentSelect.value);
              }
            } catch (_) {}
          });
        }
        const settingsHardwareConsentSelect = $("settingsHardwareConsentSelect");
        if (settingsHardwareConsentSelect) {
          settingsHardwareConsentSelect.addEventListener("change", () => {
            try {
              if (window.ProxyListHardware && typeof window.ProxyListHardware.setConsent === "function") {
                window.ProxyListHardware.setConsent(settingsHardwareConsentSelect.value);
              }
            } catch (_) {}
          });
        }
        const settingsSaveDataExportBtn = $("settingsSaveDataExportBtn");
        if (settingsSaveDataExportBtn) {
          settingsSaveDataExportBtn.addEventListener("click", () => exportSaveDataFile());
        }
        const settingsSaveDataUploadBtn = $("settingsSaveDataUploadBtn");
        if (settingsSaveDataUploadBtn) {
          settingsSaveDataUploadBtn.addEventListener("click", () => promptUploadSaveData());
        }
        const settingsSaveDataUploadInput = $("settingsSaveDataUploadInput");
        if (settingsSaveDataUploadInput) {
          settingsSaveDataUploadInput.addEventListener("change", () => {
            const f =
              settingsSaveDataUploadInput.files && settingsSaveDataUploadInput.files[0]
                ? settingsSaveDataUploadInput.files[0]
                : null;
            void handleSaveDataUploadFile(f);
          });
        }
        const settingsFilterSelect = $("settingsFilterSelect");
        if (settingsFilterSelect) {
          settingsFilterSelect.addEventListener("change", (ev) => {
            selectedGnMathFilter = ev.target.value || "";
            const filterSel = $("filterSelect");
            if (filterSel) filterSel.value = selectedGnMathFilter;
            updateSelectedFilterUI();
            void renderAfterHeavyFilter(links, meta, link_check);
            void renderMostOpenedForList(links);
            scheduleUserProfileWrite();
          });
        }
        const settingsHideBlockedBtn = $("settingsHideBlockedBtn");
        if (settingsHideBlockedBtn) {
          settingsHideBlockedBtn.addEventListener("click", () => {
            hideBlockedBySelectedFilter = !hideBlockedBySelectedFilter;
            updateSelectedFilterUI();
            void renderAfterHeavyFilter(links, meta, link_check);
            scheduleUserProfileWrite();
          });
        }
        const settingsHideUncheckedBtn = $("settingsHideUncheckedBtn");
        if (settingsHideUncheckedBtn) {
          settingsHideUncheckedBtn.addEventListener("click", () => {
            hideLinksWithoutLensCheck = !hideLinksWithoutLensCheck;
            updateSelectedFilterUI();
            void renderAfterHeavyFilter(links, meta, link_check);
            scheduleUserProfileWrite();
          });
        }
        const settingsResetBtn = $("settingsResetBtn");
        if (settingsResetBtn) {
          settingsResetBtn.addEventListener("click", () => {
            void resetAllAppAndFilterSettings();
          });
        }
        onEl("summaryBackdrop", "click", (ev) => {
          if (ev.target === $("summaryBackdrop")) closeSummary();
        });
        onEl("filterBackdrop", "click", (ev) => {
          if (ev.target === $("filterBackdrop")) closeFilterModal();
        });
        onEl("updateBackdrop", "click", (ev) => {
          if (ev.target === $("updateBackdrop")) closeUpdateModal(meta);
        });
        const mobileAutoResizeOkBtn = $("mobileAutoResizeOkBtn");
        if (mobileAutoResizeOkBtn) {
          mobileAutoResizeOkBtn.addEventListener("click", () => dismissMobileAutoResizeNotice());
        }
        const mobileAutoResizeBackdrop = $("mobileAutoResizeBackdrop");
        if (mobileAutoResizeBackdrop) {
          mobileAutoResizeBackdrop.addEventListener("click", (ev) => {
            if (ev.target === mobileAutoResizeBackdrop) dismissMobileAutoResizeNotice();
          });
        }
        const jsDelivrBd = $("jsDelivrBackdrop");
        if (jsDelivrBd) {
          jsDelivrBd.addEventListener("click", (ev) => {
            if (ev.target === jsDelivrBd) closeJsDelivrPicker();
          });
        }
        const jsDelivrCloseBtn = $("jsDelivrCloseBtn");
        if (jsDelivrCloseBtn) jsDelivrCloseBtn.addEventListener("click", closeJsDelivrPicker);
        onEl("updateCloseBtn", "click", () => closeUpdateModal(meta));
        onEl("updateGotItBtn", "click", () => closeUpdateModal(meta));
        onEl("updateNoticeBtn", "click", () => openUpdateModal(meta, readSeenVersion()));
        const siteUpdateRefreshBtn = $("siteUpdateRefreshBtn");
        if (siteUpdateRefreshBtn) {
          siteUpdateRefreshBtn.addEventListener("click", () => {
            const m = pageContext && pageContext.meta;
            if (m) {
              const stamp = versionStamp(m);
              if (stamp) writeSeenBannerStamp(stamp);
            }
            hardReloadBypassCache();
          });
        }
        const siteUpdateDismissBtn = $("siteUpdateDismissBtn");
        if (siteUpdateDismissBtn) {
          siteUpdateDismissBtn.addEventListener("click", () => {
            try {
              const m = pageContext && pageContext.meta;
              if (m) {
                const stamp = versionStamp(m);
                if (stamp) {
                  writeSeenBannerStamp(stamp);
                  sessionStorage.setItem(BANNER_DISMISS_SESSION_KEY, stamp);
                }
              }
            } catch (_) {}
            setSiteUpdateBannerVisible(false);
          });
        }
        const sidebarBackToMainList = $("sidebarBackToMainList");
        if (sidebarBackToMainList) {
          sidebarBackToMainList.addEventListener("click", (ev) => {
            if (!viewingFolderId && !savedLinksViewOnly) {
              ev.preventDefault();
              setListViewMode("full");
              window.scrollTo({ top: 0, behavior: "smooth" });
            }
          });
        }
        onEl("backToTopBtn", "click", () => {
          window.scrollTo({ top: 0, behavior: "smooth" });
        });
        document.addEventListener("keydown", (ev) => {
          if (ev.key === "Escape") {
            const jdb = $("jsDelivrBackdrop");
            if (jdb && jdb.classList.contains("open")) {
              closeJsDelivrPicker();
              return;
            }
            if (isMobileAutoResizeNoticeOpen()) {
              dismissMobileAutoResizeNotice();
              return;
            }
            closeSummary();
            closeFilterModal();
            closeSettingsModal();
            closeFolderReportModal();
            closeUpdateModal(meta);
          }
        });

        async function runInitialRender() {
          const qFromUrl =
            initialSearchQuery != null ? String(initialSearchQuery).trim() : "";
          if (qFromUrl) {
            const applied = await tryApplyGameSearchFromQuery(qFromUrl, { fromUrl: true });
            if (applied) {
              try {
                const u = new URL(window.location.href);
                u.searchParams.delete("q");
                history.replaceState({}, "", u.pathname + u.search + u.hash);
              } catch (_) {}
            }
          }
          return render(links, meta, link_check);
        }

        return runInitialRender()
          .then(() => {
            if (window.__proxyListBootGuard) window.__proxyListBootGuard.ok();
            return finishContentLoading();
          })
          .then(() => {
            if ($("folderTrustedResults")) refreshFolderTrustedSearchUI(folderTrustedSearchLastQuery);
            maybeStartWelcomeTour();
            maybeShowMobileAutoResizeNotice();
            if (!normalized.pendingCompact || typeof window.ProxyListData.expandAllLinksAsync !== "function") {
              return;
            }
            return window.ProxyListData.expandAllLinksAsync(normalized.pendingCompact, {
              shareProviderArrays: true,
              yieldEvery: 2500,
              yieldFast: true,
            })
              .then((all) => {
                if (!Array.isArray(all) || !all.length) return;
                replaceLinksInPlace(links, all);
                pageContext.links = links;
                syncFeaturedGdbButtons();
                rebuildLinkLensIndexes();
                fillSidebarFilterGroups(links, meta, link_check);
                buildSearchSuggestIndex(links);
                syncMostOpenedProviderOptions(links);
                void renderMostOpenedForList(links);
                return render(links, meta, link_check);
              })
              .catch((err) => {
                console.warn("[proxy-list] Remaining links failed to expand", err);
              });
          });
        });
      })
      .then((rendered) => {
        startPresenceWorkerPings();
        void ensureFirebaseSdk()
          .then((ok) => (ok ? initClickTracking() : false))
          .catch((err) => {
            console.warn("[proxy-list] Firebase boot skipped.", err);
          });
        return rendered;
      })
      .catch((e) => {
        setContentLoading(false);
        if (isFileProtocol()) return;
        const msg = e && e.message ? String(e.message) : String(e);
        let lead =
          "Something went wrong while loading the app. Check that <code>docs/data.json</code> exists and your local server is running from the <code>docs</code> folder.";
        if (/Failed to fetch|NetworkError|Load failed|blocked by CORS|timeout after|AbortError/i.test(msg)) {
          lead =
            "Could not reach <code>data.json</code>. Start a local server in the <code>docs</code> folder (for example <code>python -m http.server 8080</code>) and open <code>http://localhost:8080/</code>.";
        } else if (/Could not load (?:list data|data\.json).*HTTP 500|data\.json \(500\)/i.test(msg)) {
          const onUv = /\/uv\/|ultraviolet|\/service\//i.test(
            String(location.href || "") + String(location.pathname || "")
          );
          lead = onUv
            ? "The Ultraviolet proxy returned HTTP 500 for list assets (not a missing <code>data.json</code> on the site). This usually means UV’s URL rewriter/client hooks failed for this transport — try Scramjet, or Ultraviolet with epoxy-tls."
            : "List data failed with HTTP 500. If you are behind a web proxy, try another proxy or transport; otherwise verify the server can serve <code>data.json</code>.";
        } else if (isFirestorePermissionDenied(e)) {
          lead =
            "Firestore reported permission denied. Deploy the latest <code>docs/firestore.rules</code> to your Firebase project (including <code>linkRatings</code>, <code>linkRatingVotes</code>, <code>linkSaveCounts</code> if you use thumbs / “most saved”), and ensure Authentication is enabled for this host.";
        }
        const guard = window.__proxyListBootGuard;
        const networkLike = /Failed to fetch|NetworkError|Load failed|timeout after|AbortError/i.test(msg);
        if (guard) {
          if (networkLike) guard.ok();
          else guard.fail(msg);
        }
        setHtml(
          $("tableWrap"),
          '<p class="err">' + lead + "<br><br><strong>Details:</strong> " + escapeHtml(msg) + "</p>" +
            (guard && !networkLike
              ? '<p class="err">Old saved data from a previous visit can cause this. ' +
                '<button class="btn" type="button" id="loadErrorResetBtn">Reset saved data &amp; reload</button> ' +
                '<a href="' + escapeHtml(guard.helpUrl) + '" target="_blank" rel="noopener">How to fix it manually</a></p>'
              : "")
        );
        const resetBtn = $("loadErrorResetBtn");
        if (resetBtn) {
          resetBtn.addEventListener("click", () => {
            guard.reset({ all: false });
            location.reload();
          });
        }
      });
    }
    }

    function proxyListChromeReady() {
      return !!document.getElementById("tableWrap");
    }

    function scheduleProxyListBoot() {
      if (proxyListChromeReady()) {
        bootProxyListApp();
        return;
      }
      document.addEventListener("DOMContentLoaded", bootProxyListApp);
      var n = 0;
      var timer = setInterval(function () {
        n += 1;
        if (proxyListChromeReady() || n >= 600) {
          clearInterval(timer);
          bootProxyListApp();
        }
      }, 50);
    }
    scheduleProxyListBoot();
