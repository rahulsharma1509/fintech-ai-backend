/**
 * integrations/telegramClient.js
 * --------------------------------
 * Telegram Bot API helper (raw axios — no extra npm package needed).
 *
 * ============================================================
 * MANUAL SETUP REQUIRED — FREE
 * ============================================================
 * 1. Open Telegram and message @BotFather
 * 2. Send /newbot → follow prompts → get your TELEGRAM_BOT_TOKEN
 * 3. Add to .env:
 *      TELEGRAM_BOT_TOKEN=1234567890:ABCdef...
 * 4. Register webhook (run once after deploy):
 *      curl -X POST "https://api.telegram.org/bot<TOKEN>/setWebhook" \
 *        -H "Content-Type: application/json" \
 *        -d '{"url": "https://your-backend.onrender.com/telegram-webhook"}'
 * 5. Telegram Bot API is completely FREE — no cost limits.
 *
 * ============================================================
 * COST NOTE: Telegram Bot API is free. No rate limits from Telegram
 * for standard bots. We add our own limit (20 msg/min per user).
 * ============================================================
 */

const axios = require("axios");

function getBotToken() {
  return process.env.TELEGRAM_BOT_TOKEN;
}

function telegramApiUrl(method) {
  const token = getBotToken();
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN not set in environment");
  return `https://api.telegram.org/bot${token}/${method}`;
}

/**
 * Send a text message to a Telegram chat.
 * @param {string|number} chatId  - Telegram chat_id
 * @param {string} text
 * @param {object} [extra]        - extra Telegram sendMessage params (parse_mode, etc.)
 */
async function sendTelegramMessage(chatId, text, extra = {}) {
  try {
    await axios.post(telegramApiUrl("sendMessage"), {
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      ...extra,
    });
  } catch (err) {
    console.error(
      "⚠️  Telegram sendMessage failed:",
      err.response?.data || err.message
    );
    // Non-fatal — Telegram is secondary channel; never block main flow
  }
}

/**
 * Register the webhook URL with Telegram.
 * Call this once after deployment or URL change.
 * @param {string} webhookUrl - full HTTPS URL (e.g. https://api.myapp.com/telegram-webhook)
 */
async function registerWebhook(webhookUrl) {
  const token = getBotToken();
  if (!token) {
    console.warn("⚠️  TELEGRAM_BOT_TOKEN not set — skipping webhook registration");
    return;
  }
  try {
    const res = await axios.post(telegramApiUrl("setWebhook"), {
      url: webhookUrl,
      allowed_updates: ["message"],
    });
    console.log("✅ Telegram webhook registered:", res.data);
  } catch (err) {
    console.error("⚠️  Telegram setWebhook failed:", err.response?.data || err.message);
  }
}

/**
 * Get current webhook info from Telegram (useful for debugging).
 */
async function getWebhookInfo() {
  try {
    const res = await axios.get(telegramApiUrl("getWebhookInfo"));
    return res.data;
  } catch (err) {
    return { error: err.message };
  }
}

module.exports = { sendTelegramMessage, registerWebhook, getWebhookInfo };
