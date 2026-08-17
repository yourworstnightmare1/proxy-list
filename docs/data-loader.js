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

  function listAssetBaseUrl() {
    if (typeof document === "undefined") return "";
    var scripts = document.getElementsByTagName("script");
    for (var i = scripts.length - 1; i >= 0; i--) {
      var src = scripts[i].getAttribute("src");
      if (!src || src.indexOf("data-loader.js") === -1) continue;
      try {
        return new URL("./", new URL(src, document.baseURI)).href;
      } catch (_) {
        break;
      }
    }
    try {
      return new URL("/", document.baseURI).href;
    } catch (_) {
      return "";
    }
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
    var base = opts.baseUrl || listAssetBaseUrl();
    // Prefer plain JSON for maximum host compatibility; gzip is an optional fast path.
    var urls = opts.preferCompressed
      ? ["data.json.gz", "data.json.br", "data.json"]
      : ["data.json", "data.json.gz", "data.json.br"];
    var errors = [];
    for (var u = 0; u < urls.length; u++) {
      var url = urls[u];
      try {
        var fetchUrl = base ? new URL(url, base).href : url;
        var res = await fetch(fetchUrl, opts.fetchInit || {});
        if (!res.ok) {
          errors.push(url + " HTTP " + res.status);
          continue;
        }
        if (url.endsWith(".gz") || url.endsWith(".br")) {
          var buf = await res.arrayBuffer();
          if (url.endsWith(".gz")) {
            return await parseJsonBytes(buf);
          }
          if (typeof DecompressionStream !== "function") {
            errors.push(url + " (brotli unsupported)");
            continue;
          }
          var dsBr = new DecompressionStream("brotli");
          var streamBr = new Response(new Blob([buf]).stream().pipeThrough(dsBr));
          return readJsonResponse(streamBr);
        }
        return readJsonResponse(res);
      } catch (err) {
        errors.push(url + ": " + (err && err.message ? err.message : String(err)));
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
    linkCount: linkCount,
    listAssetBaseUrl: listAssetBaseUrl,
    fetchListPayload: fetchListPayload,
  };
})(typeof window !== "undefined" ? window : globalThis);
