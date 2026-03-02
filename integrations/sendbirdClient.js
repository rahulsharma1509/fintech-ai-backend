/**
 * integrations/sendbirdClient.js
 * -------------------------------
 * Low-level Sendbird Platform API helpers.
 * All functions here make direct HTTP calls — no business logic.
 *
 * WHY SEPARATED FROM BUSINESS LOGIC:
 *   If Sendbird ever changes their API (v3 → v4), we only update this file.
 *   Controllers and services call sendBotMessage() — they don't know about
 *   HTTP headers or endpoint URLs.
 */

const axios = require("axios");

const SENDBIRD_APP_ID    = process.env.SENDBIRD_APP_ID;
const SENDBIRD_API_TOKEN = process.env.SENDBIRD_API_TOKEN;
const SENDBIRDDESKAPITOKEN = process.env.SENDBIRDDESKAPITOKEN;

const CHAT_BASE = () => `https://api-${SENDBIRD_APP_ID}.sendbird.com/v3`;
const DESK_BASE = () => `https://desk-api-${SENDBIRD_APP_ID}.sendbird.com/platform/v1`;

const chatHeaders = () => ({
  "Api-Token": SENDBIRD_API_TOKEN,
  "Content-Type": "application/json",
});

const deskHeaders = () => ({
  SENDBIRDDESKAPITOKEN: SENDBIRDDESKAPITOKEN,
  "Content-Type": "application/json",
});

/**
 * Send a message from any user to a group channel.
 * data = plain JS object serialized into message.data field for frontend UI elements.
 */
async function sendChannelMessage(channelUrl, userId, message, data = null) {
  const payload = { message_type: "MESG", user_id: userId, message };
  if (data) payload.data = JSON.stringify(data);
  await axios.post(
    `${CHAT_BASE()}/group_channels/${channelUrl}/messages`,
    payload,
    { headers: chatHeaders() }
  );
}

/**
 * Send a message as the support bot.
 */
async function sendBotMessage(channelUrl, message, data = null) {
  await sendChannelMessage(channelUrl, "support_bot", message, data);
}

/**
 * Add the support bot (or other users) to a channel as members.
 */
async function addBotToChannel(channelUrl) {
  await axios.post(
    `${CHAT_BASE()}/group_channels/${channelUrl}/members`,
    { user_ids: ["support_bot"] },
    { headers: chatHeaders() }
  );
  console.log("Bot added to channel");
}

/**
 * Send a context message to a Desk ticket channel as the customer.
 * Uses userId (not support_bot) because Desk channels restrict messages
 * to users who participated in ticket creation.
 * Non-fatal — a failure here must never break the customer-facing flow.
 */
async function sendDeskContext(deskChannelUrl, userId, text) {
  try {
    await axios.post(
      `${CHAT_BASE()}/group_channels/${deskChannelUrl}/messages`,
      { message_type: "MESG", user_id: userId, message: text },
      { headers: chatHeaders() }
    );
    console.log(`✅ Desk context message sent to ${deskChannelUrl}`);
  } catch (err) {
    console.error(
      `⚠️  sendDeskContext failed for ${deskChannelUrl}:`,
      err.response?.status,
      JSON.stringify(err.response?.data) || err.message
    );
  }
}

/**
 * Get all ONLINE Desk agents (for adding to new tickets).
 */
async function getOnlineAgents() {
  const res = await axios.get(
    `${DESK_BASE()}/agents?connection=ONLINE&status=ACTIVE&limit=100`,
    { headers: deskHeaders() }
  );
  const agents = res.data.results?.map((a) => a.sendbirdId).filter(Boolean) || [];
  console.log("🧑‍💼 Online agents found:", agents);
  return agents;
}

/**
 * Fetch last N messages from a channel (used for agent-reply detection).
 */
async function getRecentMessages(channelUrl, limit = 20) {
  const res = await axios.get(
    `${CHAT_BASE()}/group_channels/${channelUrl}/messages` +
    `?prev_limit=${limit}&message_ts=${Date.now()}&include=false`,
    { headers: chatHeaders() }
  );
  return res.data.messages || [];
}

/**
 * Add members (userId + agentIds) to a Desk backing channel.
 * Non-fatal — Sendbird sometimes rejects Chat API member-management on Desk channels.
 */
async function addMembersToChannel(channelUrl, userIds) {
  await axios.post(
    `${CHAT_BASE()}/group_channels/${channelUrl}/members`,
    { user_ids: userIds },
    { headers: chatHeaders() }
  );
}

/**
 * Create or find a Desk customer by Sendbird userId.
 * Returns the Desk customer ID.
 */
async function findOrCreateDeskCustomer(userId) {
  const searchRes = await axios.get(
    `${DESK_BASE()}/customers?sendbird_id=${userId}`,
    { headers: deskHeaders() }
  );
  if (searchRes.data.results && searchRes.data.results.length > 0) {
    const id = searchRes.data.results[0].id;
    console.log("Existing Desk customer found:", id);
    return id;
  }
  const createRes = await axios.post(
    `${DESK_BASE()}/customers`,
    { sendbirdId: userId, displayName: userId },
    { headers: deskHeaders() }
  );
  console.log("New Desk customer created:", createRes.data.id);
  return createRes.data.id;
}

/**
 * Create a Desk ticket for a customer.
 * Returns { ticketId, channelUrl }
 */
async function createDeskTicketAPI(customerId, channelName) {
  const res = await axios.post(
    `${DESK_BASE()}/tickets`,
    { channelName, customerId },
    { headers: deskHeaders() }
  );
  console.log("🎫 Desk ticket created:", JSON.stringify(res.data));
  return {
    ticketId: res.data.id,
    deskChannelUrl: res.data.channelUrl,
    status: res.data.status,
  };
}

/**
 * Get a Desk ticket by ID to check its current status.
 */
async function getDeskTicket(ticketId) {
  const res = await axios.get(
    `${DESK_BASE()}/tickets/${ticketId}`,
    { headers: deskHeaders() }
  );
  return res.data;
}

/**
 * Ensure the support_bot user exists in Sendbird; create it if not.
 */
async function ensureBotUser() {
  try {
    await axios.get(`${CHAT_BASE()}/users/support_bot`, { headers: chatHeaders() });
    console.log("support_bot user exists");
  } catch (err) {
    if (err.response?.status === 400) {
      await axios.post(
        `${CHAT_BASE()}/users`,
        { user_id: "support_bot", nickname: "Support Bot", profile_url: "" },
        { headers: chatHeaders() }
      );
      console.log("support_bot user created");
    }
  }
}

module.exports = {
  sendChannelMessage,
  sendBotMessage,
  addBotToChannel,
  sendDeskContext,
  getOnlineAgents,
  getRecentMessages,
  addMembersToChannel,
  findOrCreateDeskCustomer,
  createDeskTicketAPI,
  getDeskTicket,
  ensureBotUser,
};
