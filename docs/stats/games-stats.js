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
  var shareChart = null;
  var historySpan = "1m";
  var HISTORY_SPAN_DAYS = {
    "1w": 7,
    "2w": 14,
    "1m": 31,
    "6m": 183,
    "1y": 366,
    "3y": 1098,
    "5y": 1830,
  };
  var loaded = false;
  var loading = null;
  var daySnapCache = Object.create(null);
  var archiveIndexP = null;

  var CHART_COLORS = [
    "#6cb3ff",
    "#3ecf8e",
    "#ffd57e",
    "#ff9b9b",
    "#c4a1ff",
    "#7dd3fc",
    "#f9a8d4",
    "#a3e635",
    "#fb923c",
    "#94a3b8",
    "#38bdf8",
    "#f472b6",
    "#84cc16",
    "#fbbf24",
    "#a78bfa",
    "#2dd4bf",
    "#e879f9",
    "#facc15",
    "#60a5fa",
    "#4ade80",
    "#fb7185",
    "#c084fc",
  ];

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
    function setKpi(id, value) {
      var el = $(id);
      if (!el) return;
      el.textContent = value;
      var host = el.closest ? el.closest(".stat") : null;
      if (host) host.classList.remove("is-loading");
    }
    if (selectedTag !== "all") {
      setKpi("gamesStatCatalogs", "1");
      setKpi("gamesStatEntries", fmt(liveCounts[selectedTag] || 0));
      var sm = snapshotMap()[selectedTag];
      setKpi("gamesStatUnique", sm ? fmt(sm.count) : "—");
    } else {
      setKpi("gamesStatCatalogs", fmt(rows.length));
      setKpi("gamesStatEntries", fmt(liveTotal));
      setKpi("gamesStatUnique", snap ? fmt(snap.unique_games) : "—");
    }
    setKpi("gamesStatSnapshot", (snap && snap.snapshot_date) || "—");
    var grid = document.querySelector('#panel-games .stat-grid');
    if (grid && !grid.querySelector(".stat.is-loading")) grid.removeAttribute("aria-busy");
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

  function destroyShareChart() {
    if (!shareChart) return;
    try {
      shareChart.destroy();
    } catch (_) {}
    shareChart = null;
  }

  function renderShareChart() {
    var canvas = $("gamesShareChart");
    var wrap = $("gamesShareWrap");
    var empty = $("gamesShareEmpty");
    destroyShareChart();
    if (!canvas) return;

    var smap = snapshotMap();
    var rows = catalogRows()
      .map(function (c) {
        var live = Number(liveCounts[c.tag] || 0);
        var snapCount = smap[c.tag] ? Number(smap[c.tag].count || 0) : 0;
        // Prefer live counts; fall back to snapshot when live has not loaded yet.
        var count = live > 0 ? live : snapCount;
        return { tag: c.tag, label: c.label, count: count };
      })
      .filter(function (r) {
        return r.count > 0;
      })
      .sort(function (a, b) {
        return b.count - a.count || String(a.label).localeCompare(String(b.label));
      });

    if (!rows.length || !global.Chart) {
      if (wrap) {
        wrap.hidden = true;
        wrap.classList.remove("is-loading");
      }
      if (empty) empty.hidden = false;
      return;
    }
    if (wrap) wrap.hidden = false;
    if (empty) empty.hidden = true;

    var total = rows.reduce(function (sum, r) {
      return sum + r.count;
    }, 0);

    shareChart = new global.Chart(canvas, {
      type: "doughnut",
      data: {
        labels: rows.map(function (r) {
          return r.label;
        }),
        datasets: [
          {
            data: rows.map(function (r) {
              return r.count;
            }),
            backgroundColor: rows.map(function (_, i) {
              return CHART_COLORS[i % CHART_COLORS.length];
            }),
            borderColor: "#1a1a1a",
            borderWidth: 2,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        // Override global nearest+intersect:false — that picks the wrong doughnut slice
        // when the pointer is in the hole or padding around the ring.
        interaction: { mode: "nearest", intersect: true },
        hover: { mode: "nearest", intersect: true },
        plugins: {
          legend: {
            position: "bottom",
            labels: { boxWidth: 12, padding: 10, font: { size: 11 } },
          },
          tooltip: {
            enabled: true,
            mode: "nearest",
            intersect: true,
            callbacks: {
              label: function (ctx) {
                var value = Number(ctx.raw) || 0;
                var pct = total > 0 ? Math.round((value / total) * 1000) / 10 : 0;
                return (
                  (ctx.label || "") +
                  ": " +
                  value.toLocaleString() +
                  " games (" +
                  pct +
                  "%)"
                );
              },
            },
          },
        },
      },
    });
    if (wrap) wrap.classList.remove("is-loading");
  }

  function filterHistoryBySpan(history, span) {
    var list = Array.isArray(history) ? history.slice() : [];
    if (!list.length) return [];
    list.sort(function (a, b) {
      return String(a.date || "").localeCompare(String(b.date || ""));
    });
    var days = HISTORY_SPAN_DAYS[span] || HISTORY_SPAN_DAYS["1m"];
    var latest = String(list[list.length - 1].date || "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(latest)) return list;
    var end = new Date(latest + "T00:00:00Z");
    if (!Number.isFinite(end.getTime())) return list;
    var start = new Date(end.getTime() - (days - 1) * 86400000);
    var startStr = start.toISOString().slice(0, 10);
    return list.filter(function (h) {
      return String(h.date || "") >= startStr;
    });
  }

  function syncHistoryRangeToggle() {
    var root = $("gamesHistoryRangeToggle");
    if (!root) return;
    root.querySelectorAll("[data-games-history-span]").forEach(function (btn) {
      btn.classList.toggle(
        "is-active",
        (btn.getAttribute("data-games-history-span") || "") === historySpan
      );
    });
  }

  function renderHistoryChart() {
    var fullHistory = (snap && snap.history) || [];
    var history = filterHistoryBySpan(fullHistory, historySpan);
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
    syncHistoryRangeToggle();
    if (fullHistory.length < 2) {
      if (empty) {
        empty.hidden = false;
        empty.textContent =
          "Need at least two snapshots before a growth chart can be drawn. A baseline was recorded; adds/removes appear after the next snapshot.";
      }
      if (wrap) {
        wrap.hidden = true;
        wrap.classList.remove("is-loading");
      }
      return;
    }
    if (history.length < 1) {
      if (empty) {
        empty.hidden = false;
        empty.textContent = "No snapshots fall inside this time span yet. Try a wider range.";
      }
      if (wrap) {
        wrap.hidden = true;
        wrap.classList.remove("is-loading");
      }
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

    var shortSpan = historySpan === "1w" || historySpan === "2w";
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
            pointRadius: shortSpan || history.length <= 14 ? 3 : 0,
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
          x: { ticks: { maxRotation: 0, autoSkip: true, maxTicksLimit: shortSpan ? 8 : 12 } },
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
    if (wrap) wrap.classList.remove("is-loading");
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
    var byCatalog = Object.create(null);
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
      var prevNames = namesForCatalog(prev, tag);
      var currNames = namesForCatalog(curr, tag);
      var prevSet = new Set(prevNames);
      var currSet = new Set(currNames);
      var added = [];
      var removed = [];
      currNames.forEach(function (name) {
        if (!prevSet.has(name)) added.push(name);
      });
      prevNames.forEach(function (name) {
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
      byCatalog[tag] = {
        label: label,
        from_count: prevNames.length,
        to_count: currNames.length,
        added: added.slice().sort(function (a, b) {
          return String(a).localeCompare(String(b));
        }),
        removed: removed.slice().sort(function (a, b) {
          return String(a).localeCompare(String(b));
        }),
        added_count: added.length,
        removed_count: removed.length,
      };
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
      by_catalog: byCatalog,
    };
  }

  /** Structured JSON for the snapshot↔snapshot catalog diff (game name lists). */
  function buildSnapshotJsonDiff(fromDay, toDay, fromDate, toDate, scopeTag) {
    var diff = diffDaySnapshots(fromDay, toDay, scopeTag);
    var byCatalog = Object.create(null);
    var catalogCounts = Object.create(null);
    Object.keys(diff.by_catalog || {}).forEach(function (tag) {
      var row = diff.by_catalog[tag];
      if (!row) return;
      catalogCounts[tag] = {
        label: row.label,
        from: row.from_count,
        to: row.to_count,
      };
      if (!row.added_count && !row.removed_count) return;
      byCatalog[tag] = row;
    });
    var out = {
      from: fromDate || "",
      to: toDate || "",
      scope: scopeTag && scopeTag !== "all" ? scopeTag : "all",
      added_count: (diff.added || []).length,
      removed_count: (diff.removed || []).length,
      by_catalog: byCatalog,
      added: (diff.added || []).map(function (row) {
        return row.providers && row.providers.length
          ? { name: row.name, catalogs: row.providers }
          : row.name;
      }),
      removed: (diff.removed || []).map(function (row) {
        return row.providers && row.providers.length
          ? { name: row.name, catalogs: row.providers }
          : row.name;
      }),
    };
    if (!out.added_count && !out.removed_count) {
      out.note = "No game name additions or removals between these snapshots.";
      out.catalog_counts = catalogCounts;
      if (fromDay || toDay) {
        out.metadata = {
          from_generated_at: (fromDay && fromDay.generated_at) || "",
          to_generated_at: (toDay && toDay.generated_at) || "",
        };
      }
    }
    return out;
  }

  /** Align two sorted string lists into GitHub-style split-diff rows. */
  function alignSortedNameLists(leftNames, rightNames) {
    var left = (leftNames || []).slice().sort(function (a, b) {
      return String(a).localeCompare(String(b));
    });
    var right = (rightNames || []).slice().sort(function (a, b) {
      return String(a).localeCompare(String(b));
    });
    var rows = [];
    var i = 0;
    var j = 0;
    while (i < left.length || j < right.length) {
      if (i < left.length && j < right.length && left[i] === right[j]) {
        rows.push({ type: "ctx", left: left[i], right: right[j] });
        i += 1;
        j += 1;
      } else if (j >= right.length || (i < left.length && String(left[i]).localeCompare(String(right[j])) < 0)) {
        rows.push({ type: "del", left: left[i], right: "" });
        i += 1;
      } else {
        rows.push({ type: "add", left: "", right: right[j] });
        j += 1;
      }
    }
    return rows;
  }

  /** Keep change rows plus a little unchanged context; collapse long equal runs. */
  function collapseAlignedRows(rows, contextLines) {
    var keep = Math.max(0, contextLines == null ? 2 : contextLines);
    var interesting = [];
    var i;
    for (i = 0; i < rows.length; i++) {
      if (rows[i].type !== "ctx") interesting.push(i);
    }
    if (!interesting.length) return [];
    var show = new Array(rows.length);
    for (i = 0; i < interesting.length; i++) {
      var center = interesting[i];
      var from = Math.max(0, center - keep);
      var to = Math.min(rows.length - 1, center + keep);
      var k;
      for (k = from; k <= to; k++) show[k] = true;
    }
    var out = [];
    var skipped = 0;
    for (i = 0; i < rows.length; i++) {
      if (show[i]) {
        if (skipped) {
          out.push({ type: "skip", left: "~~ " + skipped + " unchanged names ~~", right: "~~ " + skipped + " unchanged names ~~" });
          skipped = 0;
        }
        out.push(rows[i]);
      } else {
        skipped += 1;
      }
    }
    if (skipped) {
      out.push({ type: "skip", left: "~~ " + skipped + " unchanged names ~~", right: "~~ " + skipped + " unchanged names ~~" });
    }
    return out;
  }

  function splitDiffCell(side, lineNo, text, empty) {
    return (
      '<div class="gdb-diff-cell gdb-diff-cell-' +
      side +
      (empty ? " is-empty" : "") +
      '"><div class="gdb-diff-ln">' +
      (lineNo ? escapeHtml(String(lineNo)) : "") +
      '</div><div class="gdb-diff-code">' +
      escapeHtml(text || (empty ? " " : "")) +
      "</div></div>"
    );
  }

  function splitDiffRow(type, leftText, rightText, leftNo, rightNo) {
    var leftEmpty = type === "add" || (type !== "hunk" && type !== "skip" && type !== "meta" && !leftText && type !== "ctx");
    var rightEmpty = type === "del" || (type !== "hunk" && type !== "skip" && type !== "meta" && !rightText && type !== "ctx");
    if (type === "add") leftEmpty = true;
    if (type === "del") rightEmpty = true;
    if (type === "hunk" || type === "skip" || type === "meta") {
      leftEmpty = false;
      rightEmpty = false;
    }
    return (
      '<div class="gdb-diff-row is-' +
      escapeHtml(type) +
      '">' +
      splitDiffCell("left", leftNo, leftText, leftEmpty && !leftText) +
      splitDiffCell("right", rightNo, rightText, rightEmpty && !rightText) +
      "</div>"
    );
  }

  /** GitHub-style side-by-side comparison of previous vs selected snapshot files. */
  function buildSideBySideCatalogDiffHtml(fromDay, toDay, fromDate, toDate, scopeTag) {
    var diff = diffDaySnapshots(fromDay, toDay, scopeTag);
    var leftLabel = (fromDate || "previous") + ".json";
    var rightLabel = (toDate || "selected") + ".json";
    var leftMeta = fromDay && fromDay.generated_at ? "generated " + fromDay.generated_at : "previous snapshot";
    var rightMeta = toDay && toDay.generated_at ? "generated " + toDay.generated_at : "selected snapshot";

    var body = [];
    var leftLine = 0;
    var rightLine = 0;
    var rowCap = 6000;
    var omitted = 0;

    function pushRow(type, leftText, rightText, bumpLeft, bumpRight) {
      if (body.length >= rowCap) {
        omitted += 1;
        return;
      }
      var lnL = "";
      var lnR = "";
      if (bumpLeft) {
        leftLine += 1;
        lnL = leftLine;
      }
      if (bumpRight) {
        rightLine += 1;
        lnR = rightLine;
      }
      body.push(splitDiffRow(type, leftText, rightText, lnL, lnR));
    }

    pushRow(
      "meta",
      "date: " + ((fromDay && fromDay.date) || fromDate || ""),
      "date: " + ((toDay && toDay.date) || toDate || ""),
      true,
      true
    );
    pushRow(
      "meta",
      "generated_at: " + ((fromDay && fromDay.generated_at) || ""),
      "generated_at: " + ((toDay && toDay.generated_at) || ""),
      true,
      true
    );

    var tags = Object.keys(diff.by_catalog || {}).sort(function (a, b) {
      var la = (diff.by_catalog[a] && diff.by_catalog[a].label) || a;
      var lb = (diff.by_catalog[b] && diff.by_catalog[b].label) || b;
      return String(la).localeCompare(String(lb));
    });
    var anyGames = false;
    tags.forEach(function (tag) {
      var row = diff.by_catalog[tag];
      if (!row || (!row.added_count && !row.removed_count)) return;
      anyGames = true;
      var leftNames = namesForCatalog(fromDay, tag);
      var rightNames = namesForCatalog(toDay, tag);
      pushRow(
        "hunk",
        "@@ " + tag + " (" + (row.label || tag) + ") " + leftNames.length + " games @@",
        "@@ " + tag + " (" + (row.label || tag) + ") " + rightNames.length + " games @@",
        false,
        false
      );
      var aligned = collapseAlignedRows(alignSortedNameLists(leftNames, rightNames), 2);
      aligned.forEach(function (r) {
        if (r.type === "skip") {
          pushRow("skip", r.left, r.right, false, false);
          return;
        }
        if (r.type === "ctx") {
          pushRow("ctx", r.left, r.right, true, true);
        } else if (r.type === "del") {
          pushRow("del", r.left, "", true, false);
        } else if (r.type === "add") {
          pushRow("add", "", r.right, false, true);
        }
      });
    });

    if (!anyGames) {
      pushRow("hunk", "@@ catalogs @@", "@@ catalogs @@", false, false);
      pushRow(
        "ctx",
        "(no game name additions or removals)",
        "(no game name additions or removals)",
        true,
        true
      );
      // Still show per-catalog counts so the two files are comparable.
      tags.forEach(function (tag) {
        var row = diff.by_catalog[tag];
        if (!row) return;
        pushRow(
          "ctx",
          tag + ": " + row.from_count + " games",
          tag + ": " + row.to_count + " games",
          true,
          true
        );
      });
    }
    if (omitted) {
      pushRow(
        "skip",
        "…and " + omitted.toLocaleString() + " more rows omitted",
        "…and " + omitted.toLocaleString() + " more rows omitted",
        false,
        false
      );
    }

    return (
      '<div class="gdb-diff-split-headers">' +
      '<div class="gdb-diff-file-head">' +
      escapeHtml(leftLabel) +
      "<span>" +
      escapeHtml(leftMeta) +
      "</span></div>" +
      '<div class="gdb-diff-file-head">' +
      escapeHtml(rightLabel) +
      "<span>" +
      escapeHtml(rightMeta) +
      "</span></div>" +
      "</div>" +
      '<div class="gdb-diff-split-body">' +
      body.join("") +
      "</div>"
    );
  }

  function closeGdbDiffModal() {
    var backdrop = $("gdbDiffBackdrop");
    if (!backdrop) return;
    backdrop.classList.remove("open");
    backdrop.setAttribute("aria-hidden", "true");
    backdropPayload = null;
  }

  function gdbDiffHintForTab(tab, payload) {
    if (!payload) return "Games added or removed between catalog snapshots.";
    if (payload.loading) return "Loading snapshot diff…";
    if (tab === "json") {
      if (payload.jsonFrom && payload.jsonTo) {
        return (
          "Side-by-side file comparison: " +
          payload.jsonFrom +
          ".json (left) vs " +
          payload.jsonTo +
          ".json (right)."
        );
      }
      return "Side-by-side comparison of the previous and selected snapshots.";
    }
    if (payload.previousDate) return "Compared with " + payload.previousDate + ".";
    if (payload.fallback) return "Snapshot files were not available; showing the recorded summary.";
    return "Changes for this snapshot.";
  }

  var backdropPayload = null;

  function setGdbDiffTab(tab) {
    var changes = $("gdbDiffChanges");
    var json = $("gdbDiffJson");
    var tabChanges = $("gdbDiffTabChanges");
    var tabJson = $("gdbDiffTabJson");
    var hint = $("gdbDiffHint");
    var showJson = tab === "json";
    if (changes) changes.hidden = showJson;
    if (json) json.hidden = !showJson;
    if (tabChanges) tabChanges.classList.toggle("is-active", !showJson);
    if (tabJson) tabJson.classList.toggle("is-active", showJson);
    if (hint && backdropPayload) {
      hint.textContent = gdbDiffHintForTab(showJson ? "json" : "changes", backdropPayload);
    }
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

  function capChangeRows(rows, limit) {
    var list = rows || [];
    var max = limit || 250;
    if (list.length <= max) return list;
    return list.slice(0, max).concat([
      {
        name: "…and " + (list.length - max).toLocaleString() + " more",
        providers: [],
      },
    ]);
  }

  function showGdbDiffModal(payload) {
    var backdrop = $("gdbDiffBackdrop");
    var title = $("gdbDiffTitle");
    var hint = $("gdbDiffHint");
    var changes = $("gdbDiffChanges");
    var json = $("gdbDiffJson");
    if (!backdrop || !changes) return;
    backdropPayload = payload || null;
    if (title) {
      title.textContent =
        "Database modifications" + (payload.date ? " — " + payload.date : "");
    }
    if (hint) hint.textContent = gdbDiffHintForTab("changes", payload);
    changes.innerHTML =
      renderGroupedChangeList("Games added", capChangeRows(payload.added), "No games were added.") +
      renderGroupedChangeList("Games removed", capChangeRows(payload.removed), "No games were removed.");
    if (json) {
      if (payload.jsonDiffHtml) {
        json.innerHTML = payload.jsonDiffHtml;
      } else if (payload.jsonDiff) {
        json.textContent = JSON.stringify(payload.jsonDiff, null, 2);
      } else {
        json.innerHTML =
          '<div class="gdb-diff-split-headers">' +
          '<div class="gdb-diff-file-head">previous.json</div>' +
          '<div class="gdb-diff-file-head">selected.json</div>' +
          "</div>" +
          '<div class="gdb-diff-split-body">' +
          splitDiffRow("ctx", "Loading…", "Loading…", "", "") +
          "</div>";
      }
    }
    setGdbDiffTab("changes");
    backdrop.classList.add("open");
    backdrop.setAttribute("aria-hidden", "false");
  }

  function openModificationViewer(date) {
    if (!date) return;
    var scopeTag = selectedTag;
    showGdbDiffModal({
      date: date,
      previousDate: "",
      added: [],
      removed: [],
      catalogs: [],
      loading: true,
    });
    var hint = $("gdbDiffHint");
    if (hint) hint.textContent = "Loading snapshot diff…";
    archiveIndexPromise()
      .then(function (index) {
        var prevDate = previousArchiveDay(date, index);
        // JSON + Changes both compare the previous archive day → selected day.
        return Promise.all([fetchDaySnapshot(prevDate), fetchDaySnapshot(date)]).then(function (pair) {
          var prev = pair[0];
          var curr = pair[1];
          var jsonDiff = null;
          var jsonDiffHtml = "";
          if (prev && curr && prevDate) {
            jsonDiff = buildSnapshotJsonDiff(prev, curr, prevDate, date, scopeTag);
            jsonDiffHtml = buildSideBySideCatalogDiffHtml(prev, curr, prevDate, date, scopeTag);
          }

          if (curr && prev) {
            var diff = diffDaySnapshots(prev, curr, scopeTag);
            showGdbDiffModal({
              date: date,
              previousDate: prevDate,
              added: diff.added,
              removed: diff.removed,
              catalogs: diff.catalogs,
              jsonDiff: jsonDiff,
              jsonDiffHtml: jsonDiffHtml,
              jsonFrom: prevDate,
              jsonTo: date,
              jsonVsLatest: false,
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
            jsonDiff: jsonDiff,
            jsonDiffHtml: jsonDiffHtml,
            jsonFrom: prevDate,
            jsonTo: date,
            jsonVsLatest: false,
            fallback: true,
          });
        });
      })
      .catch(function (err) {
        console.warn("[games-stats] modification viewer failed", err);
        showGdbDiffModal({
          date: date,
          previousDate: "",
          added: [],
          removed: [],
          catalogs: [],
          fallback: true,
        });
        var hintEl = $("gdbDiffHint");
        if (hintEl) hintEl.textContent = "Could not load snapshot files for this day.";
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
    renderShareChart();
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
    var range = $("gamesHistoryRangeToggle");
    if (range && range.dataset.wired !== "1") {
      range.dataset.wired = "1";
      range.addEventListener("click", function (ev) {
        var btn = ev.target && ev.target.closest ? ev.target.closest("[data-games-history-span]") : null;
        if (!btn || !range.contains(btn)) return;
        var span = btn.getAttribute("data-games-history-span") || "1m";
        if (!HISTORY_SPAN_DAYS[span]) return;
        historySpan = span;
        syncHistoryRangeToggle();
        renderHistoryChart();
      });
    }
    syncHistoryRangeToggle();
    var list = $("gamesModsList");
    if (list && list.dataset.wired !== "1") {
      list.dataset.wired = "1";
      list.addEventListener(
        "click",
        function (ev) {
          var item = ev.target && ev.target.closest ? ev.target.closest(".games-mod-item") : null;
          if (!item || !list.contains(item)) return;
          var date = item.getAttribute("data-mod-date") || "";
          if (date) openModificationViewer(date);
        },
        true
      );
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
      if (shareChart && typeof shareChart.resize === "function") {
        try {
          shareChart.resize();
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
