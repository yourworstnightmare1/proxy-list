(function () {
  "use strict";

  var SU = window.SubmissionUtils;
  var MAIN_LIST_URL = "../";

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
  var bansBody = document.getElementById("bansBody");
  var bansMeta = document.getElementById("bansMeta");
  var flaggedSection = document.getElementById("flaggedSection");
  var flaggedBody = document.getElementById("flaggedBody");
  var appealsBody = document.getElementById("appealsBody");
  var appealsMeta = document.getElementById("appealsMeta");

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
      await db.collection("suspensionAppeals").where("status", "==", "pending").limit(1).get();
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

  async function notifyUser(uid, payload) {
    if (!uid) return;
    await db.collection("userNotifications").add(
      Object.assign(
        {
          uid: uid,
          read: false,
          created: firebase.firestore.FieldValue.serverTimestamp(),
          dateMs: Date.now(),
        },
        payload || {}
      )
    );
  }

  async function liftBan(uid, viaAppeal, comment) {
    if (!uid) return;
    await db.collection("contributorBans").doc(uid).delete();
    await db.collection("contributorStats").doc(uid).set(
      { submitBlocked: false, updated: firebase.firestore.FieldValue.serverTimestamp() },
      { merge: true }
    );
    var notice = { kind: viaAppeal ? "appeal_lifted" : "wait_lifted" };
    if (comment) notice.reason = comment;
    await notifyUser(uid, notice);
  }

  async function loadBans() {
    if (!bansBody) return;
    var snap = await db.collection("contributorBans").limit(100).get();
    var rows = [];
    snap.forEach(function (doc) {
      rows.push({ id: doc.id, data: doc.data() });
    });
    rows.sort(function (a, b) {
      var am = a.data.bannedAt && a.data.bannedAt.toMillis ? a.data.bannedAt.toMillis() : 0;
      var bm = b.data.bannedAt && b.data.bannedAt.toMillis ? b.data.bannedAt.toMillis() : 0;
      return bm - am;
    });
    if (bansMeta) {
      bansMeta.textContent = rows.length ? rows.length + " active" : "No active suspensions.";
    }
    if (!rows.length) {
      setTbodyHtml(bansBody, '<tr><td class="muted" colspan="6">No active suspensions.</td></tr>');
      return;
    }
    setTbodyHtml(
      bansBody,
      rows
        .map(function (row) {
          var s = row.data;
          var untilLabel = "Permanent";
          if (s.until && s.until.toDate) untilLabel = s.until.toDate().toLocaleString();
          return (
            "<tr>" +
            "<td>" +
            esc(s.submitterLabel || "—") +
            "</td>" +
            "<td><code>" +
            esc(row.id) +
            "</code></td>" +
            "<td>" +
            esc(s.scope || "both") +
            "</td>" +
            "<td>" +
            esc(untilLabel) +
            "</td>" +
            "<td>" +
            esc(s.reason || "—") +
            "</td>" +
            '<td><div class="actions">' +
            '<button class="btn btn-ok" type="button" data-lift-uid="' +
            esc(row.id) +
            '" data-lift-kind="appeal">Lift (appeal)</button>' +
            '<button class="btn" type="button" data-lift-uid="' +
            esc(row.id) +
            '" data-lift-kind="wait">Lift (waited)</button>' +
            "</div></td>" +
            "</tr>"
          );
        })
        .join("")
    );
    bansBody.querySelectorAll("[data-lift-uid]").forEach(function (btn) {
      btn.addEventListener("click", async function () {
        var uid = btn.getAttribute("data-lift-uid");
        var viaAppeal = btn.getAttribute("data-lift-kind") === "appeal";
        if (!uid || !confirm(viaAppeal ? "Lift after appeal review?" : "Lift after waiting out suspension?")) return;
        btn.disabled = true;
        try {
          await liftBan(uid, viaAppeal);
          await refreshAll();
        } catch (err) {
          alert((err && err.message) || "Lift failed");
          btn.disabled = false;
        }
      });
    });
  }

  async function loadFlagged() {
    if (!flaggedBody || !flaggedSection) return;
    var snap = await db.collection("contributorStats").where("duplicatesAttempted", ">=", 5).limit(50).get();
    var rows = [];
    snap.forEach(function (doc) {
      rows.push({ id: doc.id, data: doc.data() });
    });
    if (!rows.length) {
      flaggedSection.hidden = true;
      return;
    }
    flaggedSection.hidden = false;
    setTbodyHtml(
      flaggedBody,
      rows
        .map(function (row) {
          var s = row.data;
          return (
            "<tr>" +
            "<td><code>" +
            esc(row.id) +
            "</code></td>" +
            "<td>" +
            esc(String(s.duplicatesAttempted || 0)) +
            "</td>" +
            "<td>" +
            esc(String(s.submissionsTotal || 0)) +
            "</td>" +
            "<td>" +
            (s.submitBlocked ? "yes" : "no") +
            "</td>" +
            "</tr>"
          );
        })
        .join("")
    );
  }

  async function loadAppeals() {
    if (!appealsBody) return;
    var snap = await db.collection("suspensionAppeals").where("status", "==", "pending").limit(100).get();
    var rows = [];
    snap.forEach(function (doc) {
      rows.push({ id: doc.id, data: doc.data() });
    });
    rows.sort(function (a, b) {
      var am = a.data.created && a.data.created.toMillis ? a.data.created.toMillis() : 0;
      var bm = b.data.created && b.data.created.toMillis ? b.data.created.toMillis() : 0;
      return bm - am;
    });
    if (appealsMeta) {
      appealsMeta.textContent = rows.length ? rows.length + " pending" : "No pending appeals.";
    }
    if (!rows.length) {
      setTbodyHtml(appealsBody, '<tr><td class="muted" colspan="3">No pending appeals.</td></tr>');
      return;
    }
    setTbodyHtml(
      appealsBody,
      rows
        .map(function (row) {
          var s = row.data;
          var who = esc(s.submitterLabel || "—");
          if (s.submitterEmail) {
            who += '<div class="muted" style="font-size:0.72rem;">' + esc(s.submitterEmail) + "</div>";
          }
          who += '<div class="muted" style="font-size:0.72rem;"><code>' + esc(s.submitterUid || row.id) + "</code></div>";
          return (
            "<tr>" +
            "<td>" +
            who +
            "</td>" +
            '<td class="body-cell">' +
            esc(s.body || "") +
            "</td>" +
            '<td><div class="actions">' +
            '<button class="btn btn-ok" type="button" data-appeal-act="approve" data-appeal-id="' +
            esc(row.id) +
            '" data-appeal-uid="' +
            esc(s.submitterUid || "") +
            '">Approve &amp; lift</button>' +
            '<button class="btn btn-danger" type="button" data-appeal-act="deny" data-appeal-id="' +
            esc(row.id) +
            '" data-appeal-uid="' +
            esc(s.submitterUid || "") +
            '">Deny</button>' +
            "</div></td>" +
            "</tr>"
          );
        })
        .join("")
    );
    appealsBody.querySelectorAll("[data-appeal-act]").forEach(function (btn) {
      btn.addEventListener("click", async function () {
        var act = btn.getAttribute("data-appeal-act");
        var id = btn.getAttribute("data-appeal-id");
        var uid = btn.getAttribute("data-appeal-uid");
        if (!id) return;
        var comment = "";
        if (act === "approve") {
          var entered = window.prompt(
            "Optional comment for the user (leave blank for none, Cancel to stop):",
            ""
          );
          if (entered === null) return;
          comment = String(entered).trim().slice(0, 2000);
        }
        btn.disabled = true;
        try {
          if (act === "approve") {
            if (!uid) throw new Error("Missing submitter UID");
            await db.collection("suspensionAppeals").doc(id).update({
              status: "approved",
              reviewNote: comment,
              reviewedByUid: currentUser.uid,
              updated: firebase.firestore.FieldValue.serverTimestamp(),
            });
            await liftBan(uid, true, comment);
          } else if (act === "deny") {
            var reason =
              window.prompt("Reason for denying this appeal (shown to the user):", "") ||
              "Appeal denied.";
            await db.collection("suspensionAppeals").doc(id).update({
              status: "denied",
              reviewNote: reason,
              reviewedByUid: currentUser.uid,
              updated: firebase.firestore.FieldValue.serverTimestamp(),
            });
            if (uid) {
              await notifyUser(uid, {
                kind: "appeal_denied",
                reason: reason,
                dateMs: Date.now(),
              });
            }
          }
          await refreshAll();
        } catch (err) {
          alert((err && err.message) || "Appeal action failed");
          btn.disabled = false;
        }
      });
    });
  }

  async function refreshAll() {
    if (!(await ensureAdmin(currentUser))) return;
    if (!(await verifyFirestoreAdmin())) return;
    await Promise.all([loadAppeals(), loadBans(), loadFlagged()]);
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
