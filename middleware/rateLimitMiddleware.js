/**
 * middleware/rateLimitMiddleware.js
 * ----------------------------------
 * Per-user rate limiting using Redis sliding window algorithm.
 *
 * WHY PER-USER LIMITS (not just IP-based):
 *   Our global express-rate-limit applies per IP — useful against simple DDoS.
 *   But a single authenticated user could:
 *     - Spam the bot with thousands of messages, burning through the OpenAI budget
 *     - Send hundreds of refund requests hoping one slips through policy checks
 *     - Create thousands of Desk tickets, flooding the support queue
 *
 *   Per-user limits address this by identifying users by their Sendbird userId
 *   rather than IP (which changes on mobile networks).
 *
 * HARD STOP on vendor costs:
 *   Every message processed = one potential OpenAI API call (~$0.0003).
 *   At 10 req/min × 20 users = 200 req/min max = ~$0.06/min = ~$86/day worst case.
 *   The per-user limit + LLM budget guard together ensure this never happens.
 *
 * LIMITS:
 *   - 10 requests per minute per user (conversation pace)
 *   - 100 requests per day per user (daily budget)
 *
 * Falls back gracefully when Redis is unavailable (fail open for UX).
 */

const { checkRateLimit } = require("../integrations/redisClient");
const { sendBotMessage } = require("../integrations/sendbirdClient");
const { AuditLog } = require("../models");

const MINUTE_LIMIT = parseInt(process.env.USER_RATE_LIMIT_MIN  || "10",  10);
const DAY_LIMIT    = parseInt(process.env.USER_RATE_LIMIT_DAY  || "100", 10);
const MINUTE_MS    = 60 * 1000;
const DAY_MS       = 24 * 60 * 60 * 1000;

/**
 * Check per-user rate limits (minute + day windows).
 * Returns { allowed: bool, reason?: string }
 *
 * @param {string} userId
 */
async function checkUserRateLimit(userId) {
  // Check per-minute limit
  const perMin = await checkRateLimit(userId, "min", MINUTE_LIMIT, MINUTE_MS);
  if (!perMin.allowed) {
    return {
      allowed: false,
      reason: "per_minute",
      message: `⏱️ You're sending messages too quickly. Please wait a moment before trying again. (Limit: ${MINUTE_LIMIT}/min)`,
    };
  }

  // Check per-day limit
  const perDay = await checkRateLimit(userId, "day", DAY_LIMIT, DAY_MS);
  if (!perDay.allowed) {
    return {
      allowed: false,
      reason: "per_day",
      message: `📊 You've reached the daily message limit (${DAY_LIMIT} messages). Your limit resets at midnight. Contact support if you need urgent assistance.`,
    };
  }

  return { allowed: true };
}

/**
 * Express middleware that applies per-user rate limiting on the Sendbird webhook.
 * When a user is throttled:
 *   1. Sends a polite bot message to their channel
 *   2. Logs the rate-limit hit in AuditLog
 *   3. Returns 200 to Sendbird (so it doesn't retry)
 */
async function userRateLimitMiddleware(req, res, next) {
  const senderId = req.body?.sender?.user_id;
  const channelUrl = req.body?.channel?.channel_url;

  // Skip rate limiting for internal users (bot replying to itself)
  if (!senderId || senderId === "support_bot") {
    return next();
  }

  try {
    const result = await checkUserRateLimit(senderId);

    if (!result.allowed) {
      console.warn(`[RateLimit] User ${senderId} throttled (${result.reason})`);

      // Log to audit trail for monitoring/abuse detection
      try {
        await AuditLog.create({
          userId: senderId,
          actionType: "rate_limit_hit",
          channelUrl,
          details: { reason: result.reason, limit: result.reason === "per_minute" ? MINUTE_LIMIT : DAY_LIMIT },
        });
      } catch (logErr) {
        console.warn("⚠️  Rate limit audit log failed (non-fatal):", logErr.message);
      }

      // Send polite throttling message to the user
      if (channelUrl) {
        try {
          await sendBotMessage(channelUrl, result.message);
        } catch (msgErr) {
          console.warn("⚠️  Rate limit bot message failed (non-fatal):", msgErr.message);
        }
      }

      return res.sendStatus(200); // 200 to Sendbird so it doesn't retry
    }
  } catch (err) {
    console.warn("⚠️  Rate limit middleware error (non-fatal, failing open):", err.message);
  }

  next();
}

module.exports = { userRateLimitMiddleware, checkUserRateLimit };
