/**
 * integrations/firebaseClient.js
 * --------------------------------
 * Firebase Admin SDK initialization for FCM push notifications.
 *
 * ============================================================
 * MANUAL SETUP REQUIRED — FREE TIER
 * ============================================================
 * 1. Go to https://console.firebase.google.com/
 * 2. Create a new project (or use existing)
 * 3. Project Settings → Service accounts → Generate new private key
 * 4. Download the JSON file → save as config/firebase.json
 *    (this file is git-ignored — never commit it)
 * 5. Add to .env:
 *      FIREBASE_CONFIG_PATH=./config/firebase.json
 *
 * FCM FREE TIER:
 *   Firebase Cloud Messaging is completely free — no message limits.
 *   Firebase Spark (free) plan supports FCM without restrictions.
 *   ⚠️  Only Blaze (paid) plan charges for other Firebase services
 *       (Firestore, Functions, etc.) — we only use FCM here.
 *
 * If FIREBASE_CONFIG_PATH is not set, push notifications are silently
 * disabled — all other features continue working normally.
 * ============================================================
 */

let _admin = null;
let _messaging = null;

function initFirebase() {
  const configPath = process.env.FIREBASE_CONFIG_PATH;

  if (!configPath) {
    console.log("ℹ️  FIREBASE_CONFIG_PATH not set — push notifications disabled");
    return;
  }

  try {
    const admin = require("firebase-admin");
    // Prevent re-initialization if called multiple times
    if (admin.apps.length === 0) {
      const serviceAccount = require(`../${configPath.replace(/^\.\//, "")}`);
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
      });
    }
    _admin = admin;
    _messaging = admin.messaging();
    console.log("✅ Firebase Admin SDK initialized (FCM ready)");
  } catch (err) {
    console.warn("⚠️  Firebase init failed — push notifications disabled:", err.message);
    // Non-fatal: app runs without push notifications if Firebase isn't configured
  }
}

function getMessaging() {
  return _messaging;
}

module.exports = { initFirebase, getMessaging };
