(function () {
  "use strict";

  var SU = window.SubmissionUtils;
  var MAIN_LIST_URL = "../";
  var HISTORY_LIMIT = 120;

  function redirectToMainList() {
    window.location.replace(MAIN_LIST_URL);
  }

  if (!SU) {
    redirectToMainList();
    return;
  }

  var db = null;
  var currentUser = null;

  var gateNotice = document.getElementById("gateNotice");
  var statLinks = document.getElementById("statLinks");
  var statFeedback = document.getElementById("statFeedback");
  var statFolderReports = document.getElementById("statFolderReports");
  var statAppeals = document.getElementById("statAppeals");
  var historyBody = document.getElementById("historyBody");
  var historyMeta = document.getElementById("historyMeta");

  function esc(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function setTbodyHtml(el, html) {
    if (!el) return;
    var doc = new DOMParser().parseFromString(
      "<table><tbody>" + String(html || "") + "</tbody></table>",
      "text/html"
    );
    var nodes = Array.from(doc.querySelector("tbody").childNodes).map(function (n) {
      return document.importNode(n, true);
    });
    el.replaceChildren.apply(el, nodes);
  }

  async function ensureAdmin(user) {
    if (!SU.isSignedInNonAnonymous(user) || !(await SU.checkSubmissionAdmin(user))) {
      if (SU.denyAdminAccess(user, gateNotice)) return false;
      redirectToMainList();
      return false;
    }
    if (gateNotice) gateNotice.hidden = true;
    return true;
  }

  async function verifyFirestoreAdmin() {
    try {
      await db.collection("linkSubmissions").where("status", "==", "pending").limit(1).get();
      return true;
    } catch (err) {
      if (gateNotice) {
        gateNotice.hidden = false;
        gateNotice.className = "notice err";
        gateNotice.innerHTML =
          "Firestore denied access. Add your Firebase UID to " +
          "<code>config/submissions.adminUids</code>: <code>" +
          esc(currentUser.uid) +
          "</code>";
      }
      return false;
    }
  }

  function tsMillis(value) {
    if (!value) return 0;
    if (typeof value.toMillis === "function") return value.toMillis();
    if (typeof value.seconds === "number") return value.seconds * 1000;
    return 0;
  }

  function reviewedAtMs(data) {
    return tsMillis(data.updated) || tsMillis(data.created) || Number(data.dateMs) || 0;
  }

  function formatWhen(ms) {
    if (!ms) return "—";
    try {
      return new Date(ms).toLocaleString();
    } catch (_) {
      return "—";
    }
  }

  async function loadCounts() {
    var linksSnap = await db.collection("linkSubmissions").where("status", "==", "pending").limit(200).get();
    var feedbackSnap = await db.collection("siteFeedback").where("status", "==", "pending").limit(200).get();
    var folderReportsSnap = await db
      .collection("folderReports")
      .where("status", "==", "pending")
      .limit(200)
      .get();
    var appealsSnap = await db
      .collection("suspensionAppeals")
      .where("status", "==", "pending")
      .limit(100)
      .get();
    if (statLinks) statLinks.textContent = String(linksSnap.size);
    if (statFeedback) statFeedback.textContent = String(feedbackSnap.size);
    if (statFolderReports) statFolderReports.textContent = String(folderReportsSnap.size);
    if (statAppeals) statAppeals.textContent = String(appealsSnap.size);
  }

  async function fetchCollectionRecent(name) {
    try {
      return await db.collection(name).orderBy("created", "desc").limit(100).get();
    } catch (_) {
      return await db.collection(name).limit(100).get();
    }
  }

  function pushReviewed(rows, kind, label, snap, mapRow) {
    snap.forEach(function (doc) {
      var data = doc.data() || {};
      var status = String(data.status || "pending");
      if (status === "pending") return;
      var mapped = mapRow(doc.id, data, status);
      if (!mapped) return;
      rows.push({
        kind: kind,
        typeLabel: label,
        status: status,
        ms: reviewedAtMs(data),
        summary: mapped.summary,
        from: mapped.from,
      });
    });
  }

  async function loadHistory() {
    if (!historyBody) return;
    var rows = [];
    var snaps = await Promise.all([
      fetchCollectionRecent("linkSubmissions"),
      fetchCollectionRecent("siteFeedback"),
      fetchCollectionRecent("folderReports"),
      fetchCollectionRecent("suspensionAppeals"),
    ]);

    pushReviewed(rows, "submission", "Link submission", snaps[0], function (id, data, status) {
      return {
        summary:
          '<a href="' +
          esc(data.url || "#") +
          '" rel="noopener noreferrer" target="_blank">' +
          esc(data.url || "—") +
          "</a>" +
          (data.provider
            ? '<div class="muted" style="font-size:0.72rem;">Provider: ' + esc(data.provider) + "</div>"
            : "") +
          (data.reviewNote
            ? '<div class="muted" style="font-size:0.72rem;">Note: ' + esc(data.reviewNote) + "</div>"
            : ""),
        from: esc(data.submitterLabel || data.submitterUid || "—"),
      };
    });

    pushReviewed(rows, "feedback", "Feedback", snaps[1], function (id, data) {
      return {
        summary:
          "<strong>" +
          esc(data.title || "—") +
          "</strong>" +
          '<div class="muted" style="font-size:0.72rem;">' +
          esc(data.type || "") +
          "</div>" +
          '<div class="body-cell" style="margin-top:0.2rem;">' +
          esc((data.body || "").slice(0, 280)) +
          ((data.body || "").length > 280 ? "…" : "") +
          "</div>",
        from: esc(data.submitterLabel || data.submitterUid || "—"),
      };
    });

    pushReviewed(rows, "report", "Folder report", snaps[2], function (id, data) {
      return {
        summary:
          "<strong>" +
          esc(data.folderTitle || "—") +
          "</strong>" +
          '<div class="muted" style="font-size:0.72rem;">Owner: ' +
          esc(data.folderOwnerLabel || data.folderOwnerUid || "—") +
          "</div>" +
          '<div class="body-cell" style="margin-top:0.2rem;">' +
          esc((data.reason || "").slice(0, 280)) +
          ((data.reason || "").length > 280 ? "…" : "") +
          "</div>",
        from: esc(data.reporterLabel || data.reporterUid || "—"),
      };
    });

    pushReviewed(rows, "appeal", "Appeal", snaps[3], function (id, data) {
      return {
        summary:
          '<div class="body-cell">' +
          esc((data.body || "").slice(0, 320)) +
          ((data.body || "").length > 320 ? "…" : "") +
          "</div>" +
          (data.reviewNote
            ? '<div class="muted" style="font-size:0.72rem;">Review: ' + esc(data.reviewNote) + "</div>"
            : ""),
        from: esc(data.submitterLabel || data.submitterUid || "—"),
      };
    });

    rows.sort(function (a, b) {
      return b.ms - a.ms;
    });
    if (rows.length > HISTORY_LIMIT) rows = rows.slice(0, HISTORY_LIMIT);

    if (historyMeta) {
      historyMeta.textContent = rows.length
        ? "Showing " + rows.length + " most recently reviewed items."
        : "No reviewed items yet.";
    }
    if (!rows.length) {
      setTbodyHtml(
        historyBody,
        '<tr><td class="muted" colspan="5">No reviewed feedback, submissions, reports, or appeals yet.</td></tr>'
      );
      return;
    }

    setTbodyHtml(
      historyBody,
      rows
        .map(function (row) {
          var statusClass = String(row.status || "").replace(/[^a-z]/gi, "");
          return (
            "<tr>" +
            "<td>" +
            esc(formatWhen(row.ms)) +
            "</td>" +
            '<td><span class="type-pill">' +
            esc(row.typeLabel) +
            "</span></td>" +
            '<td><span class="status-pill ' +
            esc(statusClass) +
            '">' +
            esc(row.status) +
            "</span></td>" +
            "<td>" +
            row.summary +
            "</td>" +
            "<td>" +
            row.from +
            "</td>" +
            "</tr>"
          );
        })
        .join("")
    );
  }

  async function refreshAll() {
    if (!(await ensureAdmin(currentUser))) return;
    if (!(await verifyFirestoreAdmin())) return;
    await Promise.all([loadCounts(), loadHistory()]);
  }

  async function init() {
    var cfg = window.__FIREBASE_CONFIG__;
    if (!cfg || !cfg.apiKey || typeof firebase === "undefined") {
      if (SU.denyAdminAccess(null, gateNotice)) return;
      redirectToMainList();
      return;
    }
    if (!firebase.apps.length) firebase.initializeApp(cfg);
    db = firebase.firestore();
    document.getElementById("refreshBtn").addEventListener("click", function () {
      void refreshAll();
    });
    var auth = firebase.auth();
    await SU.whenAuthReady(auth);
    currentUser = auth.currentUser;
    if (!(await ensureAdmin(currentUser))) return;
    await refreshAll();
    auth.onAuthStateChanged(async function (user) {
      currentUser = user;
      if (!(await ensureAdmin(user))) return;
      await refreshAll();
    });
  }

  void init();
})();
