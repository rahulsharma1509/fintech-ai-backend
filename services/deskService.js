/**
 * services/deskService.js
 * ------------------------
 * Sendbird Desk ticket management, agent-away fallback timer,
 * and channel escalation state.
 */

const {
  addBotToChannel,
  addMembersToChannel,
  findOrCreateDeskCustomer,
  createDeskTicketAPI,
  getDeskTicket,
  getOnlineAgents,
  sendBotMessage,
  sendChannelMessage,
  sendDeskContext,
  getRecentMessages,
} = require("../integrations/sendbirdClient");
const { ChannelMapping } = require("../models");

// In-memory channel state — restored from DB on each server startup.
// These Sets are the fast-path check before hitting MongoDB on every webhook.
const escalatedChannels = new Set();
const deskChannels = new Set();

// ── Agent-away fallback timer ─────────────────────────────────────────────────
// When a Desk ticket is created the customer expects an agent to respond quickly.
// If no agent reply arrives within AGENT_REPLY_TIMEOUT_MS, the bot sends a
// polite "agent is busy" message so the customer isn't left in silence.
const AGENT_REPLY_TIMEOUT_MS = parseInt(process.env.AGENT_REPLY_TIMEOUT_MS || "30000", 10);
const agentAwaitTimers = new Map(); // channelUrl → setTimeout id

function scheduleAgentAwayFallback(channelUrl) {
  clearAgentAwayTimer(channelUrl); // reset if already running

  const timerId = setTimeout(async () => {
    agentAwaitTimers.delete(channelUrl);
    try {
      const messages = await getRecentMessages(channelUrl, 20);
      const agentReplied = messages.some(
        (m) => typeof m.message === "string" && m.message.startsWith("[Support Agent]:")
      );
      if (!agentReplied) {
        await sendBotMessage(
          channelUrl,
          "⏳ Our support agent is currently assisting other customers. You're in the queue — we'll be with you shortly. Feel free to type any additional details in the meantime."
        );
        console.log(`⏱ Agent-away message sent to ${channelUrl}`);
      }
    } catch (err) {
      console.warn("⚠️  agentAwayFallback check failed (non-fatal):", err.message);
    }
  }, AGENT_REPLY_TIMEOUT_MS);

  agentAwaitTimers.set(channelUrl, timerId);
  console.log(`⏱ Agent-away timer started for ${channelUrl} (${AGENT_REPLY_TIMEOUT_MS / 1000}s)`);
}

function clearAgentAwayTimer(channelUrl) {
  const existing = agentAwaitTimers.get(channelUrl);
  if (existing) {
    clearTimeout(existing);
    agentAwaitTimers.delete(channelUrl);
    console.log(`✅ Agent-away timer cleared for ${channelUrl} (agent responded)`);
  }
}

// ── Desk ticket creation ──────────────────────────────────────────────────────

/**
 * Create a full Desk ticket:
 *   1. Find/create Desk customer
 *   2. Create ticket
 *   3. Add members (non-fatal)
 *   4. Send activation message (non-fatal)
 *   5. Persist ChannelMapping to DB
 *
 * @param {string} channelUrl - customer's original channel
 * @param {string} userId
 * @returns {Promise<{ ticketId, deskChannelUrl }>}
 */
async function createDeskTicket(channelUrl, userId) {
  const customerId = await findOrCreateDeskCustomer(userId);

  const { ticketId, deskChannelUrl } = await createDeskTicketAPI(
    customerId,
    `Support - ${userId}`
  );

  deskChannels.add(deskChannelUrl);
  console.log(`Desk ticket created! ID: ${ticketId}, Desk channel: ${deskChannelUrl}`);

  // Persist mapping so agent replies can be routed back to the customer
  try {
    await ChannelMapping.findOneAndUpdate(
      { deskChannelUrl },
      { deskChannelUrl, originalChannelUrl: channelUrl, userId, ticketId },
      { upsert: true, new: true }
    );
    console.log("✅ Channel mapping saved to DB");
  } catch (err) {
    console.error("⚠️ Channel mapping save failed (non-fatal):", err.message);
  }

  // Add members to the Desk backing channel (non-fatal)
  try {
    let agentIds = [];
    try { agentIds = await getOnlineAgents(); } catch (e) { /* non-fatal */ }
    await addMembersToChannel(deskChannelUrl, [userId, ...agentIds]);
    console.log(`✅ Members added to Desk channel`);
  } catch (err) {
    console.warn(`⚠️ Adding members to Desk channel failed (non-fatal): ${err.message}`);
  }

  // Send activation message (moves ticket from INITIALIZED → UNASSIGNED)
  try {
    await sendChannelMessage(
      deskChannelUrl,
      userId,
      `Hi, I need help with my failed payment. Original channel: ${channelUrl}`
    );
    console.log("✅ Activation message sent");
  } catch (err) {
    console.warn(`⚠️ Activation message failed (non-fatal): ${err.message}`);
  }

  return { ticketId, deskChannelUrl };
}

/**
 * Get or create a Desk ticket for a channel.
 * Returns deskChannelUrl or null on failure.
 *
 * @param {string} channelUrl
 * @param {string} userId
 */
async function getOrCreateDeskChannel(channelUrl, userId) {
  if (!escalatedChannels.has(channelUrl)) {
    try {
      const ticket = await createDeskTicket(channelUrl, userId);
      escalatedChannels.add(channelUrl);
      scheduleAgentAwayFallback(channelUrl);
      return ticket?.deskChannelUrl || null;
    } catch (err) {
      console.error("getOrCreateDeskChannel — createDeskTicket failed:", err.message);
      return null;
    }
  }
  const mapping = await ChannelMapping.findOne({ originalChannelUrl: channelUrl });
  return mapping?.deskChannelUrl || null;
}

/**
 * Restore escalated channel state from DB on server startup.
 * This ensures the in-memory Sets survive server restarts.
 */
async function loadEscalatedChannels() {
  const mappings = await ChannelMapping.find({}, "originalChannelUrl deskChannelUrl");
  mappings.forEach((m) => {
    escalatedChannels.add(m.originalChannelUrl);
    deskChannels.add(m.deskChannelUrl);
  });
  console.log(`✅ Restored ${mappings.length} escalated channel mappings from DB`);
}

module.exports = {
  escalatedChannels,
  deskChannels,
  createDeskTicket,
  getOrCreateDeskChannel,
  loadEscalatedChannels,
  scheduleAgentAwayFallback,
  clearAgentAwayTimer,
  sendDeskContext,
};
