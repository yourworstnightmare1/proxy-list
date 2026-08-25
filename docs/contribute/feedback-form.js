(function () {
  "use strict";

  var SU = window.SubmissionUtils;
  if (!SU) return;

  var firebaseDb = null;
  var currentUser = null;

  var formEl = document.getElementById("feedbackForm");
  var signInPrompt = document.getElementById("feedbackSignInPrompt");
  var loadingNotice = document.getElementById("feedbackLoadingNotice");
  var bannedNotice = document.getElementById("feedbackBannedNotice");
  var statusEl = document.getElementById("feedbackStatus");
  var historyWrap = document.getElementById("feedbackHistoryWrap");
  var historyBody = document.getElementById("feedbackHistoryBody");
  var titleInput = document.getElementById("feedbackTitle");
  var bodyInput = document.getElementById("feedbackBody");
  var submitBtn = document.getElementById("feedbackSubmitBtn");

  var TYPE_LABELS = {
    bug: "Bug fix",
    feature: "Feature",
    qol: "QoL",
  };

  function showNotice(el, msg, kind) {
    if (!el) return;
    el.hidden = false;
    el.className = "submit-status" + (kind ? " " + kind : "");
    el.textContent = msg;
  }

  function hideNotice(el) {
    if (!el) return;
    el.hidden = true;
    el.textContent = "";
  }

  function showStatus(msg, kind) {
    showNotice(statusEl, msg, kind);
  }

  function clearStatus() {
    hideNotice(statusEl);
  }

  function selectedType() {
    var el = document.querySelector('input[name="feedbackType"]:checked');
    return el ? el.value : "bug";
  }

  function typeLabel(t) {
    return TYPE_LABELS[t] || t || "—";
  }

  async function isUserBanned(uid) {
    var snap = await firebaseDb.collection("contributorBans").doc(uid).get();
    if (!snap.exists) return false;
    var data = snap.data() || {};
    if (data.until && typeof data.until.toMillis === "function") {
      if (data.until.toMillis() <= Date.now()) {
        try {
          await firebaseDb.collection("contributorBans").doc(uid).delete();
          await firebaseDb.collection("contributorStats").doc(uid).set(
            { submitBlocked: false, updated: firebase.firestore.FieldValue.serverTimestamp() },
            { merge: true }
          );
          await firebaseDb.collection("userNotifications").add({
            uid: uid,
            kind: "wait_lifted",
            read: false,
            created: firebase.firestore.FieldValue.serverTimestamp(),
            dateMs: Date.now(),
          });
        } catch (_) {}
        return false;
      }
    }
    return true;
  }

  function setTbodyHtml(el, html) {
    if (!el) return;
    var raw = String(html || "");
    var toParse = "<table><tbody>" + raw + "</tbody></table>";
    if (window.DOMPurify) {
      var wrapped = DOMPurify.sanitize(toParse);
      if (!wrapped) {
        el.replaceChildren();
        return;
      }
      toParse = wrapped;
    }
    var doc = new DOMParser().parseFromString(toParse, "text/html");
    var tbody = doc.querySelector("tbody");
    var nodes = tbody
      ? Array.from(tbody.childNodes).map(function (n) {
          return document.importNode(n, true);
        })
      : [];
    el.replaceChildren.apply(el, nodes);
  }

  function esc(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  async function loadHistory(uid) {
    if (!historyWrap || !historyBody || !firebaseDb) return;
    try {
      var snap = await firebaseDb
        .collection("siteFeedback")
        .where("submitterUid", "==", uid)
        .limit(40)
        .get();
      var rows = snap.docs
        .map(function (d) {
          return Object.assign({ id: d.id }, d.data());
        })
        .sort(function (a, b) {
          var at = a.created && a.created.toMillis ? a.created.toMillis() : 0;
          var bt = b.created && b.created.toMillis ? b.created.toMillis() : 0;
          return bt - at;
        })
        .slice(0, 15);
      if (!rows.length) {
        historyWrap.hidden = true;
        return;
      }
      historyWrap.hidden = false;
      setTbodyHtml(
        historyBody,
        rows
          .map(function (r) {
            return (
              "<tr><td>" +
              esc(typeLabel(r.type)) +
              "</td><td>" +
              esc(r.title || "—") +
              "</td><td>" +
              esc(r.status || "pending") +
              "</td></tr>"
            );
          })
          .join("")
      );
    } catch (_) {
      historyWrap.hidden = true;
    }
  }

  async function handleSubmit(ev) {
    ev.preventDefault();
    clearStatus();
    if (!currentUser || !SU.isSignedInNonAnonymous(currentUser)) {
      showStatus("Sign in to send feedback.", "warn");
      return;
    }
    if (!firebaseDb) {
      showStatus("Feedback service is not available right now.", "err");
      return;
    }

    var type = selectedType();
    if (type !== "bug" && type !== "feature" && type !== "qol") {
      showStatus("Choose a request type.", "warn");
      return;
    }
    var title = String((titleInput && titleInput.value) || "").trim();
    var body = String((bodyInput && bodyInput.value) || "").trim();
    if (!title || title.length > 200) {
      showStatus("Enter a short title (1–200 characters).", "warn");
      return;
    }
    if (!body || body.length > 2000) {
      showStatus("Enter details (1–2000 characters).", "warn");
      return;
    }

    if (submitBtn) submitBtn.disabled = true;
    try {
      if (await isUserBanned(currentUser.uid)) {
        showStatus("You are banned from contributing.", "err");
        return;
      }

      var label =
        (currentUser.displayName && String(currentUser.displayName).trim()) ||
        SU.githubLoginFromUser(currentUser) ||
        "Signed-in user";
      label = String(label).slice(0, 120);

      await firebaseDb.collection("siteFeedback").add({
        type: type,
        title: title,
        body: body,
        status: "pending",
        submitterUid: currentUser.uid,
        submitterLabel: label,
        submitterGithub: SU.githubLoginFromUser(currentUser) || "",
        submitterEmail: currentUser.email ? String(currentUser.email).slice(0, 320) : "",
        created: firebase.firestore.FieldValue.serverTimestamp(),
        updated: firebase.firestore.FieldValue.serverTimestamp(),
      });

      if (titleInput) titleInput.value = "";
      if (bodyInput) bodyInput.value = "";
      showStatus("Thanks — your feedback was sent for review.", "ok");
      await loadHistory(currentUser.uid);
    } catch (err) {
      var msg = (err && err.message) || String(err);
      if (/permission|insufficient/i.test(msg)) {
        msg =
          "Could not save feedback (deploy the updated Firestore rules that allow siteFeedback).";
      }
      showStatus(msg, "err");
    } finally {
      if (submitBtn) submitBtn.disabled = false;
    }
  }

  function showSignedOutUi() {
    if (signInPrompt) signInPrompt.hidden = false;
    hideNotice(loadingNotice);
    hideNotice(bannedNotice);
    clearStatus();
    if (formEl) formEl.hidden = true;
    if (historyWrap) historyWrap.hidden = true;
  }

  async function refreshAuthUi(user) {
    currentUser = user;
    var signedIn = SU.isSignedInNonAnonymous(user);

    if (!signedIn) {
      showSignedOutUi();
      return;
    }

    if (signInPrompt) signInPrompt.hidden = true;
    showNotice(loadingNotice, "Checking your account…", "");

    if (!firebaseDb) {
      hideNotice(loadingNotice);
      showNotice(bannedNotice, "Feedback service could not start. Refresh and try again.", "err");
      if (formEl) formEl.hidden = true;
      return;
    }

    try {
      var banned = false;
      try {
        banned = await isUserBanned(user.uid);
      } catch (_) {
        banned = false;
      }
      if (banned) {
        hideNotice(loadingNotice);
        showNotice(bannedNotice, "You are banned from contributing.", "err");
        if (formEl) formEl.hidden = true;
        return;
      }
      hideNotice(bannedNotice);
      hideNotice(loadingNotice);
      if (formEl) formEl.hidden = false;
      await loadHistory(user.uid);
    } catch (_) {
      hideNotice(loadingNotice);
      if (formEl) formEl.hidden = false;
    }
  }

  function initFirebase() {
    try {
      if (!firebase.apps.length) {
        var cfg = window.__FIREBASE_CONFIG__;
        if (!cfg || !cfg.apiKey) return;
        firebase.initializeApp(cfg);
      }
      firebaseDb = firebase.firestore();
      firebase.auth().onAuthStateChanged(function (user) {
        void refreshAuthUi(user);
      });
    } catch (_) {
      firebaseDb = null;
    }
  }

  if (formEl) formEl.addEventListener("submit", handleSubmit);
  initFirebase();
})();
