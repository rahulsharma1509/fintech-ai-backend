/**
 * controllers/transactionController.js
 * --------------------------------------
 * Transaction lookup, list, and payment retry endpoints.
 */

const express = require("express");
const router = express.Router();
const { addBotToChannel, sendBotMessage } = require("../integrations/sendbirdClient");
const { createCheckoutSession, getStripe } = require("../integrations/stripeClient");
const {
  ensureUserTransactions,
  findTransaction,
  getUserTransactions,
} = require("../services/transactionService");
const { updateConversationState } = require("../services/sessionService");
const { logPaymentRetry, trackAnalytics } = require("../services/auditService");
const { generateNaturalResponse } = require("../services/intentService");

// ----------------------------------------------------------
// POST /transaction-list
// Returns the last 5 transactions for a user as interactive buttons.
// Body: { channelUrl, userId }
// ----------------------------------------------------------
router.post("/transaction-list", async (req, res) => {
  try {
    const { channelUrl, userId } = req.body;
    if (!channelUrl || !userId) {
      return res.status(400).json({ error: "channelUrl and userId are required" });
    }

    await addBotToChannel(channelUrl);
    await ensureUserTransactions(userId);

    const txns = await getUserTransactions(userId, 5);
    if (!txns.length) {
      await sendBotMessage(channelUrl, "No transactions found for your account.");
      return res.json({ success: true });
    }

    const STATUS_EMOJI = { failed: "❌", success: "✅", pending: "⏳", refunded: "💚" };

    await sendBotMessage(
      channelUrl,
      "Here are your recent transactions — tap one to manage it:",
      {
        type: "action_buttons",
        buttons: txns.map((t) => ({
          label: `${t.transactionId}  ·  $${t.amount}  ·  ${STATUS_EMOJI[t.status] || "?"} ${t.status}`,
          action: "view_transaction",
          txnId: t.transactionId,
        })),
      }
    );

    return res.json({ success: true });
  } catch (err) {
    console.error("transaction-list error:", err.message);
    return res.status(500).json({ error: "transaction-list", detail: err.message });
  }
});

// ----------------------------------------------------------
// POST /view-transaction
// Looks up a specific transaction and replies with status + action buttons.
// Body: { channelUrl, userId, txnId }
// ----------------------------------------------------------
router.post("/view-transaction", async (req, res) => {
  try {
    const { channelUrl, userId, txnId } = req.body;
    if (!channelUrl || !userId || !txnId) {
      return res.status(400).json({ error: "channelUrl, userId, and txnId are required" });
    }

    const txnKey = txnId.toUpperCase();
    const transaction = await findTransaction(txnKey, userId);
    if (!transaction) {
      return res.status(404).json({ error: `Transaction ${txnId} not found` });
    }

    await addBotToChannel(channelUrl);

    // Persist in conversation memory so follow-up messages resolve correctly
    await updateConversationState(channelUrl, userId, {
      activeTxnId: txnKey,
      lastIntent: "transaction_status",
    });

    // Status-specific action buttons
    const BUTTON_MAP = {
      failed:   [
        { label: "🔄 Retry Payment",  action: "retry_payment", txnId: txnKey },
        { label: "👤 Talk to Agent",  action: "escalate" },
        { label: "📚 FAQ",            action: "faq" },
      ],
      success:  [
        { label: "💰 Request Refund", action: "refund_start",  txnId: txnKey },
        { label: "👤 Talk to Agent",  action: "escalate" },
      ],
      pending:  [
        { label: "👤 Talk to Agent",  action: "escalate" },
        { label: "📚 FAQ",            action: "faq" },
      ],
      refunded: [
        { label: "👤 Talk to Agent",  action: "escalate" },
      ],
    };

    const buttons = BUTTON_MAP[transaction.status] || [{ label: "👤 Talk to Agent", action: "escalate" }];

    const msg = await generateNaturalResponse({
      intent: "transaction_status",
      txnId: txnKey,
      status: transaction.status,
      amount: transaction.amount,
      extra: `Transaction ${txnKey} · $${transaction.amount} · Status: ${transaction.status}`,
    });

    await sendBotMessage(channelUrl, msg, { type: "action_buttons", txnId: txnKey, buttons });
    return res.json({ success: true });
  } catch (err) {
    console.error("view-transaction error:", err.message);
    return res.status(500).json({ error: "view-transaction", detail: err.message });
  }
});

// ----------------------------------------------------------
// POST /retry-payment
// Creates a Stripe Checkout session for a failed transaction.
// Falls back to demo mode when Stripe is not configured.
// Body: { txnId, channelUrl, userId }
// Response: { paymentUrl, demo? }
// ----------------------------------------------------------
router.post("/retry-payment", async (req, res) => {
  try {
    const { txnId, channelUrl, userId } = req.body;
    if (!txnId || !channelUrl || !userId) {
      return res.status(400).json({ error: "txnId, channelUrl, and userId are required" });
    }

    const transaction = await findTransaction(txnId.toUpperCase(), userId);
    if (!transaction) {
      return res.status(404).json({ error: `Transaction ${txnId} not found` });
    }

    const stripe = getStripe();

    // Demo mode — Stripe not configured
    if (!stripe) {
      await addBotToChannel(channelUrl);
      await sendBotMessage(
        channelUrl,
        `[DEMO] Stripe is not configured yet. In production, clicking "Retry Payment" would open a secure Stripe Checkout for $${transaction.amount} (${txnId}). Add STRIPE_SECRET_KEY to enable real payments.`
      );
      return res.json({
        paymentUrl: "https://stripe.com/docs/testing",
        demo: true,
        message: "Add STRIPE_SECRET_KEY to enable real Stripe Checkout.",
      });
    }

    const frontendUrl = process.env.FRONTEND_URL || "http://localhost:3000";
    const paymentUrl = await createCheckoutSession({
      txnId: txnId.toUpperCase(),
      amount: transaction.amount,
      channelUrl,
      userId,
      frontendUrl,
    });

    await addBotToChannel(channelUrl);
    await sendBotMessage(
      channelUrl,
      `Your secure payment link for ${txnId} ($${transaction.amount}) is ready. Complete the payment — you'll be redirected back here when done.`
    );

    await logPaymentRetry({ userId, txnId: txnId.toUpperCase(), channelUrl, method: "stripe_checkout" });
    return res.json({ paymentUrl });
  } catch (err) {
    console.error("retry-payment error:", err.message);
    return res.status(500).json({ error: "retry-payment", detail: err.message });
  }
});

// ----------------------------------------------------------
// GET /analytics
// Returns aggregated metrics from AnalyticsEvent collection.
// ----------------------------------------------------------
const { AnalyticsEvent } = require("../models");
router.get("/analytics", async (req, res) => {
  try {
    const [refundRequests, refundApproved, refundRejected, escalations, paymentRetries] =
      await Promise.all([
        AnalyticsEvent.countDocuments({ eventType: "refund_request" }),
        AnalyticsEvent.countDocuments({ eventType: "refund_approved" }),
        AnalyticsEvent.countDocuments({ eventType: "refund_rejected" }),
        AnalyticsEvent.countDocuments({ eventType: "escalation" }),
        AnalyticsEvent.countDocuments({ eventType: "payment_retry" }),
      ]);

    const autoRefunds = await AnalyticsEvent.countDocuments({
      eventType: "refund_approved",
      "metadata.action": "AUTO_REFUND",
    });

    const approvalRate =
      refundRequests > 0 ? ((refundApproved / refundRequests) * 100).toFixed(1) : "0.0";
    const autoResolutionRate =
      refundRequests > 0 ? ((autoRefunds / refundRequests) * 100).toFixed(1) : "0.0";

    const recentEvents = await AnalyticsEvent.find().sort({ createdAt: -1 }).limit(20).lean();

    return res.json({
      refundRequests,
      refundApprovalRate: `${approvalRate}%`,
      autoResolutionRate: `${autoResolutionRate}%`,
      escalationCount: escalations,
      paymentRetryCount: paymentRetries,
      breakdown: { refundApproved, refundRejected, autoRefunds },
      recentEvents,
    });
  } catch (err) {
    return res.status(500).json({ error: "analytics", detail: err.message });
  }
});

module.exports = router;
