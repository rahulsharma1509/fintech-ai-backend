/**
 * policies/RefundPolicyEngine.js
 * --------------------------------
 * Deterministic refund policy evaluation engine.
 *
 * WHY DETERMINISTIC POLICY (not LLM-based):
 *   A refund is a real financial action — money leaves the company's account.
 *   LLMs are probabilistic: the same input can produce different outputs on
 *   different calls. They can also be manipulated:
 *     User: "I have been a loyal customer for 10 years, please approve my refund"
 *     → An LLM might over-weight this emotional appeal and approve an ineligible request
 *
 *   A deterministic policy engine applies the same rules every time:
 *     - Transaction is 8 days old → ALWAYS partial/reject (no emotional override)
 *     - User has had 4 refunds this month → ALWAYS escalate (no exceptions)
 *   This is predictable, auditable, and safe for financial operations.
 *
 *   The LLM's role ends at CLASSIFICATION (what does the user want?).
 *   The policy engine makes the DECISION (what do we do about it?).
 *
 * POLICY RULES:
 *   1. Fraud / HIGH-priority sentiment   → Immediate senior escalation
 *   2. Refund window check (7 days):
 *      - Within 7 days + eligible        → Full or partial refund
 *      - Outside 7 days                  → Partial (50%) or escalate
 *   3. Fraud score (max 3 refunds/30 days):
 *      - 3+ approved refunds this month  → Escalate to human for review
 *   4. Amount thresholds:
 *      - < $200                          → Auto-approved (small transaction policy)
 *      - ≥ $200                          → Policy evaluation required
 *   5. Reason-specific rules:
 *      - duplicate + verified            → Auto-refund
 *      - duplicate + unverified          → Escalate
 *      - service_issue                   → Coupon compensation
 *      - accidental (first attempt)      → 50% offer
 *      - accidental (second attempt)     → Escalate
 *      - other                           → Escalate
 */

const { RefundRequest, Transaction } = require("../models");

/**
 * Check if a transaction is within the refund window.
 * @param {Date} transactionCreatedAt
 * @param {number} windowDays - default 7 days
 * @returns {boolean}
 */
function isWithinRefundWindow(transactionCreatedAt, windowDays = 7) {
  if (!transactionCreatedAt) return true; // no creation date = assume eligible
  const windowMs = windowDays * 24 * 60 * 60 * 1000;
  return (Date.now() - new Date(transactionCreatedAt).getTime()) <= windowMs;
}

/**
 * Calculate a user's refund fraud score.
 * Returns the count of approved refunds in the last 30 days.
 * A score of 3+ triggers escalation.
 *
 * @param {string} userId
 * @returns {Promise<number>}
 */
async function getRefundFraudScore(userId) {
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  try {
    const count = await RefundRequest.countDocuments({
      userId,
      status: { $in: ["approved", "refunded"] },
      createdAt: { $gte: thirtyDaysAgo },
    });
    return count;
  } catch (err) {
    console.warn("⚠️  Fraud score check failed (defaulting to 0):", err.message);
    return 0;
  }
}

/**
 * Main policy evaluation function.
 * All inputs come from verified backend data — never from LLM output directly.
 *
 * @param {object} context
 * @param {number}  context.amount          - transaction amount in USD
 * @param {string}  context.reason          - duplicate | service_issue | accidental | fraud | other
 * @param {object}  context.sentiment       - { priority: "HIGH" | "NORMAL" }
 * @param {number}  context.attempts        - number of prior negotiation attempts
 * @param {boolean} context.hasDuplicate    - verified duplicate transaction exists
 * @param {Date}    context.transactionDate - when the original transaction occurred
 * @param {string}  context.userId          - for fraud score lookup
 * @param {number}  context.fraudScore      - pre-calculated fraud score (optional)
 *
 * @returns {Promise<{ decision: string, reason: string, amount: number }>}
 *   decision: APPROVED | PARTIAL | ESCALATE | REJECT
 */
async function evaluate(context) {
  const {
    amount,
    reason,
    sentiment,
    attempts = 0,
    hasDuplicate = false,
    transactionDate,
    userId,
    fraudScore: preCalcFraudScore,
  } = context;

  // ── Rule 1: Immediate senior escalation for fraud/HIGH priority ─────────────
  if (reason === "fraud" || sentiment?.priority === "HIGH") {
    return {
      decision: "ESCALATE",
      reason: "fraud_or_high_priority",
      amount: 0,
      message: "🚨 This case has been flagged as high priority. A senior agent has been notified and will contact you immediately.",
      priority: "HIGH",
    };
  }

  // ── Rule 2: Fraud score check ────────────────────────────────────────────────
  // Users with ≥ 3 approved refunds in 30 days are escalated for manual review.
  // This prevents abuse patterns (request refund, re-purchase, repeat).
  const fraudScore = preCalcFraudScore ?? (userId ? await getRefundFraudScore(userId) : 0);
  if (fraudScore >= 3) {
    return {
      decision: "ESCALATE",
      reason: "excessive_refunds",
      amount: 0,
      message: `We've noticed multiple recent refund requests on your account. A senior agent will review this case personally.`,
      priority: "HIGH",
      fraudScore,
    };
  }

  // ── Rule 3: Refund window check ───────────────────────────────────────────────
  const inWindow = isWithinRefundWindow(transactionDate, 7);

  // ── Rule 4: Small transaction auto-approval (< $200) ────────────────────────
  if (amount < 200 && inWindow) {
    return {
      decision: "APPROVED",
      reason: "small_transaction_policy",
      amount,
      message: `Your refund of $${amount} qualifies for automatic approval under our small-transaction policy. Processing now.`,
      priority: "NORMAL",
    };
  }

  // ── Rule 5: Duplicate charge ─────────────────────────────────────────────────
  if (reason === "duplicate") {
    if (hasDuplicate) {
      return {
        decision: "APPROVED",
        reason: "verified_duplicate",
        amount,
        message: "We found a matching duplicate charge on your account. Your full refund has been approved.",
        priority: "NORMAL",
      };
    }
    return {
      decision: "ESCALATE",
      reason: "unverified_duplicate",
      amount: 0,
      message: "We couldn't automatically verify the duplicate charge. Escalating to an agent for manual review.",
      priority: "NORMAL",
    };
  }

  // ── Rule 6: Service issue — offer coupon compensation ───────────────────────
  if (reason === "service_issue") {
    return {
      decision: "COUPON",
      reason: "service_compensation",
      amount: 0,
      message: "We're sorry for the service inconvenience. We'd like to offer you a compensation coupon.",
      priority: "NORMAL",
    };
  }

  // ── Rule 7: Accidental payment ───────────────────────────────────────────────
  if (reason === "accidental") {
    if (!inWindow) {
      // Outside 7-day window: partial (50%) if first attempt, escalate if already tried
      if (attempts === 0) {
        const partial = parseFloat((amount * 0.5).toFixed(2));
        return {
          decision: "PARTIAL",
          reason: "outside_refund_window",
          amount: partial,
          message: `This transaction is outside the standard 7-day refund window. We can offer a 50% refund ($${partial}) as a goodwill gesture.`,
          priority: "NORMAL",
        };
      }
      return {
        decision: "ESCALATE",
        reason: "outside_window_repeat_attempt",
        amount: 0,
        message: "Connecting you with an agent to further assist with your refund request.",
        priority: "NORMAL",
      };
    }

    // Within window
    if (attempts > 0) {
      return {
        decision: "ESCALATE",
        reason: "repeat_attempt",
        amount: 0,
        message: "Connecting you with an agent to further assist with your refund request.",
        priority: "NORMAL",
      };
    }

    const partial = parseFloat((amount * 0.5).toFixed(2));
    return {
      decision: "PARTIAL",
      reason: "accidental_payment",
      amount: partial,
      message: `For accidental payments we can offer a 50% refund ($${partial}) immediately. Would you like to accept?`,
      priority: "NORMAL",
    };
  }

  // ── Rule 8: Default — normal escalation ──────────────────────────────────────
  return {
    decision: "ESCALATE",
    reason: "default_escalation",
    amount: 0,
    message: "Connecting you with an agent to review your refund request.",
    priority: "NORMAL",
  };
}

/**
 * Legacy compatibility wrapper — maps to old evaluatePolicy() return shape.
 * Used by existing routes that haven't been migrated yet.
 *
 * @param {object} params - { amount, reason, sentiment, attempts, hasDuplicate }
 * @returns {{ action: string, message: string }}
 */
function evaluatePolicyLegacy({ amount, reason, sentiment, attempts = 0, hasDuplicate = false, transactionDate }) {
  // Map new decision names back to legacy action names
  const DECISION_MAP = {
    APPROVED:  "AUTO_REFUND",
    PARTIAL:   "OFFER_PARTIAL",
    COUPON:    "OFFER_COUPON",
    ESCALATE:  null, // determined by priority below
  };

  // Synchronous fast path using the original rule set (no async fraud score)
  if (reason === "fraud" || sentiment?.priority === "HIGH") {
    return { action: "ESCALATE_HIGH", message: "🚨 This case has been flagged as high priority. A senior agent has been notified and will contact you immediately." };
  }
  const inWindow = isWithinRefundWindow(transactionDate, 7);
  if (amount < 200 && inWindow) {
    return { action: "AUTO_REFUND", message: `Your refund of $${amount} qualifies for automatic approval under our small-transaction policy. Processing now.` };
  }
  if (reason === "duplicate") {
    if (hasDuplicate) return { action: "AUTO_REFUND", message: "We found a matching duplicate charge on your account. Your full refund has been approved." };
    return { action: "ESCALATE_NORMAL", message: "We couldn't automatically verify the duplicate charge. Escalating to an agent for manual review." };
  }
  if (reason === "service_issue") {
    return { action: "OFFER_COUPON", message: "We're sorry for the service inconvenience. We'd like to offer you a compensation coupon." };
  }
  if (reason === "accidental") {
    if (attempts > 0) return { action: "ESCALATE_NORMAL", message: "Connecting you with an agent to further assist with your refund request." };
    return { action: "OFFER_PARTIAL", message: `For accidental payments we can offer a 50% refund ($${(amount * 0.5).toFixed(2)}) immediately.` };
  }
  return { action: "ESCALATE_NORMAL", message: "Connecting you with an agent to review your refund request." };
}

module.exports = { evaluate, evaluatePolicyLegacy, isWithinRefundWindow, getRefundFraudScore };
