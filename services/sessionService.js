/**
 * services/sessionService.js
 * ---------------------------
 * Conversation memory management.
 *
 * TWO-TIER SESSION STORAGE:
 *
 *   1. UserSession (MongoDB) — durable, per-user record with intent history
 *      and a LLM-generated conversation summary. Survives server restarts.
 *      Updated on every significant interaction.
 *
 *   2. ConversationState (MongoDB) — per-channel bot state: active transaction,
 *      refund stage, escalation status. The bot's working memory for this
 *      specific chat window.
 *
 *   3. Redis cache — sessions cached for 15 minutes to avoid hitting MongoDB
 *      on every webhook. Invalidated on write.
 *
 * HOW THIS REDUCES LLM COSTS:
 *   Without session memory, each LLM call must include the last 10 messages
 *   as context (needed so the LLM can resolve "what about it?" follow-ups).
 *   With session memory, we inject a 1-sentence summary instead:
 *
 *     WITHOUT: 10 messages × ~50 tokens = 500 tokens context = ~$0.000075
 *     WITH:    1 summary × ~20 tokens = 20 tokens context  = ~$0.000003
 *     SAVING:  ~96% token reduction for returning users
 */

const { ConversationState, UserSession } = require("../models");
const { cacheSession, getCachedSession, invalidateSession } = require("../integrations/redisClient");

// ── ConversationState helpers (per-channel) ──────────────────────────────────

/**
 * Get the conversation state for a channel.
 * @param {string} channelUrl
 */
async function getConversationState(channelUrl) {
  return ConversationState.findOne({ channelUrl });
}

/**
 * Update conversation state for a channel (upsert).
 * @param {string} channelUrl
 * @param {string} userId
 * @param {object} updates - fields to set
 */
async function updateConversationState(channelUrl, userId, updates) {
  return ConversationState.findOneAndUpdate(
    { channelUrl },
    { ...updates, userId, updatedAt: new Date() },
    { upsert: true, new: true }
  );
}

// ── UserSession helpers (per-user, with Redis cache) ─────────────────────────

/**
 * Get a user's session. Checks Redis cache first, falls back to MongoDB.
 * @param {string} userId
 * @returns {Promise<object|null>}
 */
async function getUserSession(userId) {
  // Try Redis cache first (fast path)
  const cached = await getCachedSession(userId);
  if (cached) return cached;

  // Fall back to MongoDB
  const session = await UserSession.findOne({ userId }).lean();
  if (session) {
    // Warm the cache for next time
    await cacheSession(userId, session);
  }
  return session;
}

/**
 * Update a user's session after an interaction.
 * Invalidates Redis cache so next read gets fresh data.
 *
 * @param {string} userId
 * @param {object} updates
 * @param {string} [updates.lastIntent]
 * @param {string} [updates.lastTransactionId]
 * @param {string} [updates.lastSentiment]
 * @param {string} [updates.conversationSummary]
 */
async function updateUserSession(userId, updates) {
  try {
    const session = await UserSession.findOneAndUpdate(
      { userId },
      {
        ...updates,
        $inc: { messageCount: 1 },
        updatedAt: new Date(),
      },
      { upsert: true, new: true }
    );

    // Invalidate cache so next getUserSession() reads the updated record
    await invalidateSession(userId);

    return session;
  } catch (err) {
    console.warn("⚠️  updateUserSession failed (non-fatal):", err.message);
    return null;
  }
}

/**
 * Build a short context string from session data to inject into LLM prompts.
 * Returns empty string if no session exists (first-time users).
 *
 * This keeps LLM context compact without losing conversational continuity.
 *
 * @param {string} userId
 * @returns {Promise<string>}
 */
async function buildSessionContext(userId) {
  try {
    const session = await getUserSession(userId);
    if (!session) return "";

    const parts = [];
    if (session.conversationSummary) parts.push(`Previous context: ${session.conversationSummary}`);
    if (session.lastTransactionId)   parts.push(`Last discussed transaction: ${session.lastTransactionId}`);
    if (session.lastIntent)          parts.push(`Last intent: ${session.lastIntent}`);
    if (session.lastSentiment && session.lastSentiment !== "neutral") {
      parts.push(`User sentiment history: ${session.lastSentiment}`);
    }

    return parts.length > 0 ? parts.join(". ") + "." : "";
  } catch (err) {
    console.warn("⚠️  buildSessionContext failed (non-fatal):", err.message);
    return "";
  }
}

module.exports = {
  getConversationState,
  updateConversationState,
  getUserSession,
  updateUserSession,
  buildSessionContext,
};
