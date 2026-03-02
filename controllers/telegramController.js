/**
 * controllers/telegramController.js
 * -----------------------------------
 * Handles incoming Telegram webhook events and bridges them to Sendbird.
 *
 * FLOW:
 *   Telegram user sends message
 *     → POST /telegram-webhook
 *     → Map Telegram ID → Sendbird userId
 *     → Ensure Sendbird channel exists for this user
 *     → Forward message into Sendbird channel as the user
 *     → Bot reply from Sendbird is forwarded back to Telegram
 *       (via the sendTelegramMessage call in webhookController when it detects
 *        the message originated from Telegram — using TelegramUser.channelUrl)
 *
 * RATE LIMIT: 20 messages per minute per Telegram user (Redis-based).
 *   Telegram Bot API is free — this limit protects our OpenAI/Sendbird usage.
 *
 * MANUAL SETUP REQUIRED:
 *   See integrations/telegramClient.js for @BotFather setup instructions.
 */

const express = require("express");
const router = express.Router();

const { TelegramUser } = require("../models");
const { sendTelegramMessage } = require("../integrations/telegramClient");
const { sendChannelMessage, addBotToChannel } = require("../integrations/sendbirdClient");
const { ensureUserTransactions } = require("../services/transactionService");
const { checkRateLimit } = require("../integrations/redisClient");
const { isEnabled } = require("../middleware/featureFlagMiddleware");

// ── Per-Telegram-user rate limit: 20 msg/min ─────────────────────────────────
const TELEGRAM_RATE_LIMIT = 20;
const TELEGRAM_WINDOW_MS  = 60 * 1000;

async function checkTelegramRateLimit(telegramId) {
  try {
    const key = `tg_rate:${telegramId}`;
    const count = await checkRateLimit(key, TELEGRAM_WINDOW_MS, TELEGRAM_RATE_LIMIT);
    return count <= TELEGRAM_RATE_LIMIT;
  } catch {
    return true; // fail open
  }
}

/**
 * Generate a deterministic Sendbird userId from a Telegram chatId.
 * Prefix "tg_" distinguishes Telegram users from native Sendbird users.
 */
function telegramToSendbirdId(telegramId) {
  return `tg_${telegramId}`;
}

/**
 * Ensure a TelegramUser mapping exists; create a Sendbird channel if needed.
 * Returns { sendbirdUserId, channelUrl }.
 */
async function ensureTelegramUser(telegramId, username = "") {
  let tgUser = await TelegramUser.findOne({ telegramId: String(telegramId) });

  if (!tgUser) {
    const sendbirdUserId = telegramToSendbirdId(telegramId);

    // Create a Sendbird group channel for this Telegram user
    // We use the Sendbird Platform API via axios directly here since
    // sendbirdClient doesn't have a createChannel helper.
    const axios = require("axios");
    const CHAT_BASE = `https://api-${process.env.SENDBIRD_APP_ID}.sendbird.com/v3`;
    const headers = {
      "Api-Token": process.env.SENDBIRD_API_TOKEN,
      "Content-Type": "application/json",
    };

    // Ensure the Sendbird user exists
    try {
      await axios.get(`${CHAT_BASE}/users/${sendbirdUserId}`, { headers });
    } catch {
      await axios.post(`${CHAT_BASE}/users`, {
        user_id: sendbirdUserId,
        nickname: username || `Telegram User ${telegramId}`,
        profile_url: "",
      }, { headers }).catch(() => {});
    }

    // Create a channel for this Telegram user + support_bot
    let channelUrl = null;
    try {
      const chRes = await axios.post(`${CHAT_BASE}/group_channels`, {
        name: `Telegram Support - ${username || telegramId}`,
        channel_url: `tg_channel_${telegramId}`,
        user_ids: [sendbirdUserId, "support_bot"],
        is_distinct: true,
      }, { headers });
      channelUrl = chRes.data.channel_url;
    } catch (err) {
      // Channel may already exist
      channelUrl = `tg_channel_${telegramId}`;
    }

    // Seed demo transactions for this user
    await ensureUserTransactions(sendbirdUserId).catch(() => {});

    tgUser = await TelegramUser.create({
      telegramId: String(telegramId),
      sendbirdUserId,
      telegramUsername: username,
      channelUrl,
    });

    console.log(`✅ New Telegram user mapped: tg=${telegramId} → sb=${sendbirdUserId} channel=${channelUrl}`);
  }

  return { sendbirdUserId: tgUser.sendbirdUserId, channelUrl: tgUser.channelUrl };
}

// ── POST /telegram-webhook ───────────────────────────────────────────────────
router.post("/telegram-webhook", async (req, res) => {
  // Always return 200 to Telegram immediately — Telegram retries on non-200
  res.sendStatus(200);

  // Check feature flag
  if (!(await isEnabled("TELEGRAM_ENABLED"))) {
    console.log("[Telegram] TELEGRAM_ENABLED flag is off — ignoring message");
    return;
  }

  try {
    const update = req.body;
    const message = update.message;
    if (!message || !message.text) return; // ignore non-text updates (photos, stickers, etc.)

    const telegramId = String(message.chat.id);
    const username   = message.from?.username || message.from?.first_name || "";
    const text       = message.text.trim();

    // Rate limit check
    const allowed = await checkTelegramRateLimit(telegramId);
    if (!allowed) {
      await sendTelegramMessage(
        telegramId,
        "⏳ You're sending messages too quickly. Please wait a minute before trying again."
      );
      return;
    }

    // Ensure user + channel mapping
    const { sendbirdUserId, channelUrl } = await ensureTelegramUser(telegramId, username);

    console.log(`[Telegram] Message from tg=${telegramId} (${username}): ${text}`);

    // Forward message into Sendbird channel
    // This triggers the Sendbird webhook → bot processes it → bot replies in Sendbird
    // The Sendbird webhook handler will reply via Sendbird's sendBotMessage.
    // To route replies back to Telegram, the bot checks TelegramUser.channelUrl
    // and calls sendTelegramMessage (see webhookController.js integration point).
    await sendChannelMessage(channelUrl, sendbirdUserId, text);

  } catch (err) {
    console.error("[Telegram] Webhook handler error:", err.message);
  }
});

// ── GET /telegram-webhook-info ───────────────────────────────────────────────
// Diagnostic endpoint to check Telegram webhook registration status
router.get("/telegram-webhook-info", async (req, res) => {
  const { getWebhookInfo } = require("../integrations/telegramClient");
  const info = await getWebhookInfo();
  res.json(info);
});

module.exports = router;
