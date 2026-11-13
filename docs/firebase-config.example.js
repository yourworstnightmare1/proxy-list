/* Shipped with the site (e.g. GitHub Pages). index.html loads this first, then
   firebase-config.local.js (committed stub on Pages; you may edit locally for overrides).

   For local-only experiments, edit firebase-config.local.js in your clone (do not commit
   private keys). Production deploy uses the stub plus this example file.

   Leave apiKey empty for browser-only click counts (localStorage).

   Google Cloud → APIs & Services → Credentials → your browser API key →
   HTTP referrers must include ALL of: your GitHub Pages origin (e.g.
   https://USER.github.io/*), localhost (e.g. http://localhost:8080/*),
   https://proxy-list.jasonthegamer48.workers.dev/*, AND
   https://<projectId>.firebaseapp.com/* — Auth runs helper iframes from
   authDomain; without this, Identity Toolkit returns API_KEY_HTTP_REFERRER_BLOCKED
   (ratings show 0/0 on the Worker host until the referrer is allowed, though the
   Worker also exposes POST /api/link-ratings/get as a read fallback).

   Lifetime clicks, community ratings, and click rollups live in Cloudflare D1
   (STATS_STORE=d1). The Worker serves POST /api/link-click, /api/link-clicks/get,
   /api/link-ratings/get, POST /api/link-rating, /api/top-opens, and /api/click-stats/*.
   Auth, saved folders, submissions, and presence still use Firebase.

   GitHub Pages hosts the static site; the Worker lives at
   https://proxy-list.jasonthegamer48.workers.dev
   presence-client.js and click APIs fall back to that origin automatically on *.github.io.
   Override with: window.__PROXY_LIST_API_BASE__ = "https://proxy-list.jasonthegamer48.workers.dev";

   Approved link auto-publish (optional):
   - Add GitHub Actions secret FIREBASE_SERVICE_ACCOUNT (service account JSON) so
     .github/workflows/sync_approved_submissions.yml can write approved links into list.md.
   - Optional Worker secrets for instant kick on Approve:
     GITHUB_PUBLISH_TOKEN (workflow dispatch), SUBMISSION_ADMIN_UIDS, GITHUB_REPO.

   On-site link submissions (docs/contribute/, docs/admin/submissions.html):
   - Deploy docs/firestore.rules (includes linkSubmissions, pendingSubmissionKeys,
     contributorBans, contributorStats, and siteFeedback with strict client counter rules).
   - Bug / feature / QoL reports from Contribute go to Firestore collection siteFeedback
     and are reviewed at docs/admin/feedback.html.
   - users/{uid} profile writes require non-anonymous auth and field size limits.
   - In Firestore, create/update document config/submissions with field adminUids (array of
     Firebase Auth UIDs for accounts that may approve/reject/ban). Keep in sync with Worker:
     { "adminUids": ["OiMY32eTKcSnEX73W6oBUKgT6pG3", "QDaYz2ETKCSlEK70N3U8UKgTezX2"] }.
   - Admin UI access is true if either GET /api/admin/me (Worker SUBMISSION_ADMIN_UIDS, or the
     code default when that secret is unset) OR Firestore config/submissions.adminUids includes
     the signed-in UID. Firestore rules remain the write gate — UI access alone is not enough
     to approve/reject until the UID is also in adminUids.

   Enable Authentication → Sign-in method → Anonymous, GitHub (OAuth app in Firebase Console),
   Google, and Email/Password. For authenticator 2FA, upgrade to Identity Platform and enable
   TOTP multi-factor (Authentication → Sign-in method → Advanced → Multi-factor).

   Mobile / in-app browsers block third-party cookies, so signInWithRedirect cannot finish when
   authDomain is *.firebaseapp.com while the site is on GitHub Pages. The login page bridges
   Google (mobile) and GitHub (all GitHub Pages) through Firebase Hosting at
   https://proxy-list-c06ea.firebaseapp.com/ (auth-bridge-host/, see firebase.json). That host
   is already an authorized domain with OAuth redirect URIs. Deploy once after changes:
     npx firebase deploy --only hosting
   Optional override: window.__PROXY_LIST_AUTH_BRIDGE__ = "https://…";

   Active user count uses Realtime Database (not Firestore): each signed-in or anonymous
   auth uid writes presence/{uid} with uid + ts (one node per user — not push IDs, so
   in-site navigations do not stack duplicate sessions). Only sessions updated in the
   last ~5 minutes count as active. In Firebase Console:
   Build → Realtime Database → Create database. If the SDK cannot connect, add
   databaseURL from that screen to the config object below, e.g.:
   databaseURL: "https://<projectId>-default-rtdb.firebaseio.com"

   Example Realtime Database rules for path "presence/{uid}":

   {
     "rules": {
       "presence": {
         ".read": "auth != null",
         "$uid": {
           ".write": "auth != null && auth.uid === $uid && ((!data.exists() && newData.child('uid').val() === auth.uid) || (data.exists() && !newData.exists() && data.child('uid').val() === auth.uid) || (data.exists() && newData.exists() && newData.child('uid').val() === auth.uid))",
           ".validate": "!newData.exists() || (newData.hasChildren(['uid', 'ts']) && newData.child('uid').val() === $uid)"
         }
       }
     }
   } */
/** Public Firebase web config (API key is a client identifier, not a secret). */
window.__FIREBASE_CONFIG__ = {
  apiKey: "AIzaSyBPXPOxZeezDBn2YtgzTsj-Dxje62lYYOQ",
  authDomain: "proxy-list-c06ea.firebaseapp.com",
  databaseURL: "https://proxy-list-c06ea-default-rtdb.firebaseio.com",
  projectId: "proxy-list-c06ea",
  storageBucket: "proxy-list-c06ea.firebasestorage.app",
  messagingSenderId: "31862303655",
  appId: "1:31862303655:web:d3e93df7a86ce31cf1e482",
  measurementId: "G-P51BKTLW18",
};
