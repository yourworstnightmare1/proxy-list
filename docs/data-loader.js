/**
 * Fetch and decode proxy list data (compact format v2 or legacy expanded JSON).
 */
(function (global) {
  "use strict";

  function isCompactRow(entry) {
    return Array.isArray(entry) && entry.length >= 3 && typeof entry[2] === "string";
  }

  function isCompactPayload(json) {
    if (!json || typeof json !== "object") return false;
    if (!Array.isArray(json.links) || !Array.isArray(json.providers)) return false;
    if (json.format === 2) return true;
    return json.links.length > 0 && isCompactRow(json.links[0]);
  }

  function expandRow(payload, entry, options) {
    var opts = options || {};
    var providers = payload.providers || [];
    var contributors = payload.contributors || [];
    var pi = entry[0];
    var ci = entry[1];
    var p = providers[pi] || {};
    var c = contributors[ci] || {};
    return {
      provider: p.name || "",
      category: p.category || "",
      capabilities: p.capabilities || "",
      capability_tags: opts.shareProviderArrays ? p.capability_tags || [] : (p.capability_tags || []).slice(),
      protocols: p.protocols || "",
      protocol_tags: opts.shareProviderArrays ? p.protocol_tags || [] : (p.protocol_tags || []).slice(),
      additional_notes: p.additional_notes || "",
      locked: "",
      link: entry[2] || "",
      found: entry[3] || "",
      username: "N/A",
      password: "N/A",
      contributor: c.name || "",
      contributor_url: c.url || null,
    };
  }

  function normalizeMeta(meta, json) {
    var out = Object.assign({}, meta || {});
    if (json && Array.isArray(json.update_changelog) && !out.update_changelog) {
      out.update_changelog = json.update_changelog;
    }
    var changelog = Array.isArray(out.update_changelog) ? out.update_changelog : [];
    var latest = changelog[0] && typeof changelog[0] === "object" ? changelog[0] : null;
    if (latest) {
      if (!String(out.version || "").trim() && latest.version) out.version = latest.version;
      if (!String(out.revision || "").trim() && latest.revision) out.revision = latest.revision;
      if (!String(out.last_updated || "").trim() && latest.released) out.last_updated = latest.released;
      if (!String(out.update_notice || "").trim() && latest.update_notice) {
        out.update_notice = latest.update_notice;
      }
    }
    return out;
  }

  /** Normalize any payload into { meta, link_check, failing_links, compact, links }. */
  function normalizePayload(json) {
    if (!json || typeof json !== "object") {
      return { meta: {}, link_check: {}, failing_links: {}, compact: null, links: [] };
    }
    if (isCompactPayload(json)) {
      return {
        meta: normalizeMeta(json.meta, json),
        link_check: json.link_check || {},
        failing_links: json.failing_links || {},
        compact: {
          providers: json.providers || [],
          contributors: json.contributors || [],
          links: json.links || [],
        },
        links: null,
      };
    }
    var links = Array.isArray(json) ? json : json.links || [];
    return {
      meta: normalizeMeta(json.meta || {}, json),
      link_check: json.link_check || {},
      failing_links: json.failing_links || {},
      compact: null,
      links: links,
    };
  }

  /** Always return expanded link rows (provider, category, link, …). */
  function resolveExpandedLinks(json) {
    if (!json || typeof json !== "object") return [];
    if (json.compact && Array.isArray(json.compact.links)) {
      return expandAllLinks({
        format: 2,
        providers: json.compact.providers || [],
        contributors: json.compact.contributors || [],
        links: json.compact.links,
      });
    }
    if (isCompactPayload(json)) return expandAllLinks(json);
    if (Array.isArray(json)) return json;
    return Array.isArray(json.links) ? json.links : [];
  }

  function isRelativeUrl(s) {
    if (!s) return false;
    if (s.slice(0, 2) === "//") return false;
    return !/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(s);
  }

  function directoryOfSrc(s) {
    if (!s) return "";
    var noHash = String(s).split("#")[0].split("?")[0];
    var slash = noHash.lastIndexOf("/");
    if (slash === -1) return "";
    return noHash.slice(0, slash + 1);
  }

  function looksLikeDataLoaderSrc(s) {
    return !!(s && String(s).indexOf("data-loader.js") !== -1);
  }

  /**
   * Directory that contains data.json.
   * Prefer a relative path from the script tag so school web proxies
   * (Ultraviolet, Scramjet) can rewrite fetch() against the current page.
   * Never use `new URL("/", baseURI)` — that strips subdirectory deploys
   * and becomes the proxy origin under UV/Scramjet.
   */
  function listAssetBaseUrl() {
    if (typeof document === "undefined") return "";
    var scripts = document.getElementsByTagName("script");
    for (var i = scripts.length - 1; i >= 0; i--) {
      var el = scripts[i];
      var attr = "";
      var prop = "";
      try {
        attr = el.getAttribute("src") || "";
      } catch (_) {}
      try {
        prop = el.src || "";
      } catch (_) {}
      if (!looksLikeDataLoaderSrc(attr) && !looksLikeDataLoaderSrc(prop)) continue;
      if (looksLikeDataLoaderSrc(attr) && isRelativeUrl(attr)) {
        return directoryOfSrc(attr);
      }
      if (prop) {
        try {
          return new URL("./", prop).href;
        } catch (_) {}
      }
      if (attr) {
        try {
          return new URL("./", new URL(attr, document.baseURI)).href;
        } catch (_) {}
      }
    }
    return "";
  }

  function addUniqueUrl(list, seen, url) {
    if (!url || seen[url]) return;
    seen[url] = 1;
    list.push(url);
  }

  function resolveListAssetUrl(name, base) {
    if (!name) return name;
    var b = base == null ? "" : String(base);
    if (!b) return name;
    if (isRelativeUrl(b)) return b + name;
    try {
      return new URL(name, b).href;
    } catch (_) {
      return name;
    }
  }

  /** Relative first (proxy-safe), then resolved script directory, then parent folder. */
  function listAssetUrlCandidates(name, base) {
    var out = [];
    var seen = {};
    var resolved = resolveListAssetUrl(name, base);
    if (base && isRelativeUrl(base)) {
      addUniqueUrl(out, seen, resolved);
      return out;
    }
    addUniqueUrl(out, seen, name);
    addUniqueUrl(out, seen, resolved);
    addUniqueUrl(out, seen, "../" + name);
    return out;
  }

  function fetchWithTimeout(url, init, timeoutMs) {
    var ms = timeoutMs > 0 ? timeoutMs : 0;
    if (!ms) return fetch(url, init || {});
    var ctrl = typeof AbortController === "function" ? new AbortController() : null;
    var fetchInit = init ? Object.assign({}, init) : {};
    if (ctrl) {
      if (fetchInit.signal) {
        var outer = fetchInit.signal;
        if (outer.aborted) ctrl.abort();
        else {
          outer.addEventListener("abort", function () {
            try {
              ctrl.abort();
            } catch (_) {}
          });
        }
      }
      fetchInit.signal = ctrl.signal;
    }
    var timer;
    var timedOut = new Promise(function (_, reject) {
      timer = setTimeout(function () {
        try {
          if (ctrl) ctrl.abort();
        } catch (_) {}
        reject(new Error("timeout after " + ms + "ms"));
      }, ms);
    });
    return Promise.race([fetch(url, fetchInit), timedOut]).then(
      function (res) {
        clearTimeout(timer);
        return res;
      },
      function (err) {
        clearTimeout(timer);
        throw err;
      }
    );
  }

  function expandAllLinks(payload, options) {
    if (!isCompactPayload(payload)) {
      return Array.isArray(payload) ? payload : payload.links || [];
    }
    var opts = Object.assign({ shareProviderArrays: true }, options || {});
    var out = new Array(payload.links.length);
    for (var i = 0; i < payload.links.length; i++) {
      out[i] = expandRow(payload, payload.links[i], opts);
    }
    return out;
  }

  function yieldToMainThread() {
    return new Promise(function (resolve) {
      if (typeof requestAnimationFrame === "function") {
        requestAnimationFrame(function () {
          setTimeout(resolve, 0);
        });
      } else {
        setTimeout(resolve, 0);
      }
    });
  }

  /** Expand compact rows in chunks so web proxies and low-end devices stay responsive. */
  async function expandAllLinksAsync(payload, options) {
    if (!isCompactPayload(payload)) {
      return Array.isArray(payload) ? payload : payload.links || [];
    }
    var opts = Object.assign({ shareProviderArrays: true, yieldEvery: 500 }, options || {});
    var total = payload.links.length;
    var out = new Array(total);
    var step = Math.max(50, Number(opts.yieldEvery) || 500);
    for (var i = 0; i < total; i++) {
      out[i] = expandRow(payload, payload.links[i], opts);
      if (i > 0 && i % step === 0) {
        if (typeof opts.onProgress === "function") {
          try {
            opts.onProgress(i / total);
          } catch (_) {}
        }
        await yieldToMainThread();
      }
    }
    if (typeof opts.onProgress === "function") {
      try {
        opts.onProgress(1);
      } catch (_) {}
    }
    return out;
  }

  async function fetchJsonAsset(name, options) {
    var opts = options || {};
    var base = opts.baseUrl != null ? opts.baseUrl : listAssetBaseUrl();
    var timeoutMs = opts.timeoutMs != null ? opts.timeoutMs : 20000;
    var errors = [];
    var candidates = listAssetUrlCandidates(name, base);
    for (var i = 0; i < candidates.length; i++) {
      var url = candidates[i];
      try {
        var res = await fetchWithTimeout(url, opts.fetchInit || {}, timeoutMs);
        if (!res.ok) {
          errors.push(url + " HTTP " + res.status);
          continue;
        }
        return readJsonResponse(res);
      } catch (err) {
        errors.push(url + ": " + (err && err.message ? err.message : String(err)));
      }
    }
    var detail = errors.length ? errors.join("; ") : "no URLs attempted";
    throw new Error("Could not load " + name + " (" + detail + ")");
  }

  function linkCount(normalized) {
    if (normalized.compact) return normalized.compact.links.length;
    return (normalized.links || []).length;
  }

  async function readJsonResponse(res) {
    return res.json();
  }

  function looksLikeJsonBytes(bytes) {
    if (!bytes || !bytes.length) return false;
    var i = 0;
    while (i < bytes.length && (bytes[i] === 0x20 || bytes[i] === 0x0a || bytes[i] === 0x0d || bytes[i] === 0x09)) {
      i++;
    }
    return bytes[i] === 0x7b || bytes[i] === 0x5b; // { or [
  }

  async function parseJsonBytes(buf) {
    var bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    if (looksLikeJsonBytes(bytes)) {
      return JSON.parse(new TextDecoder().decode(bytes));
    }
    if (typeof DecompressionStream !== "function") {
      throw new Error("Compressed list data is not supported in this browser");
    }
    var ds = new DecompressionStream("gzip");
    var stream = new Response(new Blob([bytes]).stream().pipeThrough(ds));
    return readJsonResponse(stream);
  }

  async function fetchListPayload(options) {
    var opts = options || {};
    var base = opts.baseUrl != null ? opts.baseUrl : listAssetBaseUrl();
    var timeoutMs = opts.timeoutMs != null ? opts.timeoutMs : 20000;
    // Prefer plain JSON for maximum host compatibility; gzip is an optional fast path.
    var files = opts.preferCompressed
      ? ["data.json.gz", "data.json.br", "data.json"]
      : ["data.json", "data.json.gz", "data.json.br"];
    var errors = [];
    for (var f = 0; f < files.length; f++) {
      var file = files[f];
      var candidates = listAssetUrlCandidates(file, base);
      for (var c = 0; c < candidates.length; c++) {
        var fetchUrl = candidates[c];
        try {
          if (typeof opts.onAttempt === "function") {
            try {
              opts.onAttempt(file, fetchUrl);
            } catch (_) {}
          }
          var res = await fetchWithTimeout(fetchUrl, opts.fetchInit || {}, timeoutMs);
          if (!res.ok) {
            errors.push(fetchUrl + " HTTP " + res.status);
            continue;
          }
          if (file.endsWith(".gz") || file.endsWith(".br")) {
            var buf = await res.arrayBuffer();
            if (file.endsWith(".gz")) {
              return await parseJsonBytes(buf);
            }
            if (typeof DecompressionStream !== "function") {
              errors.push(fetchUrl + " (brotli unsupported)");
              continue;
            }
            var dsBr = new DecompressionStream("brotli");
            var streamBr = new Response(new Blob([buf]).stream().pipeThrough(dsBr));
            return readJsonResponse(streamBr);
          }
          return readJsonResponse(res);
        } catch (err) {
          errors.push(fetchUrl + ": " + (err && err.message ? err.message : String(err)));
        }
      }
    }
    var detail = errors.length ? errors.join("; ") : "no URLs attempted";
    throw new Error("Could not load list data (" + detail + ")");
  }

  global.ProxyListData = {
    isCompactPayload: isCompactPayload,
    isCompactRow: isCompactRow,
    expandRow: expandRow,
    normalizePayload: normalizePayload,
    resolveExpandedLinks: resolveExpandedLinks,
    expandAllLinks: expandAllLinks,
    expandAllLinksAsync: expandAllLinksAsync,
    fetchJsonAsset: fetchJsonAsset,
    linkCount: linkCount,
    isRelativeUrl: isRelativeUrl,
    directoryOfSrc: directoryOfSrc,
    listAssetBaseUrl: listAssetBaseUrl,
    resolveListAssetUrl: resolveListAssetUrl,
    listAssetUrlCandidates: listAssetUrlCandidates,
    fetchListPayload: fetchListPayload,
  };
})(typeof window !== "undefined" ? window : globalThis);
