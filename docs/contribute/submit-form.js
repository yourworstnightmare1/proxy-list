(function () {
  "use strict";

  var SU = window.SubmissionUtils;
  if (!SU) return;

  var firebaseDb = null;
  var urlKeySet = new Set();
  var blockedPatterns = ["b-cdn.net"];
  var providers = [];
  var currentUser = null;
  var userProfile = null;

  var formEl = document.getElementById("linkSubmitForm");
  var signInPrompt = document.getElementById("submitSignInPrompt");
  var loadingNotice = document.getElementById("submitLoadingNotice");
  var bannedNotice = document.getElementById("submitBannedNotice");
  var statusEl = document.getElementById("submitStatus");
  var historyWrap = document.getElementById("submitHistoryWrap");
  var historyBody = document.getElementById("submitHistoryBody");
  var adminLinksBtn = document.getElementById("adminLinksBtn");
  var adminFeedbackBtn = document.getElementById("adminFeedbackBtn");
  var providerSelect = document.getElementById("submitProviderSelect");
  var existingWrap = document.getElementById("existingProviderWrap");
  var newWrap = document.getElementById("newProviderWrap");
  var newProviderInput = document.getElementById("submitNewProvider");
  var contributorNameInput = document.getElementById("submitContributorName");
  var githubUrlInput = document.getElementById("submitGithubUrl");
  var urlChipBox = document.getElementById("submitUrlChipBox");
  var urlChipsEl = document.getElementById("submitUrlChips");
  var urlInput = document.getElementById("submitUrlInput");
  var CREDIT_NAME_KEY = "pl_submit_contributor_name";
  var CREDIT_GH_KEY = "pl_submit_github_url";
  var MAX_URLS_PER_SUBMIT = SU.RATE_LIMIT_PER_HOUR;
  var urlChips = [];

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

  function setProviderMode(mode) {
    var isNew = mode === "new";
    if (existingWrap) existingWrap.hidden = isNew;
    if (newWrap) newWrap.hidden = !isNew;
  }

  function clearUrlChips() {
    urlChips = [];
    renderUrlChips();
    if (urlInput) urlInput.value = "";
  }

  function beginEditChip(idx) {
    if (!urlInput) return;
    var url = urlChips[idx];
    if (!url) return;

    if (urlInput.value.trim() && !commitUrlDraft({ quiet: true })) {
      showStatus("Finish or clear the URL you're typing before editing another.", "warn");
      urlInput.focus();
      return;
    }

    urlChips.splice(idx, 1);
    renderUrlChips();
    urlInput.value = url;
    urlInput.focus();
    var len = urlInput.value.length;
    try {
      urlInput.setSelectionRange(len, len);
    } catch (_) {}
    clearStatus();
  }

  function renderUrlChips() {
    if (!urlChipsEl) return;
    urlChipsEl.replaceChildren();
    urlChips.forEach(function (url, idx) {
      var chip = document.createElement("span");
      chip.className = "url-chip";
      chip.title = "Click to edit";
      chip.setAttribute("role", "button");
      chip.tabIndex = 0;

      var text = document.createElement("span");
      text.className = "url-chip-text";
      text.textContent = url;

      var remove = document.createElement("button");
      remove.type = "button";
      remove.className = "url-chip-remove";
      remove.setAttribute("aria-label", "Remove " + url);
      remove.textContent = "×";
      remove.addEventListener("click", function (e) {
        e.preventDefault();
        e.stopPropagation();
        urlChips.splice(idx, 1);
        renderUrlChips();
        if (urlInput) urlInput.focus();
      });

      chip.addEventListener("click", function (e) {
        if (e.target && e.target.closest && e.target.closest(".url-chip-remove")) return;
        e.preventDefault();
        e.stopPropagation();
        beginEditChip(idx);
      });
      chip.addEventListener("keydown", function (e) {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          e.stopPropagation();
          beginEditChip(idx);
        }
      });

      chip.appendChild(text);
      chip.appendChild(remove);
      urlChipsEl.appendChild(chip);
    });
  }

  function splitUrlTokens(text) {
    return String(text || "")
      .split(/[\s,;]+/)
      .map(function (s) {
        return s.trim();
      })
      .filter(Boolean);
  }

  function addUrlChip(raw, opts) {
    opts = opts || {};
    var quiet = !!opts.quiet;
    var value = String(raw || "").trim();
    if (!value) return false;

    if (!SU.isValidHttpUrl(value)) {
      if (!quiet) showStatus("Enter a valid http(s) URL.", "err");
      return false;
    }
    if (SU.isBlockedDomain(value, blockedPatterns)) {
      if (!quiet) showStatus("This domain is blocked from the list.", "err");
      return false;
    }

    var url = SU.normalizeSubmissionUrl(value);
    var key = SU.submissionUrlKey(url);
    if (urlChips.some(function (existing) {
      return SU.submissionUrlKey(existing) === key;
    })) {
      if (!quiet) showStatus("That URL is already in this submission.", "warn");
      return false;
    }
    if (urlChips.length >= MAX_URLS_PER_SUBMIT) {
      if (!quiet) {
        showStatus(
          "You can add up to " + MAX_URLS_PER_SUBMIT + " links per submission (hourly rate limit).",
          "warn"
        );
      }
      return false;
    }

    urlChips.push(url);
    renderUrlChips();
    clearStatus();
    return true;
  }

  function commitUrlDraft(opts) {
    if (!urlInput) return false;
    var raw = urlInput.value.trim();
    if (!raw) return false;
    if (addUrlChip(raw, opts)) {
      urlInput.value = "";
      return true;
    }
    return false;
  }

  function bindUrlChipInput() {
    if (!urlInput) return;

    if (urlChipBox) {
      urlChipBox.addEventListener("click", function (e) {
        if (e.target && e.target.closest && e.target.closest(".url-chip-remove")) return;
        if (e.target && e.target.closest && e.target.closest(".url-chip")) return;
        urlInput.focus();
      });
    }

    urlInput.addEventListener("keydown", function (e) {
      if (e.key === " " || e.key === ",") {
        e.preventDefault();
        if (urlInput.value.trim()) commitUrlDraft();
        return;
      }
      if (e.key === "Enter") {
        if (urlInput.value.trim()) {
          e.preventDefault();
          commitUrlDraft();
          return;
        }
        if (!urlChips.length) {
          e.preventDefault();
          showStatus("Add at least one proxy URL.", "err");
        }
        return;
      }
      if (e.key === "Backspace" && !urlInput.value && urlChips.length) {
        e.preventDefault();
        urlChips.pop();
        renderUrlChips();
      }
    });

    urlInput.addEventListener("paste", function (e) {
      var pasted = "";
      try {
        pasted = (e.clipboardData || window.clipboardData).getData("text") || "";
      } catch (_) {
        return;
      }
      var tokens = splitUrlTokens(pasted);
      if (tokens.length <= 1 && pasted.indexOf("\n") < 0 && pasted.indexOf(",") < 0) return;
      e.preventDefault();
      var added = 0;
      tokens.forEach(function (token) {
        if (addUrlChip(token, { quiet: true })) added += 1;
      });
      if (added) {
        urlInput.value = "";
        showStatus("Added " + added + " link" + (added === 1 ? "" : "s") + ".", "ok");
      } else {
        showStatus("Could not add pasted links. Check they are valid http(s) URLs.", "err");
      }
    });

    urlInput.addEventListener("blur", function () {
      commitUrlDraft({ quiet: true });
    });
  }

  function readStoredCredit() {
    try {
      return {
        name: localStorage.getItem(CREDIT_NAME_KEY) || "",
        githubUrl: localStorage.getItem(CREDIT_GH_KEY) || "",
      };
    } catch (_) {
      return { name: "", githubUrl: "" };
    }
  }

  function writeStoredCredit(name, githubUrl) {
    try {
      localStorage.setItem(CREDIT_NAME_KEY, name);
      localStorage.setItem(CREDIT_GH_KEY, githubUrl);
    } catch (_) {}
  }

  function prefillContributorFields(user, profile) {
    if (!contributorNameInput || !githubUrlInput) return;
    if (contributorNameInput.value.trim() || githubUrlInput.value.trim()) return;

    var stored = readStoredCredit();
    var ghLogin = SU.githubLoginFromUser(user);
    var name =
      stored.name ||
      (profile && profile.siteUsername) ||
      (user && user.displayName) ||
      ghLogin ||
      "";
    var ghUrl =
      stored.githubUrl || (ghLogin ? SU.githubProfileUrlFromLogin(ghLogin) : "");

    if (name) contributorNameInput.value = String(name).trim();
    if (ghUrl) githubUrlInput.value = ghUrl;
  }

  function populateProviders(list) {
    providers = list || [];
    if (!providerSelect) return;
    providerSelect.replaceChildren();
    var placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = "Select a provider…";
    providerSelect.appendChild(placeholder);
    providers.forEach(function (name) {
      var opt = document.createElement("option");
      opt.value = name;
      opt.textContent = name;
      providerSelect.appendChild(opt);
    });
  }

  async function loadSubmissionIndex() {
    try {
      var res = await fetch("../submission_url_keys.json");
      if (!res.ok) throw new Error("Could not load submission index");
      var payload = await res.json();
      urlKeySet = SU.buildUrlKeySet(payload);
      blockedPatterns = payload.blocked_domain_patterns || blockedPatterns;
      populateProviders(payload.providers || []);
    } catch (err) {
      showStatus((err && err.message) || "Could not load duplicate index.", "err");
    }
  }

  async function isPendingOnServer(urlKey) {
    if (!firebaseDb || !urlKey) return false;
    try {
      var urlKeyHash = await SU.sha256Hex(urlKey);
      var snap = await firebaseDb.collection("pendingSubmissionKeys").doc(urlKeyHash).get();
      return snap.exists;
    } catch (_) {
      return false;
    }
  }

  function isOnListKey(key) {
    return urlKeySet.has(key);
  }

  async function getContributorStats(uid) {
    var snap = await firebaseDb.collection("contributorStats").doc(uid).get();
    return snap.exists ? snap.data() || {} : {};
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

  function buildStatsPayload(uid, stats, opts) {
    var hourAgo = Date.now() - 60 * 60 * 1000;
    var lastMs = 0;
    if (stats.lastSubmissionAt) {
      lastMs =
        typeof stats.lastSubmissionAt.toMillis === "function"
          ? stats.lastSubmissionAt.toMillis()
          : stats.lastSubmissionAt.seconds
            ? stats.lastSubmissionAt.seconds * 1000
            : 0;
    }
    var recent = Number(stats.recentHourCount) || 0;
    if (!lastMs || lastMs < hourAgo) recent = 0;
    if (opts.countSubmission) recent += 1;

    var dup = Number(stats.duplicatesAttempted) || 0;
    if (opts.countDuplicate) dup += 1;

    var total = Number(stats.submissionsTotal) || 0;
    if (opts.countSubmission) total += 1;

    var submitBlocked = !!stats.submitBlocked;
    if (dup >= SU.DUPLICATE_BLOCK_THRESHOLD) submitBlocked = true;

    return {
      uid: uid,
      submissionsTotal: total,
      duplicatesAttempted: dup,
      rejectedTotal: Number(stats.rejectedTotal) || 0,
      warningCount: Number(stats.warningCount) || 0,
      suspensionCount: Number(stats.suspensionCount) || 0,
      submitBlocked: submitBlocked,
      recentHourCount: recent,
      lastSubmissionAt: opts.touchTime ? firebase.firestore.FieldValue.serverTimestamp() : stats.lastSubmissionAt || null,
      updated: firebase.firestore.FieldValue.serverTimestamp(),
    };
  }

  async function recordDuplicateAttempt(uid) {
    var stats = await getContributorStats(uid);
    var payload = buildStatsPayload(uid, stats, { countDuplicate: true, touchTime: true });
    await firebaseDb.collection("contributorStats").doc(uid).set(payload, { merge: true });
    if (payload.submitBlocked) {
      throw new Error(
        "Too many duplicate submissions. Your ability to contribute has been paused. Contact the list maintainer if you think this is a mistake."
      );
    }
    throw new Error("This URL is already on the list or pending review. Duplicate attempts are tracked.");
  }

  async function handleSubmit(event) {
    event.preventDefault();
    clearStatus();
    if (!currentUser || !firebaseDb) {
      showStatus("Sign in to submit links.", "warn");
      return;
    }

    commitUrlDraft({ quiet: true });
    if (!urlChips.length) {
      showStatus("Add at least one proxy URL.", "err");
      if (urlInput) urlInput.focus();
      return;
    }

    var note = (document.getElementById("submitNote").value || "").trim();
    var mode = (document.querySelector('input[name="providerMode"]:checked') || {}).value || "existing";
    var isNewProvider = mode === "new";
    var provider = isNewProvider ? (newProviderInput.value || "").trim() : (providerSelect.value || "").trim();

    if (!provider) {
      showStatus(isNewProvider ? "Enter a name for the new provider." : "Choose a provider.", "err");
      return;
    }

    var contributorName = contributorNameInput ? contributorNameInput.value.trim() : "";
    var githubUrlRaw = githubUrlInput ? githubUrlInput.value.trim() : "";
    if (!contributorName) {
      showStatus("Enter your name so you can be credited on the list.", "err");
      return;
    }
    if (contributorName.length > SU.MAX_CONTRIBUTOR_NAME_LEN) {
      showStatus("Name is too long.", "err");
      return;
    }
    var githubLogin = "";
    var githubUrl = "";
    if (githubUrlRaw) {
      if (githubUrlRaw.length > SU.MAX_GITHUB_URL_LEN) {
        showStatus("GitHub profile URL is too long.", "err");
        return;
      }
      githubLogin = SU.githubLoginFromProfileUrl(githubUrlRaw);
      if (!githubLogin) {
        showStatus(
          "Enter a GitHub profile URL like https://github.com/username (not a repo or other page), or leave it blank.",
          "err"
        );
        return;
      }
      showStatus("Checking that the GitHub account exists…");
      var ghCheck = await SU.verifyGithubAccountExists(githubLogin);
      if (!ghCheck.ok) {
        if (ghCheck.reason === "not_found") {
          showStatus("That GitHub account does not exist. Check the username, or leave the field blank.", "err");
        } else if (ghCheck.reason === "rate_limited") {
          showStatus("GitHub rate limit hit while verifying the profile. Wait a minute and try again.", "warn");
        } else {
          showStatus("Could not verify the GitHub profile right now. Try again, or leave it blank.", "err");
        }
        return;
      }
      githubLogin = ghCheck.login;
      githubUrl = SU.githubProfileUrlFromLogin(githubLogin);
      clearStatus();
    }

    if (note.length > SU.MAX_NOTE_LEN) {
      showStatus("Note is too long.", "err");
      return;
    }

    var urls = urlChips.slice();
    var prepared = [];
    for (var i = 0; i < urls.length; i++) {
      var url = urls[i];
      if (!SU.isValidHttpUrl(url) || SU.isBlockedDomain(url, blockedPatterns)) {
        showStatus("Remove invalid or blocked URLs before submitting.", "err");
        return;
      }
      prepared.push({
        url: url,
        urlKey: SU.submissionUrlKey(url),
      });
    }

    try {
      if (await isUserBanned(currentUser.uid)) {
        showStatus("You are banned from submitting links.", "err");
        return;
      }

      var stats = await getContributorStats(currentUser.uid);
      if (stats.submitBlocked) {
        showStatus("Submissions paused due to repeated duplicates or policy violations.", "err");
        return;
      }
      var remaining = SU.remainingRateSlots(stats);
      if (remaining <= 0) {
        showStatus("Rate limit reached. Try again later.", "warn");
        return;
      }
      if (prepared.length > remaining) {
        showStatus(
          "You can submit " +
            remaining +
            " more link" +
            (remaining === 1 ? "" : "s") +
            " this hour. Remove some chips or submit fewer.",
          "warn"
        );
        return;
      }

      for (var d = 0; d < prepared.length; d++) {
        var item = prepared[d];
        if (isOnListKey(item.urlKey) || (await isPendingOnServer(item.urlKey))) {
          try {
            await recordDuplicateAttempt(currentUser.uid);
          } catch (err) {
            showStatus(
              (err && err.message) ||
                "Duplicate URL in batch: " + item.url + ". Remove it and try again.",
              "err"
            );
          }
          return;
        }
      }
    } catch (err) {
      showStatus(
        (err && err.message) ||
          "Could not verify your account (Firestore may need updated rules). Try again or use the Google Form.",
        "err"
      );
      return;
    }

    var submitBtn = document.getElementById("submitBtn");
    if (submitBtn) submitBtn.disabled = true;

    try {
      var batch = firebaseDb.batch();
      for (var p = 0; p < prepared.length; p++) {
        var entry = prepared[p];
        var urlKeyHash = await SU.sha256Hex(entry.urlKey);
        var payload = {
          url: entry.url,
          urlKey: entry.urlKey,
          urlKeyHash: urlKeyHash,
          provider: provider,
          isNewProvider: isNewProvider,
          submitterUid: currentUser.uid,
          submitterLabel: contributorName,
          submitterGithub: githubLogin,
          submitterEmail: currentUser.email ? String(currentUser.email).slice(0, 320) : "",
          status: "pending",
          optionalNote: note || "",
          created: firebase.firestore.FieldValue.serverTimestamp(),
          updated: firebase.firestore.FieldValue.serverTimestamp(),
        };
        var pendingRef = firebaseDb.collection("pendingSubmissionKeys").doc(urlKeyHash);
        batch.set(pendingRef, {
          urlKey: entry.urlKey,
          urlKeyHash: urlKeyHash,
          submitterUid: currentUser.uid,
          created: firebase.firestore.FieldValue.serverTimestamp(),
        });
        var subRef = firebaseDb.collection("linkSubmissions").doc();
        batch.set(subRef, payload);
      }
      await batch.commit();

      writeStoredCredit(contributorName, githubUrl);

      for (var s = 0; s < prepared.length; s++) {
        var latest = await getContributorStats(currentUser.uid);
        var nextStats = buildStatsPayload(currentUser.uid, latest, {
          countSubmission: true,
          touchTime: true,
        });
        await firebaseDb.collection("contributorStats").doc(currentUser.uid).set(nextStats, { merge: true });
      }

      var count = prepared.length;
      formEl.reset();
      clearUrlChips();
      setProviderMode("existing");
      prefillContributorFields(currentUser, userProfile);
      showStatus(
        count === 1
          ? "Submitted 1 link for review. Thank you!"
          : "Submitted " + count + " links for review. Thank you!",
        "ok"
      );
      await loadSubmitHistory(currentUser.uid);
    } catch (err) {
      console.warn("[proxy-list] link submission failed", err);
      var msg = (err && err.message) || "Submission failed.";
      if (/permission|insufficient/i.test(msg)) {
        msg =
          "Could not save submission (permission denied). If you were recently banned, wait for it to expire or ask an admin to lift it. Otherwise refresh and try again.";
      }
      showStatus(msg, "err");
    } finally {
      if (submitBtn) submitBtn.disabled = false;
    }
  }

  function statusPill(status) {
    var s = String(status || "pending");
    return '<span class="status-pill ' + s.replace(/[^a-z]/gi, "") + '">' + s + "</span>";
  }

  function localEscapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function setHistoryHtml(el, html) {
    if (!el) return;
    var raw = String(html || "");
    // Sanitize inside a real <table> — bare <tr>/<td> fragments are stripped by DOMPurify.
    var toParse = raw;
    if (window.DOMPurify) {
      var wrapped = DOMPurify.sanitize("<table><tbody>" + raw + "</tbody></table>");
      if (!wrapped) {
        el.replaceChildren();
        return;
      }
      toParse = wrapped;
    } else {
      toParse = "<table><tbody>" + raw + "</tbody></table>";
    }
    var doc = new DOMParser().parseFromString(toParse, "text/html");
    var section = doc.querySelector("tbody");
    var nodes = section
      ? Array.from(section.childNodes).map(function (n) {
          return document.importNode(n, true);
        })
      : [];
    el.replaceChildren.apply(el, nodes);
  }

  async function loadSubmitHistory(uid) {
    if (!firebaseDb || !historyBody || !historyWrap) return;
    try {
      var snap = await firebaseDb
        .collection("linkSubmissions")
        .where("submitterUid", "==", uid)
        .limit(40)
        .get();
      var rows = [];
      snap.forEach(function (doc) {
        rows.push(Object.assign({ id: doc.id }, doc.data()));
      });
      rows.sort(function (a, b) {
        var am = a.created && a.created.toMillis ? a.created.toMillis() : 0;
        var bm = b.created && b.created.toMillis ? b.created.toMillis() : 0;
        return bm - am;
      });
      rows = rows.slice(0, 20);
      if (!rows.length) {
        historyWrap.hidden = true;
        return;
      }
      historyWrap.hidden = false;
      setHistoryHtml(
        historyBody,
        rows
          .map(function (r) {
            return (
              "<tr><td>" +
              localEscapeHtml(r.url || "") +
              "</td><td>" +
              localEscapeHtml(r.provider || "") +
              "</td><td>" +
              statusPill(r.status) +
              "</td></tr>"
            );
          })
          .join("")
      );
    } catch (err) {
      console.warn("[proxy-list] could not load recent submissions", err);
      historyWrap.hidden = true;
    }
  }

  function setAdminButtonsVisible(visible) {
    var show = !!visible;
    if (adminLinksBtn) {
      adminLinksBtn.hidden = !show;
      adminLinksBtn.style.display = show ? "" : "none";
    }
    if (adminFeedbackBtn) {
      adminFeedbackBtn.hidden = !show;
      adminFeedbackBtn.style.display = show ? "" : "none";
    }
  }

  function showSignedOutUi() {
    if (formEl) formEl.hidden = true;
    if (signInPrompt) signInPrompt.hidden = false;
    if (historyWrap) historyWrap.hidden = true;
    setAdminButtonsVisible(false);
    hideNotice(loadingNotice);
    hideNotice(bannedNotice);
    clearStatus();
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
    setAdminButtonsVisible(SU.isSubmissionAdminUser(user));

    if (!firebaseDb) {
      hideNotice(loadingNotice);
      showNotice(
        bannedNotice,
        "Submission service could not start. Refresh the page or try again later.",
        "err"
      );
      if (formEl) formEl.hidden = true;
      return;
    }

    try {
      try {
        var profSnap = await firebaseDb.collection("users").doc(user.uid).get();
        userProfile = profSnap.exists ? profSnap.data() : null;
      } catch (_) {
        userProfile = null;
      }

      var banned = false;
      try {
        banned = await isUserBanned(user.uid);
      } catch (_) {
        banned = false;
      }

      if (banned) {
        var banSnap = await firebaseDb.collection("contributorBans").doc(user.uid).get();
        var reason = (banSnap.data() && banSnap.data().reason) || "Policy violation";
        hideNotice(loadingNotice);
        showNotice(bannedNotice, "You are banned from submitting links: " + reason, "err");
        if (formEl) formEl.hidden = true;
        return;
      }

      hideNotice(bannedNotice);

      var stats = {};
      try {
        stats = await getContributorStats(user.uid);
      } catch (_) {
        stats = {};
      }

      if (stats.submitBlocked) {
        hideNotice(loadingNotice);
        showNotice(
          bannedNotice,
          "Submissions paused after repeated duplicate URLs. Contact the list maintainer if you need this lifted.",
          "warn"
        );
        if (formEl) formEl.hidden = true;
        return;
      }

      hideNotice(loadingNotice);
      if (formEl) formEl.hidden = false;
      prefillContributorFields(user, userProfile);
      setAdminButtonsVisible(SU.isSubmissionAdminUser(user));
      await loadSubmitHistory(user.uid);
    } catch (err) {
      hideNotice(loadingNotice);
      if (formEl) formEl.hidden = false;
      prefillContributorFields(user, userProfile);
      showNotice(
        bannedNotice,
        "Could not fully verify your account, but you can try submitting. If it fails, the site maintainer may still be deploying submission support.",
        "warn"
      );
      setAdminButtonsVisible(SU.isSubmissionAdminUser(user));
    }
  }

  function initFirebase() {
    var cfg = window.__FIREBASE_CONFIG__;
    if (!cfg || !cfg.apiKey || typeof firebase === "undefined") {
      if (signInPrompt) {
        signInPrompt.hidden = false;
        signInPrompt.innerHTML =
          'Firebase is not configured for submissions on this host. Use <a href="https://forms.gle/SMx9EUkBeiFuLwBa8" rel="noopener noreferrer" target="_blank">Google Form</a> or GitHub instead.';
      }
      return;
    }
    try {
      if (!firebase.apps.length) firebase.initializeApp(cfg);
      firebaseDb = firebase.firestore();
      var auth = firebase.auth();
      var ready =
        typeof auth.authStateReady === "function"
          ? auth.authStateReady()
          : Promise.resolve();
      ready.then(function () {
        auth.onAuthStateChanged(function (user) {
          refreshAuthUi(user);
        });
      });
    } catch (err) {
      if (signInPrompt) {
        signInPrompt.hidden = false;
        signInPrompt.textContent = "Could not initialize submission service.";
      }
    }
  }

  document.querySelectorAll('input[name="providerMode"]').forEach(function (radio) {
    radio.addEventListener("change", function () {
      setProviderMode(radio.value);
    });
  });

  if (formEl) formEl.addEventListener("submit", handleSubmit);
  bindUrlChipInput();

  loadSubmissionIndex();
  initFirebase();
})();
