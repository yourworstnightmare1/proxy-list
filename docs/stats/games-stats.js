/**
 * Game database stats panel for docs/stats/ (#games).
 * Requires ProxyListGameDbSearch + Chart.js and panel markup in stats/index.html.
 */
(function (global) {
  "use strict";

  var api = global.ProxyListGameDbSearch;
  var snap = null;
  var liveCounts = Object.create(null);
  var selectedTag = "all";
  var historyChart = null;
  var loaded = false;
  var loading = null;
  var daySnapCache = Object.create(null);
  var archiveIndexP = null;

  function $(id) {
    return document.getElementById(id);
  }

  function fmt(n) {
    if (n == null || !Number.isFinite(Number(n))) return "—";
    return Number(n).toLocaleString();
  }

  function escapeHtml(s) {
    return String(s || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function setBaselineNotice(text) {
    var el = $("gamesBaselineNotice");
    if (!el) return;
    if (!text) {
      el.hidden = true;
      el.textContent = "";
      return;
    }
    el.hidden = false;
    el.textContent = text;
  }

  function catalogRows() {
    var fromApi = api && typeof api.listCatalogs === "function" ? api.listCatalogs() : [];
    if (fromApi.length) {
      return fromApi
        .map(function (c) {
          return { tag: c.tag, label: c.label };
        })
        .sort(function (a, b) {
          return String(a.label).localeCompare(String(b.label));
        });
    }
    return ((snap && snap.catalogs) || [])
      .map(function (c) {
        return { tag: c.tag, label: c.label };
      })
      .sort(function (a, b) {
        return String(a.label).localeCompare(String(b.label));
      });
  }

  function snapshotMap() {
    var map = Object.create(null);
    ((snap && snap.catalogs) || []).forEach(function (c) {
      map[c.tag] = c;
    });
    return map;
  }

  function fillFilter() {
    var sel = $("gamesDbFilter");
    if (!sel) return;
    var keep = selectedTag;
    sel.innerHTML = '<option value="all">All databases</option>';
    catalogRows().forEach(function (c) {
      var opt = document.createElement("option");
      opt.value = c.tag;
      opt.textContent = c.label;
      sel.appendChild(opt);
    });
    sel.value = keep;
    if (sel.value !== keep) {
      selectedTag = "all";
      sel.value = "all";
    }
  }

  function renderKpis() {
    var rows = catalogRows();
    var liveTotal = 0;
    rows.forEach(function (c) {
      liveTotal += Number(liveCounts[c.tag] || 0);
    });
    if (selectedTag !== "all") {
      if ($("gamesStatCatalogs")) $("gamesStatCatalogs").textContent = "1";
      if ($("gamesStatEntries")) $("gamesStatEntries").textContent = fmt(liveCounts[selectedTag] || 0);
      var sm = snapshotMap()[selectedTag];
      if ($("gamesStatUnique")) $("gamesStatUnique").textContent = sm ? fmt(sm.count) : "—";
    } else {
      if ($("gamesStatCatalogs")) $("gamesStatCatalogs").textContent = fmt(rows.length);
      if ($("gamesStatEntries")) $("gamesStatEntries").textContent = fmt(liveTotal);
      if ($("gamesStatUnique")) {
        $("gamesStatUnique").textContent = snap ? fmt(snap.unique_games) : "—";
      }
    }
    if ($("gamesStatSnapshot")) {
      $("gamesStatSnapshot").textContent = (snap && snap.snapshot_date) || "—";
    }
  }

  function renderCountsTable() {
    var body = $("gamesCountsBody");
    if (!body) return;
    var rows = catalogRows();
    var smap = snapshotMap();
    var max = 1;
    rows.forEach(function (c) {
      max = Math.max(
        max,
        Number(liveCounts[c.tag] || 0),
        Number((smap[c.tag] && smap[c.tag].count) || 0)
      );
    });
    if (selectedTag !== "all") {
      rows = rows.filter(function (c) {
        return c.tag === selectedTag;
      });
    }
    if (!rows.length) {
      body.innerHTML = '<tr><td colspan="4" class="muted">No databases.</td></tr>';
      return;
    }
    body.innerHTML = rows
      .map(function (c) {
        var live = Number(liveCounts[c.tag] || 0);
        var snapCount = smap[c.tag] ? Number(smap[c.tag].count || 0) : null;
        var empty = smap[c.tag] && smap[c.tag].empty;
        var pct = Math.round((live / max) * 100);
        var liveLabel =
          live === 0 && empty ? '<span class="muted">0 (empty)</span>' : fmt(live);
        return (
          "<tr>" +
          "<td>" +
          escapeHtml(c.label) +
          '<div class="muted" style="font-size:.75rem">' +
          escapeHtml(c.tag) +
          "</div></td>" +
          '<td class="num">' +
          liveLabel +
          "</td>" +
          '<td class="num">' +
          (snapCount == null ? "—" : fmt(snapCount)) +
          "</td>" +
          '<td><div class="games-bar" title="' +
          pct +
          '%"><span style="width:' +
          pct +
          '%"></span></div></td>' +
          "</tr>"
        );
      })
      .join("");
  }

  function renderHistoryChart() {
    var history = (snap && snap.history) || [];
    var empty = $("gamesHistoryEmpty");
    var canvas = $("gamesHistoryChart");
    var wrap = $("gamesHistoryWrap");
    if (historyChart) {
      try {
        historyChart.destroy();
      } catch (_) {}
      historyChart = null;
    }
    if (!canvas) return;
    if (history.length < 2) {
      if (empty) empty.hidden = false;
      if (wrap) wrap.hidden = true;
      return;
    }
    if (empty) empty.hidden = true;
    if (wrap) wrap.hidden = false;
    if (!global.Chart) return;

    var labels = history.map(function (h) {
      return h.date;
    });
    var data;
    var label;
    if (selectedTag === "all") {
      data = history.map(function (h) {
        return Number(h.total_entries || 0);
      });
      label = "Total catalog entries";
    } else {
      data = history.map(function (h) {
        return Number((h.counts && h.counts[selectedTag]) || 0);
      });
      var row = catalogRows().find(function (c) {
        return c.tag === selectedTag;
      });
      label = (row && row.label) || selectedTag;
    }

    historyChart = new global.Chart(canvas, {
      type: "line",
      data: {
        labels: labels,
        datasets: [
          {
            label: label,
            data: data,
            borderColor: "#6cb3ff",
            backgroundColor: "rgba(108,179,255,.18)",
            fill: true,
            tension: 0.25,
            pointRadius: 3,
            pointHoverRadius: 6,
            pointHitRadius: 16,
            pointBackgroundColor: "#6cb3ff",
            pointBorderColor: "#6cb3ff",
            pointBorderWidth: 2,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: "nearest", intersect: false, axis: "xy" },
        hover: { mode: "nearest", intersect: false },
        plugins: {
          legend: { display: true },
          tooltip: { enabled: true, intersect: false, mode: "nearest" },
        },
        scales: {
          x: { ticks: { maxRotation: 0 } },
          y: {
            beginAtZero: true,
            ticks: {
              callback: function (v) {
                return Number(v).toLocaleString();
              },
            },
          },
        },
      },
    });
  }

  function latestChangesForScope() {
    var lc = (snap && snap.latest_changes) || null;
    if (!lc) return { isBaseline: true, added: [], date: "" };
    if (lc.is_baseline) return { isBaseline: true, added: [], date: lc.date || "" };
    if (selectedTag === "all") {
      return {
        isBaseline: false,
        date: lc.date || "",
        added: (lc.all && lc.all.added) || [],
        addedCount: (lc.all && lc.all.added_count) || 0,
        addedTrunc: (lc.all && lc.all.added_truncated) || 0,
      };
    }
    var ch = (lc.by_catalog && lc.by_catalog[selectedTag]) || null;
    if (!ch) {
      return { isBaseline: false, date: lc.date || "", added: [], addedCount: 0, addedTrunc: 0 };
    }
    return {
      isBaseline: false,
      date: lc.date || "",
      added: (ch.added || []).map(function (name) {
        return { name: name, label: ch.label };
      }),
      addedCount: ch.added_count || 0,
      addedTrunc: ch.added_truncated || 0,
    };
  }

  function groupAddedGames(added) {
    var map = new Map();
    (added || []).forEach(function (item) {
      var name = typeof item === "string" ? item : item && item.name;
      var label = typeof item === "string" ? "" : (item && item.label) || "";
      if (!name) return;
      if (!map.has(name)) map.set(name, []);
      var labels = map.get(name);
      if (label && labels.indexOf(label) === -1) labels.push(label);
    });
    return Array.from(map.entries()).map(function (entry) {
      return { name: entry[0], labels: entry[1] };
    });
  }

  function renderLatestGames() {
    var list = $("gamesLatestList");
    var hint = $("gamesLatestHint");
    if (!list) return;
    var ch = latestChangesForScope();
    if (ch.isBaseline) {
      if (hint) {
        hint.textContent =
          "Baseline snapshot" +
          (ch.date ? " (" + ch.date + ")" : "") +
          ". Newly found games will appear after the next snapshot.";
      }
      list.innerHTML =
        '<li class="muted">No new games yet — waiting for the next catalog snapshot.</li>';
      return;
    }
    if (hint) {
      hint.textContent =
        "Games newly present as of " +
        (ch.date || "latest snapshot") +
        (ch.addedCount ? " (" + ch.addedCount.toLocaleString() + " added)" : "") +
        ".";
    }
    if (!ch.added.length) {
      list.innerHTML =
        '<li class="muted">No games were added in the latest snapshot for this scope.</li>';
      return;
    }
    var grouped = groupAddedGames(ch.added);
    list.innerHTML =
      grouped
        .map(function (item) {
          var providers = (item.labels || []).join(", ");
          return (
            "<li><strong>" +
            escapeHtml(item.name) +
            "</strong>" +
            (providers && selectedTag === "all"
              ? '<span class="meta">' + escapeHtml(providers) + "</span>"
              : "") +
            "</li>"
          );
        })
        .join("") +
      (ch.addedTrunc
        ? '<li class="muted">…and ' + ch.addedTrunc.toLocaleString() + " more</li>"
        : "");
  }

  function archiveIndexPromise() {
    if (archiveIndexP) return archiveIndexP;
    archiveIndexP = fetch("./archive/gdb_catalogs/index.json", { cache: "no-store" })
      .then(function (res) {
        if (!res.ok) throw new Error("HTTP " + res.status);
        return res.json();
      })
      .catch(function () {
        archiveIndexP = null;
        return null;
      });
    return archiveIndexP;
  }

  function fetchDaySnapshot(date) {
    if (!date) return Promise.resolve(null);
    if (!daySnapCache[date]) {
      daySnapCache[date] = fetch("./archive/gdb_catalogs/days/" + encodeURIComponent(date) + ".json", {
        cache: "force-cache",
      })
        .then(function (res) {
          if (!res.ok) throw new Error("HTTP " + res.status);
          return res.json();
        })
        .catch(function () {
          daySnapCache[date] = null;
          return null;
        });
    }
    return Promise.resolve(daySnapCache[date]).then(function (data) {
      return data;
    });
  }

  function previousArchiveDay(date, index) {
    var days = (index && index.days) || [];
    var i = days.indexOf(date);
    if (i > 0) return days[i - 1];
    return "";
  }

  function catalogLabelFromSnap(tag, day) {
    var cat = day && day.catalogs && day.catalogs[tag];
    if (cat && cat.label) return cat.label;
    var row = catalogRows().find(function (c) {
      return c.tag === tag;
    });
    return (row && row.label) || tag;
  }

  function namesForCatalog(day, tag) {
    var cat = day && day.catalogs && day.catalogs[tag];
    return (cat && Array.isArray(cat.names) ? cat.names : []).slice();
  }

  function diffDaySnapshots(prev, curr, scopeTag) {
    var addedMap = new Map();
    var removedMap = new Map();
    var catalogSummary = [];
    var tags = [];
    if (scopeTag && scopeTag !== "all") {
      tags = [scopeTag];
    } else {
      var seen = Object.create(null);
      [prev, curr].forEach(function (day) {
        Object.keys((day && day.catalogs) || {}).forEach(function (tag) {
          if (!seen[tag]) {
            seen[tag] = 1;
            tags.push(tag);
          }
        });
      });
    }
    tags.forEach(function (tag) {
      var label = catalogLabelFromSnap(tag, curr) || catalogLabelFromSnap(tag, prev);
      var prevSet = new Set(namesForCatalog(prev, tag));
      var currNames = namesForCatalog(curr, tag);
      var currSet = new Set(currNames);
      var added = [];
      var removed = [];
      currNames.forEach(function (name) {
        if (!prevSet.has(name)) added.push(name);
      });
      namesForCatalog(prev, tag).forEach(function (name) {
        if (!currSet.has(name)) removed.push(name);
      });
      added.forEach(function (name) {
        if (!addedMap.has(name)) addedMap.set(name, []);
        var labels = addedMap.get(name);
        if (labels.indexOf(label) === -1) labels.push(label);
      });
      removed.forEach(function (name) {
        if (!removedMap.has(name)) removedMap.set(name, []);
        var labels = removedMap.get(name);
        if (labels.indexOf(label) === -1) labels.push(label);
      });
      if (added.length || removed.length) {
        catalogSummary.push({
          tag: tag,
          label: label,
          added: added.length,
          removed: removed.length,
        });
      }
    });
    function mapToRows(map) {
      return Array.from(map.entries())
        .map(function (entry) {
          return { name: entry[0], providers: entry[1] };
        })
        .sort(function (a, b) {
          return String(a.name).localeCompare(String(b.name));
        });
    }
    return {
      added: mapToRows(addedMap),
      removed: mapToRows(removedMap),
      catalogs: catalogSummary,
    };
  }

  function closeGdbDiffModal() {
    var backdrop = $("gdbDiffBackdrop");
    if (!backdrop) return;
    backdrop.classList.remove("open");
    backdrop.setAttribute("aria-hidden", "true");
  }

  function setGdbDiffTab(tab) {
    var changes = $("gdbDiffChanges");
    var json = $("gdbDiffJson");
    var tabChanges = $("gdbDiffTabChanges");
    var tabJson = $("gdbDiffTabJson");
    var showJson = tab === "json";
    if (changes) changes.hidden = showJson;
    if (json) json.hidden = !showJson;
    if (tabChanges) tabChanges.classList.toggle("is-active", !showJson);
    if (tabJson) tabJson.classList.toggle("is-active", showJson);
  }

  function renderGroupedChangeList(title, rows, emptyText) {
    if (!rows || !rows.length) {
      return "<h3>" + escapeHtml(title) + '</h3><p class="muted">' + escapeHtml(emptyText) + "</p>";
    }
    return (
      "<h3>" +
      escapeHtml(title) +
      " (" +
      rows.length.toLocaleString() +
      ")</h3><ul class=\"games-list gdb-diff-list\">" +
      rows
        .map(function (row) {
          return (
            "<li><strong>" +
            escapeHtml(row.name) +
            "</strong>" +
            (row.providers && row.providers.length
              ? '<span class="meta">' + escapeHtml(row.providers.join(", ")) + "</span>"
              : "") +
            "</li>"
          );
        })
        .join("") +
      "</ul>"
    );
  }

  function showGdbDiffModal(payload) {
    var backdrop = $("gdbDiffBackdrop");
    var title = $("gdbDiffTitle");
    var hint = $("gdbDiffHint");
    var changes = $("gdbDiffChanges");
    var json = $("gdbDiffJson");
    if (!backdrop || !changes) return;
    if (title) {
      title.textContent =
        "Database modifications" + (payload.date ? " — " + payload.date : "");
    }
    if (hint) {
      hint.textContent = payload.previousDate
        ? "Compared with " + payload.previousDate + "."
        : payload.fallback
          ? "Snapshot files were not available; showing the recorded summary."
          : "Changes for this snapshot.";
    }
    changes.innerHTML =
      renderGroupedChangeList("Games added", payload.added, "No games were added.") +
      renderGroupedChangeList("Games removed", payload.removed, "No games were removed.");
    if (json) {
      var view = {
        date: payload.date || "",
        previous_date: payload.previousDate || "",
        added: payload.added,
        removed: payload.removed,
        catalogs: payload.catalogs || [],
      };
      json.textContent = JSON.stringify(view, null, 2);
    }
    setGdbDiffTab("changes");
    backdrop.classList.add("open");
    backdrop.setAttribute("aria-hidden", "false");
  }

  function openModificationViewer(date) {
    if (!date) return;
    var scopeTag = selectedTag;
    archiveIndexPromise().then(function (index) {
      var prevDate = previousArchiveDay(date, index);
      return Promise.all([fetchDaySnapshot(prevDate), fetchDaySnapshot(date)]).then(function (pair) {
        var prev = pair[0];
        var curr = pair[1];
        if (curr && prev) {
          var diff = diffDaySnapshots(prev, curr, scopeTag);
          showGdbDiffModal({
            date: date,
            previousDate: prevDate,
            added: diff.added,
            removed: diff.removed,
            catalogs: diff.catalogs,
          });
          return;
        }
        var mods = (snap && snap.modifications) || [];
        var mod = mods.find(function (m) {
          return m.date === date;
        });
        var added = [];
        var removed = [];
        var catalogs = (mod && mod.by_catalog) || [];
        if (scopeTag !== "all") {
          catalogs = catalogs.filter(function (c) {
            return c.tag === scopeTag;
          });
        }
        catalogs.forEach(function (c) {
          if (c.added) {
            added.push({
              name: "+" + fmt(c.added) + " games",
              providers: [c.label || c.tag],
            });
          }
          if (c.removed) {
            removed.push({
              name: "−" + fmt(c.removed) + " games",
              providers: [c.label || c.tag],
            });
          }
        });
        showGdbDiffModal({
          date: date,
          previousDate: prevDate,
          added: added,
          removed: removed,
          catalogs: catalogs,
          fallback: true,
        });
      });
    });
  }

  function renderModifications() {
    var list = $("gamesModsList");
    if (!list) return;
    var mods = (snap && snap.modifications) || [];
    if (selectedTag !== "all") {
      mods = mods.filter(function (m) {
        if (m.kind === "baseline") return true;
        return (m.catalogs_touched || []).indexOf(selectedTag) !== -1;
      });
    }
    if (!mods.length) {
      list.innerHTML = '<li class="muted">No modification history yet.</li>';
      return;
    }
    list.innerHTML = mods
      .map(function (m) {
        if (m.kind === "baseline") {
          return (
            '<li class="games-mod-item" data-mod-date="' +
            escapeHtml(m.date) +
            '"><div class="games-mod-row"><strong>' +
            escapeHtml(m.date) +
            '</strong><span class="muted">Baseline recorded</span></div>' +
            '<span class="meta">First snapshot — no add/remove diff yet. Click to inspect.</span></li>'
          );
        }
        var detail;
        if (selectedTag === "all") {
          detail =
            '<span class="ok">+' +
            fmt(m.added) +
            '</span> / <span class="danger">−' +
            fmt(m.removed) +
            "</span>";
          var touched = (m.by_catalog || [])
            .slice(0, 6)
            .map(function (c) {
              return c.label + " (+" + c.added + "/−" + c.removed + ")";
            })
            .join(" · ");
          return (
            '<li class="games-mod-item" data-mod-date="' +
            escapeHtml(m.date) +
            '" role="button" tabindex="0"><div class="games-mod-row"><strong>' +
            escapeHtml(m.date) +
            "</strong><span>" +
            detail +
            "</span></div>" +
            (touched ? '<span class="meta">' + escapeHtml(touched) + "</span>" : "") +
            '<span class="meta">Click to view added/removed games</span></li>'
          );
        }
        var cat = (m.by_catalog || []).find(function (c) {
          return c.tag === selectedTag;
        });
        detail = cat
          ? '<span class="ok">+' +
            fmt(cat.added) +
            '</span> / <span class="danger">−' +
            fmt(cat.removed) +
            "</span>"
          : '<span class="muted">no change</span>';
        return (
          '<li class="games-mod-item" data-mod-date="' +
          escapeHtml(m.date) +
          '" role="button" tabindex="0"><div class="games-mod-row"><strong>' +
          escapeHtml(m.date) +
          "</strong><span>" +
          detail +
          "</span></div>" +
          '<span class="meta">Click to view added/removed games</span></li>'
        );
      })
      .join("");
  }

  function renderAll() {
    renderKpis();
    renderCountsTable();
    renderHistoryChart();
    renderLatestGames();
    renderModifications();
  }

  function loadLiveCounts() {
    if (!api || typeof api.listCatalogs !== "function") return Promise.resolve();
    return Promise.all(
      api.listCatalogs().map(function (c) {
        return api
          .ensureCatalogEntries(c.tag)
          .then(function (entries) {
            liveCounts[c.tag] = Array.isArray(entries) ? entries.length : 0;
          })
          .catch(function () {
            liveCounts[c.tag] = 0;
          });
      })
    );
  }

  function loadSnapshot() {
    return fetch("../gdb_stats.json", { cache: "no-store" })
      .then(function (res) {
        if (!res.ok) throw new Error("HTTP " + res.status);
        return res.json();
      })
      .then(function (data) {
        snap = data;
        if (data.latest_changes && data.latest_changes.is_baseline) {
          setBaselineNotice(
            "Baseline snapshot recorded" +
              (data.snapshot_date ? " on " + data.snapshot_date : "") +
              ". Adds/removes and growth charts appear after the next snapshot (run scripts/build_gdb_stats.py)."
          );
        } else {
          setBaselineNotice("");
        }
      })
      .catch(function () {
        snap = null;
        setBaselineNotice(
          "No gdb_stats.json yet. Run scripts/build_gdb_stats.py to create the first snapshot."
        );
      });
  }

  function wire() {
    var sel = $("gamesDbFilter");
    if (sel && sel.dataset.wired !== "1") {
      sel.dataset.wired = "1";
      sel.addEventListener("change", function () {
        selectedTag = sel.value || "all";
        renderAll();
      });
    }
    var list = $("gamesModsList");
    if (list && list.dataset.wired !== "1") {
      list.dataset.wired = "1";
      list.addEventListener("click", function (ev) {
        var item = ev.target && ev.target.closest ? ev.target.closest(".games-mod-item") : null;
        if (!item || !list.contains(item)) return;
        var date = item.getAttribute("data-mod-date") || "";
        if (date) openModificationViewer(date);
      });
      list.addEventListener("keydown", function (ev) {
        if (ev.key !== "Enter" && ev.key !== " ") return;
        var item = ev.target && ev.target.closest ? ev.target.closest(".games-mod-item") : null;
        if (!item || !list.contains(item)) return;
        ev.preventDefault();
        var date = item.getAttribute("data-mod-date") || "";
        if (date) openModificationViewer(date);
      });
    }
    var closeBtn = $("gdbDiffCloseBtn");
    var dismissBtn = $("gdbDiffDismissBtn");
    var backdrop = $("gdbDiffBackdrop");
    if (closeBtn && closeBtn.dataset.wired !== "1") {
      closeBtn.dataset.wired = "1";
      closeBtn.addEventListener("click", closeGdbDiffModal);
    }
    if (dismissBtn && dismissBtn.dataset.wired !== "1") {
      dismissBtn.dataset.wired = "1";
      dismissBtn.addEventListener("click", closeGdbDiffModal);
    }
    if (backdrop && backdrop.dataset.wired !== "1") {
      backdrop.dataset.wired = "1";
      backdrop.addEventListener("click", function (ev) {
        if (ev.target === backdrop) closeGdbDiffModal();
      });
    }
    var tabChanges = $("gdbDiffTabChanges");
    var tabJson = $("gdbDiffTabJson");
    if (tabChanges && tabChanges.dataset.wired !== "1") {
      tabChanges.dataset.wired = "1";
      tabChanges.addEventListener("click", function () {
        setGdbDiffTab("changes");
      });
    }
    if (tabJson && tabJson.dataset.wired !== "1") {
      tabJson.dataset.wired = "1";
      tabJson.addEventListener("click", function () {
        setGdbDiffTab("json");
      });
    }
    if (!global.__proxyListGdbDiffEscWired) {
      global.__proxyListGdbDiffEscWired = true;
      document.addEventListener("keydown", function (ev) {
        if (ev.key === "Escape") closeGdbDiffModal();
      });
    }
  }

  function ensureLoaded() {
    if (loaded) {
      renderAll();
      if (historyChart && typeof historyChart.resize === "function") {
        try {
          historyChart.resize();
        } catch (_) {}
      }
      return Promise.resolve();
    }
    if (loading) return loading;
    loading = Promise.resolve()
      .then(function () {
        wire();
        return loadSnapshot();
      })
      .then(function () {
        ((snap && snap.catalogs) || []).forEach(function (c) {
          if (liveCounts[c.tag] == null) liveCounts[c.tag] = Number(c.count || 0);
        });
        fillFilter();
        renderAll();
        return loadLiveCounts();
      })
      .then(function () {
        fillFilter();
        renderAll();
        loaded = true;
        loading = null;
      })
      .catch(function (err) {
        loading = null;
        console.warn("[games-stats]", err);
      });
    return loading;
  }

  global.ProxyListGamesStats = {
    ensureLoaded: ensureLoaded,
    render: renderAll,
  };
})(typeof window !== "undefined" ? window : globalThis);
