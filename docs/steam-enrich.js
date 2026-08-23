/**
 * Best-effort Steam Store enrichment for game catalogs.
 * Uses Worker proxies at /api/steam/search and /api/steam/appdetails
 * (store.steampowered.com has no CORS; see https://steamapi.xpaw.me/ for Steam Web API docs).
 */
(function (global) {
  "use strict";

  var DEFAULT_WORKER_ORIGIN = "https://proxy-list.jasonthegamer48.workers.dev";
  var MIN_SCORE = 90;
  var memory = Object.create(null);
  var inflight = Object.create(null);

  function configuredApiOrigin() {
    try {
      var raw = global.__PROXY_LIST_API_BASE__;
      if (raw == null || raw === false) return "";
      return String(raw).trim().replace(/\/+$/, "");
    } catch (_) {
      return "";
    }
  }

  function hostIsGitHubPages() {
    try {
      var host = String((global.location && global.location.hostname) || "").toLowerCase();
      return host === "github.io" || host.endsWith(".github.io");
    } catch (_) {
      return false;
    }
  }

  function hostIsLocalDev() {
    try {
      var host = String((global.location && global.location.hostname) || "").toLowerCase();
      return host === "localhost" || host === "127.0.0.1" || host === "[::1]";
    } catch (_) {
      return false;
    }
  }

  function resolveApiUrl(path) {
    if (global.ProxyListPresence && typeof global.ProxyListPresence.apiUrl === "function") {
      return global.ProxyListPresence.apiUrl(path);
    }
    var p = path.charAt(0) === "/" ? path : "/" + path;
    var configured = configuredApiOrigin();
    if (configured) return configured + p;
    if (hostIsGitHubPages() || hostIsLocalDev()) return DEFAULT_WORKER_ORIGIN + p;
    try {
      var pathname = String((global.location && global.location.pathname) || "");
      if (/\/games-browser(\/|$)/i.test(pathname)) return ".." + p;
    } catch (_) {}
    return "." + p;
  }

  function normalizeName(name) {
    return String(name || "")
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[™®©]/g, "")
      .replace(/&/g, " and ")
      .replace(/['’]/g, "")
      .replace(/[^a-z0-9]+/g, " ")
      .replace(/\b(demo|soundtrack|ost|dlc|pack|edition)\b/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function tokens(s) {
    return normalizeName(s).split(" ").filter(Boolean);
  }

  function scoreMatch(queryName, candidateName) {
    var q = normalizeName(queryName);
    var c = normalizeName(candidateName);
    if (!q || !c) return 0;
    if (q === c) return 100;

    var qt = tokens(queryName);
    var ct = tokens(candidateName);
    if (qt.length && ct.length && qt.join(" ") === ct.join(" ")) return 100;

    // Same multiset of tokens (order-insensitive).
    if (qt.length === ct.length && qt.length > 0) {
      var a = qt.slice().sort().join("\0");
      var b = ct.slice().sort().join("\0");
      if (a === b) return 98;
    }

    // One name fully contains the other as a contiguous phrase, with similar length.
    if (c.indexOf(q) === 0 || q.indexOf(c) === 0) {
      var shorter = Math.min(q.length, c.length);
      var longer = Math.max(q.length, c.length);
      if (shorter >= 4 && shorter / longer >= 0.85) return 92;
    }

    // All query tokens present as whole tokens in candidate (and not a tiny query).
    if (qt.length >= 2 && qt.every(function (t) { return ct.indexOf(t) !== -1; })) {
      if (ct.length - qt.length <= 1) return 91;
    }

    return 0;
  }

  function isNoiseApp(item, queryName) {
    var n = normalizeName(item && item.name);
    var q = normalizeName(queryName);
    if (!n) return true;
    if (/\b(soundtrack|ost|wallpaper|modding tool|server|sdk|dedicated server)\b/.test(n)) {
      if (!/\b(soundtrack|ost|wallpaper)\b/.test(q)) return true;
    }
    return false;
  }

  function pickBestMatch(queryName, items) {
    var best = null;
    var bestScore = 0;
    (items || []).forEach(function (item) {
      if (!item || String(item.type || "").toLowerCase() !== "app") return;
      if (isNoiseApp(item, queryName)) return;
      var score = scoreMatch(queryName, item.name);
      if (score > bestScore) {
        bestScore = score;
        best = item;
      }
    });
    if (!best || bestScore < MIN_SCORE) return null;
    return { item: best, score: bestScore };
  }

  function decodeEntities(s) {
    return String(s || "")
      .replace(/&nbsp;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/&quot;/gi, '"')
      .replace(/&#39;/gi, "'")
      .replace(/&#(\d+);/g, function (_, n) {
        return String.fromCharCode(Number(n));
      });
  }

  function stripHtml(html) {
    var text = String(html || "")
      .replace(/\r/g, "")
      .replace(/<\s*br\s*\/?\s*>/gi, "\n")
      .replace(/<\s*\/\s*p\s*>/gi, "\n\n")
      .replace(/<\s*p(\s[^>]*)?>/gi, "")
      .replace(/<\s*li(\s[^>]*)?>/gi, "• ")
      .replace(/<\s*\/\s*li\s*>/gi, "\n")
      .replace(/<[^>]+>/g, "")
      .replace(/\n{3,}/g, "\n\n");
    return decodeEntities(text).replace(/[ \t]+\n/g, "\n").trim();
  }

  function libraryCoverUrl(appId) {
    return (
      "https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/" +
      appId +
      "/library_600x900.jpg"
    );
  }

  function fetchJson(url) {
    return fetch(url, { mode: "cors", credentials: "omit" }).then(function (res) {
      return res.json().then(function (body) {
        if (!res.ok || !body || body.ok === false) {
          var err = new Error((body && body.error) || "steam_proxy_failed");
          err.status = res.status;
          throw err;
        }
        return body.data;
      });
    });
  }

  function searchSteam(term) {
    var url =
      resolveApiUrl("/api/steam/search") +
      "?term=" +
      encodeURIComponent(String(term || "").trim());
    return fetchJson(url).then(function (data) {
      return (data && data.items) || [];
    });
  }

  function fetchAppDetails(appId) {
    var url =
      resolveApiUrl("/api/steam/appdetails") +
      "?appids=" +
      encodeURIComponent(String(appId));
    return fetchJson(url).then(function (data) {
      var entry = data && data[String(appId)];
      if (!entry || !entry.success || !entry.data) return null;
      return entry.data;
    });
  }

  function buildEnrichment(appId, data) {
    var description =
      stripHtml(data.detailed_description) ||
      stripHtml(data.about_the_game) ||
      String(data.short_description || "").trim();
    if (description.length > 4000) description = description.slice(0, 3990).trim() + "…";

    var publishers = Array.isArray(data.publishers) ? data.publishers.filter(Boolean) : [];
    var developers = Array.isArray(data.developers) ? data.developers.filter(Boolean) : [];
    var publisher = publishers.join(", ");
    var developer = developers.join(", ");

    var previews = (data.screenshots || [])
      .map(function (ss) {
        return {
          thumb: ss.path_thumbnail || "",
          full: ss.path_full || ss.path_thumbnail || "",
        };
      })
      .filter(function (p) {
        return p.full || p.thumb;
      })
      .slice(0, 12);

    return {
      appId: Number(appId),
      steamName: data.name || "",
      description: description,
      shortDescription: String(data.short_description || "").trim(),
      publisher: publisher,
      developer: developer,
      publishers: publishers,
      developers: developers,
      thumbnail: libraryCoverUrl(appId),
      headerImage: data.header_image || "",
      capsuleImage: data.capsule_image || "",
      previews: previews,
    };
  }

  function applyEnrichment(game, enrich) {
    if (!game) return game;
    if (!enrich) {
      game.steamEnrich = "none";
      return game;
    }
    game.steamEnrich = "done";
    game.steamAppId = enrich.appId;
    game.steamName = enrich.steamName;
    if (enrich.description) {
      game.descriptionOriginal = game.descriptionOriginal != null ? game.descriptionOriginal : game.description;
      game.description = enrich.description;
    }
    if (enrich.publisher) {
      game.publisherOriginal = game.publisherOriginal != null ? game.publisherOriginal : game.publisher;
      game.publisher = enrich.publisher;
    }
    if (enrich.developer) {
      game.developerOriginal = game.developerOriginal != null ? game.developerOriginal : game.developer;
      game.developer = enrich.developer;
    }
    game.steamPublishers = enrich.publishers || [];
    game.steamDevelopers = enrich.developers || [];
    if (enrich.thumbnail) {
      game.thumbnailOriginal = game.thumbnailOriginal != null ? game.thumbnailOriginal : game.thumbnail;
      game.thumbnail = enrich.thumbnail;
    }
    game.previews = enrich.previews || [];
    game.steamHeaderImage = enrich.headerImage || "";
    return game;
  }

  function lookupByName(name) {
    var key = normalizeName(name);
    if (!key) return Promise.resolve(null);
    if (Object.prototype.hasOwnProperty.call(memory, key)) {
      return Promise.resolve(memory[key]);
    }
    if (inflight[key]) return inflight[key];

    inflight[key] = searchSteam(name)
      .then(function (items) {
        var picked = pickBestMatch(name, items);
        if (!picked) {
          memory[key] = null;
          return null;
        }
        return fetchAppDetails(picked.item.id).then(function (data) {
          if (!data) {
            memory[key] = null;
            return null;
          }
          var enrich = buildEnrichment(picked.item.id, data);
          enrich.matchScore = picked.score;
          memory[key] = enrich;
          return enrich;
        });
      })
      .catch(function () {
        // Do not cache hard failures (network / rate limit) so a later retry can succeed.
        return null;
      })
      .finally(function () {
        delete inflight[key];
      });

    return inflight[key];
  }

  /**
   * Mutates game in place when a confident Steam match is found.
   * Resolves with the game (enriched or unchanged).
   */
  function enrichGame(game) {
    if (!game || !game.name) return Promise.resolve(game);
    if (game.steamEnrich === "done" || game.steamEnrich === "none") {
      return Promise.resolve(game);
    }
    return lookupByName(game.name).then(function (enrich) {
      return applyEnrichment(game, enrich);
    });
  }

  global.ProxyListSteamEnrich = {
    enrichGame: enrichGame,
    lookupByName: lookupByName,
    normalizeName: normalizeName,
    scoreMatch: scoreMatch,
    pickBestMatch: pickBestMatch,
    apiUrl: resolveApiUrl,
  };
})(typeof window !== "undefined" ? window : globalThis);
