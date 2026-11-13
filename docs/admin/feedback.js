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
  var pendingBody = document.getElementById("pendingBody");
  var pendingMeta = document.getElementById("pendingMeta");
  var punishModal = document.getElementById("punishModal");
  var punishUserLabel = document.getElementById("punishUserLabel");
  var punishHistory = document.getElementById("punishHistory");
  var punishReason = document.getElementById("punishReason");
  var punishDurationBlock = document.getElementById("punishDurationBlock");
  var punishCustomAmount = document.getElementById("punishCustomAmount");
  var punishCustomUnit = document.getElementById("punishCustomUnit");
  var punishScope = document.getElementById("punishScope");
  var punishAlsoDeny = document.getElementById("punishAlsoDeny");
  var punishConfirmBtn = document.getElementById("punishConfirmBtn");
  var punishCancelBtn = document.getElementById("punishCancelBtn");
  var punishPresets = document.getElementById("punishPresets");
  var punishContext = null;
  var selectedPresetMs = null;

  var TYPE_LABELS = { bug: "Bug", feature: "Feature", qol: "QoL" };

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

  function showGate(msg) {
    if (gateNotice) {
      gateNotice.hidden = false;
      gateNotice.className = "notice err";
      gateNotice.textContent = msg;
    }
  }

  async function ensureAdmin(user) {
    if (!SU.isSignedInNonAnonymous(user) || !(await SU.checkSubmissionAdmin(user))) {
      if (SU.denyAdminAccess(user, gateNotice)) return false;
      redirectToMainList();
      return false;
    }
    if (gateNotice) {
      gateNotice.hidden = true;
      gateNotice.className = "notice";
    }
    return true;
  }

  async function verifyFirestoreAdmin() {
    try {
      await db.collection("siteFeedback").where("status", "==", "pending").limit(1).get();
      return true;
    } catch (err) {
      if (gateNotice) {
        gateNotice.hidden = false;
        gateNotice.className = "notice err";
        gateNotice.innerHTML =
          "Signed in as admin, but Firestore denied access. Deploy updated rules and ensure your UID is in " +
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

  function formatPunishHistory(stats) {
    var warnings = Number(stats && stats.warningCount) || 0;
    var suspensions = Number(stats && stats.suspensionCount) || 0;
    return (
      "History: " +
      warnings +
      " warning" +
      (warnings === 1 ? "" : "s") +
      " · " +
      suspensions +
      " suspension" +
      (suspensions === 1 ? "" : "s")
    );
  }

  async function loadPunishHistory(uid) {
    if (!punishHistory) return;
    if (!uid) {
      punishHistory.textContent = "History: unknown user";
      return;
    }
    punishHistory.textContent = "History: loading…";
    try {
      var snap = await db.collection("contributorStats").doc(uid).get();
      punishHistory.textContent = formatPunishHistory(snap.exists ? snap.data() : {});
    } catch (_) {
      punishHistory.textContent = "History: unavailable";
    }
  }

  function isWarningSelected() {
    return selectedPresetMs === "warning";
  }

  function syncPunishMode() {
    var warning = isWarningSelected();
    if (punishDurationBlock) punishDurationBlock.hidden = warning;
    if (punishConfirmBtn) {
      punishConfirmBtn.textContent = warning ? "Send warning" : "Apply suspension";
    }
  }

  async function warnUser(uid, reason) {
    await db.collection("contributorStats").doc(uid).set(
      {
        warningCount: firebase.firestore.FieldValue.increment(1),
        updated: firebase.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
    await notifyUser(uid, { kind: "warning", reason: reason || "", dateMs: Date.now() });
  }

  async function banUser(uid, reason, label, opts) {
    opts = opts || {};
    var until = opts.until || null;
    var scope = opts.scope || "both";
    await db.collection("contributorBans").doc(uid).set({
      uid: uid,
      reason: reason || "Spam or policy violation",
      submitterLabel: label || "",
      scope: scope,
      until: until,
      permanent: !until,
      bannedAt: firebase.firestore.FieldValue.serverTimestamp(),
      bannedByUid: currentUser.uid,
      appealSubmitted: false,
      appealSubmittedAt: null,
    });
    await db.collection("contributorStats").doc(uid).set(
      {
        submitBlocked: true,
        suspensionCount: firebase.firestore.FieldValue.increment(1),
        updated: firebase.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
    var kind =
      scope === "account"
        ? "account_suspended"
        : scope === "form"
          ? "form_suspended"
          : "suspended_both";
    await notifyUser(uid, { kind: kind, reason: reason || "", until: until });
  }

  async function setStatus(docId, status, reason) {
    var snap = await db.collection("siteFeedback").doc(docId).get();
    var row = snap.data() || {};
    await db.collection("siteFeedback").doc(docId).update({
      status: status,
      reviewNote: reason || "",
      updated: firebase.firestore.FieldValue.serverTimestamp(),
      reviewedByUid: currentUser.uid,
    });
    if (!row.submitterUid) return;
    var type = row.type || "feature";
    if (status === "done") {
      var kind = type === "bug" ? "bug_approved" : "feature_approved";
      var approvedNotice = { kind: kind, dateMs: Date.now() };
      if (reason) approvedNotice.reason = reason;
      await notifyUser(row.submitterUid, approvedNotice);
    } else if (status === "wontfix") {
      var denyKind = type === "bug" ? "bug_denied" : "feature_denied";
      await notifyUser(row.submitterUid, {
        kind: denyKind,
        dateMs: Date.now(),
        reason: reason || "No reason provided.",
      });
    }
  }

  function clearPresetActive() {
    if (!punishPresets) return;
    punishPresets.querySelectorAll(".btn").forEach(function (b) {
      b.classList.remove("active");
    });
  }

  function openPunishModal(row) {
    punishContext = row || {};
    selectedPresetMs = 86400000;
    if (punishUserLabel) {
      var parts = [];
      if (row.submitterLabel) parts.push(row.submitterLabel);
      if (row.submitterEmail) parts.push(row.submitterEmail);
      if (row.submitterUid) parts.push(row.submitterUid);
      punishUserLabel.textContent = parts.length ? parts.join(" · ") : "Unknown user";
    }
    void loadPunishHistory(row.submitterUid);
    if (punishReason) punishReason.value = "Spam, abuse, or policy violation";
    if (punishCustomAmount) punishCustomAmount.value = "";
    if (punishCustomUnit) punishCustomUnit.value = "days";
    if (punishScope) punishScope.value = "both";
    if (punishAlsoDeny) punishAlsoDeny.checked = true;
    clearPresetActive();
    if (punishPresets) {
      var dayBtn = punishPresets.querySelector('[data-ms="86400000"]');
      if (dayBtn) dayBtn.classList.add("active");
    }
    syncPunishMode();
    if (punishModal) {
      punishModal.classList.add("open");
      punishModal.setAttribute("aria-hidden", "false");
    }
  }

  function closePunishModal() {
    punishContext = null;
    if (punishModal) {
      punishModal.classList.remove("open");
      punishModal.setAttribute("aria-hidden", "true");
    }
  }

  function resolveUntilFromForm() {
    var customAmount = punishCustomAmount ? Number(punishCustomAmount.value) : 0;
    if (customAmount > 0) {
      var unit = punishCustomUnit ? punishCustomUnit.value : "days";
      var ms = customAmount;
      if (unit === "hours") ms *= 3600 * 1000;
      else if (unit === "days") ms *= 86400 * 1000;
      else if (unit === "weeks") ms *= 7 * 86400 * 1000;
      else if (unit === "months") ms *= 30 * 86400 * 1000;
      else ms *= 86400 * 1000;
      return firebase.firestore.Timestamp.fromDate(new Date(Date.now() + ms));
    }
    if (selectedPresetMs === "permanent" || selectedPresetMs == null) return null;
    var n = Number(selectedPresetMs);
    if (!n || n <= 0) return null;
    return firebase.firestore.Timestamp.fromDate(new Date(Date.now() + n));
  }

  async function applyPunish() {
    if (!punishContext || !punishContext.submitterUid) {
      alert("No submitter UID on this feedback.");
      return;
    }
    var reason = punishReason ? String(punishReason.value || "").trim() : "";
    if (!reason) {
      alert(isWarningSelected() ? "Enter a reason for the warning." : "Enter a reason for the suspension.");
      return;
    }
    var alsoDeny = !!(punishAlsoDeny && punishAlsoDeny.checked);
    if (punishConfirmBtn) punishConfirmBtn.disabled = true;
    try {
      if (alsoDeny && punishContext.id) {
        await setStatus(punishContext.id, "wontfix", reason);
      }
      if (isWarningSelected()) {
        await warnUser(punishContext.submitterUid, reason);
      } else {
        var until = resolveUntilFromForm();
        var scope = punishScope ? punishScope.value : "both";
        await banUser(punishContext.submitterUid, reason, punishContext.submitterLabel || "", {
          until: until,
          scope: scope,
        });
      }
      closePunishModal();
      await loadPending();
    } finally {
      if (punishConfirmBtn) punishConfirmBtn.disabled = false;
    }
  }

  function bindPunishModal() {
    if (punishPresets) {
      punishPresets.addEventListener("click", function (ev) {
        var btn = ev.target.closest("button[data-ms]");
        if (!btn) return;
        clearPresetActive();
        btn.classList.add("active");
        selectedPresetMs = btn.getAttribute("data-ms");
        if (punishCustomAmount) punishCustomAmount.value = "";
        syncPunishMode();
      });
    }
    if (punishCustomAmount) {
      punishCustomAmount.addEventListener("input", function () {
        if (String(punishCustomAmount.value || "").trim()) {
          clearPresetActive();
          selectedPresetMs = null;
          syncPunishMode();
        }
      });
    }
    if (punishCancelBtn) punishCancelBtn.addEventListener("click", closePunishModal);
    if (punishConfirmBtn) {
      punishConfirmBtn.addEventListener("click", function () {
        void applyPunish().catch(function (err) {
          alert((err && err.message) || "Punish failed");
        });
      });
    }
    if (punishModal) {
      punishModal.addEventListener("click", function (ev) {
        if (ev.target === punishModal) closePunishModal();
      });
    }
  }

  async function loadPending() {
    var snap = await db.collection("siteFeedback").where("status", "==", "pending").limit(200).get();
    var rows = snap.docs
      .map(function (d) {
        return Object.assign({ id: d.id }, d.data());
      })
      .sort(function (a, b) {
        var at = a.created && a.created.toMillis ? a.created.toMillis() : 0;
        var bt = b.created && b.created.toMillis ? b.created.toMillis() : 0;
        return bt - at;
      });

    if (pendingMeta) {
      pendingMeta.textContent = rows.length ? rows.length + " pending" : "No pending feedback.";
    }
    if (!rows.length) {
      setTbodyHtml(pendingBody, '<tr><td class="muted" colspan="5">No pending feedback.</td></tr>');
      return;
    }

    setTbodyHtml(
      pendingBody,
      rows
        .map(function (r) {
          var who = esc(r.submitterLabel || "—");
          if (r.submitterGithub) {
            who =
              '<a href="https://github.com/' +
              esc(r.submitterGithub) +
              '" target="_blank" rel="noopener noreferrer">' +
              who +
              "</a>";
          }
          var emailLine = r.submitterEmail
            ? '<div class="muted" style="font-size:0.72rem;">' + esc(r.submitterEmail) + "</div>"
            : "";
          return (
            '<tr data-id="' +
            esc(r.id) +
            '">' +
            "<td>" +
            esc(TYPE_LABELS[r.type] || r.type || "—") +
            "</td>" +
            "<td>" +
            esc(r.title || "—") +
            "</td>" +
            '<td class="body-cell">' +
            esc(r.body || "") +
            "</td>" +
            "<td>" +
            who +
            emailLine +
            '<div class="muted" style="font-size:0.72rem;">' +
            esc(r.submitterUid || "") +
            "</div></td>" +
            '<td><div class="actions">' +
            '<button class="btn btn-ok" type="button" data-act="done">Approve</button>' +
            '<button class="btn btn-danger" type="button" data-act="wontfix">Deny</button>' +
            '<button class="btn btn-danger" type="button" data-act="punish">Punish</button>' +
            "</div></td></tr>"
          );
        })
        .join("")
    );
  }

  async function refresh() {
    if (!(await ensureAdmin(currentUser))) return;
    if (!(await verifyFirestoreAdmin())) return;
    await loadPending();
  }

  function bindTable() {
    if (!pendingBody) return;
    pendingBody.addEventListener("click", function (ev) {
      var btn = ev.target.closest("button[data-act]");
      if (!btn) return;
      var tr = btn.closest("tr[data-id]");
      if (!tr) return;
      var id = tr.getAttribute("data-id");
      var act = btn.getAttribute("data-act");

      if (act === "punish") {
        btn.disabled = true;
        void db
          .collection("siteFeedback")
          .doc(id)
          .get()
          .then(function (snap) {
            openPunishModal(Object.assign({ id: id }, snap.data() || {}));
          })
          .catch(function (err) {
            alert((err && err.message) || "Could not load feedback");
          })
          .finally(function () {
            btn.disabled = false;
          });
        return;
      }

      var status = act === "done" ? "done" : act === "wontfix" ? "wontfix" : "";
      if (!status) return;
      var reason = "";
      if (status === "done") {
        var comment = window.prompt(
          "Optional comment for the user (leave blank for none, Cancel to stop):",
          ""
        );
        if (comment === null) return;
        reason = String(comment).trim().slice(0, 2000);
      } else {
        reason = window.prompt("Reason for denial (shown to the user):", "") || "";
      }
      btn.disabled = true;
      setStatus(id, status, reason)
        .then(function () {
          return loadPending();
        })
        .catch(function (err) {
          alert((err && err.message) || String(err));
          btn.disabled = false;
        });
    });
  }

  function initFirebase() {
    if (!firebase.apps.length) {
      var cfg = window.__FIREBASE_CONFIG__;
      if (!cfg || !cfg.apiKey) {
        showGate("Missing Firebase config.");
        return;
      }
      firebase.initializeApp(cfg);
    }
    db = firebase.firestore();
    var auth = firebase.auth();
    SU.whenAuthReady(auth).then(function () {
      currentUser = auth.currentUser;
      void refresh();
      auth.onAuthStateChanged(function (user) {
        currentUser = user;
        void refresh();
      });
    });
  }

  var refreshBtn = document.getElementById("refreshBtn");
  if (refreshBtn) {
    refreshBtn.addEventListener("click", function () {
      void refresh();
    });
  }
  bindTable();
  bindPunishModal();
  initFirebase();
})();
