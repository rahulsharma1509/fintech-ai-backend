/**
 * services/pushNotificationService.js
 * -------------------------------------
 * FCM push notification dispatch service.
 *
 * EVENTS THAT TRIGGER PUSH NOTIFICATIONS:
 *   - Refund processed (success or failure)
 *   - Escalation created (agent assigned)
 *   - Fraud detected (HIGH risk flagged)
 *   - Payment success (Stripe webhook)
 *
 * RATE LIMIT: 50 push notifications per user per day (Redis-based).
 *   FCM is free — this limit protects against spam / runaway loops.
 *
 * TOKEN STORAGE:
 *   FCM device tokens are stored in UserSession.fcmToken.
 *   The frontend must call POST /register-push-token after login.
 *   If no token is on file, the notification is silently skipped.
 *
 * ALL FUNCTIONS ARE NON-FATAL:
 *   Push notification failure must never break the main flow.
 *   Always wrap calls in .catch(() => {}) at the call site.
 */

const { getMessaging } = require("../integrations/firebaseClient");
const { UserSession } = require("../models");
const { checkRateLimit } = require("../integrations/redisClient");

// Max 50 push notifications per user per day
const PUSH_DAILY_LIMIT  = 50;
const PUSH_WINDOW_MS    = 24 * 60 * 60 * 1000;

/**
 * Check + increment push notification rate limit.
 * @returns {boolean} true if allowed, false if over limit
 */
async function checkPushRateLimit(userId) {
  try {
    const key = `push_rate:${userId}`;
    const count = await checkRateLimit(key, PUSH_WINDOW_MS, PUSH_DAILY_LIMIT);
    return count <= PUSH_DAILY_LIMIT;
  } catch {
    return true; // fail open — don't block notification on Redis error
  }
}

/**
 * Send a push notification to a user.
 * Silently no-ops if:
 *   - Firebase not configured
 *   - User has no FCM token
 *   - Rate limit exceeded
 *
 * @param {string} userId
 * @param {object} notification
 * @param {string} notification.title
 * @param {string} notification.body
 * @param {object} [notification.data]  - key/value string pairs for deep linking
 */
async function sendPushNotification(userId, { title, body, data = {} }) {
  const messaging = getMessaging();
  if (!messaging) return; // Firebase not configured — silently skip

  try {
    // Check rate limit
    const allowed = await checkPushRateLimit(userId);
    if (!allowed) {
      console.warn(`[Push] Rate limit reached for userId=${userId} — skipping notification`);
      return;
    }

    // Look up FCM token from user session
    const session = await UserSession.findOne({ userId }).lean();
    const fcmToken = session?.fcmToken;

    if (!fcmToken) {
      // No token — user hasn't granted notification permission or registered token
      return;
    }

    // Ensure all data values are strings (FCM requirement)
    const stringData = Object.fromEntries(
      Object.entries(data).map(([k, v]) => [k, String(v)])
    );

    await messaging.send({
      token: fcmToken,
      notification: { title, body },
      data: stringData,
      android: { priority: "high" },
      apns: { payload: { aps: { sound: "default" } } },
    });

    console.log(`[Push] ✅ Sent to userId=${userId}: "${title}"`);
  } catch (err) {
    // Token may be stale/invalid — log but don't throw
    console.warn(`[Push] Failed for userId=${userId}:`, err.message);

    // If token is invalid, clear it so we stop retrying
    if (err.code === "messaging/registration-token-not-registered" ||
        err.code === "messaging/invalid-registration-token") {
      await UserSession.updateOne({ userId }, { $unset: { fcmToken: "" } }).catch(() => {});
      console.log(`[Push] Cleared stale FCM token for userId=${userId}`);
    }
  }
}

/**
 * Convenience wrappers for common notification types.
 */
const notify = {
  refundProcessed: (userId, { txnId, amount, success }) =>
    sendPushNotification(userId, {
      title: success ? "💸 Refund Processed" : "Refund Update",
      body: success
        ? `Your refund of $${amount} for ${txnId} has been issued.`
        : `Your refund request for ${txnId} needs attention.`,
      data: { txnId, type: "refund" },
    }),

  escalationCreated: (userId, { txnId } = {}) =>
    sendPushNotification(userId, {
      title: "🧑‍💼 Agent Assigned",
      body: "A support agent has been assigned to your case.",
      data: { txnId: txnId || "", type: "escalation" },
    }),

  fraudDetected: (userId, { txnId, riskLevel }) =>
    sendPushNotification(userId, {
      title: "⚠️ Account Review",
      body: "Your request has been flagged for review. An agent will contact you.",
      data: { txnId: txnId || "", type: "fraud", riskLevel },
    }),

  paymentSuccess: (userId, { txnId, amount }) =>
    sendPushNotification(userId, {
      title: "✅ Payment Successful",
      body: `Payment of $${amount} for ${txnId} was successful.`,
      data: { txnId, type: "payment_success" },
    }),
};

module.exports = { sendPushNotification, notify };
