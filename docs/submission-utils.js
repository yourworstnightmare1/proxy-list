/**
 * Shared helpers for on-site link submissions (duplicate checks, validation, admin).
 * URL keys match scripts/submission_url_key.py / import_link_request_csv.normalize_key.
 */
(function (global) {
  "use strict";

  var DUPLICATE_BLOCK_THRESHOLD = 10;
  var RATE_LIMIT_PER_HOUR = 8;
  var MAX_NOTE_LEN = 500;
  var MAX_CONTRIBUTOR_NAME_LEN = 120;
  var MAX_GITHUB_URL_LEN = 200;

  function submissionUrlKey(url) {
    var u = String(url || "").trim();
    if (!/^https?:\/\//i.test(u)) u = "https://" + u;
    u = u.replace("?/", "/");
    while (true) {
      var u2 = u.replace(/(https?:\/\/[^/]+)\/+/g, "$1/");
      if (u2 === u) break;
      u = u2;
    }
    var parts = u.split("://", 1 + 1);
    if (parts.length === 2) {
      var scheme = parts[0];
      var rest = parts[1];
      var slash = rest.indexOf("/");
      var netloc = (slash === -1 ? rest : rest.slice(0, slash)).toLowerCase();
      var pathPart = slash === -1 ? "" : rest.slice(slash);
      u = scheme + "://" + netloc + pathPart;
    }
    if (u.endsWith("/") && (u.match(/\//g) || []).length > 3) u = u.replace(/\/+$/, "");
    return u;
  }

  function normalizeSubmissionUrl(url) {
    return submissionUrlKey(url);
  }

  function isBlockedDomain(url, patterns) {
    var list = patterns || ["b-cdn.net"];
    var lower = String(url || "").toLowerCase();
    for (var i = 0; i < list.length; i++) {
      if (lower.indexOf(String(list[i]).toLowerCase()) !== -1) return true;
    }
    return false;
  }

  function isValidHttpUrl(url) {
    try {
      var u = new URL(submissionUrlKey(url));
      return u.protocol === "http:" || u.protocol === "https:";
    } catch (_) {
      return false;
    }
  }

  function buildUrlKeySet(indexPayload) {
    var keys = indexPayload && indexPayload.keys;
    return new Set(Array.isArray(keys) ? keys : []);
  }

  function githubLoginFromUser(user) {
    if (!user) return "";
    var gh = (user.providerData || []).find(function (p) {
      return p.providerId === "github.com";
    });
    if (!gh) return "";
    // Prefer GitHub username (login). Firebase often puts profile "name" in displayName.
    if (gh.screenName) return String(gh.screenName).trim();
    if (gh.username) return String(gh.username).trim();
    // Known mapping: GitHub user id → login (Firebase provider uid is the numeric id).
    if (String(gh.uid) === "134671973") return "yourworstnightmare1";
    if (gh.displayName && /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,37}[a-zA-Z0-9])?$/.test(String(gh.displayName).trim())) {
      return String(gh.displayName).trim();
    }
    var email = gh.email ? String(gh.email).split("@")[0] : "";
    return email;
  }

  function githubLoginFromProfileUrl(url) {
    var raw = String(url || "").trim();
    if (!raw) return "";
    try {
      var u = new URL(raw.indexOf("://") === -1 ? "https://" + raw : raw);
      var host = u.hostname.toLowerCase();
      if (host !== "github.com" && host !== "www.github.com") return "";
      // Profile URLs only: https://github.com/{username} (optional trailing slash)
      var parts = u.pathname.split("/").filter(Boolean);
      if (parts.length !== 1) return "";
      var login = String(parts[0]).replace(/^@/, "").trim();
      if (!/^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,37}[a-zA-Z0-9])?$/.test(login)) return "";
      return login;
    } catch (_) {
      return "";
    }
  }

  function githubProfileUrlFromLogin(login) {
    var gh = String(login || "").trim().replace(/^@/, "");
    if (!githubLoginFromProfileUrl("https://github.com/" + gh)) return "";
    return "https://github.com/" + gh;
  }

  /** Check that a GitHub username exists via the public Users API. */
  function verifyGithubAccountExists(login) {
    var gh = String(login || "").trim().replace(/^@/, "");
    if (!gh || !githubLoginFromProfileUrl("https://github.com/" + gh)) {
      return Promise.resolve({ ok: false, reason: "invalid" });
    }
    return fetch("https://api.github.com/users/" + encodeURIComponent(gh), {
      method: "GET",
      headers: {
        Accept: "application/vnd.github+json",
      },
    })
      .then(function (res) {
        if (res.status === 404) return { ok: false, reason: "not_found" };
        if (res.status === 403) return { ok: false, reason: "rate_limited" };
        if (!res.ok) return { ok: false, reason: "http" };
        return res.json().then(function (data) {
          var actual = data && data.login ? String(data.login) : gh;
          if (!githubLoginFromProfileUrl("https://github.com/" + actual)) {
            return { ok: false, reason: "invalid" };
          }
          return { ok: true, login: actual };
        });
      })
      .catch(function () {
        return { ok: false, reason: "network" };
      });
  }

  function contributorMdFromFields(name, githubLoginOrUrl) {
    var label = String(name || "").trim();
    if (!label) label = "Contributor";
    var gh = githubLoginFromProfileUrl(githubLoginOrUrl) || String(githubLoginOrUrl || "").trim().replace(/^@/, "");
    if (gh && githubProfileUrlFromLogin(gh)) {
      return "[" + label + "](https://github.com/" + gh + ")";
    }
    return label;
  }

  function isSignedInNonAnonymous(user) {
    return !!(user && !user.isAnonymous);
  }

  var adminCheckCache = { uid: "", admin: false, at: 0 };
  var ADMIN_CACHE_MS = 60 * 1000;
  var adminCheckInflight = { uid: "", promise: null };
  // Keep in sync with workers/auth-api.js submissionAdminUidList fallback.
  // Used when /api/admin/me fails (common on localhost→production) so the owner
  // account is not stuck behind a false "not an admin" gate.
  var DEFAULT_ADMIN_UIDS = [
    "OiMY32eTKcSnEX73W6oBUKgT6pG3",
    "QDaYz2ETKCSlEK70N3U8UKgTezX2",
  ];

  function isDefaultAdminUid(uid) {
    var id = String(uid || "").trim();
    return !!(id && DEFAULT_ADMIN_UIDS.indexOf(id) !== -1);
  }

  function clearSubmissionAdminCache() {
    adminCheckCache = { uid: "", admin: false, at: 0 };
    adminCheckInflight = { uid: "", promise: null };
  }

  function hasSubmissionAdminCache(user) {
    return !!(
      user &&
      adminCheckCache.uid === user.uid &&
      Date.now() - adminCheckCache.at < ADMIN_CACHE_MS
    );
  }

  function isSubmissionAdminUser(user) {
    if (!isSignedInNonAnonymous(user)) return false;
    if (hasSubmissionAdminCache(user)) return adminCheckCache.admin;
    return false;
  }

  function delayMs(ms) {
    return new Promise(function (resolve) {
      setTimeout(resolve, ms);
    });
  }

  /** Wait briefly for auth-security.js when scripts load in parallel with app.js. */
  function waitForFetchAdminMe(attemptsLeft) {
    var sec = global.ProxyListAuthSecurity;
    var fetchMe = sec && typeof sec.fetchAdminMe === "function" ? sec.fetchAdminMe : null;
    if (fetchMe) return Promise.resolve(fetchMe);
    if (attemptsLeft <= 0) return Promise.resolve(null);
    return delayMs(50).then(function () {
      return waitForFetchAdminMe(attemptsLeft - 1);
    });
  }

  /**
   * Worker allowlist (SUBMISSION_ADMIN_UIDS via /api/admin/me).
   * Resolves { status: "ok"|"error", admin?: boolean }.
   */
  function checkWorkerAdmin(user) {
    return waitForFetchAdminMe(40).then(function (fetchMe) {
      if (!fetchMe) return { status: "error" };
      return fetchMe(user).then(
        function (ok) {
          return { status: "ok", admin: !!ok };
        },
        function () {
          return { status: "error" };
        }
      );
    });
  }

  /**
   * Firestore config/submissions.adminUids — same list rules use for writes.
   * Readable by any signed-in non-anonymous user. Critical on localhost:8080 where
   * /api hits production Worker and may disagree with (or fail before) the Firestore list.
   */
  function checkFirestoreAdminUids(user) {
    if (!user || !user.uid) return Promise.resolve({ status: "error" });
    try {
      if (!global.firebase || typeof firebase.firestore !== "function") {
        return Promise.resolve({ status: "error" });
      }
      return firebase
        .firestore()
        .collection("config")
        .doc("submissions")
        .get()
        .then(function (snap) {
          if (!snap.exists) return { status: "ok", admin: false };
          var data = snap.data() || {};
          var uids = data.adminUids;
          var ok = Array.isArray(uids) && uids.indexOf(user.uid) !== -1;
          return { status: "ok", admin: ok };
        })
        .catch(function () {
          return { status: "error" };
        });
    } catch (_) {
      return Promise.resolve({ status: "error" });
    }
  }

  function checkSubmissionAdmin(user) {
    if (!isSignedInNonAnonymous(user)) {
      clearSubmissionAdminCache();
      return Promise.resolve(false);
    }
    if (adminCheckCache.uid === user.uid && Date.now() - adminCheckCache.at < ADMIN_CACHE_MS) {
      return Promise.resolve(adminCheckCache.admin);
    }
    if (adminCheckInflight.uid === user.uid && adminCheckInflight.promise) {
      return adminCheckInflight.promise;
    }

    var uid = user.uid;
    // Fast path: known owner UIDs (matches Worker default allowlist).
    if (isDefaultAdminUid(uid)) {
      adminCheckCache = { uid: uid, admin: true, at: Date.now() };
      return Promise.resolve(true);
    }

    var promise = Promise.all([checkWorkerAdmin(user), checkFirestoreAdminUids(user)])
      .then(function (parts) {
        var worker = parts[0] || { status: "error" };
        var firestore = parts[1] || { status: "error" };
        var isAdmin =
          isDefaultAdminUid(uid) ||
          (worker.status === "ok" && worker.admin) ||
          (firestore.status === "ok" && firestore.admin);
        // Cache when either source answered, or default allowlist matched.
        if (isAdmin || worker.status === "ok" || firestore.status === "ok") {
          adminCheckCache = { uid: uid, admin: !!isAdmin, at: Date.now() };
          return adminCheckCache.admin;
        }
        // Both failed transiently — do not cache as non-admin.
        return Promise.reject(new Error("admin_check_unavailable"));
      })
      .catch(function () {
        return delayMs(200)
          .then(function () {
            return Promise.all([checkWorkerAdmin(user), checkFirestoreAdminUids(user)]);
          })
          .then(function (parts) {
            var worker = parts[0] || { status: "error" };
            var firestore = parts[1] || { status: "error" };
            var isAdmin =
              isDefaultAdminUid(uid) ||
              (worker.status === "ok" && worker.admin) ||
              (firestore.status === "ok" && firestore.admin);
            if (isAdmin || worker.status === "ok" || firestore.status === "ok") {
              adminCheckCache = { uid: uid, admin: !!isAdmin, at: Date.now() };
              return adminCheckCache.admin;
            }
            return false;
          })
          .catch(function () {
            return isDefaultAdminUid(uid);
          });
      })
      .then(function (result) {
        if (adminCheckInflight.promise === promise) {
          adminCheckInflight = { uid: "", promise: null };
        }
        return result;
      });

    adminCheckInflight = { uid: uid, promise: promise };
    return promise;
  }

  function escAdminHtml(s) {
    return String(s || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  /** Wait until Firebase Auth finishes restoring a session (avoids false "signed out" gates). */
  function whenAuthReady(auth) {
    var Auth = global.ProxyListAuth;
    if (Auth && typeof Auth.prepare === "function") return Auth.prepare(auth);
    if (Auth && typeof Auth.waitForAuthReady === "function") return Auth.waitForAuthReady(auth);
    if (auth && typeof auth.authStateReady === "function") return auth.authStateReady();
    return Promise.resolve();
  }

  /**
   * Show why /admin is blocked instead of silently bouncing to the homepage.
   * Returns true when the caller should stay on the page (message shown or
   * signed-in non-admin). Only returns false when there is no gate element and
   * the visitor is signed out — callers may then redirect.
   */
  function denyAdminAccess(user, gateEl) {
    var signedIn = isSignedInNonAnonymous(user);
    var html;
    if (!signedIn) {
      html =
        'Sign in with an admin account to open this page. ' +
        '<a href="../login/?next=admin/">Sign in</a>';
    } else {
      html =
        "This signed-in account is not an admin. Your Firebase UID is " +
        "<code>" +
        escAdminHtml(user.uid) +
        "</code>. Add it to the Worker secret <code>SUBMISSION_ADMIN_UIDS</code> " +
        "and Firestore <code>config/submissions.adminUids</code>, then refresh.";
    }
    if (gateEl) {
      gateEl.hidden = false;
      gateEl.className = "notice err";
      gateEl.innerHTML = html;
      return true;
    }
    // Stay put for signed-in users so they can copy their UID; bounce only if signed out.
    return signedIn;
  }

  function submitterLabelFromUser(user, profileDoc) {
    if (profileDoc && profileDoc.siteUsername) return String(profileDoc.siteUsername).trim();
    var gh = githubLoginFromUser(user);
    if (gh) return gh;
    if (user.displayName) return String(user.displayName).trim();
    if (user.email) return String(user.email).split("@")[0];
    return "Contributor";
  }

  function contributorMdFromUser(user, profileDoc) {
    var gh = githubLoginFromUser(user);
    var label = submitterLabelFromUser(user, profileDoc);
    return contributorMdFromFields(label, gh);
  }

  function formatListMdRow(url, contributorMd) {
    return "| | " + url + " | N/A | N/A | N/A | " + contributorMd;
  }

  function remainingRateSlots(stats) {
    if (!stats || !stats.lastSubmissionAt) return RATE_LIMIT_PER_HOUR;
    var ts = stats.lastSubmissionAt;
    var ms = typeof ts.toMillis === "function" ? ts.toMillis() : typeof ts.seconds === "number" ? ts.seconds * 1000 : 0;
    if (!ms) return RATE_LIMIT_PER_HOUR;
    var hourAgo = Date.now() - 60 * 60 * 1000;
    if (ms < hourAgo) return RATE_LIMIT_PER_HOUR;
    var recent = Number(stats.recentHourCount) || 0;
    return Math.max(0, RATE_LIMIT_PER_HOUR - recent);
  }

  function rateLimitOk(stats) {
    return remainingRateSlots(stats) > 0;
  }

  function sha256Hex(text) {
    if (typeof crypto !== "undefined" && crypto.subtle && crypto.subtle.digest) {
      return crypto.subtle
        .digest("SHA-256", new TextEncoder().encode(String(text)))
        .then(function (buf) {
          return Array.from(new Uint8Array(buf))
            .map(function (b) {
              return b.toString(16).padStart(2, "0");
            })
            .join("");
        });
    }
    return Promise.reject(new Error("SHA-256 unavailable"));
  }

  global.SubmissionUtils = {
    DUPLICATE_BLOCK_THRESHOLD: DUPLICATE_BLOCK_THRESHOLD,
    RATE_LIMIT_PER_HOUR: RATE_LIMIT_PER_HOUR,
    MAX_NOTE_LEN: MAX_NOTE_LEN,
    MAX_CONTRIBUTOR_NAME_LEN: MAX_CONTRIBUTOR_NAME_LEN,
    MAX_GITHUB_URL_LEN: MAX_GITHUB_URL_LEN,
    submissionUrlKey: submissionUrlKey,
    normalizeSubmissionUrl: normalizeSubmissionUrl,
    isBlockedDomain: isBlockedDomain,
    isValidHttpUrl: isValidHttpUrl,
    buildUrlKeySet: buildUrlKeySet,
    githubLoginFromUser: githubLoginFromUser,
    githubLoginFromProfileUrl: githubLoginFromProfileUrl,
    githubProfileUrlFromLogin: githubProfileUrlFromLogin,
    verifyGithubAccountExists: verifyGithubAccountExists,
    contributorMdFromFields: contributorMdFromFields,
    isSignedInNonAnonymous: isSignedInNonAnonymous,
    isSubmissionAdminUser: isSubmissionAdminUser,
    hasSubmissionAdminCache: hasSubmissionAdminCache,
    checkSubmissionAdmin: checkSubmissionAdmin,
    clearSubmissionAdminCache: clearSubmissionAdminCache,
    whenAuthReady: whenAuthReady,
    denyAdminAccess: denyAdminAccess,
    submitterLabelFromUser: submitterLabelFromUser,
    contributorMdFromUser: contributorMdFromUser,
    formatListMdRow: formatListMdRow,
    remainingRateSlots: remainingRateSlots,
    rateLimitOk: rateLimitOk,
    sha256Hex: sha256Hex,
  };
})(typeof window !== "undefined" ? window : globalThis);
