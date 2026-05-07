/* Copy this file to firebase-config.local.js and fill in your Firebase web app config.
   firebase-config.local.js is gitignored so secrets do not get committed.

   Leave apiKey empty to use browser-only click counts (localStorage) instead of Firestore.

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
    apiKey: "AIzaSyBPXPOxZeezDBn2YtgzTsj-Dxje62lYYOQ",
    authDomain: "proxy-list-c06ea.firebaseapp.com",
    projectId: "proxy-list-c06ea",
    storageBucket: "proxy-list-c06ea.firebasestorage.app",
    messagingSenderId: "31862303655",
    appId: "1:31862303655:web:d3e93df7a86ce31cf1e482",
    measurementId: "G-P51BKTLW18"
  };