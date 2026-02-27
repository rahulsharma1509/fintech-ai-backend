/**
 * services/auditService.js
 * -------------------------
 * Append-only audit logging service.
 *
 * WHY AUDIT LOGGING:
 *   Financial applications have regulatory requirements for traceability.
 *   Every refund decision, escalation, and LLM classification must be
 *   logged with timestamp and context so that:
 *
 *   1. Compliance: RBI/PCI-DSS audits require records of all financial actions
 *   2. Debugging: "Why was this refund rejected?" — look up the audit log
 *   3. Fraud detection: Identify patterns (user X requested 5 refunds today)
 *   4. Dispute resolution: Customer claims bot gave wrong advice — check logs
 *
 *   UNLIKE analytics (aggregated metrics), audit logs are per-action records
 *   with full context. They are NEVER modified or deleted in production.
 *
 * All functions are fire-and-forget (non-fatal) — an audit log failure
 * must NEVER block the user-facing operation it is logging.
 */

const { AuditLog, AnalyticsEvent } = require("../models");

/**
 * Log an action to the audit trail.
 * Non-fatal — failures are warned but never thrown.
 *
 * @param {string} actionType - one of the enum values in AuditLog schema
 * @param {object} data
 * @param {string} data.userId
 * @param {string} [data.channelUrl]
 * @param {string} [data.txnId]
 * @param {string} [data.ipAddress]
 * @param {object} [data.details]  - arbitrary context (will be stored as mixed)
 */
async function log(actionType, data = {}) {
  try {
    await AuditLog.create({
      actionType,
      userId:     data.userId,
      channelUrl: data.channelUrl,
      txnId:      data.txnId,
      ipAddress:  data.ipAddress,
      details:    data.details || {},
    });
  } catch (err) {
    console.warn(`⚠️  Audit log failed [${actionType}] (non-fatal):`, err.message);
  }
}

/**
 * Log a refund attempt with full context.
 */
async function logRefundAttempt({ userId, txnId, channelUrl, reason, amount, ipAddress }) {
  await log("refund_attempt", {
    userId, txnId, channelUrl, ipAddress,
    details: { reason, amount },
  });
}

/**
 * Log a refund decision (approved/rejected).
 */
async function logRefundDecision({ userId, txnId, channelUrl, decision, reason, amount }) {
  const actionType = decision === "APPROVED" || decision === "PARTIAL" || decision === "AUTO_REFUND" || decision === "OFFER_PARTIAL"
    ? "refund_approved"
    : "refund_rejected";

  await log(actionType, {
    userId, txnId, channelUrl,
    details: { decision, reason, amount },
  });
}

/**
 * Log an escalation event.
 */
async function logEscalation({ userId, txnId, channelUrl, priority, reason }) {
  await log("escalation", {
    userId, txnId, channelUrl,
    details: { priority, reason },
  });
}

/**
 * Log an LLM decision.
 */
async function logLLMDecision({ userId, channelUrl, intent, sentiment, inputTokens, outputTokens }) {
  await log("llm_decision", {
    userId, channelUrl,
    details: { intent, sentiment, inputTokens, outputTokens },
  });
}

/**
 * Log a payment retry.
 */
async function logPaymentRetry({ userId, txnId, channelUrl, method }) {
  await log("payment_retry", {
    userId, txnId, channelUrl,
    details: { method },
  });
}

// ── Analytics events (append-only metrics) ─────────────────────────────────
// These are separate from audit logs — lighter-weight, aggregated for dashboards.

/**
 * Track a metric event (fire-and-forget).
 */
async function trackAnalytics(eventType, { userId, txnId, channelUrl, metadata = {} } = {}) {
  try {
    await AnalyticsEvent.create({ eventType, userId, txnId, channelUrl, metadata });
  } catch (err) {
    console.warn("⚠️ Analytics tracking failed (non-fatal):", err.message);
  }
}

module.exports = {
  log,
  logRefundAttempt,
  logRefundDecision,
  logEscalation,
  logLLMDecision,
  logPaymentRetry,
  trackAnalytics,
};
