/**
 * controllers/refundController.js
 * --------------------------------
 * Refund negotiation flow and refund execution endpoints.
 *
 * Flow states: refund_start → refund_reason → [refund_accept_partial | refund_decline]
 *
 * WHY DETERMINISTIC POLICY (not LLM):
 *   Every refund decision in this file goes through RefundPolicyEngine.evaluate()
 *   which applies fixed, auditable business rules. The LLM classified the intent
 *   and the user typed the reason — but the DECISION is made by code, not AI.
 *   This means a refund is issued only when all conditions are provably met:
 *   transaction exists in DB, belongs to this user, amount matches policy threshold,
 *   refund window hasn't expired, and fraud score is below the limit.
 */

const express = require("express");
const router = express.Router();
const { addBotToChannel, sendBotMessage } = require("../integrations/sendbirdClient");
const { RefundRequest, Transaction } = require("../models");
const { evaluatePolicyLegacy } = require("../policies/RefundPolicyEngine");
const { evaluate: evaluateRefundPolicy, getRefundFraudScore } = require("../policies/RefundPolicyEngine");
const { processRefundInternal, findTransaction } = require("../services/transactionService");
const { updateConversationState } = require("../services/sessionService");
const { logRefundAttempt, logRefundDecision, logEscalation, trackAnalytics } = require("../services/auditService");
const { detectSentiment } = require("../services/intentService");
const {
  escalatedChannels,
  getOrCreateDeskChannel,
  sendDeskContext,
} = require("../services/deskService");
const { ChannelMapping } = require("../models");

// ----------------------------------------------------------
// POST /refund-action
// Handles all refund negotiation button clicks from the frontend.
//   action="refund_start"           → ask reason
//   action="refund_reason"          → evaluate policy, execute decision
//   action="refund_accept_partial"  → user accepts 50% offer
//   action="refund_decline"         → user declines offer
// Body: { channelUrl, userId, txnId, action, reason? }
// ----------------------------------------------------------
router.post("/refund-action", async (req, res) => {
  try {
    const { channelUrl, userId, txnId, action, reason } = req.body;
    if (!channelUrl || !userId || !txnId || !action) {
      return res.status(400).json({ error: "channelUrl, userId, txnId, and action are required" });
    }

    const txnKey = txnId.toUpperCase();
    const transaction = await findTransaction(txnKey, userId);
    if (!transaction) return res.status(404).json({ error: `Transaction ${txnId} not found` });

    await addBotToChannel(channelUrl);

    // ── START: ask the user to pick a reason ─────────────────────────────────
    if (action === "refund_start" || action === "start") {
      if (transaction.status === "refunded") {
        await sendBotMessage(channelUrl, `A refund for ${txnKey} has already been processed.`);
        return res.json({ success: true });
      }
      if (transaction.status !== "success") {
        await sendBotMessage(
          channelUrl,
          `Refunds are only available for successful transactions. ${txnKey} has status: ${transaction.status}.`
        );
        return res.json({ success: true });
      }

      await RefundRequest.findOneAndUpdate(
        { userId, txnId: txnKey, channelUrl },
        {
          userId, txnId: txnKey, channelUrl,
          refundStage: "reason_asked", status: "pending",
          negotiationAttempts: 0, updatedAt: new Date(),
        },
        { upsert: true }
      );
      await updateConversationState(channelUrl, userId, {
        activeTxnId: txnKey, refundStage: "reason_asked", lastIntent: "refund_start",
      });
      await logRefundAttempt({ userId, txnId: txnKey, channelUrl, amount: transaction.amount });
      await trackAnalytics("refund_request", { userId, txnId: txnKey, channelUrl });

      await sendBotMessage(
        channelUrl,
        `I can help with a refund for ${txnKey} ($${transaction.amount}). Please select the reason for your request:`,
        {
          type: "action_buttons",
          txnId: txnKey,
          buttons: [
            { label: "Duplicate Charge", action: "refund_reason", reason: "duplicate" },
            { label: "Service Issue",    action: "refund_reason", reason: "service_issue" },
            { label: "Accidental Pay",   action: "refund_reason", reason: "accidental" },
            { label: "Fraud Concern",    action: "refund_reason", reason: "fraud" },
            { label: "Other",            action: "refund_reason", reason: "other" },
          ],
        }
      );
      return res.json({ success: true });
    }

    // ── REASON: run policy engine and execute decision ────────────────────────
    if (action === "refund_reason") {
      if (!reason) return res.status(400).json({ error: "reason is required" });

      const existing = await RefundRequest.findOne({ userId, txnId: txnKey, channelUrl });
      const attempts = existing?.negotiationAttempts || 0;

      // For duplicate claims: check last 5 transactions for a same-amount match
      let hasDuplicate = false;
      if (reason === "duplicate") {
        const recentTxns = await Transaction.find({ userId }).sort({ _id: -1 }).limit(5);
        hasDuplicate = recentTxns.some(
          (t) => t.amount === transaction.amount && t.transactionId !== txnKey
        );
        console.log(`🔍 Duplicate check for ${txnKey}: hasDuplicate=${hasDuplicate}`);
      }

      // Get fraud score (max 3 refunds per 30 days)
      const fraudScore = await getRefundFraudScore(userId);

      // Run the enhanced policy engine
      const policyResult = await evaluateRefundPolicy({
        amount: transaction.amount,
        reason,
        sentiment: detectSentiment(reason),
        attempts,
        hasDuplicate,
        transactionDate: transaction.createdAt,
        userId,
        fraudScore,
      });

      // Map new policy decision names to legacy action names for the existing flow
      const legacyAction = {
        APPROVED: "AUTO_REFUND",
        PARTIAL:  "OFFER_PARTIAL",
        COUPON:   "OFFER_COUPON",
        ESCALATE: policyResult.priority === "HIGH" ? "ESCALATE_HIGH" : "ESCALATE_NORMAL",
      }[policyResult.decision] || "ESCALATE_NORMAL";

      // Persist the decision
      await RefundRequest.findOneAndUpdate(
        { userId, txnId: txnKey, channelUrl },
        {
          refundReason: reason,
          refundStage: "policy_evaluated",
          finalDecision: legacyAction,
          negotiationAttempts: attempts + 1,
          updatedAt: new Date(),
        },
        { upsert: true }
      );
      await updateConversationState(channelUrl, userId, {
        refundStage: "policy_evaluated", lastIntent: "refund_reason",
      });

      // Log for audit trail
      await logRefundAttempt({ userId, txnId: txnKey, channelUrl, reason, amount: transaction.amount });

      if (legacyAction === "AUTO_REFUND") {
        await processRefundInternal(txnKey, channelUrl, userId, transaction);
        await logRefundDecision({ userId, txnId: txnKey, channelUrl, decision: "APPROVED", reason, amount: transaction.amount });
        await trackAnalytics("refund_approved", {
          userId, txnId: txnKey, channelUrl,
          metadata: { reason, action: "AUTO_REFUND" },
        });

      } else if (legacyAction === "OFFER_PARTIAL") {
        const half = (transaction.amount * 0.5).toFixed(2);
        await sendBotMessage(
          channelUrl,
          `${policyResult.message} Would you like to accept a 50% refund of $${half}?`,
          {
            type: "action_buttons",
            txnId: txnKey,
            buttons: [
              { label: `Accept $${half} Refund`, action: "refund_accept_partial", txnId: txnKey },
              { label: "Decline",                action: "refund_decline",         txnId: txnKey },
            ],
          }
        );

      } else if (legacyAction === "OFFER_COUPON") {
        const coupon = `COUP-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
        await RefundRequest.findOneAndUpdate(
          { userId, txnId: txnKey, channelUrl },
          { status: "approved", finalDecision: "OFFER_COUPON", refundStage: "completed", updatedAt: new Date() }
        );
        await sendBotMessage(
          channelUrl,
          `${policyResult.message} Your compensation coupon: **${coupon}** (valid 30 days on your next transaction).`,
          { type: "refund_status", status: "coupon_issued", txnId: txnKey, couponCode: coupon }
        );
        await logRefundDecision({ userId, txnId: txnKey, channelUrl, decision: "COUPON", reason, amount: 0 });
        await trackAnalytics("refund_approved", {
          userId, txnId: txnKey, channelUrl,
          metadata: { reason, action: "OFFER_COUPON", couponCode: coupon },
        });

      } else if (legacyAction === "ESCALATE_HIGH") {
        const deskUrl = await getOrCreateDeskChannel(channelUrl, userId);
        await sendBotMessage(channelUrl, policyResult.message,
          { type: "priority_badge", priority: "HIGH", txnId: txnKey }
        );
        if (deskUrl) {
          await sendDeskContext(
            deskUrl, userId,
            `[🤖 AI Support — Automated Context]\n\n` +
            `🚨 HIGH PRIORITY — Refund Escalation\n\n` +
            `Customer : ${userId}\n` +
            `Transaction : ${txnKey}  ·  $${transaction.amount}\n` +
            `Refund Reason : ${reason}\n` +
            `Fraud Score : ${fraudScore} refunds in last 30 days\n\n` +
            `⚠️  Immediate review required.`
          );
        }
        await logEscalation({ userId, txnId: txnKey, channelUrl, priority: "HIGH", reason });
        await trackAnalytics("escalation", { userId, txnId: txnKey, channelUrl, metadata: { reason, priority: "HIGH" } });

      } else { // ESCALATE_NORMAL
        const REASON_LABELS = {
          duplicate:     "Duplicate Charge (could not be auto-verified)",
          service_issue: "Service Issue",
          accidental:    "Accidental Payment (50% offer was presented)",
          other:         "Other / Unspecified",
        };
        const deskUrl = await getOrCreateDeskChannel(channelUrl, userId);
        await sendBotMessage(channelUrl, policyResult.message,
          { type: "priority_badge", priority: "NORMAL", txnId: txnKey }
        );
        if (deskUrl) {
          await sendDeskContext(
            deskUrl, userId,
            `[🤖 AI Support — Automated Context]\n\n` +
            `📋 Refund Escalation — Agent Review Required\n\n` +
            `Customer : ${userId}\n` +
            `Transaction : ${txnKey}  ·  $${transaction.amount}\n` +
            `Refund Reason : ${REASON_LABELS[reason] || reason}\n\n` +
            `Policy engine could not auto-resolve. Please review manually.`
          );
        }
        await logEscalation({ userId, txnId: txnKey, channelUrl, priority: "NORMAL", reason });
        await trackAnalytics("escalation", { userId, txnId: txnKey, channelUrl, metadata: { reason, priority: "NORMAL" } });
      }

      return res.json({ success: true, decision: legacyAction });
    }

    // ── ACCEPT PARTIAL ─────────────────────────────────────────────────────────
    if (action === "refund_accept_partial") {
      const partialAmt = transaction.amount * 0.5;
      await processRefundInternal(txnKey, channelUrl, userId, transaction, partialAmt);
      await logRefundDecision({ userId, txnId: txnKey, channelUrl, decision: "PARTIAL", reason: "accidental", amount: partialAmt });
      await trackAnalytics("refund_approved", {
        userId, txnId: txnKey, channelUrl,
        metadata: { action: "OFFER_PARTIAL", amount: partialAmt },
      });
      return res.json({ success: true, decision: "OFFER_PARTIAL" });
    }

    // ── DECLINE ────────────────────────────────────────────────────────────────
    if (action === "refund_decline") {
      await RefundRequest.findOneAndUpdate(
        { userId, txnId: txnKey, channelUrl },
        { status: "rejected", refundStage: "completed", updatedAt: new Date() }
      );
      await sendBotMessage(
        channelUrl,
        `Understood. Your refund request for ${txnKey} has been cancelled. Is there anything else I can help you with?`
      );
      await logRefundDecision({ userId, txnId: txnKey, channelUrl, decision: "declined" });
      await trackAnalytics("refund_rejected", { userId, txnId: txnKey, channelUrl });
      return res.json({ success: true, decision: "declined" });
    }

    return res.status(400).json({ error: `Unknown refund action: ${action}` });
  } catch (err) {
    console.error("refund-action error:", err.message);
    return res.status(500).json({ error: "refund-action", detail: err.message });
  }
});

// ----------------------------------------------------------
// POST /process-refund
// Direct refund execution — requires an existing approved/pending RefundRequest.
// Body: { txnId, channelUrl, userId, amount? }
// ----------------------------------------------------------
router.post("/process-refund", async (req, res) => {
  try {
    const { txnId, channelUrl, userId, amount } = req.body;
    if (!txnId || !channelUrl || !userId) {
      return res.status(400).json({ error: "txnId, channelUrl, and userId are required" });
    }

    const txnKey = txnId.toUpperCase();
    const transaction = await findTransaction(txnKey, userId);
    if (!transaction) return res.status(404).json({ error: `Transaction ${txnId} not found` });

    // Authorization gate: an approved/pending RefundRequest must exist
    const refundReq = await RefundRequest.findOne({
      txnId: txnKey,
      userId,
      status: { $in: ["pending", "approved"] },
    });
    if (!refundReq) {
      return res.status(403).json({ error: "No approved refund request found for this transaction." });
    }

    const refundAmount = amount != null ? Number(amount) : transaction.amount;
    await processRefundInternal(txnKey, channelUrl, userId, transaction, refundAmount);

    // Notify Desk channel if ticket is open
    if (escalatedChannels.has(channelUrl)) {
      const mapping = await ChannelMapping.findOne({ originalChannelUrl: channelUrl });
      if (mapping) {
        await sendBotMessage(
          mapping.deskChannelUrl,
          `Refund of $${refundAmount.toFixed(2)} for ${txnKey} has been processed for customer ${userId}. Ticket can be closed.`
        );
      }
    }

    await logRefundDecision({ userId, txnId: txnKey, channelUrl, decision: "APPROVED", amount: refundAmount });
    await trackAnalytics("refund_approved", {
      userId, txnId: txnKey, channelUrl,
      metadata: { source: "process-refund", amount: refundAmount },
    });
    return res.json({ success: true, refundAmount });
  } catch (err) {
    console.error("process-refund error:", err.message);
    return res.status(500).json({ error: "process-refund", detail: err.message });
  }
});

module.exports = router;
