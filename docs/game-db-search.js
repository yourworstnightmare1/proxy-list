/**
 * Game database (GDB) catalog search.
 * Fetches remote game lists used by sites like Unblockedzone, then maps hits
 * back to capability tags such as gdb:noahs-tutoring so the main list can filter.
 */
(function (global) {
  "use strict";

  var DEFAULT_CDN = "https://quantil.jsdelivr.net";
  var CDN_FALLBACKS = [
    "https://quantil.jsdelivr.net",
    "https://cdn.jsdelivr.net",
    "https://fastly.jsdelivr.net",
    "https://gcore.jsdelivr.net",
  ];

  /** @type {Record<string, {tag:string,label:string,aliases:string[],loader:Function}>} */
  var CATALOGS = {
    "gdb:unblockedzone": {
      tag: "gdb:unblockedzone",
      label: "Unblockedzone",
      aliases: ["ubz", "unblocked zone", "unblockedzone", "gdb:unblockedzone"],
      loader: loadUnblockedzone,
    },
    "gdb:gn-math": {
      tag: "gdb:gn-math",
      label: "gn-math",
      aliases: ["gn", "gn-math", "gnmath", "gdb:gn-math"],
      loader: loadZonesCatalog,
    },
    "gdb:luminsdk": {
      tag: "gdb:luminsdk",
      label: "Lumin SDK",
      aliases: ["lumin", "luminsdk", "lumin sdk", "gdb:luminsdk"],
      loader: loadZonesCatalog,
    },
    "gdb:noahs-tutoring": {
      tag: "gdb:noahs-tutoring",
      label: "Noah's Tutoring",
      aliases: ["noah", "noahs", "noah's tutoring", "noahs tutoring", "gdb:noahs-tutoring"],
      loader: loadNoah,
    },
    "gdb:elite-games": {
      tag: "gdb:elite-games",
      label: "Elite Games",
      aliases: ["elite", "elite games", "gdb:elite-games"],
      loader: loadElite,
    },
    "gdb:ultimate-game-stash": {
      tag: "gdb:ultimate-game-stash",
      label: "Ultimate Game Stash",
      aliases: ["ugs", "ultimate game stash", "ultimate-game-stash", "gdb:ultimate-game-stash"],
      loader: loadUgs,
    },
    "gdb:seraph": {
      tag: "gdb:seraph",
      label: "Seraph",
      aliases: ["seraph", "gdb:seraph"],
      loader: loadSeraph,
    },
    "gdb:chicken-kings-vault": {
      tag: "gdb:chicken-kings-vault",
      label: "Chicken King's Vault",
      aliases: ["ckv", "chicken king", "chicken kings vault", "chicken-kings-vault", "gdb:chicken-kings-vault"],
      loader: loadCkv,
    },
    "gdb:lucide": {
      tag: "gdb:lucide",
      label: "Lucide",
      aliases: ["lucide", "lucideproxy", "gdb:lucide"],
      loader: loadLucide,
    },
    "gdb:sdxp": {
      tag: "gdb:sdxp",
      label: "SDXP",
      aliases: ["sdxp", "gdb:sdxp"],
      loader: loadEmptyCatalog,
    },
    "gdb:duckmath": {
      tag: "gdb:duckmath",
      label: "DuckMath",
      aliases: ["duckmath", "duck math", "gdb:duckmath"],
      loader: loadEmptyCatalog,
    },
    "gdb:ccported": {
      tag: "gdb:ccported",
      label: "CCPorted",
      aliases: ["ccported", "cc ported", "gdb:ccported"],
      loader: loadEmptyCatalog,
    },
    "gdb:selenite": {
      tag: "gdb:selenite",
      label: "Selenite",
      aliases: ["selenite", "gdb:selenite"],
      loader: loadEmptyCatalog,
    },
    "gdb:radon": {
      tag: "gdb:radon",
      label: "Radon",
      aliases: ["radon", "gdb:radon"],
      loader: loadEmptyCatalog,
    },
    "gdb:fyinx": {
      tag: "gdb:fyinx",
      label: "Fyinx",
      aliases: ["fyinx", "gdb:fyinx"],
      loader: loadEmptyCatalog,
    },
    "gdb:truffled": {
      tag: "gdb:truffled",
      label: "Truffled",
      aliases: ["truffled", "gdb:truffled"],
      loader: loadEmptyCatalog,
    },
    "gdb:totally-science": {
      tag: "gdb:totally-science",
      label: "Totally Science",
      aliases: ["totalscience", "totally science", "totally-science", "gdb:totally-science"],
      loader: loadEmptyCatalog,
    },
    "gdb:petezah": {
      tag: "gdb:petezah",
      label: "PeteZah Lite",
      aliases: ["petezah", "petezah lite", "pete zah", "gdb:petezah"],
      loader: loadEmptyCatalog,
    },
  };

  var cache = Object.create(null);
  var cachePromises = Object.create(null);

  function normalizeQuery(q) {
    return String(q || "")
      .toLowerCase()
      .replace(/['’]/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function gameName(raw) {
    return String(raw || "").trim();
  }

  function uniqueNames(list) {
    var seen = Object.create(null);
    var out = [];
    (list || []).forEach(function (name) {
      var n = gameName(name);
      if (!n) return;
      var key = n.toLowerCase();
      if (seen[key]) return;
      seen[key] = true;
      out.push(n);
    });
    return out;
  }

  function cdnBase() {
    try {
      var saved = localStorage.getItem("proxyList_gdb_cdn");
      if (saved) return saved.replace(/\/$/, "");
    } catch (_) {}
    return DEFAULT_CDN;
  }

  async function fetchText(url) {
    var res = await fetch(url, { mode: "cors", credentials: "omit" });
    if (!res.ok) throw new Error("HTTP " + res.status + " for " + url);
    return res.text();
  }

  async function fetchJson(url) {
    var res = await fetch(url, { mode: "cors", credentials: "omit" });
    if (!res.ok) throw new Error("HTTP " + res.status + " for " + url);
    return res.json();
  }

  async function fetchViaCdns(path) {
    var errors = [];
    var bases = [cdnBase()].concat(CDN_FALLBACKS.filter(function (b) { return b !== cdnBase(); }));
    for (var i = 0; i < bases.length; i++) {
      var url = bases[i].replace(/\/$/, "") + path;
      try {
        var data = await fetchJson(url);
        try {
          localStorage.setItem("proxyList_gdb_cdn", bases[i].replace(/\/$/, ""));
        } catch (_) {}
        return data;
      } catch (err) {
        errors.push(String(err && err.message ? err.message : err));
      }
    }
    throw new Error(errors.join("; ") || "All CDN fetches failed");
  }

  async function fetchTextViaCdns(path) {
    var errors = [];
    var bases = [cdnBase()].concat(CDN_FALLBACKS.filter(function (b) { return b !== cdnBase(); }));
    for (var i = 0; i < bases.length; i++) {
      var url = bases[i].replace(/\/$/, "") + path;
      try {
        var text = await fetchText(url);
        try {
          localStorage.setItem("proxyList_gdb_cdn", bases[i].replace(/\/$/, ""));
        } catch (_) {}
        return text;
      } catch (err) {
        errors.push(String(err && err.message ? err.message : err));
      }
    }
    throw new Error(errors.join("; ") || "All CDN fetches failed");
  }

  async function loadZonesCatalog() {
    var data = await fetchViaCdns("/gh/freebuisness/assets@main/zones.json");
    if (!Array.isArray(data)) return [];
    return uniqueNames(
      data
        .filter(function (g) {
          return g && g.id !== -1 && g.name && !String(g.name).startsWith("[!]");
        })
        .map(function (g) {
          return g.name;
        })
    );
  }

  async function loadNoah() {
    try {
      var d = await fetchViaCdns("/gh/NoahsAmazingTutoringHelp/Noahs-Calculus-Tutor@master/games.json");
      var rows = Array.isArray(d) ? d : d && Array.isArray(d.games) ? d.games : [];
      var names = uniqueNames(
        rows.map(function (g) {
          return g.title || g.name;
        })
      );
      if (names.length) return names;
    } catch (_) {}

    var text = await fetchTextViaCdns("/gh/NoahsAmazingTutoringHelp/Noahs-Calculus-Tutor@master/games.js");
    var names = [];
    var re = /title:\s*["'](.+?)["']/g;
    var m;
    while ((m = re.exec(text))) names.push(m[1]);
    return uniqueNames(names);
  }

  async function loadElite() {
    var d = await fetchViaCdns("/gh/1234chromebook1234-creator/ww@main/games.json");
    if (!Array.isArray(d)) return [];
    return uniqueNames(
      d.map(function (g) {
        return g.title || g.name;
      })
    );
  }

  async function loadSeraph() {
    var d = await fetchViaCdns("/gh/DominumNetwork/dominum@main/src/assets/libraries/seraph/games.json");
    if (!Array.isArray(d)) return [];
    return uniqueNames(
      d.map(function (g) {
        return g.name || g.title;
      })
    );
  }

  async function loadCkv() {
    var d = await fetchViaCdns("/gh/carbonicality/ChickenKingsVault@main/games.json");
    if (!Array.isArray(d)) return [];
    return uniqueNames(
      d.map(function (g) {
        return g.name || g.title;
      })
    );
  }

  async function loadUgs() {
    var repos = ["tharun9772/ugs-1", "tharun9772/ugs-2", "tharun9772/ugs-3"];
    var names = [];
    for (var i = 0; i < repos.length; i++) {
      try {
        var d = await fetchJson("https://api.github.com/repos/" + repos[i] + "/contents/");
        if (!Array.isArray(d)) continue;
        d.forEach(function (f) {
          if (f && f.type === "file" && /^cl.+\.html$/i.test(f.name || "")) {
            names.push(String(f.name).replace(/^cl/i, "").replace(/\.html$/i, ""));
          }
        });
      } catch (_) {}
    }
    return uniqueNames(names);
  }

  async function loadUnblockedzone() {
    // UBZ embeds its catalog in the launcher HTML; scrape normalizeGame({name:"..."}) entries.
    var text = await fetchTextViaCdns("/gh/s0n-1m-cr1n3/sc13nc3@latest/assets/index.html");
    var names = [];
    var re = /normalizeGame\(\{\s*name\s*:\s*["']([^"']+)["']/g;
    var m;
    while ((m = re.exec(text))) names.push(m[1]);
    if (!names.length) {
      // Fallback: openGame('Name', ...)
      re = /openGame\(\s*['"]([^'"]+)['"]/g;
      while ((m = re.exec(text))) names.push(m[1]);
    }
    return uniqueNames(names);
  }

  async function loadLucide() {
    // Lucide ships an obfuscated Vite GamesPage bundle under lucideproxy/svg.
    // Discover the current GamesPage-*.js asset, then scrape readable title-like strings.
    var listing = await fetchTextViaCdns("/gh/lucideproxy/svg@latest/assets/");
    var jsMatch = listing.match(/GamesPage-[A-Za-z0-9_-]+\.js/);
    if (!jsMatch) return [];
    var text = await fetchTextViaCdns("/gh/lucideproxy/svg@latest/assets/" + jsMatch[0]);
    var names = [];
    var re = /["']([A-Z][A-Za-z0-9](?:[A-Za-z0-9 .:!&+\-]{2,60}))["']/g;
    var m;
    while ((m = re.exec(text))) {
      var n = m[1].trim();
      if (n.indexOf(" ") === -1) continue;
      if (/^(Error|Click|Please|Function|Return|Class)\b/i.test(n)) continue;
      names.push(n);
    }
    return uniqueNames(names);
  }

  async function loadEmptyCatalog() {
    // Pack is filterable by alias; remote game-name catalogs are not wired yet.
    return [];
  }

  function getCatalog(tag) {
    return CATALOGS[String(tag || "").toLowerCase()] || null;
  }

  function listCatalogs() {
    return Object.keys(CATALOGS).map(function (k) {
      return CATALOGS[k];
    });
  }

  async function ensureCatalogGames(tag) {
    var key = String(tag || "").toLowerCase();
    var cat = CATALOGS[key];
    if (!cat) return [];
    if (cache[key]) return cache[key];
    if (cachePromises[key]) return cachePromises[key];
    cachePromises[key] = Promise.resolve()
      .then(function () {
        return cat.loader();
      })
      .then(function (games) {
        cache[key] = uniqueNames(games || []);
        delete cachePromises[key];
        return cache[key];
      })
      .catch(function (err) {
        delete cachePromises[key];
        throw err;
      });
    return cachePromises[key];
  }

  function scoreGameMatch(name, q) {
    var n = normalizeQuery(name);
    if (!n || !q) return -1;
    if (n === q) return 100;
    if (n.startsWith(q)) return 80;
    if (n.includes(q)) return 60;
    var tokens = q.split(" ").filter(Boolean);
    if (tokens.length > 1 && tokens.every(function (t) { return n.includes(t); })) return 50;
    return -1;
  }

  function catalogMatchesDatabaseQuery(cat, q) {
    if (!q) return false;
    var hay = [cat.tag, cat.label].concat(cat.aliases || []).map(normalizeQuery);
    return hay.some(function (h) {
      return h === q || h.includes(q) || q.includes(h);
    });
  }

  function cachedGames(tag) {
    var key = String(tag || "").toLowerCase();
    return cache[key] || null;
  }

  function warmAll() {
    return Promise.allSettled(
      listCatalogs().map(function (cat) {
        return ensureCatalogGames(cat.tag);
      })
    );
  }

  /**
   * Sync suggestions from already-loaded catalogs (+ always-on database aliases).
   * Call warmAll() in the background so game names become available.
   */
  function suggestFromCache(query, options) {
    var opts = options || {};
    var q = normalizeQuery(query);
    var limit = opts.limit != null ? opts.limit : 8;
    if (!q) return [];

    var dbHits = [];
    var gameMap = Object.create(null);

    listCatalogs().forEach(function (cat) {
      if (catalogMatchesDatabaseQuery(cat, q)) {
        dbHits.push({
          kind: "gdb-database",
          value: cat.tag,
          label: cat.label,
          tag: cat.tag,
          tags: [cat.tag],
          match: (cat.label + " " + cat.tag + " " + (cat.aliases || []).join(" ")).toLowerCase(),
          score: normalizeQuery(cat.label) === q || normalizeQuery(cat.tag) === q ? 100 : 70,
        });
      }

      var games = cachedGames(cat.tag);
      if (!games) return;
      games.forEach(function (name) {
        var score = scoreGameMatch(name, q);
        if (score < 0) return;
        var key = name.toLowerCase();
        if (!gameMap[key]) {
          gameMap[key] = {
            kind: "gdb-game",
            value: name,
            label: name,
            tags: [],
            match: name.toLowerCase(),
            score: score,
          };
        } else if (score > gameMap[key].score) {
          gameMap[key].score = score;
        }
        if (gameMap[key].tags.indexOf(cat.tag) === -1) gameMap[key].tags.push(cat.tag);
      });
    });

    var gameHits = Object.keys(gameMap)
      .map(function (k) {
        return gameMap[k];
      })
      .sort(function (a, b) {
        return b.score - a.score || a.label.localeCompare(b.label);
      });

    dbHits.sort(function (a, b) {
      return b.score - a.score || a.label.localeCompare(b.label);
    });

    var out = [];
    var seen = Object.create(null);
    function push(item) {
      var key = item.kind + ":" + String(item.value).toLowerCase();
      if (seen[key]) return;
      seen[key] = true;
      out.push(item);
    }
    dbHits.forEach(push);
    gameHits.forEach(push);
    return out.slice(0, limit);
  }

  /**
   * Search catalogs for a game name and/or database name.
   * @returns {Promise<{query:string, matches:Array, errors:Array}>}
   */
  async function search(query, options) {
    var opts = options || {};
    var q = normalizeQuery(query);
    var onlyTags = Array.isArray(opts.tags) ? opts.tags.map(function (t) { return String(t).toLowerCase(); }) : null;
    var catalogs = listCatalogs().filter(function (c) {
      return !onlyTags || onlyTags.indexOf(c.tag) !== -1;
    });

    var matches = [];
    var errors = [];

    if (!q) {
      return { query: "", matches: [], errors: [] };
    }

    await Promise.all(
      catalogs.map(async function (cat) {
        var dbHit = catalogMatchesDatabaseQuery(cat, q);
        var gameHits = [];
        try {
          var games = await ensureCatalogGames(cat.tag);
          gameHits = games
            .map(function (name) {
              return { name: name, score: scoreGameMatch(name, q) };
            })
            .filter(function (g) {
              return g.score >= 0;
            })
            .sort(function (a, b) {
              return b.score - a.score || a.name.localeCompare(b.name);
            })
            .slice(0, opts.gameLimit != null ? opts.gameLimit : 12);
        } catch (err) {
          errors.push({ tag: cat.tag, label: cat.label, error: String(err && err.message ? err.message : err) });
          if (!dbHit) return;
        }

        if (!dbHit && !gameHits.length) return;
        matches.push({
          tag: cat.tag,
          label: cat.label,
          matchType: dbHit && gameHits.length ? "both" : dbHit ? "database" : "game",
          games: gameHits,
          gameCount: gameHits.length,
        });
      })
    );

    matches.sort(function (a, b) {
      var rank = { both: 0, game: 1, database: 2 };
      return (rank[a.matchType] || 9) - (rank[b.matchType] || 9) || a.label.localeCompare(b.label);
    });

    return { query: q, matches: matches, errors: errors };
  }

  global.ProxyListGameDbSearch = {
    CATALOGS: CATALOGS,
    listCatalogs: listCatalogs,
    getCatalog: getCatalog,
    ensureCatalogGames: ensureCatalogGames,
    cachedGames: cachedGames,
    warmAll: warmAll,
    suggestFromCache: suggestFromCache,
    search: search,
    normalizeQuery: normalizeQuery,
  };
})(typeof window !== "undefined" ? window : globalThis);
