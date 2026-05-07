/* Shipped with the site (e.g. GitHub Pages). index.html loads this first, then
   firebase-config.local.js (gitignored) to override when present.

   For local-only Firestore, copy this file to firebase-config.local.js and edit there
   so secret scanning / commits stay cleaner; production can rely on this file alone.

   Leave apiKey empty for browser-only click counts (localStorage).

   For "Most opened", Firestore must allow authenticated clients, e.g.:

   match /link_clicks/{id} {
     allow read: if request.auth != null;
     allow create, update: if request.auth != null;
   }

   Active user count uses Realtime Database (not Firestore). In Firebase Console:
   Build → Realtime Database → Create database. If the SDK cannot connect, add
   databaseURL from that screen to the config object below, e.g.:
   databaseURL: "https://<projectId>-default-rtdb.firebaseio.com"

   Example Realtime Database rules for path "presence/{sessionId}":

   {
     "rules": {
       "presence": {
         ".read": "auth != null",
         "$key": {
           ".write": "auth != null && ((!data.exists() && newData.child('uid').val() === auth.uid) || (data.exists() && !newData.exists() && data.child('uid').val() === auth.uid))",
           ".validate": "!newData.exists() || newData.hasChildren(['uid', 'ts'])"
         }
       }
     }
   } */
window.__FIREBASE_CONFIG__ = {
  apiKey: "AIzaSyBPXPOxZeezDBn2YtgzTsj-Dxje62lYYOQ",
  authDomain: "proxy-list-c06ea.firebaseapp.com",
  projectId: "proxy-list-c06ea",
  storageBucket: "proxy-list-c06ea.firebasestorage.app",
  messagingSenderId: "31862303655",
  appId: "1:31862303655:web:d3e93df7a86ce31cf1e482",
  measurementId: "G-P51BKTLW18",
};
