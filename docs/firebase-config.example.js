/* Shipped with the site (e.g. GitHub Pages). index.html loads this first, then
   firebase-config.local.js (committed stub on Pages; you may edit locally for overrides).

   For local-only experiments, edit firebase-config.local.js in your clone (do not commit
   private keys). Production deploy uses the stub plus this example file.

   Leave apiKey empty for browser-only click counts (localStorage).

   Google Cloud → APIs & Services → Credentials → your browser API key →
   HTTP referrers must include ALL of: your GitHub Pages origin (e.g.
   https://USER.github.io/*), localhost (e.g. http://localhost:8080/*), AND
   https://<projectId>.firebaseapp.com/* — Auth runs helper iframes from
   authDomain; without this, Identity Toolkit returns API_KEY_HTTP_REFERRER_BLOCKED.

   For "Most opened", deploy docs/firestore.rules (client writes to link_clicks are denied).
   Statistics provider open-over-time charts read click_daily/{yyyy-mm-dd} (Worker writes counts.{hash}).
   Clicks go through the Cloudflare Worker at POST /api/link-click with a per-IP rate limit
   (40/hour). Set Worker secrets for Firestore admin writes:
     FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY
   (service account with Cloud Datastore User). Without secrets, the Worker still rate-limits
   and stores edge counters (Cloudflare-only) — presence/stats will NOT update in Firestore.

   GitHub Pages hosts the static site; the Worker lives at
   https://proxy-list.jasonthegamer48.workers.dev
   presence-client.js and click APIs fall back to that origin automatically on *.github.io.
   Override with: window.__PROXY_LIST_API_BASE__ = "https://proxy-list.jasonthegamer48.workers.dev";

   On-site link submissions (docs/contribute/, docs/admin/submissions.html):
   - Deploy docs/firestore.rules (includes linkSubmissions, pendingSubmissionKeys,
     contributorBans, contributorStats, and siteFeedback with strict client counter rules).
   - Bug / feature / QoL reports from Contribute go to Firestore collection siteFeedback
     and are reviewed at docs/admin/feedback.html.
   - users/{uid} profile writes require non-anonymous auth and field size limits.
   - In Firestore, create document config/submissions with field adminUids (array of Firebase Auth UIDs
     for accounts that may approve/reject/ban). Example: { "adminUids": ["abc123uid"] }.
   - Set window.__SUBMISSION_ADMIN_GITHUB__ in this file for GitHub admins (UI access).
   - Both the GitHub username AND adminUids entry are required for full admin actions.

   Enable Authentication → Sign-in method → Anonymous, GitHub (OAuth app in Firebase Console),
   Google, and Email/Password.

   Mobile / in-app browsers block third-party cookies, so signInWithRedirect cannot finish when
   authDomain is *.firebaseapp.com while the site is on GitHub Pages. The login page bridges
   Google (mobile) and GitHub (all GitHub Pages) through the Worker origin, which reverse-proxies
   /__/auth/* (see workers/site.js). After deploying the Worker, finish setup once:
   1) Firebase Console → Authentication → Settings → Authorized domains → add
      proxy-list.jasonthegamer48.workers.dev
   2) Google Cloud Console → APIs & Services → Credentials → the OAuth 2.0 Web client →
      Authorized redirect URIs → add
      https://proxy-list.jasonthegamer48.workers.dev/__/auth/handler
   3) GitHub OAuth App (Firebase GitHub provider) → Authorization callback URL → set to
      https://proxy-list.jasonthegamer48.workers.dev/__/auth/handler
      (GitHub allows one callback; GitHub sign-in on GitHub Pages then uses the Worker bridge.)

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

/** GitHub usernames allowed to open docs/admin/submissions.html (UI gate). */
window.__SUBMISSION_ADMIN_GITHUB__ = ["yourworstnightmare1"];

/** Firebase Auth UIDs with Firestore write access for submissions (must match config/submissions.adminUids). */
window.__SUBMISSION_ADMIN_UIDS__ = ["OiMY32eTKcSnEX73W6oBUKgT6pG3"];
