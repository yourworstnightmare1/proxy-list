/* Tracked placeholder shipped with the site (e.g. GitHub Pages). The page loads
   firebase-config.local.js first, then falls back to this file if local is missing.

   firebase-config.local.js is gitignored — it is not deployed, so the live site only
   sees this file. Leave apiKey empty for browser-only counts, or set real Firebase
   web app values here (restrict the key by HTTP referrer in Google Cloud) if you
   want Firestore on the hosted URL.

   For local dev, you can copy this file to firebase-config.local.js and fill in config.

   For the live "Most opened" section (index.html), Firestore must allow the client to run:
   collection("link_clicks").orderBy("count", "desc").limit(...)
   on documents the anonymous user can read. Example rules:

   match /link_clicks/{id} {
     allow read: if request.auth != null;
     allow create, update: if request.auth != null;
   }

   Writes already use signInAnonymously; if reads were get()-only before, add the same read
   rule so list queries work. */
window.__FIREBASE_CONFIG__ = {
  apiKey: "",
  authDomain: "your-project.firebaseapp.com",
  projectId: "your-project-id",
  storageBucket: "your-project.appspot.com",
  messagingSenderId: "000000000000",
  appId: "1:000000000000:web:0000000000000000000000",
  measurementId: "G-XXXXXXXXXX"
};
