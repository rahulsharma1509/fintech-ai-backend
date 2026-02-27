/**
 * controllers/userController.js
 * ------------------------------
 * User registration and welcome flow.
 */

const express = require("express");
const router = express.Router();
const { RegisteredUser } = require("../models");
const { addBotToChannel, sendBotMessage } = require("../integrations/sendbirdClient");
const { ensureUserTransactions } = require("../services/transactionService");
const { getConversationState, updateConversationState } = require("../services/sessionService");
const { log } = require("../services/auditService");

const USER_LIMIT = 20;

// ----------------------------------------------------------
// POST /register-user
// Checks the 20-user hard limit before allowing a new user in.
// Existing users always pass through immediately.
// Body: { userId }
// Response: { allowed: bool }
// ----------------------------------------------------------
router.post("/register-user", async (req, res) => {
  try {
    const { userId } = req.body;
    if (!userId || typeof userId !== "string" || !userId.trim()) {
      return res.status(400).json({ error: "userId is required" });
    }
    const id = userId.trim();
    if (id === "support_bot") return res.json({ allowed: true });

    const existing = await RegisteredUser.findOne({ userId: id });
    if (existing) return res.json({ allowed: true });

    const count = await RegisteredUser.countDocuments();
    if (count >= USER_LIMIT) {
      return res.status(403).json({
        allowed: false,
        message: `This app has reached its ${USER_LIMIT}-user limit. Please contact support to get access.`,
      });
    }

    await RegisteredUser.create({ userId: id });
    await log("user_registered", { userId: id, details: { userCount: count + 1 } });
    return res.status(201).json({ allowed: true });
  } catch (err) {
    console.error("register-user error:", err.message);
    return res.status(500).json({ error: "register-user", detail: err.message });
  }
});

// ----------------------------------------------------------
// POST /welcome
// Called by the frontend the first time a channel is opened.
// Sends a greeting with category quick-action buttons.
// Idempotent: if ConversationState already exists the call is a no-op.
// Body: { channelUrl, userId }
// ----------------------------------------------------------
router.post("/welcome", async (req, res) => {
  try {
    const { channelUrl, userId } = req.body;
    if (!channelUrl || !userId) {
      return res.status(400).json({ error: "channelUrl and userId are required" });
    }

    // Seed transactions for this user on first contact (idempotent)
    await ensureUserTransactions(userId);

    // Only send the greeting once per channel
    const state = await getConversationState(channelUrl);
    if (state?.lastIntent) {
      return res.json({ success: true, skipped: true });
    }

    await addBotToChannel(channelUrl);

    await sendBotMessage(
      channelUrl,
      `👋 Hi! I'm your AI financial support assistant.\nI can help you with transactions, refunds, payments, and more — just pick a category or type your question below.`,
      {
        type: "action_buttons",
        buttons: [
          { label: "🔍 Check Transaction",  action: "check_transaction" },
          { label: "💰 Request Refund",      action: "ask_refund" },
          { label: "🔄 Retry a Payment",     action: "ask_retry" },
          { label: "👤 Talk to Agent",       action: "escalate" },
          { label: "📚 FAQ & Policies",      action: "faq" },
        ],
      }
    );

    // Mark channel as welcomed so we don't repeat on reconnect
    await updateConversationState(channelUrl, userId, { lastIntent: "welcome" });
    return res.json({ success: true });
  } catch (err) {
    console.error("welcome error:", err.message);
    return res.status(500).json({ error: "welcome", detail: err.message });
  }
});

// ----------------------------------------------------------
// POST /knowledge-base
// Body: { query }
// Response: { found: bool, answer: string|null }
// ----------------------------------------------------------
const { queryKnowledgeBase } = require("../services/intentService");
router.post("/knowledge-base", async (req, res) => {
  try {
    const { query } = req.body;
    if (!query) return res.status(400).json({ error: "query is required" });
    return res.json(queryKnowledgeBase(query));
  } catch (err) {
    return res.status(500).json({ error: "knowledge-base", detail: err.message });
  }
});

module.exports = router;
