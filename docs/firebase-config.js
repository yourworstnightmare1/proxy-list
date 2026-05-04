/* Paste your Firebase web app config here (Project settings). Leave apiKey empty to use
   browser-only click counts (localStorage) instead of Firestore.

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
  apiKey: "AIzaSyBC-dCF7QdX1nhtQJqUncHY5sfw64y1NmE",
  authDomain: "proxy-list-c06ea.firebaseapp.com",
  projectId: "proxy-list-c06ea",
  storageBucket: "proxy-list-c06ea.firebasestorage.app",
  messagingSenderId: "31862303655",
  appId: "1:31862303655:web:d3e93df7a86ce31cf1e482",
  measurementId: "G-P51BKTLW18"
};
