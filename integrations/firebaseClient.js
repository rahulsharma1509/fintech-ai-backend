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
  // ── Two ways to provide the Firebase service account ─────────────────────
  //
  // Option A — FIREBASE_SERVICE_ACCOUNT_BASE64 (recommended for Render/cloud):
  //   base64-encode your firebase.json and paste the result as an env var.
  //   How to encode on Mac/Linux:
  //     base64 -i firebase.json | pbcopy    ← copies to clipboard (Mac)
  //     base64 -i firebase.json             ← prints to terminal (Linux)
  //   Set in Render: FIREBASE_SERVICE_ACCOUNT_BASE64 = <paste here>
  //
  // Option B — FIREBASE_CONFIG_PATH (local dev only):
  //   Download firebase.json → save as config/firebase.json
  //   Set in .env: FIREBASE_CONFIG_PATH=./config/firebase.json
  //   ⚠️  Never commit config/firebase.json to GitHub.
  //
  // If neither is set, push notifications are silently disabled.
  // ─────────────────────────────────────────────────────────────────────────

  const b64 = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64;
  const configPath = process.env.FIREBASE_CONFIG_PATH;

  if (!b64 && !configPath) {
    console.log("ℹ️  Firebase not configured — push notifications disabled");
    return;
  }

  try {
    const admin = require("firebase-admin");
    if (admin.apps.length === 0) {
      let serviceAccount;
      if (b64) {
        // Decode base64 → parse JSON (works on Render, Heroku, any cloud host)
        serviceAccount = JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
      } else {
        serviceAccount = require(`../${configPath.replace(/^\.\//, "")}`);
      }
      admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    }
    _admin = admin;
    _messaging = admin.messaging();
    console.log("✅ Firebase Admin SDK initialized (FCM ready)");
  } catch (err) {
    console.warn("⚠️  Firebase init failed — push notifications disabled:", err.message);
  }
}

function getMessaging() {
  return _messaging;
}

module.exports = { initFirebase, getMessaging };
