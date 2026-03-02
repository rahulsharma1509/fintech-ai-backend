/**
 * policies/FraudEngine.js
 * -----------------------
 * Deterministic fraud detection engine.
 *
 * WHY DETERMINISTIC (NOT LLM):
 *   Financial fraud decisions must be auditable, reproducible, and fast.
 *   An LLM can be manipulated by clever phrasing; rule-based logic cannot.
 *   Every decision here traces back to specific measurable inputs.
 *
 * RISK SCORING:
 *   Each triggered rule adds to a 0–100 risk score.
 *   riskLevel is derived from the final score:
 *     0–30  → LOW    → APPROVE
 *     31–60 → MEDIUM → PARTIAL refund or extra review
 *     61+   → HIGH   → ESCALATE to human agent
 *
 * NO LLM CALLS HERE. No external API calls here.
 */

const { RefundRequest, Transaction, FraudLog } = require("../models");

// Score weights per rule (must sum to ≤ 100 for a single case)
const WEIGHTS = {
  HIGH_REFUND_AMOUNT:    30,  // refund amount > ₹10,000
  REFUND_HISTORY:        40,  // >3 approved refunds in last 30 days
  NEW_USER_INSTANT:      20,  // account < 24h and requesting refund
  RAPID_REQUESTS:        25,  // 3+ refund requests in 5 minutes
};

/**
 * Count approved refunds for userId in the last 30 days.
 * @returns {number}
 */
async function countRecentApprovedRefunds(userId) {
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  return RefundRequest.countDocuments({
    userId,
    status: { $in: ["approved", "refunded"] },
    createdAt: { $gte: since },
  });
}

/**
 * Count refund requests in the last 5 minutes (rapid-fire detection).
 * @returns {number}
 */
async function countRecentRequests(userId) {
  const since = new Date(Date.now() - 5 * 60 * 1000);
  return RefundRequest.countDocuments({
    userId,
    createdAt: { $gte: since },
  });
}

/**
 * Main fraud evaluation function.
 *
 * @param {object} params
 * @param {string} params.userId
 * @param {string} params.txnId
 * @param {number} params.amountINR   - refund amount in INR (use USD amount × 83 as approx if needed)
 * @param {Date}   params.userCreatedAt - when the user registered (for new-user check)
 * @returns {Promise<{riskScore: number, riskLevel: string, action: string, triggers: string[]}>}
 */
async function evaluate({ userId, txnId, amountINR = 0, userCreatedAt = null }) {
  let score = 0;
  const triggers = [];

  // ── Rule 1: High refund amount (> ₹10,000) ───────────────────────────────
  if (amountINR > 10000) {
    score += WEIGHTS.HIGH_REFUND_AMOUNT;
    triggers.push("high_refund_amount");
  }

  // ── Rule 2: >3 approved refunds in last 30 days ───────────────────────────
  const recentRefunds = await countRecentApprovedRefunds(userId);
  if (recentRefunds > 3) {
    score += WEIGHTS.REFUND_HISTORY;
    triggers.push("refund_history_abuse");
  }

  // ── Rule 3: New user requesting refund immediately (account < 24h) ────────
  if (userCreatedAt) {
    const ageMs = Date.now() - new Date(userCreatedAt).getTime();
    const ageHours = ageMs / (1000 * 60 * 60);
    if (ageHours < 24) {
      score += WEIGHTS.NEW_USER_INSTANT;
      triggers.push("new_user_instant_refund");
    }
  }

  // ── Rule 4: Rapid repeated requests (3+ in 5 minutes) ────────────────────
  const rapidCount = await countRecentRequests(userId);
  if (rapidCount >= 3) {
    score += WEIGHTS.RAPID_REQUESTS;
    triggers.push("rapid_requests");
  }

  // Cap score at 100
  score = Math.min(score, 100);

  // ── Derive risk level + action ────────────────────────────────────────────
  let riskLevel, action;
  if (score >= 61) {
    riskLevel = "HIGH";
    action = "ESCALATE";
  } else if (score >= 31) {
    riskLevel = "MEDIUM";
    action = "PARTIAL";
  } else {
    riskLevel = "LOW";
    action = "APPROVE";
  }

  // ── Persist fraud log (non-fatal) ─────────────────────────────────────────
  try {
    await FraudLog.create({
      userId,
      txnId,
      riskScore: score,
      riskLevel,
      action,
      triggers,
      refundAmountINR: amountINR,
      refundsInLast30Days: recentRefunds,
    });
  } catch (err) {
    console.error("⚠️  FraudEngine: failed to persist fraud log:", err.message);
  }

  console.log(`[FraudEngine] userId=${userId} txnId=${txnId} score=${score} level=${riskLevel} action=${action} triggers=[${triggers.join(",")}]`);

  return { riskScore: score, riskLevel, action, triggers };
}

module.exports = { evaluate };
