(function () {
  "use strict";

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
  ];
  var DAILY_LOOKBACK_DAYS = 90;
  var PRESENCE_DAILY_LOOKBACK = 366;
  var PRESENCE_MONTHLY_LOOKBACK = 18;

  var charts = [];
  var detailCharts = [];
  var filterDetailCharts = [];
  var userCharts = [];
  var state = {
    links: [],
    providers: [],
    urlToProvider: new Map(),
    selectedProvider: "",
    selectedFilter: "",
    filterStats: null,
    db: null,
    dailyCache: null,
    presenceDaily: null,
    presenceMonthly: null,
    usersSpan: "7d",
    panel: "providers",
  };

  var PANEL_META = {
    providers: {
      title: "Providers & Domains",
      sub:
        "Provider composition and domains from the sorted list, plus lifetime link-open totals from this site. Opens are click counts, not unique visitors.",
    },
    filters: {
      title: "Filter Data",
      sub:
        "Web-filter blocked / unblocked / warning coverage from gn-math checks across sorted links, including block reasons by filter.",
    },
    contributions: {
      title: "Contributions",
      sub: "Cumulative link counts attributed to contributors on the sorted list.",
    },
    users: {
      title: "Users",
      sub:
        "Active visitors over time from presence heartbeats, busiest UTC hours, and monthly uniques.",
    },
  };

  function $(id) {
    return document.getElementById(id);
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function setNotice(msg, kind) {
    var el = $("statusNotice");
    if (!el) return;
    if (!msg) {
      el.hidden = true;
      el.textContent = "";
      return;
    }
    el.hidden = false;
    el.className = "notice" + (kind ? " " + kind : "");
    el.textContent = msg;
  }

  function normalizeUrlKey(u) {
    return normalizeUrlForHash(u);
  }

  /** Match Worker normalizeUrl used for link_clicks / click_daily doc ids. */
  function normalizeUrlForHash(raw) {
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

  async function sha256Hex(text) {
    var buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
    return Array.from(new Uint8Array(buf))
      .map(function (b) {
        return b.toString(16).padStart(2, "0");
      })
      .join("");
  }

  function stripProviderEmoji(name) {
    return (
      String(name || "")
        .replace(/^[^\w#]+/u, "")
        .trim() || String(name || "Unknown")
    );
  }

  function shortLabel(text, max) {
    var s = String(text || "");
    if (s.length <= max) return s;
    return s.slice(0, Math.max(1, max - 1)) + "…";
  }

  function chartDefaults() {
    if (!window.Chart) return;
    Chart.defaults.color = "#9a9a9a";
    Chart.defaults.borderColor = "#2e2e2e";
    Chart.defaults.font.family = '"Segoe UI", system-ui, sans-serif';
    // Fill/extend along the value axis instead of scaling bars/arcs up from nothing.
    Chart.defaults.animation = {
      duration: 850,
      easing: "easeOutQuart",
    };
    Chart.defaults.animations = {
      colors: false,
      numbers: {
        type: "number",
        properties: ["x", "y", "base", "circumference", "startAngle", "endAngle", "innerRadius", "outerRadius"],
      },
    };
  }

  /** Bar charts: grow from the baseline along the value axis only (no pop/scale-in). */
  function barFillAnimations(indexAxis) {
    var horizontal = indexAxis === "y";
    if (horizontal) {
      return {
        // Keep bar thickness + row position fixed; only extend along X.
        y: { duration: 0 },
        height: { duration: 0 },
        base: {
          type: "number",
          easing: "easeOutQuart",
          duration: 850,
          from: function (ctx) {
            if (ctx.type !== "data" || !ctx.chart.scales.x) return undefined;
            return ctx.chart.scales.x.getPixelForValue(0);
          },
        },
        x: {
          type: "number",
          easing: "easeOutQuart",
          duration: 850,
          from: function (ctx) {
            if (ctx.type !== "data" || !ctx.chart.scales.x) return undefined;
            return ctx.chart.scales.x.getPixelForValue(0);
          },
        },
        width: {
          type: "number",
          easing: "easeOutQuart",
          duration: 850,
          from: 0,
        },
      };
    }
    return {
      // Keep bar thickness + column position fixed; only extend along Y.
      x: { duration: 0 },
      width: { duration: 0 },
      base: {
        type: "number",
        easing: "easeOutQuart",
        duration: 850,
        from: function (ctx) {
          if (ctx.type !== "data" || !ctx.chart.scales.y) return undefined;
          return ctx.chart.scales.y.getPixelForValue(0);
        },
      },
      y: {
        type: "number",
        easing: "easeOutQuart",
        duration: 850,
        from: function (ctx) {
          if (ctx.type !== "data" || !ctx.chart.scales.y) return undefined;
          return ctx.chart.scales.y.getPixelForValue(0);
        },
      },
      height: {
        type: "number",
        easing: "easeOutQuart",
        duration: 850,
        from: 0,
      },
    };
  }

  function doughnutFillAnimation() {
    return {
      animateRotate: true,
      animateScale: false,
      duration: 900,
      easing: "easeOutQuart",
    };
  }

  function lineFillAnimations() {
    return {
      x: { duration: 0 },
      y: {
        type: "number",
        easing: "easeOutQuart",
        duration: 850,
        from: function (ctx) {
          if (ctx.type !== "data" || !ctx.chart || !ctx.chart.scales || !ctx.chart.scales.y) return undefined;
          return ctx.chart.scales.y.getPixelForValue(0);
        },
      },
    };
  }

  function destroyChartList(list) {
    list.forEach(function (c) {
      try {
        c.destroy();
      } catch (_) {}
    });
    list.length = 0;
  }

  function makeChart(canvas, config, bucket) {
    if (!window.Chart || !canvas) return null;
    config = config || {};
    config.options = config.options || {};
    var type = config.type;
    var indexAxis = (config.options && config.options.indexAxis) || "x";

    if (type === "bar") {
      config.options.animations = Object.assign({}, barFillAnimations(indexAxis), config.options.animations || {});
      if (!config.options.animation) {
        config.options.animation = { duration: 850, easing: "easeOutQuart" };
      }
    } else if (type === "doughnut" || type === "pie") {
      config.options.animation = Object.assign({}, doughnutFillAnimation(), config.options.animation || {});
      // Prevent radius pop-in; only sweep the arc.
      config.options.animations = Object.assign(
        {
          numbers: {
            type: "number",
            properties: ["circumference", "startAngle", "endAngle"],
          },
        },
        config.options.animations || {}
      );
    } else if (type === "line") {
      config.options.animations = Object.assign({}, lineFillAnimations(), config.options.animations || {});
    }

    var chart = new Chart(canvas, config);
    (bucket || charts).push(chart);
    return chart;
  }

  /** Y-axis options for horizontal bar charts: show every category label. */
  function hBarCategoryAxis(extra) {
    return Object.assign(
      {
        grid: { display: false },
        ticks: {
          autoSkip: false,
          font: { size: 11 },
        },
      },
      extra || {}
    );
  }

  function countBy(arr, keyFn) {
    var map = new Map();
    arr.forEach(function (item) {
      var k = keyFn(item);
      if (!k) return;
      map.set(k, (map.get(k) || 0) + 1);
    });
    return map;
  }

  function topEntries(map, limit) {
    return Array.from(map.entries())
      .sort(function (a, b) {
        return b[1] - a[1] || String(a[0]).localeCompare(String(b[0]));
      })
      .slice(0, limit);
  }

  function setText(id, value) {
    var el = $(id);
    if (el) el.textContent = value;
  }

  function formatInt(n) {
    try {
      return Number(n).toLocaleString();
    } catch (_) {
      return String(n);
    }
  }

  function parseFoundDate(s) {
    var m = String(s || "").trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (!m) return null;
    var d = new Date(Number(m[3]), Number(m[1]) - 1, Number(m[2]));
    return Number.isNaN(d.getTime()) ? null : d;
  }

  function formatShortDate(d) {
    try {
      return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
    } catch (_) {
      return d.toISOString().slice(0, 10);
    }
  }

  function utcDayIds(lookback) {
    var out = [];
    var now = new Date();
    for (var i = lookback - 1; i >= 0; i--) {
      var d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - i));
      out.push(d.toISOString().slice(0, 10));
    }
    return out;
  }

  function buildProviderIndex(links) {
    var byProv = new Map();
    links.forEach(function (row) {
      var p = String(row.provider || "").trim() || "Unknown";
      if (!byProv.has(p)) byProv.set(p, []);
      byProv.get(p).push(row);
    });
    return Array.from(byProv.entries())
      .map(function (e) {
        return { name: e[0], links: e[1], count: e[1].length };
      })
      .sort(function (a, b) {
        return b.count - a.count || a.name.localeCompare(b.name);
      });
  }

  function linksOverTimeSeries(providerLinks) {
    var dated = [];
    providerLinks.forEach(function (row) {
      var d = parseFoundDate(row.found);
      if (!d) return;
      dated.push(d.getTime());
    });
    dated.sort(function (a, b) {
      return a - b;
    });
    var labels = [];
    var values = [];
    var cum = 0;
    var unknown = providerLinks.length - dated.length;
    if (unknown > 0) {
      labels.push("Unknown date");
      values.push(unknown);
      cum = unknown;
    }
    dated.forEach(function (ts) {
      cum += 1;
      labels.push(formatShortDate(new Date(ts)));
      values.push(cum);
    });
    return { labels: labels, values: values, earliest: dated.length ? new Date(dated[0]) : null };
  }

  function renderProviderTable(rows) {
    var body = $("providerTableBody");
    if (!body) return;
    if (!rows.length) {
      body.innerHTML = '<tr><td class="muted" colspan="3">No provider data.</td></tr>';
      return;
    }
    body.innerHTML = rows
      .map(function (row, i) {
        var selected = row[0] === state.selectedProvider ? " is-selected" : "";
        return (
          '<tr class="' +
          selected.trim() +
          '" data-provider="' +
          escapeHtml(row[0]) +
          '"><td>' +
          (i + 1) +
          "</td><td>" +
          escapeHtml(row[0]) +
          '</td><td class="num">' +
          formatInt(row[1]) +
          "</td></tr>"
        );
      })
      .join("");
  }

  function renderProviderCharts(links) {
    var byProvider = countBy(links, function (r) {
      return String(r.provider || "").trim() || "Unknown";
    });
    var byCategory = countBy(links, function (r) {
      return String(r.category || "").trim() || "Uncategorized";
    });

    var topProviders = topEntries(byProvider, 15);
    renderProviderTable(topEntries(byProvider, 20));

    makeChart($("providerLinksChart"), {
      type: "bar",
      data: {
        labels: topProviders.map(function (r) {
          return shortLabel(stripProviderEmoji(r[0]), 28);
        }),
        datasets: [
          {
            label: "Links",
            data: topProviders.map(function (r) {
              return r[1];
            }),
            backgroundColor: CHART_COLORS[0],
            borderWidth: 0,
            borderRadius: 4,
          },
        ],
      },
      options: {
        indexAxis: "y",
        responsive: true,
        maintainAspectRatio: false,
        onClick: function (_evt, elements) {
          if (!elements || !elements.length) return;
          var idx = elements[0].index;
          if (topProviders[idx]) void selectProvider(topProviders[idx][0]);
        },
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              title: function (items) {
                var i = items[0] && items[0].dataIndex;
                return topProviders[i] ? topProviders[i][0] : "";
              },
            },
          },
        },
        scales: {
          x: {
            beginAtZero: true,
            ticks: { precision: 0 },
            grid: { color: "#2a2a2a" },
          },
          y: hBarCategoryAxis(),
        },
      },
    });

    var catRows = topEntries(byCategory, 12);
    makeChart($("categoryChart"), {
      type: "doughnut",
      data: {
        labels: catRows.map(function (r) {
          return r[0];
        }),
        datasets: [
          {
            data: catRows.map(function (r) {
              return r[1];
            }),
            backgroundColor: catRows.map(function (_, i) {
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
        plugins: {
          legend: {
            position: "bottom",
            labels: { boxWidth: 12, padding: 10, font: { size: 11 } },
          },
        },
      },
    });

    return byProvider.size;
  }

  function renderOpenCharts(clickRows, urlToProvider) {
    var top = clickRows.slice(0, 15);
    makeChart($("topOpensChart"), {
      type: "bar",
      data: {
        labels: top.map(function (r) {
          try {
            var u = new URL(r.url);
            return shortLabel(u.hostname.replace(/^www\./, "") + u.pathname, 32);
          } catch (_) {
            return shortLabel(r.url, 32);
          }
        }),
        datasets: [
          {
            label: "Opens",
            data: top.map(function (r) {
              return r.count;
            }),
            backgroundColor: CHART_COLORS[1],
            borderWidth: 0,
            borderRadius: 4,
          },
        ],
      },
      options: {
        indexAxis: "y",
        responsive: true,
        maintainAspectRatio: false,
        onClick: function (_evt, elements) {
          if (!elements || !elements.length) return;
          var idx = elements[0].index;
          var row = top[idx];
          if (!row) return;
          var prov = urlToProvider.get(normalizeUrlKey(row.url));
          if (prov) void selectProvider(prov);
        },
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              title: function (items) {
                var i = items[0] && items[0].dataIndex;
                return top[i] ? top[i].url : "";
              },
            },
          },
        },
        scales: {
          x: {
            beginAtZero: true,
            ticks: { precision: 0 },
            grid: { color: "#2a2a2a" },
          },
          y: hBarCategoryAxis(),
        },
      },
    });

    var byProv = new Map();
    clickRows.forEach(function (row) {
      var norm = normalizeUrlKey(row.url);
      var provider = urlToProvider.get(norm) || "Other / unmatched";
      byProv.set(provider, (byProv.get(provider) || 0) + row.count);
    });
    var topProvOpens = topEntries(byProv, 12);

    makeChart($("opensByProviderChart"), {
      type: "bar",
      data: {
        labels: topProvOpens.map(function (r) {
          return shortLabel(stripProviderEmoji(r[0]), 28);
        }),
        datasets: [
          {
            label: "Opens",
            data: topProvOpens.map(function (r) {
              return r[1];
            }),
            backgroundColor: CHART_COLORS[2],
            borderWidth: 0,
            borderRadius: 4,
          },
        ],
      },
      options: {
        indexAxis: "y",
        responsive: true,
        maintainAspectRatio: false,
        onClick: function (_evt, elements) {
          if (!elements || !elements.length) return;
          var idx = elements[0].index;
          var row = topProvOpens[idx];
          if (row && row[0] !== "Other / unmatched") void selectProvider(row[0]);
        },
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              title: function (items) {
                var i = items[0] && items[0].dataIndex;
                return topProvOpens[i] ? topProvOpens[i][0] : "";
              },
            },
          },
        },
        scales: {
          x: {
            beginAtZero: true,
            ticks: { precision: 0 },
            grid: { color: "#2a2a2a" },
          },
          y: hBarCategoryAxis(),
        },
      },
    });
  }

  function setFilterTableSelection(key) {
    var body = $("filterTableBody");
    if (!body) return;
    body.querySelectorAll("tr[data-filter]").forEach(function (tr) {
      if (tr.getAttribute("data-filter") === key) tr.classList.add("is-selected");
      else tr.classList.remove("is-selected");
    });
  }

  function selectFilter(nameOrKey) {
    var stats = state.filterStats;
    if (!stats || !Array.isArray(stats.filters)) return;
    var want = String(nameOrKey || "").trim().toLowerCase();
    var row =
      stats.filters.find(function (f) {
        return String(f.key || "").toLowerCase() === want || String(f.name || "").toLowerCase() === want;
      }) || null;
    if (!row) return;
    state.selectedFilter = row.key || row.name;
    setFilterTableSelection(row.key);
    renderFilterDetail(row, stats.block_reasons || []);
  }

  function renderFilterDetail(filterRow, allReasons) {
    destroyChartList(filterDetailCharts);
    var card = $("filterDetailCard");
    if (card) card.hidden = false;
    setText("filterDetailTitle", filterRow.name || "Filter");
    setText(
      "filterDetailHint",
      "Blocked / unblocked / warning among sorted links that include a result from this filter."
    );
    setText("filterDetailBlocked", formatInt(filterRow.blocked || 0));
    setText("filterDetailUnblocked", formatInt(filterRow.unblocked || 0));
    setText("filterDetailWarning", formatInt(filterRow.warning || 0));
    setText("filterDetailTotal", formatInt(filterRow.total || 0));

    var filterName = filterRow.name;
    var reasonRows = [];
    (allReasons || []).forEach(function (r) {
      var match = (r.by_filter || []).find(function (bf) {
        return String(bf.name || "") === filterName;
      });
      if (match && Number(match.count) > 0) {
        reasonRows.push({ reason: r.reason || "Uncategorized", count: Number(match.count) || 0 });
      }
    });
    reasonRows.sort(function (a, b) {
      return b.count - a.count || a.reason.localeCompare(b.reason);
    });

    var tbody = $("filterReasonTableBody");
    if (tbody) {
      if (!reasonRows.length) {
        tbody.innerHTML = '<tr><td class="muted" colspan="2">No block reasons for this filter.</td></tr>';
      } else {
        tbody.innerHTML = reasonRows
          .map(function (r) {
            return (
              "<tr><td>" +
              escapeHtml(r.reason) +
              '</td><td class="num">' +
              formatInt(r.count) +
              "</td></tr>"
            );
          })
          .join("");
      }
    }

    var top = reasonRows.slice(0, 15);
    makeChart(
      $("filterReasonChart"),
      {
        type: "bar",
        data: {
          labels: top.map(function (r) {
            return shortLabel(r.reason, 28);
          }),
          datasets: [
            {
              label: "Blocked",
              data: top.map(function (r) {
                return r.count;
              }),
              backgroundColor: "#ff8f8f",
            },
          ],
        },
        options: {
          indexAxis: "y",
          responsive: true,
          maintainAspectRatio: false,
          plugins: { legend: { display: false } },
          scales: {
            x: { beginAtZero: true },
            y: hBarCategoryAxis(),
          },
        },
      },
      filterDetailCharts
    );
  }

  function formatFilterNameList(names, limit) {
    var rows = (Array.isArray(names) ? names.slice() : []).filter(Boolean);
    rows.sort(function (a, b) {
      return String(a).localeCompare(String(b));
    });
    var top = rows.slice(0, limit || 3);
    if (!top.length) return '<span class="muted">—</span>';
    var html = top
      .map(function (name) {
        return "<strong>" + escapeHtml(name) + "</strong>";
      })
      .join(", ");
    var extra = rows.length - top.length;
    if (extra > 0) {
      var allLabel = rows.join(", ");
      html +=
        ' <span class="muted filter-more" title="' +
        escapeHtml(allLabel) +
        '" tabindex="0" aria-label="All filters: ' +
        escapeHtml(allLabel) +
        '">+' +
        formatInt(extra) +
        " more</span>";
    }
    return '<span class="filter-tags">' + html + "</span>";
  }

  function formatFilterOrigins(byFilter, limit) {
    var rows = Array.isArray(byFilter) ? byFilter.slice() : [];
    rows.sort(function (a, b) {
      return (Number(b.count) || 0) - (Number(a.count) || 0) || String(a.name || "").localeCompare(String(b.name || ""));
    });
    var top = rows.slice(0, limit || 4);
    if (!top.length) return '<span class="muted">—</span>';
    var html = top
      .map(function (f) {
        return (
          "<strong>" +
          escapeHtml(f.name || "Unknown") +
          "</strong> (" +
          formatInt(f.count || 0) +
          ")"
        );
      })
      .join(", ");
    var extra = rows.length - top.length;
    if (extra > 0) {
      var allLabel = rows
        .map(function (f) {
          return (f.name || "Unknown") + " (" + formatInt(f.count || 0) + ")";
        })
        .join(", ");
      html +=
        ' <span class="muted filter-more" title="' +
        escapeHtml(allLabel) +
        '" tabindex="0" aria-label="All filters: ' +
        escapeHtml(allLabel) +
        '">+' +
        formatInt(extra) +
        " more</span>";
    }
    return '<span class="filter-tags">' + html + "</span>";
  }

  function domainOfLink(link) {
    try {
      var u = new URL(String(link || "").trim());
      return String(u.hostname || "").toLowerCase().replace(/^www\./, "");
    } catch (_) {
      return "";
    }
  }

  function renderDomainStats(links) {
    var counts = new Map();
    (links || []).forEach(function (row) {
      var d = domainOfLink(row && row.link);
      if (!d) return;
      counts.set(d, (counts.get(d) || 0) + 1);
    });
    var ranked = Array.from(counts.entries())
      .map(function (e) {
        return { domain: e[0], count: e[1] };
      })
      .sort(function (a, b) {
        return b.count - a.count || a.domain.localeCompare(b.domain);
      });
    var totalLinks = (links || []).length || 1;
    setText("statUniqueDomains", formatInt(ranked.length));
    setText("statTopDomain", ranked.length ? formatInt(ranked[0].count) : "—");
    var hint = $("domainsHint");
    if (hint) {
      hint.textContent = ranked.length
        ? "Top domain: " +
          ranked[0].domain +
          " (" +
          formatInt(ranked[0].count) +
          " links). " +
          formatInt(ranked.length) +
          " unique hostnames on the sorted list."
        : "No domains found on the sorted list.";
    }

    var top = ranked.slice(0, 15);
    makeChart($("domainsChart"), {
      type: "bar",
      data: {
        labels: top.map(function (r) {
          return shortLabel(r.domain, 28);
        }),
        datasets: [
          {
            label: "Links",
            data: top.map(function (r) {
              return r.count;
            }),
            backgroundColor: "#7dd3fc",
            borderWidth: 0,
            borderRadius: 4,
          },
        ],
      },
      options: {
        indexAxis: "y",
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          x: { beginAtZero: true, ticks: { precision: 0 }, grid: { color: "#2a2a2a" } },
          y: hBarCategoryAxis(),
        },
      },
    });

    var body = $("domainsTableBody");
    if (!body) return;
    if (!ranked.length) {
      body.innerHTML = '<tr><td class="muted" colspan="4">No domains found.</td></tr>';
      return;
    }
    body.innerHTML = ranked
      .slice(0, 50)
      .map(function (r, i) {
        var share = ((r.count / totalLinks) * 100).toFixed(1) + "%";
        return (
          '<tr><td class="num">' +
          (i + 1) +
          "</td><td><code>" +
          escapeHtml(r.domain) +
          '</code></td><td class="num">' +
          formatInt(r.count) +
          '</td><td class="num">' +
          share +
          "</td></tr>"
        );
      })
      .join("");
  }

  function renderFilterStats(payload) {
    state.filterStats = payload || null;
    destroyChartList(filterDetailCharts);
    var filters = Array.isArray(payload && payload.filters) ? payload.filters.slice() : [];
    var reasons = Array.isArray(payload && payload.block_reasons) ? payload.block_reasons : [];

    setText("statFilters", formatInt(payload && payload.filter_count != null ? payload.filter_count : filters.length));
    setText(
      "statFilterChecked",
      formatInt(payload && payload.links_with_filter_data != null ? payload.links_with_filter_data : "—")
    );

    var hint = $("filterStatsHint");
    if (hint && payload) {
      var generated = payload.generated_at ? " Updated " + payload.generated_at + "." : "";
      hint.textContent =
        "Per-filter blocked / unblocked / warning counts across " +
        formatInt(payload.links_with_filter_data || 0) +
        " sorted links with gn-math data (" +
        formatInt(payload.links_without_filter_data || 0) +
        " unchecked)." +
        generated +
        " Click a filter for its top block reasons.";
    }

    var sortedFilters = filters.slice().sort(function (a, b) {
      return (Number(b.blocked) || 0) - (Number(a.blocked) || 0) || String(a.name).localeCompare(String(b.name));
    });

    makeChart($("filterStatusChart"), {
      type: "bar",
      data: {
        labels: sortedFilters.map(function (f) {
          return shortLabel(f.name, 22);
        }),
        datasets: [
          {
            label: "Blocked",
            data: sortedFilters.map(function (f) {
              return Number(f.blocked) || 0;
            }),
            backgroundColor: "#ff8f8f",
          },
          {
            label: "Unblocked",
            data: sortedFilters.map(function (f) {
              return Number(f.unblocked) || 0;
            }),
            backgroundColor: "#3ecf8e",
          },
          {
            label: "Warning",
            data: sortedFilters.map(function (f) {
              return Number(f.warning) || 0;
            }),
            backgroundColor: "#ffd57e",
          },
        ],
      },
      options: {
        indexAxis: "y",
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { position: "bottom" },
        },
        scales: {
          x: { stacked: true, beginAtZero: true },
          y: hBarCategoryAxis({ stacked: true }),
        },
        onClick: function (_evt, elements) {
          if (!elements || !elements.length) return;
          var idx = elements[0].index;
          var row = sortedFilters[idx];
          if (row) selectFilter(row.key || row.name);
        },
      },
    });

    var filterBody = $("filterTableBody");
    if (filterBody) {
      if (!sortedFilters.length) {
        filterBody.innerHTML = '<tr><td class="muted" colspan="5">No filter stats yet.</td></tr>';
      } else {
        filterBody.innerHTML = sortedFilters
          .map(function (f) {
            return (
              '<tr data-filter="' +
              escapeHtml(f.key || f.name) +
              '"><td>' +
              escapeHtml(f.name) +
              '</td><td class="num"><span class="pill pill-blocked">' +
              formatInt(f.blocked || 0) +
              '</span></td><td class="num"><span class="pill pill-unblocked">' +
              formatInt(f.unblocked || 0) +
              '</span></td><td class="num"><span class="pill pill-warning">' +
              formatInt(f.warning || 0) +
              '</span></td><td class="num">' +
              formatInt(f.total || 0) +
              "</td></tr>"
            );
          })
          .join("");
        filterBody.querySelectorAll("tr[data-filter]").forEach(function (tr) {
          tr.addEventListener("click", function () {
            selectFilter(tr.getAttribute("data-filter"));
          });
        });
      }
    }

    var topReasons = reasons.slice(0, 20);
    makeChart($("blockReasonsChart"), {
      type: "bar",
      data: {
        labels: topReasons.map(function (r) {
          return shortLabel(r.reason || "Uncategorized", 28);
        }),
        datasets: [
          {
            label: "Blocked",
            data: topReasons.map(function (r) {
              return Number(r.count) || 0;
            }),
            backgroundColor: "#ff9b9b",
          },
        ],
      },
      options: {
        indexAxis: "y",
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          x: { beginAtZero: true },
          y: hBarCategoryAxis(),
        },
      },
    });

    var reasonBody = $("blockReasonsTableBody");
    if (reasonBody) {
      if (!reasons.length) {
        reasonBody.innerHTML = '<tr><td class="muted" colspan="4">No block reasons yet.</td></tr>';
      } else {
        reasonBody.innerHTML = reasons
          .slice(0, 80)
          .map(function (r, i) {
            return (
              '<tr><td class="num">' +
              (i + 1) +
              "</td><td>" +
              escapeHtml(r.reason || "Uncategorized") +
              "</td><td>" +
              formatFilterOrigins(r.by_filter, 4) +
              '</td><td class="num">' +
              formatInt(r.count || 0) +
              "</td></tr>"
            );
          })
          .join("");
      }
    }

    var blockedDomains = Array.isArray(payload && payload.blocked_domains) ? payload.blocked_domains : [];
    var topBlockedDomains = blockedDomains.slice(0, 15);
    makeChart($("blockedDomainsChart"), {
      type: "bar",
      data: {
        labels: topBlockedDomains.map(function (d) {
          return shortLabel(d.domain, 28);
        }),
        datasets: [
          {
            label: "Blocked matches",
            data: topBlockedDomains.map(function (d) {
              return Number(d.blocked) || 0;
            }),
            backgroundColor: "#ff8f8f",
          },
        ],
      },
      options: {
        indexAxis: "y",
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              title: function (items) {
                var i = items[0] && items[0].dataIndex;
                return topBlockedDomains[i] ? topBlockedDomains[i].domain : "";
              },
              afterBody: function (items) {
                var i = items[0] && items[0].dataIndex;
                var row = topBlockedDomains[i];
                if (!row) return "";
                return [
                  "Links: " + formatInt(row.links || 0),
                  "Filters blocking: " + formatInt(row.filters_blocking || 0),
                ];
              },
            },
          },
        },
        scales: {
          x: { beginAtZero: true, ticks: { precision: 0 } },
          y: hBarCategoryAxis(),
        },
      },
    });

    var blockedHint = $("blockedDomainsHint");
    if (blockedHint && blockedDomains.length) {
      blockedHint.textContent =
        "Top domain: " +
        blockedDomains[0].domain +
        " (" +
        formatInt(blockedDomains[0].blocked || 0) +
        " blocked matches across " +
        formatInt(blockedDomains[0].filters_blocking || 0) +
        " filters). Showing top " +
        Math.min(50, blockedDomains.length) +
        ".";
    }

    var blockedBody = $("blockedDomainsTableBody");
    if (blockedBody) {
      if (!blockedDomains.length) {
        blockedBody.innerHTML = '<tr><td class="muted" colspan="5">No blocked-domain data yet.</td></tr>';
      } else {
        blockedBody.innerHTML = blockedDomains
          .slice(0, 50)
          .map(function (d, i) {
            var filterHtml = formatFilterNameList(d.blocking_filters || [], 3);
            return (
              '<tr><td class="num">' +
              (i + 1) +
              '</td><td><code>' +
              escapeHtml(d.domain || "") +
              '</code></td><td class="num"><span class="pill pill-blocked">' +
              formatInt(d.blocked || 0) +
              '</span></td><td class="num">' +
              formatInt(d.filters_blocking || 0) +
              "</td><td>" +
              filterHtml +
              "</td></tr>"
            );
          })
          .join("");
      }
    }

    if (state.selectedFilter) selectFilter(state.selectedFilter);
  }

  function renderContributors(payload) {
    var contribs = (payload && payload.contributors) || {};
    var rows = Object.keys(contribs)
      .map(function (name) {
        var c = contribs[name] || {};
        return [name, Number(c.links_total) || 0];
      })
      .filter(function (r) {
        return r[1] > 0;
      })
      .sort(function (a, b) {
        return b[1] - a[1] || a[0].localeCompare(b[0]);
      })
      .slice(0, 10);

    makeChart($("contributorsChart"), {
      type: "bar",
      data: {
        labels: rows.map(function (r) {
          return shortLabel(r[0], 24);
        }),
        datasets: [
          {
            label: "Links",
            data: rows.map(function (r) {
              return r[1];
            }),
            backgroundColor: CHART_COLORS[4],
            borderWidth: 0,
            borderRadius: 4,
          },
        ],
      },
      options: {
        indexAxis: "y",
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          x: {
            beginAtZero: true,
            ticks: { precision: 0 },
            grid: { color: "#2a2a2a" },
          },
          y: hBarCategoryAxis(),
        },
      },
    });
  }

  function updateSuggest(query) {
    var box = $("providerSuggest");
    if (!box) return;
    var q = String(query || "").trim().toLowerCase();
    if (!q) {
      box.hidden = true;
      box.innerHTML = "";
      return;
    }
    var matches = state.providers
      .filter(function (p) {
        return p.name.toLowerCase().includes(q) || stripProviderEmoji(p.name).toLowerCase().includes(q);
      })
      .slice(0, 12);
    if (!matches.length) {
      box.hidden = false;
      box.innerHTML = '<li class="muted" style="padding:0.55rem 0.7rem;">No providers match.</li>';
      return;
    }
    box.hidden = false;
    box.innerHTML = matches
      .map(function (p) {
        return (
          "<li><button type=\"button\" role=\"option\" data-pick-provider=\"" +
          escapeHtml(p.name) +
          "\">" +
          escapeHtml(p.name) +
          ' <span class="muted">(' +
          formatInt(p.count) +
          ")</span></button></li>"
        );
      })
      .join("");
  }

  async function loadDailyClickDocs(db) {
    if (state.dailyCache) return state.dailyCache;
    var days = utcDayIds(DAILY_LOOKBACK_DAYS);
    var snaps = await Promise.all(
      days.map(function (day) {
        return db.collection("click_daily").doc(day).get();
      })
    );
    state.dailyCache = snaps.map(function (snap, i) {
      var counts = {};
      if (snap.exists) {
        var data = snap.data() || {};
        counts = data.counts && typeof data.counts === "object" ? data.counts : {};
      }
      return { date: days[i], counts: counts };
    });
    return state.dailyCache;
  }

  async function lifetimeOpensForHashes(db, hashes) {
    if (!db || !hashes.length) return 0;
    var total = 0;
    for (var i = 0; i < hashes.length; i += 40) {
      var chunk = hashes.slice(i, i + 40);
      var snaps = await Promise.all(
        chunk.map(function (h) {
          return db.collection("link_clicks").doc(h).get();
        })
      );
      snaps.forEach(function (snap) {
        if (!snap.exists) return;
        var n = Number((snap.data() || {}).count);
        if (Number.isFinite(n)) total += n;
      });
    }
    return total;
  }

  async function selectProvider(name) {
    var provider = state.providers.find(function (p) {
      return p.name === name;
    });
    if (!provider) return;

    state.selectedProvider = name;
    var clearBtn = $("providerClearBtn");
    if (clearBtn) clearBtn.hidden = false;
    var search = $("providerSearch");
    if (search) search.value = name;
    var suggest = $("providerSuggest");
    if (suggest) {
      suggest.hidden = true;
      suggest.innerHTML = "";
    }

    document.querySelectorAll("tr[data-provider]").forEach(function (tr) {
      tr.classList.toggle("is-selected", tr.getAttribute("data-provider") === name);
    });

    var card = $("providerDetailCard");
    if (card) card.hidden = false;
    setText("providerDetailTitle", name);
    setText(
      "providerDetailHint",
      "Showing " +
        formatInt(provider.count) +
        " sorted links. Link growth uses Found dates; opens use daily click totals."
    );

    var series = linksOverTimeSeries(provider.links);
    setText("detailLinks", formatInt(provider.count));
    setText(
      "detailFirstFound",
      series.earliest ? formatShortDate(series.earliest) : "—"
    );
    var cats = new Set(
      provider.links.map(function (r) {
        return String(r.category || "").trim() || "Uncategorized";
      })
    );
    setText("detailCategories", formatInt(cats.size));

    destroyChartList(detailCharts);
    makeChart(
      $("providerLinksOverTimeChart"),
      {
        type: "line",
        data: {
          labels: series.labels.length ? series.labels : ["No dated links"],
          datasets: [
            {
              label: "Cumulative links",
              data: series.values.length ? series.values : [0],
              borderColor: CHART_COLORS[0],
              backgroundColor: "rgba(108, 179, 255, 0.15)",
              fill: true,
              tension: 0.2,
              pointRadius: series.labels.length > 40 ? 0 : 2,
            },
          ],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: { legend: { display: false } },
          scales: {
            x: {
              ticks: {
                maxRotation: 0,
                autoSkip: true,
                maxTicksLimit: 8,
              },
              grid: { color: "#2a2a2a" },
            },
            y: {
              beginAtZero: true,
              ticks: { precision: 0 },
              grid: { color: "#2a2a2a" },
            },
          },
        },
      },
      detailCharts
    );

    var hashes = [];
    for (var i = 0; i < provider.links.length; i++) {
      var norm = normalizeUrlForHash(provider.links[i].link);
      if (!norm) continue;
      hashes.push(await sha256Hex(norm));
    }
    var hashSet = new Set(hashes);

    var opensTotal = 0;
    var openLabels = [];
    var openValues = [];
    if (state.db) {
      try {
        opensTotal = await lifetimeOpensForHashes(state.db, hashes);
        var daily = await loadDailyClickDocs(state.db);
        daily.forEach(function (day) {
          var sum = 0;
          Object.keys(day.counts || {}).forEach(function (h) {
            if (!hashSet.has(h)) return;
            var n = Number(day.counts[h]);
            if (Number.isFinite(n)) sum += n;
          });
          openLabels.push(day.date.slice(5));
          openValues.push(sum);
        });
      } catch (err) {
        console.warn("[stats] provider opens failed", err);
      }
    }
    setText("detailOpens", state.db ? formatInt(opensTotal) : "—");

    var hasDaily = openValues.some(function (v) {
      return v > 0;
    });
    makeChart(
      $("providerOpensOverTimeChart"),
      {
        type: "line",
        data: {
          labels: openLabels.length ? openLabels : ["—"],
          datasets: [
            {
              label: "Daily opens",
              data: openValues.length ? openValues : [0],
              borderColor: CHART_COLORS[1],
              backgroundColor: "rgba(62, 207, 142, 0.15)",
              fill: true,
              tension: 0.2,
              pointRadius: 0,
            },
          ],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: { display: false },
            subtitle: hasDaily
              ? undefined
              : {
                  display: true,
                  text: "No daily open data yet for this provider",
                  color: "#9a9a9a",
                },
          },
          scales: {
            x: {
              ticks: { maxTicksLimit: 10, maxRotation: 0 },
              grid: { color: "#2a2a2a" },
            },
            y: {
              beginAtZero: true,
              ticks: { precision: 0 },
              grid: { color: "#2a2a2a" },
            },
          },
        },
      },
      detailCharts
    );

    try {
      card.scrollIntoView({ behavior: "smooth", block: "start" });
    } catch (_) {}
  }

  function clearProvider() {
    state.selectedProvider = "";
    var card = $("providerDetailCard");
    if (card) card.hidden = true;
    var clearBtn = $("providerClearBtn");
    if (clearBtn) clearBtn.hidden = true;
    var search = $("providerSearch");
    if (search) search.value = "";
    var suggest = $("providerSuggest");
    if (suggest) {
      suggest.hidden = true;
      suggest.innerHTML = "";
    }
    document.querySelectorAll("tr[data-provider]").forEach(function (tr) {
      tr.classList.remove("is-selected");
    });
    destroyChartList(detailCharts);
  }

  function wireProviderUi() {
    var search = $("providerSearch");
    if (search) {
      search.addEventListener("input", function () {
        updateSuggest(search.value);
      });
      search.addEventListener("keydown", function (ev) {
        if (ev.key === "Escape") {
          var box = $("providerSuggest");
          if (box) box.hidden = true;
        }
      });
    }
    var clearBtn = $("providerClearBtn");
    if (clearBtn) clearBtn.addEventListener("click", clearProvider);

    document.addEventListener("click", function (ev) {
      var t = ev.target;
      if (!t || !t.closest) return;
      var pick = t.closest("[data-pick-provider]");
      if (pick) {
        ev.preventDefault();
        void selectProvider(pick.getAttribute("data-pick-provider"));
        return;
      }
      var row = t.closest("tr[data-provider]");
      if (row) {
        void selectProvider(row.getAttribute("data-provider"));
        return;
      }
      var suggest = $("providerSuggest");
      var searchEl = $("providerSearch");
      if (
        suggest &&
        !suggest.hidden &&
        searchEl &&
        !suggest.contains(t) &&
        t !== searchEl
      ) {
        suggest.hidden = true;
      }
    });
  }

  function loadExternalScript(src) {
    return new Promise(function (resolve, reject) {
      var s = document.createElement("script");
      s.src = src;
      s.onload = function () {
        resolve();
      };
      s.onerror = function () {
        reject(new Error("Could not load " + src));
      };
      document.head.appendChild(s);
    });
  }

  var firebaseSdkPromise = null;
  var FIREBASE_COMPAT_BASE = "https://www.gstatic.com/firebasejs/10.7.1/";

  function ensureFirebaseSdk() {
    if (typeof firebase !== "undefined") return Promise.resolve(true);
    if (firebaseSdkPromise) return firebaseSdkPromise;
    firebaseSdkPromise = ["firebase-app-compat.js", "firebase-auth-compat.js", "firebase-firestore-compat.js"]
      .reduce(function (chain, file) {
        return chain.then(function () {
          return loadExternalScript(FIREBASE_COMPAT_BASE + file);
        });
      }, Promise.resolve())
      .then(function () {
        return typeof firebase !== "undefined";
      })
      .catch(function (err) {
        console.warn("[stats] Firebase SDK did not load", err);
        firebaseSdkPromise = null;
        return false;
      });
    return firebaseSdkPromise;
  }

  function fetchDocsAsset(name) {
    if (window.ProxyListData && typeof ProxyListData.fetchJsonAsset === "function") {
      return ProxyListData.fetchJsonAsset(name, { fetchInit: { cache: "no-cache" }, timeoutMs: 20000 });
    }
    return fetch("../" + name, { cache: "no-cache" }).then(function (res) {
      if (!res.ok) throw new Error(name + " HTTP " + res.status);
      return res.json();
    });
  }

  async function resolveExpandedLinksAsync(json, normalized) {
    if (normalized && normalized.compact && typeof ProxyListData.expandAllLinksAsync === "function") {
      return ProxyListData.expandAllLinksAsync({
        format: 2,
        providers: normalized.compact.providers,
        contributors: normalized.compact.contributors,
        links: normalized.compact.links,
      });
    }
    return ProxyListData.resolveExpandedLinks(normalized && normalized.compact ? normalized : json);
  }

  function initFirebase() {
    try {
      var cfg = window.__FIREBASE_CONFIG__;
      if (!cfg || !cfg.apiKey || typeof firebase === "undefined") return null;
      if (!firebase.apps.length) firebase.initializeApp(cfg);
      return firebase.firestore();
    } catch (_) {
      return null;
    }
  }

  async function ensureAuth(db) {
    if (!db || typeof firebase === "undefined") return;
    var auth = firebase.auth();
    if (window.ProxyListAuth && typeof window.ProxyListAuth.ensureAnonymous === "function") {
      try {
        await window.ProxyListAuth.ensureAnonymous(auth);
      } catch (_) {}
      return;
    }
    if (typeof auth.authStateReady === "function") {
      await auth.authStateReady();
    }
    if (!auth.currentUser) {
      try {
        await auth.signInAnonymously();
      } catch (_) {}
    }
  }

  async function fetchTopClicks(db, limit) {
    if (!db) return [];
    var snap = await db.collection("link_clicks").orderBy("count", "desc").limit(limit).get();
    return snap.docs
      .map(function (doc) {
        var d = doc.data() || {};
        var url = d.url != null ? String(d.url).trim() : "";
        var count = Number(d.count);
        return { url: url, count: Number.isFinite(count) ? count : 0 };
      })
      .filter(function (x) {
        return x.url && x.count > 0;
      });
  }

  function utcMonthIds(lookback) {
    var out = [];
    var now = new Date();
    for (var i = lookback - 1; i >= 0; i--) {
      var d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
      out.push(d.toISOString().slice(0, 7));
    }
    return out;
  }

  function emptySubtitle(text) {
    return {
      display: true,
      text: text,
      color: "#9a9a9a",
      font: { size: 12 },
    };
  }

  async function loadPresenceDaily(db) {
    if (state.presenceDaily) return state.presenceDaily;
    var days = utcDayIds(PRESENCE_DAILY_LOOKBACK);
    var snaps = await Promise.all(
      days.map(function (day) {
        return db.collection("presence_daily").doc(day).get();
      })
    );
    state.presenceDaily = snaps.map(function (snap, i) {
      var data = snap.exists ? snap.data() || {} : {};
      return {
        date: days[i],
        uniqueVisitors: Number(data.uniqueVisitors) || 0,
        heartbeats: Number(data.heartbeats) || 0,
        signedInUniques: Number(data.signedInUniques) || 0,
        hourHeartbeats: data.hourHeartbeats && typeof data.hourHeartbeats === "object" ? data.hourHeartbeats : {},
        hourUniques: data.hourUniques && typeof data.hourUniques === "object" ? data.hourUniques : {},
      };
    });
    return state.presenceDaily;
  }

  async function loadPresenceMonthly(db) {
    if (state.presenceMonthly) return state.presenceMonthly;
    var months = utcMonthIds(PRESENCE_MONTHLY_LOOKBACK);
    var snaps = await Promise.all(
      months.map(function (month) {
        return db.collection("presence_monthly").doc(month).get();
      })
    );
    state.presenceMonthly = snaps.map(function (snap, i) {
      var data = snap.exists ? snap.data() || {} : {};
      return {
        month: months[i],
        uniqueVisitors: Number(data.uniqueVisitors) || 0,
        heartbeats: Number(data.heartbeats) || 0,
      };
    });
    return state.presenceMonthly;
  }

  function presenceSpanSeries(daily, span) {
    var now = new Date();
    if (span === "24h") {
      var labels = [];
      var values = [];
      for (var h = 23; h >= 0; h--) {
        var dt = new Date(now.getTime() - h * 3600 * 1000);
        var day = dt.toISOString().slice(0, 10);
        var hour = String(dt.getUTCHours()).padStart(2, "0");
        var row = daily.find(function (d) {
          return d.date === day;
        });
        var n = 0;
        if (row) {
          n = Number(row.hourUniques[hour] != null ? row.hourUniques[hour] : row.hourUniques[String(Number(hour))]) || 0;
        }
        labels.push(hour + ":00");
        values.push(n);
      }
      return { labels: labels, values: values, yLabel: "Unique visitors / hour" };
    }

    var days =
      span === "7d" ? 7 : span === "1m" ? 30 : span === "6m" ? 180 : 365;
    var slice = daily.slice(Math.max(0, daily.length - days));
    return {
      labels: slice.map(function (d) {
        return d.date.slice(5);
      }),
      values: slice.map(function (d) {
        return d.uniqueVisitors;
      }),
      yLabel: "Unique visitors / day",
    };
  }

  function averageHourActivity(daily, lookbackDays) {
    var slice = daily.slice(Math.max(0, daily.length - lookbackDays));
    var sums = [];
    var counts = [];
    var i;
    for (i = 0; i < 24; i++) {
      sums[i] = 0;
      counts[i] = 0;
    }
    slice.forEach(function (day) {
      var has = false;
      for (i = 0; i < 24; i++) {
        var key = String(i).padStart(2, "0");
        var uniq = Number(day.hourUniques[key] != null ? day.hourUniques[key] : day.hourUniques[String(i)]) || 0;
        var beats = Number(day.hourHeartbeats[key] != null ? day.hourHeartbeats[key] : day.hourHeartbeats[String(i)]) || 0;
        var v = uniq > 0 ? uniq : beats > 0 ? beats : 0;
        if (v > 0) {
          sums[i] += v;
          counts[i] += 1;
          has = true;
        }
      }
      if (!has && day.uniqueVisitors > 0) {
        /* day exists but no hour breakdown yet */
      }
    });
    var labels = [];
    var values = [];
    var peakHour = "—";
    var peakVal = -1;
    for (i = 0; i < 24; i++) {
      var label = String(i).padStart(2, "0") + ":00";
      var avg = counts[i] ? sums[i] / counts[i] : 0;
      labels.push(label);
      values.push(Math.round(avg * 10) / 10);
      if (avg > peakVal) {
        peakVal = avg;
        peakHour = label + " UTC";
      }
    }
    return { labels: labels, values: values, peakHour: peakVal > 0 ? peakHour : "—" };
  }

  function renderUsersOverTimeChart() {
    var series = presenceSpanSeries(state.presenceDaily || [], state.usersSpan);
    var hasData = series.values.some(function (v) {
      return v > 0;
    });
    makeChart(
      $("usersActiveOverTimeChart"),
      {
        type: "line",
        data: {
          labels: series.labels.length ? series.labels : ["No data"],
          datasets: [
            {
              label: series.yLabel,
              data: series.values.length ? series.values : [0],
              borderColor: CHART_COLORS[0],
              backgroundColor: "rgba(108, 179, 255, 0.15)",
              fill: true,
              tension: 0.25,
              pointRadius: state.usersSpan === "24h" || state.usersSpan === "7d" ? 2 : 0,
            },
          ],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: { display: false },
            subtitle: hasData ? undefined : emptySubtitle("No presence data yet — visit the main list to start collecting."),
          },
          scales: {
            x: { ticks: { maxRotation: 0, autoSkip: true, maxTicksLimit: 12 } },
            y: { beginAtZero: true, ticks: { precision: 0 } },
          },
        },
      },
      userCharts
    );
  }

  function renderUserStatsCharts() {
    destroyChartList(userCharts);
    renderUsersOverTimeChart();

    var hours = averageHourActivity(state.presenceDaily || [], 30);
    setText("statUsersPeakHour", hours.peakHour);
    var hoursHave = hours.values.some(function (v) {
      return v > 0;
    });
    makeChart(
      $("usersActiveHoursChart"),
      {
        type: "bar",
        data: {
          labels: hours.labels,
          datasets: [
            {
              label: "Avg activity",
              data: hours.values,
              backgroundColor: CHART_COLORS[1],
              borderRadius: 4,
            },
          ],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: { display: false },
            subtitle: hoursHave ? undefined : emptySubtitle("Hourly activity appears after presence pings accumulate."),
          },
          scales: {
            x: { ticks: { maxRotation: 0, autoSkip: true, maxTicksLimit: 12 } },
            y: { beginAtZero: true },
          },
        },
      },
      userCharts
    );

    var monthly = state.presenceMonthly || [];
    var mLabels = monthly.map(function (m) {
      return m.month;
    });
    var mValues = monthly.map(function (m) {
      return m.uniqueVisitors;
    });
    var mHave = mValues.some(function (v) {
      return v > 0;
    });
    makeChart(
      $("usersMonthlyChart"),
      {
        type: "bar",
        data: {
          labels: mLabels.length ? mLabels : ["No data"],
          datasets: [
            {
              label: "Monthly unique visitors",
              data: mValues.length ? mValues : [0],
              backgroundColor: CHART_COLORS[4],
              borderRadius: 4,
            },
          ],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: { display: false },
            subtitle: mHave ? undefined : emptySubtitle("Monthly uniques fill in as visitors return across days."),
          },
          scales: {
            y: { beginAtZero: true, ticks: { precision: 0 } },
          },
        },
      },
      userCharts
    );
  }

  function updateUsersKpis() {
    var daily = state.presenceDaily || [];
    var today = daily.length ? daily[daily.length - 1] : null;
    setText("statUsersToday", today ? formatInt(today.uniqueVisitors) : "—");
    var last7 = daily.slice(-7);
    var sum7 = last7.reduce(function (s, d) {
      return s + d.uniqueVisitors;
    }, 0);
    var avg7 = last7.length ? Math.round((sum7 / last7.length) * 10) / 10 : 0;
    setText("statUsers7d", last7.some(function (d) { return d.uniqueVisitors > 0; }) ? formatInt(avg7) : "—");
    var monthly = state.presenceMonthly || [];
    var thisMonth = monthly.length ? monthly[monthly.length - 1] : null;
    setText("statUsersMonth", thisMonth && thisMonth.uniqueVisitors ? formatInt(thisMonth.uniqueVisitors) : "—");
  }

  function wireUsersRangeToggle() {
    var root = $("usersRangeToggle");
    if (!root || root.getAttribute("data-wired") === "1") return;
    root.setAttribute("data-wired", "1");
    root.querySelectorAll("[data-users-span]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var span = btn.getAttribute("data-users-span") || "7d";
        state.usersSpan = span;
        root.querySelectorAll("[data-users-span]").forEach(function (b) {
          b.classList.toggle("is-active", b.getAttribute("data-users-span") === span);
        });
        renderUserStatsCharts();
        resizeVisibleCharts();
      });
    });
  }

  async function loadAndRenderUserStats(db) {
    wireUsersRangeToggle();
    if (!db) {
      setText("statUsersToday", "—");
      setText("statUsers7d", "—");
      setText("statUsersMonth", "—");
      setText("statUsersPeakHour", "—");
      renderUserStatsCharts();
      return;
    }
    try {
      await Promise.all([loadPresenceDaily(db), loadPresenceMonthly(db)]);
      updateUsersKpis();
      renderUserStatsCharts();
    } catch (err) {
      console.warn("[stats] presence load failed", err);
      setText("statUsersToday", "—");
      setText("statUsers7d", "—");
      setText("statUsersMonth", "—");
      setText("statUsersPeakHour", "—");
      renderUserStatsCharts();
    }
  }

  function panelFromHash() {
    var raw = String(window.location.hash || "")
      .replace(/^#/, "")
      .toLowerCase();
    if (raw === "filters" || raw === "filter" || raw === "filter-data") return "filters";
    if (raw === "contributions" || raw === "contribution" || raw === "contributors") return "contributions";
    if (raw === "users" || raw === "user" || raw === "activity") return "users";
    if (raw === "providers" || raw === "domains" || raw === "providers-domains") return "providers";
    return "providers";
  }

  function resizeVisibleCharts() {
    requestAnimationFrame(function () {
      [charts, detailCharts, filterDetailCharts, userCharts].forEach(function (list) {
        list.forEach(function (c) {
          try {
            if (c && typeof c.resize === "function") c.resize();
          } catch (_) {}
        });
      });
    });
  }

  function showPanel(name, opts) {
    opts = opts || {};
    var id = PANEL_META[name] ? name : "providers";
    state.panel = id;
    document.querySelectorAll(".panel[data-panel]").forEach(function (panel) {
      panel.hidden = panel.getAttribute("data-panel") !== id;
    });
    document.querySelectorAll("[data-stats-panel]").forEach(function (btn) {
      if (btn.getAttribute("data-stats-panel") === id) btn.classList.add("is-active");
      else btn.classList.remove("is-active");
    });
    var meta = PANEL_META[id];
    setText("pageTitle", meta.title);
    setText("pageSub", meta.sub);
    if (!opts.skipHash) {
      var nextHash = "#" + id;
      if (window.location.hash !== nextHash) {
        try {
          history.replaceState(null, "", nextHash);
        } catch (_) {
          window.location.hash = id;
        }
      }
    }
    resizeVisibleCharts();
  }

  function wireStatsNav() {
    document.querySelectorAll("[data-stats-panel]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        showPanel(btn.getAttribute("data-stats-panel") || "providers");
      });
    });
    window.addEventListener("hashchange", function () {
      showPanel(panelFromHash(), { skipHash: true });
    });
  }

  async function main() {
    chartDefaults();
    destroyChartList(charts);
    destroyChartList(detailCharts);
    wireProviderUi();
    wireStatsNav();
    if (!window.location.hash) {
      try {
        history.replaceState(null, "", "#providers");
      } catch (_) {}
    }
    showPanel(panelFromHash(), { skipHash: true });

    if (typeof Chart === "undefined") {
      setNotice("Chart.js did not load — graphs are unavailable in this browser or proxy.", "err");
    }

    var data;
    try {
      var json = await ProxyListData.fetchListPayload({ fetchInit: { cache: "no-cache" }, timeoutMs: 20000 });
      var normalized = ProxyListData.normalizePayload(json);
      var links = await resolveExpandedLinksAsync(json, normalized);
      data = {
        meta: normalized.meta || (json && json.meta) || {},
        links: links,
      };
    } catch (err) {
      setNotice((err && err.message) || "Failed to load list data.", "err");
      return;
    }

    var links = Array.isArray(data.links) ? data.links : [];
    state.links = links;
    state.providers = buildProviderIndex(links);
    var meta = data.meta || {};
    setText("statSorted", formatInt(links.length));
    setText(
      "statUnsorted",
      formatInt(meta.unsorted_total != null ? meta.unsorted_total : "—")
    );

    var providerCount = renderProviderCharts(links);
    setText("statProviders", formatInt(providerCount));
    renderDomainStats(links);

    state.urlToProvider = new Map();
    links.forEach(function (row) {
      var norm = normalizeUrlKey(row.link);
      if (!norm) return;
      state.urlToProvider.set(norm, String(row.provider || "").trim() || "Unknown");
    });

    try {
      renderContributors(await fetchDocsAsset("contributor_link_totals.json"));
    } catch (_) {}

    try {
      renderFilterStats(await fetchDocsAsset("filter_stats.json"));
    } catch (err) {
      console.warn("[stats] filter_stats load failed", err);
      setText("statFilters", "—");
      setText("statFilterChecked", "—");
      var filterBody = $("filterTableBody");
      if (filterBody) {
        filterBody.innerHTML =
          '<tr><td class="muted" colspan="5">filter_stats.json missing. Run scripts/build_filter_stats.py.</td></tr>';
      }
    }

    await ensureFirebaseSdk();
    state.db = initFirebase();
    var clicks = [];
    if (!state.db) {
      setNotice(
        "Firebase is not configured here, so open activity and user charts are empty. Provider and filter stats still work.",
        "warn"
      );
      setText("statOpens", "—");
      renderOpenCharts([], state.urlToProvider);
      void loadAndRenderUserStats(null);
      return;
    }

    try {
      await ensureAuth(state.db);
      clicks = await fetchTopClicks(state.db, 100);
      var totalOpens = clicks.reduce(function (sum, r) {
        return sum + r.count;
      }, 0);
      setText("statOpens", formatInt(totalOpens));
      if (!clicks.length) {
        setNotice(
          "No link-open data yet. Opens appear after visitors open links on the main list.",
          "warn"
        );
      } else {
        setNotice("");
      }
      renderOpenCharts(clicks, state.urlToProvider);
      // Warm daily cache in background for faster provider drill-down.
      void loadDailyClickDocs(state.db).catch(function () {});
    } catch (err) {
      console.warn("[stats] link_clicks load failed", err);
      setText("statOpens", "—");
      setNotice("Could not load open activity from Firestore. Provider stats still work.", "warn");
      renderOpenCharts([], state.urlToProvider);
    }

    void loadAndRenderUserStats(state.db);

    // Keep User Statistics aggregates fresh while this page is open.
    (function startStatsPresencePings() {
      if (typeof window.ProxyListPresence === "undefined") return;
      function tick(force) {
        var user = null;
        try {
          user = typeof firebase !== "undefined" && firebase.auth ? firebase.auth().currentUser : null;
        } catch (_) {}
        var anonymous = true;
        var uid = "";
        var displayName = "";
        if (user) {
          uid = user.uid || "";
          try {
            anonymous = !!(user.isAnonymous || (user.providerData || []).length === 0);
          } catch (_) {
            anonymous = !!user.isAnonymous;
          }
          if (!anonymous) {
            try {
              displayName = String((user.displayName || user.email || "").split("@")[0] || "").slice(0, 32);
            } catch (_) {}
          }
        }
        void window.ProxyListPresence.ping({
          uid: uid,
          anonymous: anonymous,
          displayName: displayName,
          force: !!force,
        });
      }
      tick(true);
      setInterval(function () {
        tick(false);
      }, 60 * 1000);
    })();

    try {
      var params = new URLSearchParams(window.location.search);
      var qProv = params.get("provider");
      if (qProv) {
        showPanel("providers");
        void selectProvider(qProv);
      }
    } catch (_) {}

    resizeVisibleCharts();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () {
      void main();
    });
  } else {
    void main();
  }
})();
