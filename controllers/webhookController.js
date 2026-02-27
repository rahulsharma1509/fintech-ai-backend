/**
 * controllers/webhookController.js
 * ---------------------------------
 * Sendbird webhook handler (main bot logic) and Stripe payment webhook.
 *
 * Message routing order:
 *   1. Desk channel? → forward agent replies to customer
 *   2. Already escalated + no TXN? → forward customer follow-ups to Desk
 *   3. HIGH sentiment keywords? → auto-escalate
 *   4. No TXN ID? → LLM intent detection → route to intent handlers
 *   5. TXN ID found? → transaction lookup + action buttons
 */

const express = require("express");
const router = express.Router();

const { addBotToChannel, sendBotMessage, sendChannelMessage } = require("../integrations/sendbirdClient");
const { constructWebhookEvent, getStripe } = require("../integrations/stripeClient");
const { Transaction, ChannelMapping } = require("../models");
const {
  detectIntent,
  generateNaturalResponse,
  detectSentiment,
  queryKnowledgeBase,
} = require("../services/intentService");
const { ensureUserTransactions, findTransaction, processRefundInternal } = require("../services/transactionService");
const { updateConversationState, getConversationState } = require("../services/sessionService");
const { trackAnalytics, log } = require("../services/auditService");
const {
  escalatedChannels,
  deskChannels,
  createDeskTicket,
  getOrCreateDeskChannel,
  scheduleAgentAwayFallback,
  clearAgentAwayTimer,
  sendDeskContext,
} = require("../services/deskService");
const { RefundRequest } = require("../models");

// HubSpot (optional)
async function createHubSpotTicket(txnId, email) {
  const HUBSPOT_TOKEN = process.env.HUBSPOT_TOKEN;
  if (!HUBSPOT_TOKEN) return;
  const axios = require("axios");
  await axios.post(
    "https://api.hubapi.com/crm/v3/objects/tickets",
    {
      properties: {
        subject: `Failed Transaction ${txnId}`,
        content: `Transaction ${txnId} failed for ${email}`,
        hs_pipeline: "0",
        hs_pipeline_stage: "1",
      },
    },
    { headers: { Authorization: `Bearer ${HUBSPOT_TOKEN}`, "Content-Type": "application/json" } }
  );
  console.log("HubSpot ticket created");
}

// ----------------------------------------------------------
// POST /sendbird-webhook
// Main bot logic — routes every incoming message.
// Idempotency and per-user rate limiting are handled by middleware
// applied in server.js before this handler runs.
// ----------------------------------------------------------
router.post("/sendbird-webhook", async (req, res) => {
  try {
    const event = req.body;

    if (event.category !== "group_channel:message_send") {
      return res.sendStatus(200);
    }

    const messageId   = event.payload?.message_id;
    const messageText = event.payload?.message;
    const channelUrl  = event.channel?.channel_url;
    const senderId    = event.sender?.user_id;

    console.log("📩 Webhook received:", { messageId, senderId, channelUrl, messageText });

    if (!senderId) return res.sendStatus(200);
    if (senderId === "support_bot") return res.sendStatus(200);

    // Log webhook received (async, non-blocking)
    log("webhook_received", {
      userId: senderId,
      channelUrl,
      details: { messageId, messageLength: messageText?.length },
    }).catch(() => {});

    // ── Desk channel: forward agent replies back to the customer ──────────────
    if (channelUrl?.startsWith("sendbird_desk_") || deskChannels.has(channelUrl)) {
      const mapping = await ChannelMapping.findOne({ deskChannelUrl: channelUrl });
      if (mapping && senderId !== mapping.userId) {
        console.log(`📨 Forwarding agent message to customer channel: ${mapping.originalChannelUrl}`);
        clearAgentAwayTimer(mapping.originalChannelUrl);
        await sendBotMessage(mapping.originalChannelUrl, `[Support Agent]: ${messageText}`);
      }
      return res.sendStatus(200);
    }

    // Safety guard: drop stray Desk agent messages
    if (senderId?.startsWith("sendbird_desk_agent_id_")) return res.sendStatus(200);

    const txnMatch = messageText?.match(/TXN\d+/i);

    // ── Already escalated: forward customer follow-ups to Desk ────────────────
    if (escalatedChannels.has(channelUrl) && !txnMatch) {
      const mapping = await ChannelMapping.findOne({ originalChannelUrl: channelUrl });
      if (mapping) {
        console.log(`📨 Forwarding customer follow-up to Desk channel: ${mapping.deskChannelUrl}`);
        await sendChannelMessage(mapping.deskChannelUrl, senderId, messageText);
      }
      return res.sendStatus(200);
    }

    // ── HIGH sentiment: immediate escalation ─────────────────────────────────
    const { priority: msgPriority, triggers: sentimentTriggers } = detectSentiment(messageText);
    if (msgPriority === "HIGH") {
      console.log(`🚨 HIGH priority sentiment detected: ${sentimentTriggers.join(", ")}`);
      await addBotToChannel(channelUrl);
      if (!escalatedChannels.has(channelUrl)) {
        try {
          await createDeskTicket(channelUrl, senderId);
          escalatedChannels.add(channelUrl);
          scheduleAgentAwayFallback(channelUrl);
        } catch (err) {
          console.error("High-priority escalation failed:", err.message);
        }
      }
      await updateConversationState(channelUrl, senderId, {
        escalationStatus: "high",
        priority: "HIGH",
        lastIntent: "sentiment_escalation",
      });
      await trackAnalytics("escalation", {
        userId: senderId, channelUrl,
        metadata: { priority: "HIGH", triggers: sentimentTriggers },
      });
      await sendBotMessage(
        channelUrl,
        "🚨 Your message has been flagged as high priority. A senior support agent has been notified and will contact you immediately.",
        { type: "priority_badge", priority: "HIGH" }
      );
      return res.sendStatus(200);
    }

    // ── No TXN ID: LLM intent detection ──────────────────────────────────────
    if (!txnMatch) {
      const {
        intent,
        transaction_id: llmTxnId,
        sentiment: llmSentiment,
      } = await detectIntent(messageText, senderId);

      await addBotToChannel(channelUrl);

      const needsEscalationSuggestion =
        (llmSentiment === "angry" || llmSentiment === "frustrated") && intent !== "escalation";

      // Transaction inference from LLM context
      if (llmTxnId && /^TXN\d+$/i.test(llmTxnId)) {
        const inferredTxn = await findTransaction(llmTxnId.toUpperCase(), senderId);
        if (inferredTxn) {
          console.log(`[LLM] Inferred TXN from context: ${llmTxnId}`);
          await updateConversationState(channelUrl, senderId, {
            activeTxnId: inferredTxn.transactionId,
            lastIntent: "transaction_lookup",
          });
          const naturalMsg = await generateNaturalResponse({
            intent: "transaction_status",
            txnId: inferredTxn.transactionId,
            status: inferredTxn.status,
            amount: inferredTxn.amount,
            extra: `Transaction ${inferredTxn.transactionId} status: ${inferredTxn.status}. Amount: $${inferredTxn.amount}.`,
          });
          await sendBotMessage(channelUrl, naturalMsg, {
            type: "action_buttons",
            txnId: inferredTxn.transactionId,
            buttons: inferredTxn.status === "failed"
              ? [
                  { label: "Retry Payment",  action: "retry_payment", txnId: inferredTxn.transactionId },
                  { label: "Talk to Human",  action: "escalate" },
                  { label: "View FAQ",       action: "faq" },
                ]
              : [
                  { label: "Request Refund", action: "refund_start",  txnId: inferredTxn.transactionId },
                  { label: "Talk to Agent",  action: "escalate" },
                ],
          });
          return res.sendStatus(200);
        }
      }

      // Route by intent
      if (intent === "escalation") {
        if (!escalatedChannels.has(channelUrl)) {
          try {
            await createDeskTicket(channelUrl, senderId);
            escalatedChannels.add(channelUrl);
            scheduleAgentAwayFallback(channelUrl);
          } catch (err) {
            console.error("Desk escalation failed (non-fatal):", err.message);
          }
        }
        await sendBotMessage(
          channelUrl,
          "Connecting you with a human support agent now. Please hold on — an agent will be with you shortly."
        );
        return res.sendStatus(200);
      }

      if (intent === "retry_payment") {
        await sendBotMessage(
          channelUrl,
          "Please provide your transaction ID (e.g., TXN1001) so I can initiate the retry."
        );
        return res.sendStatus(200);
      }

      if (intent === "refund_request") {
        const state = await getConversationState(channelUrl);
        const activeTxnId = llmTxnId?.toUpperCase() || state?.activeTxnId;

        if (!activeTxnId) {
          await sendBotMessage(
            channelUrl,
            "To start a refund request, please provide your transaction ID first (e.g., TXN1001)."
          );
          return res.sendStatus(200);
        }

        const refundTxn = await findTransaction(activeTxnId, senderId);
        if (!refundTxn || refundTxn.status === "failed") {
          await sendBotMessage(
            channelUrl,
            `Transaction ${activeTxnId} is not eligible for a refund (refunds apply to successful transactions only).`
          );
          return res.sendStatus(200);
        }
        if (refundTxn.status === "refunded") {
          await sendBotMessage(channelUrl, `A refund for ${activeTxnId} has already been processed.`);
          return res.sendStatus(200);
        }

        await RefundRequest.findOneAndUpdate(
          { userId: senderId, txnId: activeTxnId, channelUrl },
          {
            userId: senderId, txnId: activeTxnId, channelUrl,
            refundStage: "reason_asked", status: "pending",
            negotiationAttempts: 0, updatedAt: new Date(),
          },
          { upsert: true }
        );
        await updateConversationState(channelUrl, senderId, {
          lastIntent: "refund_request",
          refundStage: "reason_asked",
        });
        await trackAnalytics("refund_request", { userId: senderId, txnId: activeTxnId, channelUrl });

        await sendBotMessage(
          channelUrl,
          `I can help with a refund for ${activeTxnId} ($${refundTxn.amount}). Please select the reason:`,
          {
            type: "action_buttons",
            txnId: activeTxnId,
            buttons: [
              { label: "Duplicate Charge", action: "refund_reason", reason: "duplicate" },
              { label: "Service Issue",    action: "refund_reason", reason: "service_issue" },
              { label: "Accidental Pay",   action: "refund_reason", reason: "accidental" },
              { label: "Fraud Concern",    action: "refund_reason", reason: "fraud" },
              { label: "Other",            action: "refund_reason", reason: "other" },
            ],
          }
        );
        return res.sendStatus(200);
      }

      // KB fallback
      const kbResult = queryKnowledgeBase(messageText);
      if (kbResult.found) {
        await sendBotMessage(channelUrl, kbResult.answer);
        return res.sendStatus(200);
      }

      // Unknown intent — suggestion buttons
      const fallbackText = needsEscalationSuggestion
        ? "I can see you're having a frustrating experience — I'm sorry about that. Let me help you get to the right place quickly."
        : "Please provide your transaction ID (e.g., TXN1001), or choose an option below:";

      const suggestionButtons = needsEscalationSuggestion
        ? [
            { label: "Talk to Human",  action: "escalate" },
            { label: "Retry Payment",  action: "retry_payment" },
            { label: "View FAQ",       action: "faq" },
          ]
        : [
            { label: "Retry Payment",  action: "retry_payment" },
            { label: "Talk to Human",  action: "escalate" },
            { label: "View FAQ",       action: "faq" },
          ];

      await sendBotMessage(channelUrl, fallbackText, {
        type: "action_buttons",
        buttons: suggestionButtons,
      });
      return res.sendStatus(200);
    }

    // ── TXN ID found ──────────────────────────────────────────────────────────
    const txnId = txnMatch[0].toUpperCase();
    await ensureUserTransactions(senderId);
    console.log("🔍 Looking up transaction:", txnId, "for user:", senderId);
    const transaction = await findTransaction(txnId, senderId);

    if (!transaction) {
      await addBotToChannel(channelUrl);
      await sendBotMessage(
        channelUrl,
        `Transaction ${txnId} was not found in our system. Please check the ID and try again.`
      );
      return res.sendStatus(200);
    }

    console.log("✅ Transaction found, status:", transaction.status);
    await addBotToChannel(channelUrl);

    await updateConversationState(channelUrl, senderId, {
      activeTxnId: txnId,
      lastIntent: "transaction_status",
    });

    if (transaction.status === "failed") {
      try { await createHubSpotTicket(txnId, transaction.userEmail); } catch {}
      try {
        await createDeskTicket(channelUrl, senderId);
        escalatedChannels.add(channelUrl);
        scheduleAgentAwayFallback(channelUrl);
      } catch (err) {
        console.error("Desk (non-fatal):", err.message);
      }

      await trackAnalytics("payment_retry", {
        userId: senderId, txnId, channelUrl,
        metadata: { status: "failed", amount: transaction.amount },
      });

      const failedMsg = await generateNaturalResponse({
        intent: "transaction_status",
        txnId,
        status: "failed",
        amount: transaction.amount,
        extra: `Your transaction ${txnId} ($${transaction.amount}) has failed. A support case has been opened. How would you like to proceed?`,
      });

      await sendBotMessage(channelUrl, failedMsg, {
        type: "action_buttons",
        txnId,
        buttons: [
          { label: "Retry Payment", action: "retry_payment", txnId },
          { label: "Talk to Human", action: "escalate" },
          { label: "View FAQ",      action: "faq" },
        ],
      });
      return res.sendStatus(200);
    }

    if (transaction.status === "success") {
      const successMsg = await generateNaturalResponse({
        intent: "transaction_status",
        txnId,
        status: "success",
        amount: transaction.amount,
        extra: `Transaction ${txnId} completed successfully ✅. Amount: $${transaction.amount}.\nNeed help with this transaction?`,
      });

      await sendBotMessage(channelUrl, successMsg, {
        type: "action_buttons",
        txnId,
        buttons: [
          { label: "Request Refund", action: "refund_start", txnId },
          { label: "Talk to Agent",  action: "escalate" },
        ],
      });
      return res.sendStatus(200);
    }

    await sendBotMessage(
      channelUrl,
      `Transaction ${txnId} status: ${transaction.status} ⏳. Amount: $${transaction.amount}.`
    );
    return res.sendStatus(200);
  } catch (error) {
    console.error("Webhook error:", error.response?.data || error.message);
    return res.sendStatus(500);
  }
});

// ----------------------------------------------------------
// POST /payment-webhook
// Stripe calls this after checkout.session.completed.
// Signature verified before this handler via constructWebhookEvent.
// ----------------------------------------------------------
router.post("/payment-webhook", async (req, res) => {
  try {
    const stripe = getStripe();
    const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;

    if (!stripe || !STRIPE_WEBHOOK_SECRET) {
      console.warn("Payment webhook called but Stripe is not configured — ignoring");
      return res.sendStatus(200);
    }

    const sig = req.headers["stripe-signature"];
    let event;
    try {
      event = constructWebhookEvent(req.rawBody, sig, STRIPE_WEBHOOK_SECRET);
    } catch (err) {
      console.error("Stripe signature verification failed:", err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    if (event.type === "checkout.session.completed") {
      const session = event.data.object;
      const { txnId, channelUrl, userId } = session.metadata || {};

      if (txnId) {
        const updateFields = { status: "success" };
        if (session.payment_intent) updateFields.paymentIntentId = session.payment_intent;
        await Transaction.updateOne({ transactionId: txnId, userId }, updateFields);
        console.log(`✅ Transaction ${txnId} updated to success via Stripe webhook`);
        await trackAnalytics("payment_retry", {
          userId, txnId, channelUrl,
          metadata: { status: "success", paymentIntentId: session.payment_intent },
        });
      }

      if (channelUrl) {
        await sendBotMessage(
          channelUrl,
          `Payment for ${txnId} was successful! Your transaction is now complete. Thank you.`
        );
      }

      if (channelUrl && escalatedChannels.has(channelUrl)) {
        const mapping = await ChannelMapping.findOne({ originalChannelUrl: channelUrl });
        if (mapping) {
          await sendBotMessage(
            mapping.deskChannelUrl,
            `Customer ${userId} successfully retried payment for ${txnId}. Ticket can be closed.`
          );
        }
      }
    }

    return res.sendStatus(200);
  } catch (err) {
    console.error("payment-webhook error:", err.message);
    return res.sendStatus(500);
  }
});

// ----------------------------------------------------------
// POST /escalate
// Called directly by the "Talk to Agent" button on the frontend.
// ----------------------------------------------------------
router.post("/escalate", async (req, res) => {
  try {
    const { channelUrl, userId } = req.body;
    if (!channelUrl || !userId) {
      return res.status(400).json({ error: "channelUrl and userId are required" });
    }

    await addBotToChannel(channelUrl);

    if (escalatedChannels.has(channelUrl)) {
      const mapping = await ChannelMapping.findOne({ originalChannelUrl: channelUrl });
      if (mapping) {
        let ticketIsActive = false;
        try {
          if (mapping.ticketId) {
            const axios = require("axios");
            const deskBaseUrl = `https://desk-api-${process.env.SENDBIRD_APP_ID}.sendbird.com/platform/v1`;
            const ticketCheck = await axios.get(
              `${deskBaseUrl}/tickets/${mapping.ticketId}`,
              { headers: { SENDBIRDDESKAPITOKEN: process.env.SENDBIRDDESKAPITOKEN } }
            );
            const ticketStatus = ticketCheck.data.status2 || ticketCheck.data.status;
            console.log(`🎫 Existing ticket #${mapping.ticketId} status: ${ticketStatus}`);
            if (ticketStatus && ticketStatus !== "INITIALIZED") ticketIsActive = true;
            else console.warn(`⚠️ Ticket #${mapping.ticketId} is ${ticketStatus} — will re-escalate.`);
          } else {
            console.warn("⚠️ No ticketId in mapping — treating as stale, will re-escalate.");
          }
        } catch {
          console.warn("⚠️ Could not verify ticket status — re-escalating to be safe.");
        }

        if (ticketIsActive) {
          const axios = require("axios");
          let agentHasReplied = false;
          try {
            const msgRes = await axios.get(
              `https://api-${process.env.SENDBIRD_APP_ID}.sendbird.com/v3/group_channels/${channelUrl}/messages` +
              `?prev_limit=20&message_ts=${Date.now()}&include=false`,
              { headers: { "Api-Token": process.env.SENDBIRD_API_TOKEN } }
            );
            agentHasReplied = (msgRes.data.messages || []).some(
              (m) => m.message?.startsWith("[Support Agent]:")
            );
          } catch {}

          if (!agentHasReplied) {
            await sendBotMessage(
              channelUrl,
              `Your support ticket is already open (Ticket #${mapping.ticketId || mapping.deskChannelUrl}). An agent will join shortly.`
            );
          }
          return res.json({ success: true, message: "Already escalated" });
        }

        await ChannelMapping.deleteOne({ originalChannelUrl: channelUrl });
        escalatedChannels.delete(channelUrl);
      } else {
        escalatedChannels.delete(channelUrl);
      }
    }

    try {
      const ticket = await createDeskTicket(channelUrl, userId);
      escalatedChannels.add(channelUrl);
      scheduleAgentAwayFallback(channelUrl);
      const ticketRef = ticket?.ticketId ? ` (Ticket #${ticket.ticketId})` : "";
      await sendBotMessage(
        channelUrl,
        `Support ticket created${ticketRef}. An agent will join shortly.\n\nIn your Sendbird Desk dashboard, go to → All Tickets (or New/Unassigned) to find this ticket.`
      );
    } catch (err) {
      const errDetail = `${err.message} | HTTP ${err.response?.status} | ${JSON.stringify(err.response?.data)}`;
      console.error("Desk ticket creation failed:", errDetail);
      await sendBotMessage(channelUrl, `DEBUG — ticket creation failed: ${errDetail}`);
      return res.status(500).json({ error: "Failed to create support ticket", detail: errDetail });
    }

    return res.json({ success: true });
  } catch (err) {
    console.error("escalate error:", err.message);
    return res.status(500).json({ error: "escalate", detail: err.message });
  }
});

module.exports = router;
