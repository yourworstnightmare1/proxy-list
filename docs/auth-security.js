/**
 * Client helpers for Worker-backed login guards, password policy, admin checks,
 * and GitHub token storage (never localStorage).
 */
(function (global) {
  "use strict";

  var DEFAULT_WORKER_ORIGIN = "https://proxy-list.jasonthegamer48.workers.dev";
  var memoryGithubToken = "";

  function configuredApiOrigin() {
    try {
      var raw = global.__PROXY_LIST_API_BASE__;
      if (raw == null || raw === false) return "";
      return String(raw).trim().replace(/\/+$/, "");
    } catch (_) {
      return "";
    }
  }

  function hostIsOurWorker() {
    try {
      var host = String((global.location && global.location.hostname) || "").toLowerCase();
      if (host === "proxy-list.jasonthegamer48.workers.dev") return true;
      if (/-proxy-list\.jasonthegamer48\.workers\.dev$/i.test(host)) return true;
      if (/\.proxy-list\.jasonthegamer48\.workers\.dev$/i.test(host)) return true;
      return false;
    } catch (_) {
      return false;
    }
  }

  function apiUrl(path) {
    var p = path.charAt(0) === "/" ? path : "/" + path;
    if (global.ProxyListPresence && typeof global.ProxyListPresence.apiUrl === "function") {
      return global.ProxyListPresence.apiUrl(p);
    }
    var origin = configuredApiOrigin();
    if (origin) return origin + p;
    if (hostIsOurWorker()) return p;
    try {
      var loc = global.location || {};
      var host = String(loc.hostname || "").toLowerCase();
      var port = String(loc.port || "");
      if ((host === "localhost" || host === "127.0.0.1" || host === "[::1]") && port === "8787") return p;
    } catch (_) {}
    return DEFAULT_WORKER_ORIGIN + p;
  }

  function stripLocalStorageAuthTokens() {
    var stores = [];
    try {
      if (global.localStorage) stores.push(global.localStorage);
    } catch (_) {}
    try {
      if (global.sessionStorage) stores.push(global.sessionStorage);
    } catch (_) {}
    stores.forEach(function (store) {
      try {
        var keys = [];
        for (var i = 0; i < store.length; i++) keys.push(store.key(i));
        keys.forEach(function (k) {
          if (!k) return;
          if (
            k === "proxyList_github_access_token" ||
            /^firebase:(authUser|host|redirectUser):/i.test(k)
          ) {
            store.removeItem(k);
          }
        });
      } catch (_) {}
    });
  }

  function authHeaders(idToken) {
    var h = { "Content-Type": "application/json", Accept: "application/json" };
    if (idToken) h.Authorization = "Bearer " + idToken;
    return h;
  }

  function currentIdToken() {
    try {
      var auth = global.firebase && firebase.auth && firebase.auth();
      var user = auth && auth.currentUser;
      if (!user || user.isAnonymous) return Promise.resolve("");
      return user.getIdToken();
    } catch (_) {
      return Promise.resolve("");
    }
  }

  function parseJson(res) {
    return res.json().catch(function () {
      return {};
    });
  }

  function guardAuth(kind, email) {
    return fetch(apiUrl("/api/auth/guard"), {
      method: "POST",
      mode: "cors",
      headers: authHeaders(""),
      body: JSON.stringify({ kind: kind || "login", email: String(email || "").trim() }),
    })
      .then(function (res) {
        return parseJson(res).then(function (data) {
          if (res.status === 429 || (data && data.error === "rate_limited")) {
            return { ok: false, error: "rate_limited", message: "Too many attempts. Wait a few minutes and try again." };
          }
          if (!res.ok || (data && data.ok === false)) {
            return {
              ok: false,
              error: (data && data.error) || "guard_failed",
              message: data && data.error === "invalid_email" ? "Enter a valid email address." : "Could not continue.",
            };
          }
          return { ok: true };
        });
      })
      .catch(function () {
        return { ok: false, error: "network", message: "Could not reach the sign-in service." };
      });
  }

  function checkPassword(password, email) {
    return fetch(apiUrl("/api/auth/password-check"), {
      method: "POST",
      mode: "cors",
      headers: authHeaders(""),
      body: JSON.stringify({ password: String(password || ""), email: String(email || "").trim() }),
    })
      .then(function (res) {
        return parseJson(res).then(function (data) {
          if (res.status === 429) {
            return { ok: false, error: "rate_limited", issues: ["try again in a moment"], leaked: false };
          }
          return data && typeof data === "object" ? data : { ok: false, issues: ["could not check password"] };
        });
      })
      .catch(function () {
        return { ok: false, issues: ["could not check password"] };
      });
  }

  function requestPasswordReset(email) {
    return fetch(apiUrl("/api/auth/reset"), {
      method: "POST",
      mode: "cors",
      headers: authHeaders(""),
      body: JSON.stringify({ email: String(email || "").trim() }),
    }).then(function (res) {
      return parseJson(res).then(function (data) {
        if (res.status === 429 || (data && data.error === "rate_limited")) {
          return { ok: false, error: "rate_limited", message: "Too many reset emails. Wait a bit, then try again." };
        }
        if (!res.ok) {
          return { ok: false, error: (data && data.error) || "reset_failed", message: "Could not send a reset email." };
        }
        return { ok: true };
      });
    });
  }

  /**
   * Resolves true/false only for a definitive Worker answer.
   * Rejects on network / HTTP / auth failures so callers do not cache "not admin".
   */
  function fetchAdminMe(user) {
    if (!user || user.isAnonymous) return Promise.resolve(false);

    function request(forceRefresh) {
      return user.getIdToken(!!forceRefresh).then(function (token) {
        return fetch(apiUrl("/api/admin/me"), {
          method: "GET",
          mode: "cors",
          headers: { Authorization: "Bearer " + token, Accept: "application/json" },
        }).then(function (res) {
          // Stale ID token right after session restore — refresh once.
          if (res.status === 401 && !forceRefresh) {
            return request(true);
          }
          if (!res.ok) {
            var httpErr = new Error("admin_me_http_" + res.status);
            httpErr.status = res.status;
            return Promise.reject(httpErr);
          }
          return parseJson(res).then(function (data) {
            if (!data || data.ok !== true) {
              return Promise.reject(new Error("admin_me_bad_body"));
            }
            return !!data.admin;
          });
        });
      });
    }

    return request(false);
  }

  function storeGithubAccessToken(token) {
    memoryGithubToken = String(token || "");
    if (!memoryGithubToken) return Promise.resolve(false);
    return currentIdToken().then(function (idToken) {
      if (!idToken) return false;
      return fetch(apiUrl("/api/github/token"), {
        method: "POST",
        mode: "cors",
        headers: authHeaders(idToken),
        body: JSON.stringify({ token: memoryGithubToken }),
      })
        .then(function (res) {
          if (res.ok) memoryGithubToken = "";
          return res.ok;
        })
        .catch(function () {
          return false;
        });
    });
  }

  function clearGithubAccessToken() {
    memoryGithubToken = "";
    stripLocalStorageAuthTokens();
    return currentIdToken()
      .then(function (idToken) {
        if (!idToken) return;
        return fetch(apiUrl("/api/github/token"), {
          method: "DELETE",
          mode: "cors",
          headers: { Authorization: "Bearer " + idToken, Accept: "application/json" },
        });
      })
      .catch(function () {});
  }

  function fetchGithubExtras() {
    return currentIdToken().then(function (idToken) {
      if (!idToken) return { ok: false, missing: true, starred: false, notifications: [] };
      return fetch(apiUrl("/api/github/extras"), {
        method: "GET",
        mode: "cors",
        headers: { Authorization: "Bearer " + idToken, Accept: "application/json" },
      }).then(function (res) {
        return parseJson(res).then(function (data) {
          if (!res.ok || !data) return { ok: false, starred: false, notifications: [] };
          return data;
        });
      });
    });
  }

  function passwordCheckMessage(data) {
    if (!data) return "Could not check password.";
    if (data.leaked) {
      return "That password appears in a public data breach. Choose a different one.";
    }
    if (data.issues && data.issues.length) {
      return "Password needs " + data.issues.join(", ") + ".";
    }
    if (data.ok) return "Password looks strong.";
    return "Choose a stronger password.";
  }

  stripLocalStorageAuthTokens();

  global.ProxyListAuthSecurity = {
    apiUrl: apiUrl,
    stripLocalStorageAuthTokens: stripLocalStorageAuthTokens,
    guardAuth: guardAuth,
    checkPassword: checkPassword,
    requestPasswordReset: requestPasswordReset,
    fetchAdminMe: fetchAdminMe,
    storeGithubAccessToken: storeGithubAccessToken,
    clearGithubAccessToken: clearGithubAccessToken,
    fetchGithubExtras: fetchGithubExtras,
    passwordCheckMessage: passwordCheckMessage,
  };
})(typeof window !== "undefined" ? window : globalThis);
