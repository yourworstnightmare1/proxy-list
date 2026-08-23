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
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: true } },
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
    list.innerHTML =
      ch.added
        .map(function (item) {
          var name = typeof item === "string" ? item : item.name;
          var label = typeof item === "string" ? "" : item.label;
          return (
            "<li><strong>" +
            escapeHtml(name) +
            "</strong>" +
            (label && selectedTag === "all"
              ? '<span class="meta">' + escapeHtml(label) + "</span>"
              : "") +
            "</li>"
          );
        })
        .join("") +
      (ch.addedTrunc
        ? '<li class="muted">…and ' + ch.addedTrunc.toLocaleString() + " more</li>"
        : "");
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
            '<li><div class="games-mod-row"><strong>' +
            escapeHtml(m.date) +
            '</strong><span class="muted">Baseline recorded</span></div>' +
            '<span class="meta">First snapshot — no add/remove diff yet.</span></li>'
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
            '<li><div class="games-mod-row"><strong>' +
            escapeHtml(m.date) +
            "</strong><span>" +
            detail +
            "</span></div>" +
            (touched ? '<span class="meta">' + escapeHtml(touched) + "</span>" : "") +
            "</li>"
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
          '<li><div class="games-mod-row"><strong>' +
          escapeHtml(m.date) +
          "</strong><span>" +
          detail +
          "</span></div></li>"
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
    if (!sel || sel.dataset.wired === "1") return;
    sel.dataset.wired = "1";
    sel.addEventListener("change", function () {
      selectedTag = sel.value || "all";
      renderAll();
    });
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
