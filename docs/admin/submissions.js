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
  var userProfiles = {};

  var gateNotice = document.getElementById("gateNotice");
  var pendingBody = document.getElementById("pendingBody");
  var pendingMeta = document.getElementById("pendingMeta");
  var recentBody = document.getElementById("recentBody");
  var recentMeta = document.getElementById("recentMeta");
  var flaggedSection = document.getElementById("flaggedSection");
  var flaggedBody = document.getElementById("flaggedBody");
  var bansBody = document.getElementById("bansBody");
  var bansMeta = document.getElementById("bansMeta");
  var copySection = document.getElementById("copySection");
  var copyBox = document.getElementById("copyBox");
  var punishModal = document.getElementById("punishModal");
  var punishUserLabel = document.getElementById("punishUserLabel");
  var punishHistory = document.getElementById("punishHistory");
  var punishReason = document.getElementById("punishReason");
  var punishDurationBlock = document.getElementById("punishDurationBlock");
  var punishCustomAmount = document.getElementById("punishCustomAmount");
  var punishCustomUnit = document.getElementById("punishCustomUnit");
  var punishScope = document.getElementById("punishScope");
  var punishAlsoReject = document.getElementById("punishAlsoReject");
  var punishConfirmBtn = document.getElementById("punishConfirmBtn");
  var punishCancelBtn = document.getElementById("punishCancelBtn");
  var punishPresets = document.getElementById("punishPresets");
  var punishContext = null;
  var selectedPresetMs = null;

  function esc(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function setTbodyHtml(el, html) {
    if (!el) return;
    var doc = new DOMParser().parseFromString("<table><tbody>" + String(html || "") + "</tbody></table>", "text/html");
    var nodes = Array.from(doc.querySelector("tbody").childNodes).map(function (n) {
      return document.importNode(n, true);
    });
    el.replaceChildren.apply(el, nodes);
  }

  function showGate(msg) {
    if (gateNotice) {
      gateNotice.hidden = false;
      gateNotice.textContent = msg;
    }
  }

  function contributorMd(sub) {
    return SU.contributorMdFromFields(sub.submitterLabel, sub.submitterGithub || "");
  }

  async function ensureAdmin(user) {
    if (!SU.isSignedInNonAnonymous(user) || !SU.isSubmissionAdminUser(user)) {
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
      await db.collection("linkSubmissions").where("status", "==", "pending").limit(1).get();
      return true;
    } catch (err) {
      if (gateNotice) {
        gateNotice.hidden = false;
        gateNotice.className = "notice err";
        gateNotice.innerHTML =
          "Signed in as admin, but Firestore denied access. Add your Firebase UID to " +
          '<code>config/submissions.adminUids</code> in the Firebase console: <code>' +
          esc(currentUser.uid) +
          "</code>";
      }
      return false;
    }
  }

  async function notifyUser(uid, payload) {
    if (!uid) return;
    var data = Object.assign(
      {
        uid: uid,
        read: false,
        created: firebase.firestore.FieldValue.serverTimestamp(),
        dateMs: Date.now(),
      },
      payload || {}
    );
    await db.collection("userNotifications").add(data);
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

  async function liftBan(uid, viaAppeal) {
    if (!uid) return;
    await db.collection("contributorBans").doc(uid).delete();
    await db.collection("contributorStats").doc(uid).set(
      { submitBlocked: false, updated: firebase.firestore.FieldValue.serverTimestamp() },
      { merge: true }
    );
    await notifyUser(uid, { kind: viaAppeal ? "appeal_lifted" : "wait_lifted" });
  }

  async function clearPendingSubmissionKey(sub) {
    if (!sub || !sub.urlKeyHash) return;
    try {
      await db.collection("pendingSubmissionKeys").doc(sub.urlKeyHash).delete();
    } catch (_) {}
  }

  async function updateSubmission(docId, status, reviewNote, extra) {
    var subSnap = await db.collection("linkSubmissions").doc(docId).get();
    var sub = subSnap.data() || {};
    var payload = {
      status: status,
      reviewNote: reviewNote || "",
      reviewedBy: currentUser.uid,
      updated: firebase.firestore.FieldValue.serverTimestamp(),
    };
    if (extra && typeof extra === "object") {
      Object.keys(extra).forEach(function (k) {
        payload[k] = extra[k];
      });
    }
    await db.collection("linkSubmissions").doc(docId).update(payload);
    if (status !== "pending") await clearPendingSubmissionKey(sub);
  }

  async function requestPublishSync() {
    try {
      var base =
        (window.__PROXY_LIST_API_BASE__ || "https://proxy-list.jasonthegamer48.workers.dev").replace(
          /\/$/,
          ""
        );
      var token = currentUser && (await currentUser.getIdToken());
      if (!token) return;
      await fetch(base + "/api/submissions/sync", {
        method: "POST",
        headers: {
          Authorization: "Bearer " + token,
          "Content-Type": "application/json",
        },
        body: "{}",
      });
    } catch (_) {
      /* optional kick; scheduled sync still picks approvals up */
    }
  }

  async function onApprove(docId, sub) {
    await updateSubmission(docId, "approved", "", {
      publishedToList: false,
      publishQueued: true,
    });
    var row = SU.formatListMdRow(sub.url, contributorMd(sub));
    if (copyBox) copyBox.value = row;
    if (copySection) copySection.hidden = false;
    await requestPublishSync();
    await notifyUser(sub.submitterUid, {
      kind: "links_approved",
      count: 1,
      dateMs: Date.now(),
    });
    await loadPending();
    await loadRecent();
  }

  async function onReject(docId, reason) {
    var note = reason;
    if (!note) {
      note = window.prompt("Reason for denying this link request (shown to the user):", "") || "";
    }
    await updateSubmission(docId, "rejected", note);
    var subSnap = await db.collection("linkSubmissions").doc(docId).get();
    var sub = subSnap.data() || {};
    if (sub.submitterUid) {
      var statsSnap = await db.collection("contributorStats").doc(sub.submitterUid).get();
      var stats = statsSnap.exists ? statsSnap.data() : {};
      await db.collection("contributorStats").doc(sub.submitterUid).set(
        {
          uid: sub.submitterUid,
          rejectedTotal: (Number(stats.rejectedTotal) || 0) + 1,
          updated: firebase.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
      await notifyUser(sub.submitterUid, {
        kind: "links_denied",
        count: 1,
        dateMs: Date.now(),
        reason: note || "No reason provided.",
      });
    }
    await loadPending();
    await loadRecent();
  }

  async function onRejectBan(docId, sub) {
    openPunishModal(docId, sub);
  }

  function clearPresetActive() {
    if (!punishPresets) return;
    punishPresets.querySelectorAll(".btn").forEach(function (b) {
      b.classList.remove("active");
    });
  }

  function openPunishModal(docId, sub) {
    punishContext = { docId: docId, sub: sub || {} };
    selectedPresetMs = 86400000;
    if (punishUserLabel) {
      var parts = [];
      if (sub.submitterLabel) parts.push(sub.submitterLabel);
      if (sub.submitterEmail) parts.push(sub.submitterEmail);
      if (sub.submitterUid) parts.push(sub.submitterUid);
      punishUserLabel.textContent = parts.length ? parts.join(" · ") : "Unknown user";
    }
    void loadPunishHistory(sub.submitterUid);
    if (punishReason) {
      punishReason.value = "Spam, malicious, or repeated bad submissions";
    }
    if (punishCustomAmount) punishCustomAmount.value = "";
    if (punishCustomUnit) punishCustomUnit.value = "days";
    if (punishScope) punishScope.value = "both";
    if (punishAlsoReject) {
      punishAlsoReject.checked = !!docId;
      punishAlsoReject.disabled = !docId;
      var rejectLabel = punishAlsoReject.parentNode;
      if (rejectLabel) rejectLabel.style.display = docId ? "" : "none";
    }
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
    if (!punishContext || !punishContext.sub || !punishContext.sub.submitterUid) {
      alert("No submitter UID on this submission.");
      return;
    }
    var reason = punishReason ? String(punishReason.value || "").trim() : "";
    if (!reason) {
      alert(isWarningSelected() ? "Enter a reason for the warning." : "Enter a reason for the suspension.");
      return;
    }
    var alsoReject = !!(punishAlsoReject && punishAlsoReject.checked);
    if (punishConfirmBtn) punishConfirmBtn.disabled = true;
    try {
      if (alsoReject && punishContext.docId) {
        await onReject(punishContext.docId, reason);
      }
      if (isWarningSelected()) {
        await warnUser(punishContext.sub.submitterUid, reason);
      } else {
        var until = resolveUntilFromForm();
        var scope = punishScope ? punishScope.value : "both";
        await banUser(punishContext.sub.submitterUid, reason, punishContext.sub.submitterLabel || "", {
          until: until,
          scope: scope,
        });
      }
      closePunishModal();
      await loadPending();
      await loadRecent();
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

  function bindPendingActions() {
    document.querySelectorAll("[data-action]").forEach(function (btn) {
      btn.addEventListener("click", async function () {
        var action = btn.getAttribute("data-action");
        var id = btn.getAttribute("data-id");
        if (!id) return;
        btn.disabled = true;
        try {
          var snap = await db.collection("linkSubmissions").doc(id).get();
          var sub = snap.data() || {};
          if (action === "approve") await onApprove(id, sub);
          else if (action === "reject") await onReject(id, "");
          else if (action === "ban") await onRejectBan(id, sub);
          else if (action === "punish") openPunishModal(id, sub);
        } catch (err) {
          alert((err && err.message) || "Action failed");
        } finally {
          if (action !== "punish") btn.disabled = false;
          else btn.disabled = false;
        }
      });
    });
  }

  async function loadPending() {
    if (!pendingBody) return;
    var snap = await db.collection("linkSubmissions").where("status", "==", "pending").limit(200).get();
    var rows = [];
    snap.forEach(function (doc) {
      rows.push({ id: doc.id, data: doc.data() });
    });
    rows.sort(function (a, b) {
      var am = a.data.created && a.data.created.toMillis ? a.data.created.toMillis() : 0;
      var bm = b.data.created && b.data.created.toMillis ? b.data.created.toMillis() : 0;
      return bm - am;
    });
    if (pendingMeta) {
      pendingMeta.textContent = rows.length
        ? rows.length + " pending"
        : "No pending link submissions. New ones appear after someone uses Submit a link for review on Contribute (not the feedback form).";
    }
    if (!rows.length) {
      setTbodyHtml(
        pendingBody,
        '<tr><td class="muted" colspan="5">No pending link submissions.</td></tr>'
      );
      return;
    }
    setTbodyHtml(
      pendingBody,
      rows
        .map(function (row) {
          var s = row.data;
          var provider = esc(s.provider || "") + (s.isNewProvider ? ' <span class="muted">(new)</span>' : "");
          return (
            "<tr>" +
            '<td><a href="' +
            esc(s.url) +
            '" rel="noopener noreferrer" target="_blank">' +
            esc(s.url) +
            "</a></td>" +
            "<td>" +
            provider +
            "</td>" +
            "<td>" +
            esc(s.submitterLabel || s.submitterUid || "") +
            (s.submitterEmail
              ? '<div class="muted" style="font-size:0.72rem;">' + esc(s.submitterEmail) + "</div>"
              : "") +
            (s.submitterGithub
              ? '<div class="muted" style="font-size:0.72rem;"><a href="https://github.com/' +
                esc(s.submitterGithub) +
                '" target="_blank" rel="noopener noreferrer">@' +
                esc(s.submitterGithub) +
                "</a></div>"
              : "") +
            "</td>" +
            "<td>" +
            esc(s.optionalNote || "—") +
            "</td>" +
            '<td><div class="actions">' +
            '<button class="btn btn-ok" type="button" data-action="approve" data-id="' +
            esc(row.id) +
            '">Approve</button>' +
            '<button class="btn" type="button" data-action="reject" data-id="' +
            esc(row.id) +
            '">Reject</button>' +
            '<button class="btn btn-danger" type="button" data-action="punish" data-id="' +
            esc(row.id) +
            '">Punish</button>' +
            "</div></td>" +
            "</tr>"
          );
        })
        .join("")
    );
    bindPendingActions();
  }

  function submitterCell(s) {
    return (
      esc(s.submitterLabel || s.submitterUid || "") +
      (s.submitterEmail
        ? '<div class="muted" style="font-size:0.72rem;">' + esc(s.submitterEmail) + "</div>"
        : "") +
      (s.submitterGithub
        ? '<div class="muted" style="font-size:0.72rem;"><a href="https://github.com/' +
          esc(s.submitterGithub) +
          '" target="_blank" rel="noopener noreferrer">@' +
          esc(s.submitterGithub) +
          "</a></div>"
        : "")
    );
  }

  async function loadRecent() {
    if (!recentBody) return;
    var rows = [];
    try {
      var snap = await db.collection("linkSubmissions").orderBy("created", "desc").limit(50).get();
      snap.forEach(function (doc) {
        rows.push({ id: doc.id, data: doc.data() });
      });
    } catch (err) {
      try {
        var snap2 = await db.collection("linkSubmissions").limit(50).get();
        snap2.forEach(function (doc) {
          rows.push({ id: doc.id, data: doc.data() });
        });
        rows.sort(function (a, b) {
          var am = a.data.created && a.data.created.toMillis ? a.data.created.toMillis() : 0;
          var bm = b.data.created && b.data.created.toMillis ? b.data.created.toMillis() : 0;
          return bm - am;
        });
      } catch (err2) {
        if (recentMeta) recentMeta.textContent = "Could not load recent submissions.";
        setTbodyHtml(
          recentBody,
          '<tr><td class="muted" colspan="5">' + esc((err2 && err2.message) || "Load failed") + "</td></tr>"
        );
        return;
      }
    }
    if (recentMeta) {
      recentMeta.textContent = rows.length
        ? "Showing " + rows.length + " most recent"
        : "No link submissions in Firestore yet.";
    }
    if (!rows.length) {
      setTbodyHtml(
        recentBody,
        '<tr><td class="muted" colspan="5">No link submissions yet. Use Contribute → Submit a link for review.</td></tr>'
      );
      return;
    }
    setTbodyHtml(
      recentBody,
      rows
        .map(function (row) {
          var s = row.data;
          var status = String(s.status || "pending");
          return (
            "<tr>" +
            '<td><a href="' +
            esc(s.url || "#") +
            '" rel="noopener noreferrer" target="_blank">' +
            esc(s.url || "—") +
            "</a></td>" +
            "<td>" +
            esc(s.provider || "") +
            (s.isNewProvider ? ' <span class="muted">(new)</span>' : "") +
            "</td>" +
            "<td>" +
            submitterCell(s) +
            "</td>" +
            '<td><span class="status-pill ' +
            esc(status.replace(/[^a-z]/gi, "")) +
            '">' +
            esc(status) +
            "</span></td>" +
            "<td>" +
            esc(s.optionalNote || s.reviewNote || "—") +
            "</td>" +
            "</tr>"
          );
        })
        .join("")
    );
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
          if (s.until && s.until.toDate) {
            untilLabel = s.until.toDate().toLocaleString();
          }
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
          await loadBans();
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
            "<td>" +
            esc(s.uid) +
            "</td>" +
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
            '<td><button class="btn btn-danger" type="button" data-ban-uid="' +
            esc(row.id) +
            '">Punish</button></td>' +
            "</tr>"
          );
        })
        .join("")
    );
    document.querySelectorAll("[data-ban-uid]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var uid = btn.getAttribute("data-ban-uid");
        if (!uid) return;
        openPunishModal(null, { submitterUid: uid, submitterLabel: "" });
        if (punishScope) punishScope.value = "form";
      });
    });
  }

  async function refreshAll() {
    if (!(await ensureAdmin(currentUser))) return;
    if (!(await verifyFirestoreAdmin())) return;
    await Promise.all([loadPending(), loadRecent()]);
  }

  function init() {
    var cfg = window.__FIREBASE_CONFIG__;
    if (!cfg || !cfg.apiKey || typeof firebase === "undefined") {
      showGate("Firebase is not configured.");
      redirectToMainList();
      return;
    }
    if (!firebase.apps.length) firebase.initializeApp(cfg);
    db = firebase.firestore();

    document.getElementById("refreshBtn").addEventListener("click", refreshAll);
    document.getElementById("copyBtn").addEventListener("click", function () {
      if (!copyBox) return;
      copyBox.select();
      navigator.clipboard.writeText(copyBox.value).catch(function () {
        document.execCommand("copy");
      });
    });
    bindPunishModal();

    firebase.auth().onAuthStateChanged(async function (user) {
      currentUser = user;
      if (!(await ensureAdmin(user))) return;
      await refreshAll();
    });
  }

  init();
})();
