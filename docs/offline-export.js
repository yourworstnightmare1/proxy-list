/**
 * Browser-side offline exports:
 * - HTML Lite / Full (offline-shell + embedded data)
 * - List Markdown (.md) and List Text (.txt)
 */
(function (global) {
  "use strict";

  var abortController = null;
  var LIST_MD_RAW_URL =
    "https://raw.githubusercontent.com/yourworstnightmare1/proxy-list/main/list.md";
  var EXPORT_BUTTON_IDS = [
    "offlineExportLiteBtn",
    "offlineExportFullBtn",
    "offlineExportMdBtn",
    "offlineExportTxtBtn",
    "offlineCopyHtmlLiteBtn",
    "offlineCopyHtmlFullBtn",
    "offlineCopyTxtBtn",
  ];

  function $(id) {
    return document.getElementById(id);
  }

  function setProgress(text, pct) {
    var el = $("offlineExportProgress");
    if (el) el.textContent = String(text || "");
    var bar = $("offlineExportProgressBar");
    if (bar) {
      var n = Math.max(0, Math.min(100, Number(pct) || 0));
      bar.style.width = n + "%";
      bar.parentElement && bar.parentElement.setAttribute("aria-valuenow", String(Math.round(n)));
    }
  }

  function setBusy(busy) {
    EXPORT_BUTTON_IDS.forEach(function (id) {
      var btn = $(id);
      if (btn) btn.disabled = !!busy;
    });
    var cancel = $("offlineExportCancelBtn");
    if (cancel) cancel.hidden = !busy;
  }

  function openModal() {
    var backdrop = $("offlineExportBackdrop");
    if (!backdrop) return;
    setProgress("Choose a download or copy option above.", 0);
    setBusy(false);
    abortController = null;
    backdrop.classList.add("open");
    backdrop.setAttribute("aria-hidden", "false");
  }

  function closeModal() {
    if (abortController) {
      try {
        abortController.abort();
      } catch (_) {}
      abortController = null;
    }
    setBusy(false);
    var backdrop = $("offlineExportBackdrop");
    if (!backdrop) return;
    backdrop.classList.remove("open");
    backdrop.setAttribute("aria-hidden", "true");
  }

  function stampDate() {
    try {
      return new Date().toISOString().slice(0, 10);
    } catch (_) {
      return "export";
    }
  }

  function escapeBundleJson(obj) {
    return JSON.stringify(obj).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
  }

  async function fetchText(url, signal, onProgress) {
    var res = await fetch(url, { signal: signal, cache: "no-cache" });
    if (!res.ok) throw new Error("Failed to fetch " + url + " (" + res.status + ")");
    var total = Number(res.headers.get("Content-Length")) || 0;
    if (!res.body || !res.body.getReader || !total || !onProgress) {
      return await res.text();
    }
    var reader = res.body.getReader();
    var chunks = [];
    var received = 0;
    var decoder = new TextDecoder();
    while (true) {
      var step = await reader.read();
      if (step.done) break;
      chunks.push(step.value);
      received += step.value.byteLength;
      onProgress(received, total);
    }
    var merged = new Uint8Array(received);
    var offset = 0;
    for (var i = 0; i < chunks.length; i++) {
      merged.set(chunks[i], offset);
      offset += chunks[i].byteLength;
    }
    return decoder.decode(merged);
  }

  async function fetchJson(url, signal, onProgress) {
    var text = await fetchText(url, signal, onProgress);
    return JSON.parse(text);
  }

  function getInMemoryData() {
    try {
      var ctx = global.__proxyListPageContext;
      if (ctx && Array.isArray(ctx.links)) {
        return {
          meta: ctx.meta || {},
          link_check: ctx.link_check || {},
          links: ctx.links,
        };
      }
    } catch (_) {}
    return null;
  }

  function getInMemoryLinkLens() {
    try {
      if (
        global.__proxyListLinkLensHydrated &&
        global.__proxyListLinkLensData &&
        typeof global.__proxyListLinkLensData === "object"
      ) {
        var keys = Object.keys(global.__proxyListLinkLensData);
        if (keys.length) return global.__proxyListLinkLensData;
      }
    } catch (_) {}
    return null;
  }

  async function ensureListData(signal) {
    var data = getInMemoryData();
    if (data) return data;
    setProgress("Fetching list data…", 30);
    if (global.ProxyListData && typeof global.ProxyListData.fetchListPayload === "function") {
      var json = await global.ProxyListData.fetchListPayload({ fetchInit: { signal: signal } });
      var normalized = global.ProxyListData.normalizePayload(json);
      if (normalized.compact) {
        return {
          meta: normalized.meta,
          link_check: normalized.link_check,
          failing_links: normalized.failing_links,
          links: global.ProxyListData.expandAllLinks({
            format: 2,
            providers: normalized.compact.providers,
            contributors: normalized.compact.contributors,
            links: normalized.compact.links,
          }),
        };
      }
      return {
        meta: normalized.meta,
        link_check: normalized.link_check,
        failing_links: normalized.failing_links,
        links: normalized.links || [],
      };
    }
    return await fetchJson("data.json", signal, function (done, total) {
      var pct = 30 + Math.min(40, Math.round((done / Math.max(1, total)) * 40));
      setProgress(
        "Fetching list data… " + Math.round(done / 1048576) + " / " + Math.round(total / 1048576) + " MB",
        pct
      );
    });
  }

  function triggerDownload(blob, filename) {
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
    }, 2500);
  }

  function formatBytesLabel(size) {
    if (size < 1048576) return (size / 1024).toFixed(0) + " KB";
    return (size / 1048576).toFixed(1) + " MB";
  }

  function domainFromLink(link) {
    try {
      var h = new URL(link).hostname.toLowerCase();
      return h.indexOf("www.") === 0 ? h.slice(4) : h;
    } catch (_) {
      return "";
    }
  }

  function lensEntryHasSignal(entry) {
    if (!entry || typeof entry !== "object") return false;
    var total = Number(entry.summary && entry.summary.total);
    var providers = Array.isArray(entry.providers) ? entry.providers.length : 0;
    return total > 0 || providers > 0 || entry.status === "ok";
  }

  /** Keep exact URL entries only when needed; bulk domains (e.g. storage.googleapis.com) share one domain: key. */
  function slimLinklensForBundle(fullLens, data) {
    if (!fullLens || typeof fullLens !== "object") return {};
    var links = (data && data.links) || [];
    var slim = {};
    var domainsNeeded = Object.create(null);

    for (var i = 0; i < links.length; i++) {
      var link = links[i] && links[i].link;
      if (!link) continue;
      var exact = fullLens[link];
      if (exact && lensEntryHasSignal(exact)) {
        slim[link] = exact;
        continue;
      }
      var d = domainFromLink(link);
      if (d) domainsNeeded[d] = true;
    }

    Object.keys(fullLens).forEach(function (key) {
      if (key.indexOf("domain:") !== 0) return;
      var d = key.slice(7).toLowerCase();
      if (!domainsNeeded[d]) return;
      var entry = fullLens[key];
      if (entry && lensEntryHasSignal(entry)) slim[key] = entry;
    });

    Object.keys(domainsNeeded).forEach(function (d) {
      if (slim["domain:" + d]) return;
      for (var key in fullLens) {
        if (!Object.prototype.hasOwnProperty.call(fullLens, key)) continue;
        var entry = fullLens[key];
        if (!entry || typeof entry !== "object") continue;
        if (String(entry.domain || "").toLowerCase() === d && lensEntryHasSignal(entry)) {
          slim["domain:" + d] = entry;
          break;
        }
      }
    });

    return slim;
  }

  async function buildOfflineHtml(mode, signal) {
    setProgress("Fetching offline shell…", 5);
    var shellText = await fetchText("offline-shell.html", signal);

    setProgress("Fetching DOMPurify…", 12);
    var purifyText = await fetchText("vendor/purify.min.js", signal);

    var data = getInMemoryData();
    if (data) {
      setProgress("Using loaded list data…", 30);
    } else {
      data = await ensureListData(signal);
    }

    setProgress("Fetching checked domains…", 50);
    var checkedDomainsText = "";
    try {
      checkedDomainsText = await fetchText("checked_domains.txt", signal);
    } catch (_) {
      checkedDomainsText = "";
    }

    var linklens = null;
    if (mode === "full") {
      linklens = getInMemoryLinkLens();
      if (linklens) {
        setProgress("Using loaded gn-math data…", 70);
      } else {
        setProgress("Fetching gn-math (large)…", 55);
        linklens = await fetchJson("linklens.json", signal, function (done, total) {
          var pct = 55 + Math.min(30, Math.round((done / Math.max(1, total)) * 30));
          setProgress(
            "Fetching gn-math… " +
              (done / 1048576).toFixed(1) +
              " / " +
              (total / 1048576).toFixed(1) +
              " MB",
            pct
          );
        });
      }
      linklens = slimLinklensForBundle(linklens || {}, data);
    }

    setProgress("Building offline file…", 90);
    var bundle = {
      mode: mode === "full" ? "full" : "lite",
      generatedAt: new Date().toISOString(),
      data: data,
      checkedDomainsText: checkedDomainsText,
      linklens: mode === "full" ? linklens || {} : null,
    };

    var safePurify = String(purifyText || "").replace(/<\/(script)/gi, "<\\/$1");
    var purifyBlock = "<script>\n" + safePurify + "\n</script>";
    var bundleBlock =
      "<script>window.__OFFLINE_BUNDLE__=" + escapeBundleJson(bundle) + ";</script>";

    if (shellText.indexOf("<!--OFFLINE_PURIFY_INJECTION-->") === -1) {
      throw new Error("offline-shell.html missing purify injection marker");
    }
    if (shellText.indexOf("<!--OFFLINE_BUNDLE_INJECTION-->") === -1) {
      throw new Error("offline-shell.html missing bundle injection marker");
    }

    var withPurify = shellText.replace("<!--OFFLINE_PURIFY_INJECTION-->", purifyBlock);
    var parts = withPurify.split("<!--OFFLINE_BUNDLE_INJECTION-->");
    if (parts.length !== 2) throw new Error("Could not split shell at bundle marker");

    var html = parts[0] + bundleBlock + parts[1];
    setProgress("Ready…", 100);
    return html;
  }

  async function buildOfflineHtmlBlob(mode, signal) {
    var html = await buildOfflineHtml(mode, signal);
    return new Blob([html], { type: "text/html;charset=utf-8" });
  }

  async function copyTextToClipboard(text) {
    var value = String(text == null ? "" : text);
    if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
      try {
        await navigator.clipboard.writeText(value);
        return true;
      } catch (_) {}
    }
    try {
      var ta = document.createElement("textarea");
      ta.value = value;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.left = "-9999px";
      document.body.appendChild(ta);
      ta.select();
      var ok = document.execCommand("copy");
      ta.remove();
      return !!ok;
    } catch (_) {
      return false;
    }
  }

  function buildPlainTextList(data) {
    var links = (data && data.links) || [];
    var lines = [];
    var meta = (data && data.meta) || {};
    lines.push("# Proxy List links");
    if (meta.version || meta.revision) {
      lines.push("# " + String(meta.version || "") + String(meta.revision || ""));
    }
    if (meta.last_updated) lines.push("# Updated: " + String(meta.last_updated));
    lines.push("# Total: " + links.length);
    lines.push("# Generated: " + new Date().toISOString());
    lines.push("");
    var currentProvider = null;
    links.forEach(function (row) {
      var provider = String((row && row.provider) || "").trim() || "(unknown)";
      var url = String((row && row.link) || "").trim();
      if (!url) return;
      if (provider !== currentProvider) {
        if (currentProvider !== null) lines.push("");
        lines.push("# " + provider);
        currentProvider = provider;
      }
      lines.push(url);
    });
    lines.push("");
    return lines.join("\n");
  }

  function buildMarkdownFallback(data) {
    var links = (data && data.links) || [];
    var meta = (data && data.meta) || {};
    var out = [];
    out.push("# Proxy List");
    out.push(
      "> Generated offline export" +
        (meta.version || meta.revision
          ? " · " + String(meta.version || "") + String(meta.revision || "")
          : "") +
        (meta.last_updated ? " · " + String(meta.last_updated) : "")
    );
    out.push("");
    out.push("Total links: " + links.length);
    out.push("");
    var byProvider = new Map();
    links.forEach(function (row) {
      var provider = String((row && row.provider) || "").trim() || "(unknown)";
      if (!byProvider.has(provider)) byProvider.set(provider, []);
      byProvider.get(provider).push(row);
    });
    byProvider.forEach(function (rows, provider) {
      out.push("# " + provider);
      out.push("");
      out.push("| Link | Category | Capabilities | Protocols | Contributor |");
      out.push("| - | - | - | - | - |");
      rows.forEach(function (row) {
        var caps = Array.isArray(row.capability_tags)
          ? row.capability_tags.join(", ")
          : String(row.capabilities || "N/A");
        var protocols = Array.isArray(row.protocol_tags)
          ? row.protocol_tags.join(", ")
          : String(row.protocols || "N/A");
        var contributor = String(row.contributor || "N/A");
        var contribUrl = String(row.contributor_url || "").trim();
        var contribCell =
          contribUrl && contributor && contributor.toLowerCase() !== "n/a"
            ? "[" + contributor + "](" + contribUrl + ")"
            : contributor;
        out.push(
          "| " +
            String(row.link || "") +
            " | " +
            String(row.category || "N/A") +
            " | " +
            (caps || "N/A") +
            " | " +
            (protocols || "N/A") +
            " | " +
            contribCell +
            " |"
        );
      });
      out.push("");
    });
    return out.join("\n");
  }

  async function buildListMarkdown(signal) {
    setProgress("Fetching formatted list.md…", 20);
    try {
      var md = await fetchText(LIST_MD_RAW_URL, signal, function (done, total) {
        var pct = 20 + Math.min(70, Math.round((done / Math.max(1, total)) * 70));
        setProgress(
          "Fetching list.md… " + Math.round(done / 1024) + " / " + Math.round(total / 1024) + " KB",
          pct
        );
      });
      setProgress("Download starting…", 100);
      return md;
    } catch (err) {
      console.warn("[proxy-list] list.md fetch failed, generating from data.json", err);
      setProgress("Building markdown from list data…", 50);
      var data = await ensureListData(signal);
      setProgress("Download starting…", 100);
      return buildMarkdownFallback(data);
    }
  }

  async function buildListText(signal) {
    setProgress("Preparing plain-text link list…", 20);
    var data = await ensureListData(signal);
    setProgress("Building .txt file…", 80);
    var text = buildPlainTextList(data);
    setProgress("Download starting…", 100);
    return text;
  }

  async function runExport(kind) {
    if (abortController) return;
    abortController = new AbortController();
    setBusy(true);
    try {
      var signal = abortController.signal;
      var blob;
      var name;
      if (kind === "lite" || kind === "full") {
        blob = await buildOfflineHtmlBlob(kind, signal);
        name = "proxy-list-offline-" + kind + "-" + stampDate() + ".html";
      } else if (kind === "md") {
        var md = await buildListMarkdown(signal);
        blob = new Blob([md], { type: "text/markdown;charset=utf-8" });
        name = "proxy-list-" + stampDate() + ".md";
      } else if (kind === "txt") {
        var txt = await buildListText(signal);
        blob = new Blob([txt], { type: "text/plain;charset=utf-8" });
        name = "proxy-list-" + stampDate() + ".txt";
      } else {
        throw new Error("Unknown export kind: " + kind);
      }
      triggerDownload(blob, name);
      setProgress("Done. Saved " + name + " (~" + formatBytesLabel(blob.size) + ").", 100);
    } catch (err) {
      if (err && err.name === "AbortError") {
        setProgress("Cancelled.", 0);
      } else {
        console.warn("[proxy-list] Offline export failed", err);
        setProgress("Export failed: " + (err && err.message ? err.message : String(err)), 0);
      }
    } finally {
      abortController = null;
      setBusy(false);
    }
  }

  async function runCopy(kind) {
    if (abortController) return;
    abortController = new AbortController();
    setBusy(true);
    try {
      var signal = abortController.signal;
      var text = "";
      var label = "";
      if (kind === "html-lite" || kind === "html-full") {
        var mode = kind === "html-full" ? "full" : "lite";
        setProgress("Building HTML to copy…", 5);
        text = await buildOfflineHtml(mode, signal);
        label = "HTML (" + mode + ")";
      } else if (kind === "txt") {
        text = await buildListText(signal);
        label = "plain text";
      } else {
        throw new Error("Unknown copy kind: " + kind);
      }
      setProgress("Copying " + label + " to clipboard…", 95);
      var ok = await copyTextToClipboard(text);
      if (!ok) {
        throw new Error(
          "Clipboard rejected the copy" +
            (kind === "html-full" ? " (Full HTML is very large — try Lite or Download instead)" : "")
        );
      }
      setProgress(
        "Copied " + label + " (~" + formatBytesLabel(new Blob([text]).size) + ") to clipboard.",
        100
      );
    } catch (err) {
      if (err && err.name === "AbortError") {
        setProgress("Cancelled.", 0);
      } else {
        console.warn("[proxy-list] Offline copy failed", err);
        setProgress("Copy failed: " + (err && err.message ? err.message : String(err)), 0);
      }
    } finally {
      abortController = null;
      setBusy(false);
    }
  }

  function wire() {
    var openBtn = $("offlineExportOpenBtn");
    if (openBtn) openBtn.addEventListener("click", openModal);
    var closeBtn = $("offlineExportCloseBtn");
    if (closeBtn) closeBtn.addEventListener("click", closeModal);
    var dismissBtn = $("offlineExportDismissBtn");
    if (dismissBtn) dismissBtn.addEventListener("click", closeModal);

    var liteBtn = $("offlineExportLiteBtn");
    if (liteBtn) liteBtn.addEventListener("click", function () { void runExport("lite"); });
    var fullBtn = $("offlineExportFullBtn");
    if (fullBtn) fullBtn.addEventListener("click", function () { void runExport("full"); });
    var mdBtn = $("offlineExportMdBtn");
    if (mdBtn) mdBtn.addEventListener("click", function () { void runExport("md"); });
    var txtBtn = $("offlineExportTxtBtn");
    if (txtBtn) txtBtn.addEventListener("click", function () { void runExport("txt"); });

    var copyHtmlLiteBtn = $("offlineCopyHtmlLiteBtn");
    if (copyHtmlLiteBtn) {
      copyHtmlLiteBtn.addEventListener("click", function () { void runCopy("html-lite"); });
    }
    var copyHtmlFullBtn = $("offlineCopyHtmlFullBtn");
    if (copyHtmlFullBtn) {
      copyHtmlFullBtn.addEventListener("click", function () { void runCopy("html-full"); });
    }
    var copyTxtBtn = $("offlineCopyTxtBtn");
    if (copyTxtBtn) copyTxtBtn.addEventListener("click", function () { void runCopy("txt"); });

    var cancelBtn = $("offlineExportCancelBtn");
    if (cancelBtn) {
      cancelBtn.addEventListener("click", function () {
        if (abortController) {
          try {
            abortController.abort();
          } catch (_) {}
        }
      });
    }
    var backdrop = $("offlineExportBackdrop");
    if (backdrop) {
      backdrop.addEventListener("click", function (ev) {
        if (ev.target === backdrop && !abortController) closeModal();
      });
    }
  }

  global.ProxyListOfflineExport = {
    open: openModal,
    close: closeModal,
    start: runExport,
    copy: runCopy,
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", wire);
  } else {
    wire();
  }
})(typeof window !== "undefined" ? window : this);
