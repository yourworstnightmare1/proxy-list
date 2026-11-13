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
  var punishAlsoDelete = document.getElementById("punishAlsoDelete");
  var punishConfirmBtn = document.getElementById("punishConfirmBtn");
  var punishCancelBtn = document.getElementById("punishCancelBtn");
  var punishPresets = document.getElementById("punishPresets");
  var punishContext = null;
  var selectedPresetMs = 86400000;

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
    if (gateNotice) {
      gateNotice.hidden = true;
      gateNotice.className = "notice";
    }
    return true;
  }

  async function verifyFirestoreAdmin() {
    try {
      await db.collection("folderReports").where("status", "==", "pending").limit(1).get();
      return true;
    } catch (err) {
      if (gateNotice) {
        gateNotice.hidden = false;
        gateNotice.className = "notice err";
        gateNotice.innerHTML =
          "Firestore denied access. Deploy updated rules and ensure your UID is in " +
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

  async function dismissReport(docId) {
    await db.collection("folderReports").doc(docId).update({
      status: "dismissed",
      reviewedByUid: currentUser ? currentUser.uid : "",
      updated: firebase.firestore.FieldValue.serverTimestamp(),
    });
  }

  async function deleteReportedFolder(folderId) {
    if (!folderId) return;
    await db.collection("savedFolders").doc(folderId).delete();
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
      if (row.folderOwnerLabel) parts.push(row.folderOwnerLabel);
      if (row.folderOwnerUid) parts.push(row.folderOwnerUid);
      if (row.folderTitle) parts.push('Folder: "' + row.folderTitle + '"');
      punishUserLabel.textContent = parts.length ? parts.join(" · ") : "Unknown folder owner";
    }
    void loadPunishHistory(row.folderOwnerUid);
    if (punishReason) {
      punishReason.value = "Inappropriate folder or creator name";
    }
    if (punishCustomAmount) punishCustomAmount.value = "";
    if (punishCustomUnit) punishCustomUnit.value = "days";
    if (punishScope) punishScope.value = "account";
    if (punishAlsoDelete) {
      punishAlsoDelete.checked = true;
      punishAlsoDelete.disabled = !row.folderId;
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
    if (!punishContext || !punishContext.folderOwnerUid) {
      window.alert("No folder owner UID on this report.");
      return;
    }
    var reason = punishReason ? String(punishReason.value || "").trim() : "";
    if (!reason) {
      window.alert(isWarningSelected() ? "Enter a reason for the warning." : "Enter a reason for the suspension.");
      return;
    }
    var alsoDelete = !!(punishAlsoDelete && punishAlsoDelete.checked && punishContext.folderId);
    if (punishConfirmBtn) punishConfirmBtn.disabled = true;
    try {
      if (isWarningSelected()) {
        await warnUser(punishContext.folderOwnerUid, reason);
      } else {
        var until = resolveUntilFromForm();
        var scope = punishScope ? punishScope.value : "account";
        await banUser(punishContext.folderOwnerUid, reason, punishContext.folderOwnerLabel || "", {
          until: until,
          scope: scope,
        });
      }
      if (alsoDelete) {
        await deleteReportedFolder(punishContext.folderId);
        if (punishContext.reportId) await dismissReport(punishContext.reportId);
      }
      closePunishModal();
      await loadPending();
    } catch (err) {
      console.warn("[folder-reports] punish failed", err);
      window.alert("Could not apply " + (isWarningSelected() ? "warning" : "suspension") + ".");
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
        void applyPunish();
      });
    }
    if (punishModal) {
      punishModal.addEventListener("click", function (ev) {
        if (ev.target === punishModal) closePunishModal();
      });
    }
  }

  async function loadPending() {
    if (!pendingBody) return;
    var snap = await db.collection("folderReports").where("status", "==", "pending").limit(200).get();
    var rows = [];
    snap.forEach(function (doc) {
      rows.push({ id: doc.id, data: doc.data() || {} });
    });
    rows.sort(function (a, b) {
      var am = a.data.created && a.data.created.toMillis ? a.data.created.toMillis() : 0;
      var bm = b.data.created && b.data.created.toMillis ? b.data.created.toMillis() : 0;
      return bm - am;
    });
    if (pendingMeta) {
      pendingMeta.textContent = rows.length
        ? rows.length + " pending report" + (rows.length === 1 ? "" : "s")
        : "No pending folder reports.";
    }
    if (!rows.length) {
      setTbodyHtml(pendingBody, '<tr><td class="muted" colspan="5">No pending folder reports.</td></tr>');
      return;
    }
    setTbodyHtml(
      pendingBody,
      rows
        .map(function (row) {
          var d = row.data;
          var tags = "";
          if (d.reportFolderName) tags += '<span class="tag">Folder name</span>';
          if (d.reportCreatorName) tags += '<span class="tag">Creator name</span>';
          var folderHref = "../?folder=" + encodeURIComponent(d.folderId || "");
          var canPunish = !!(d.folderOwnerUid);
          return (
            "<tr>" +
            "<td><strong>" +
            esc(d.folderTitle || "(untitled)") +
            '</strong><div class="muted">Creator: ' +
            esc(d.folderOwnerLabel || "—") +
            '</div><div class="muted"><code>' +
            esc(d.folderId || "") +
            '</code></div><div><a href="' +
            esc(folderHref) +
            '" target="_blank" rel="noopener noreferrer">Open folder</a></div></td>' +
            "<td>" +
            tags +
            "</td>" +
            '<td class="body-cell">' +
            esc(d.reason || "") +
            "</td>" +
            "<td>" +
            esc(d.reporterLabel || "—") +
            (d.reporterGithub ? '<div class="muted">@' + esc(d.reporterGithub) + "</div>" : "") +
            "</td>" +
            '<td><div class="actions">' +
            '<button class="btn btn-ok" type="button" data-dismiss-id="' +
            esc(row.id) +
            '">Dismiss</button>' +
            (canPunish
              ? '<button class="btn btn-danger" type="button" data-punish-id="' +
                esc(row.id) +
                '">Punish</button>'
              : "") +
            '<button class="btn btn-danger" type="button" data-delete-folder-id="' +
            esc(d.folderId || "") +
            '" data-dismiss-with="' +
            esc(row.id) +
            '">Delete folder</button>' +
            "</div></td>" +
            "</tr>"
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

  document.addEventListener("click", function (ev) {
    var t = ev.target;
    if (!t || !t.closest) return;

    var punishBtn = t.closest("[data-punish-id]");
    if (punishBtn) {
      var reportId = punishBtn.getAttribute("data-punish-id");
      if (!reportId) return;
      punishBtn.disabled = true;
      db.collection("folderReports")
        .doc(reportId)
        .get()
        .then(function (snap) {
          punishBtn.disabled = false;
          if (!snap.exists) {
            window.alert("Report no longer exists.");
            return loadPending();
          }
          var d = snap.data() || {};
          openPunishModal({
            reportId: reportId,
            folderId: d.folderId || "",
            folderTitle: d.folderTitle || "",
            folderOwnerUid: d.folderOwnerUid || "",
            folderOwnerLabel: d.folderOwnerLabel || "",
          });
        })
        .catch(function (err) {
          console.warn("[folder-reports] load report failed", err);
          window.alert("Could not open punish dialog.");
          punishBtn.disabled = false;
        });
      return;
    }

    var dismissBtn = t.closest("button.btn-ok[data-dismiss-id]");
    if (dismissBtn) {
      var dismissId = dismissBtn.getAttribute("data-dismiss-id");
      if (!dismissId) return;
      dismissBtn.disabled = true;
      dismissReport(dismissId)
        .then(function () {
          return loadPending();
        })
        .catch(function (err) {
          console.warn("[folder-reports] dismiss failed", err);
          window.alert("Could not dismiss report.");
          dismissBtn.disabled = false;
        });
      return;
    }

    var delBtn = t.closest("[data-delete-folder-id]");
    if (delBtn) {
      var folderId = delBtn.getAttribute("data-delete-folder-id");
      var reportIdDel = delBtn.getAttribute("data-dismiss-with");
      if (!folderId || !window.confirm("Delete this folder permanently and clear the report?")) return;
      delBtn.disabled = true;
      deleteReportedFolder(folderId)
        .then(function () {
          return reportIdDel ? dismissReport(reportIdDel) : null;
        })
        .then(function () {
          return loadPending();
        })
        .catch(function (err) {
          console.warn("[folder-reports] delete folder failed", err);
          window.alert("Could not delete folder. Dismiss the report manually if needed.");
          delBtn.disabled = false;
        });
    }
  });

  var refreshBtn = document.getElementById("refreshBtn");
  if (refreshBtn) refreshBtn.addEventListener("click", function () {
    void refresh();
  });

  bindPunishModal();

  try {
    if (!firebase.apps.length) {
      var cfg = window.__FIREBASE_CONFIG__;
      if (!cfg || !cfg.apiKey) {
        SU.denyAdminAccess(null, gateNotice);
        return;
      }
      firebase.initializeApp(cfg);
    }
    db = firebase.firestore();
    var auth = firebase.auth();
    SU.whenAuthReady(auth).then(function () {
      currentUser = auth.currentUser && !auth.currentUser.isAnonymous ? auth.currentUser : null;
      void refresh();
      auth.onAuthStateChanged(function (user) {
        currentUser = user && !user.isAnonymous ? user : null;
        void refresh();
      });
    });
  } catch (_) {
    SU.denyAdminAccess(null, gateNotice);
  }
})();
