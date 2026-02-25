require("dotenv").config();

const express = require("express");
const mongoose = require("mongoose");
const axios = require("axios");
const cors = require("cors");
const rateLimit = require("express-rate-limit");

const app = express();
app.use(cors());
app.use(express.json());

// ===============================
// RATE LIMITING (hobby — strict)
// ===============================

// Global limiter: 60 requests per 15 minutes per IP
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests, please try again later." },
});
app.use(globalLimiter);

// Webhook limiter: 120 requests per minute (Sendbird sends events, not humans)
// This is tight enough to block any accidental flooding while allowing real events.
const webhookLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Webhook rate limit exceeded." },
});

console.log("Starting server...");

// ===============================
// ENV VALIDATION
// ===============================
const {
  PORT,
  MONGO_URI,
  SENDBIRD_APP_ID,
  SENDBIRD_API_TOKEN,
  SENDBIRDDESKAPITOKEN,
  HUBSPOT_TOKEN
} = process.env;

if (!SENDBIRD_APP_ID || !SENDBIRD_API_TOKEN || !SENDBIRDDESKAPITOKEN) {
  console.error("❌ Missing required environment variables");
  process.exit(1);
}

// ===============================
// MongoDB
// ===============================
mongoose.connect(MONGO_URI)
  .then(() => {
    console.log("MongoDB Connected");
    seedTransactions();
    ensureBotUser();
    loadEscalatedChannels();
  })
  .catch(err => console.error("Mongo Error:", err));

// ===============================
// Schema
// ===============================
const transactionSchema = new mongoose.Schema({
  transactionId: String,
  amount: Number,
  status: String,
  userEmail: String
});

const Transaction = mongoose.model("Transaction", transactionSchema);

// ===============================
// Channel Mapping Schema
// Maps Desk ticket channel → original customer channel
// ===============================
const channelMappingSchema = new mongoose.Schema({
  deskChannelUrl: { type: String, unique: true },
  originalChannelUrl: String,
  userId: String,
  createdAt: { type: Date, default: Date.now }
});

const ChannelMapping = mongoose.model("ChannelMapping", channelMappingSchema);

// ===============================
// Seed
// ===============================
async function seedTransactions() {
  const count = await Transaction.countDocuments();
  if (count === 0) {
    await Transaction.insertMany([
      { transactionId: "TXN1001", amount: 500, status: "failed", userEmail: "rahul@test.com" },
      { transactionId: "TXN1002", amount: 1200, status: "success", userEmail: "rahul@test.com" },
      { transactionId: "TXN1003", amount: 300, status: "pending", userEmail: "rahul@test.com" }
    ]);
    console.log("Seed data inserted");
  }
}

// ===============================
// Ensure Bot User Exists
// ===============================
async function ensureBotUser() {
  try {
    await axios.get(
      `https://api-${SENDBIRD_APP_ID}.sendbird.com/v3/users/support_bot`,
      { headers: { "Api-Token": SENDBIRD_API_TOKEN } }
    );
    console.log("support_bot user exists");
  } catch (err) {
    if (err.response?.status === 400) {
      await axios.post(
        `https://api-${SENDBIRD_APP_ID}.sendbird.com/v3/users`,
        { user_id: "support_bot", nickname: "Support Bot", profile_url: "" },
        { headers: { "Api-Token": SENDBIRD_API_TOKEN, "Content-Type": "application/json" } }
      );
      console.log("support_bot user created");
    }
  }
}

// ===============================
// HubSpot
// ===============================
async function createHubSpotTicket(txnId, email) {
  await axios.post(
    "https://api.hubapi.com/crm/v3/objects/tickets",
    {
      properties: {
        subject: `Failed Transaction ${txnId}`,
        content: `Transaction ${txnId} failed for ${email}`,
        hs_pipeline: "0",
        hs_pipeline_stage: "1"
      }
    },
    {
      headers: {
        Authorization: `Bearer ${HUBSPOT_TOKEN}`,
        "Content-Type": "application/json"
      }
    }
  );
  console.log("HubSpot ticket created");
}

// ===============================
// Desk Ticket
// ===============================
async function createDeskTicket(channelUrl, userId) {
  const headers = {
    "SENDBIRDDESKAPITOKEN": SENDBIRDDESKAPITOKEN,
    "Content-Type": "application/json"
  };
  const baseUrl = `https://desk-api-${SENDBIRD_APP_ID}.sendbird.com/platform/v1`;

  // Step 1: Find or create Desk customer
  let customerId;
  let searchRes;
  try {
    searchRes = await axios.get(
      `${baseUrl}/customers?sendbird_id=${userId}`,
      { headers }
    );
    console.log("🔍 Desk customer search response:", JSON.stringify(searchRes.data));
  } catch (err) {
    console.error("❌ Desk customer search failed:", err.response?.status, JSON.stringify(err.response?.data) || err.message);
    throw err;
  }

  if (searchRes.data.results && searchRes.data.results.length > 0) {
    customerId = searchRes.data.results[0].id;
    console.log("Existing Desk customer found:", customerId);
  } else {
    try {
      const createRes = await axios.post(
        `${baseUrl}/customers`,
        { sendbirdId: userId, displayName: userId },
        { headers }
      );
      customerId = createRes.data.id;
      console.log("New Desk customer created:", customerId);
    } catch (err) {
      console.error("❌ Desk customer creation failed:", err.response?.status, JSON.stringify(err.response?.data) || err.message);
      throw err;
    }
  }

  // Step 2: Create the ticket
  let ticketRes;
  try {
    ticketRes = await axios.post(
      `${baseUrl}/tickets`,
      {
        channelName: `Support - ${userId}`,
        customerId: customerId
      },
      { headers }
    );
    console.log("🎫 Desk ticket creation response:", JSON.stringify(ticketRes.data));
  } catch (err) {
    console.error("❌ Desk ticket creation failed:", err.response?.status, JSON.stringify(err.response?.data) || err.message);
    throw err;
  }

  const deskChannelUrl = ticketRes.data.channelUrl;
  deskChannels.add(deskChannelUrl);
  console.log("Desk ticket created! Desk channel:", deskChannelUrl);

  // Persist the mapping so agent replies can be routed back to the customer
  await ChannelMapping.findOneAndUpdate(
    { deskChannelUrl },
    { deskChannelUrl, originalChannelUrl: channelUrl, userId },
    { upsert: true, new: true }
  );
  console.log("✅ Channel mapping saved to DB");

  // Step 3: Fetch online agents and add them + customer to Desk channel
  const agentIds = await getOnlineAgents();
  const memberIds = [userId, ...agentIds];
  console.log("Adding members to Desk channel:", memberIds);

  await axios.put(
    `https://api-${SENDBIRD_APP_ID}.sendbird.com/v3/group_channels/${deskChannelUrl}/members`,
    { user_ids: memberIds },
    {
      headers: {
        "Api-Token": SENDBIRD_API_TOKEN,
        "Content-Type": "application/json"
      }
    }
  );
  console.log("✅ Members added to Desk channel");

  // Step 4: Send initial message as the specific user to activate ticket
  await axios.post(
    `https://api-${SENDBIRD_APP_ID}.sendbird.com/v3/group_channels/${deskChannelUrl}/messages`,
    {
      message_type: "MESG",
      user_id: userId,  // ✅ Dynamic — uses the actual customer's userId
      message: `Hi, I need help with my failed transaction. Ref: ${channelUrl}`
    },
    {
      headers: {
        "Api-Token": SENDBIRD_API_TOKEN,
        "Content-Type": "application/json"
      }
    }
  );
  console.log(`✅ Initial message sent in Desk channel for user: ${userId} — ticket is now PENDING`);
}

// ===============================
// Get Online Desk Agents
// ===============================
async function getOnlineAgents() {
  const res = await axios.get(
    `https://desk-api-${SENDBIRD_APP_ID}.sendbird.com/platform/v1/agents?connection=ONLINE&status=ACTIVE&limit=100`,
    {
      headers: { "SENDBIRDDESKAPITOKEN": SENDBIRDDESKAPITOKEN }
    }
  );
  const agents = res.data.results?.map(a => a.sendbirdId).filter(Boolean) || [];
  console.log("🧑‍💼 Online agents found:", agents);
  return agents;
}

// ===============================
// Add Bot to Channel
// ===============================
async function addBotToChannel(channelUrl) {
  await axios.put(
    `https://api-${SENDBIRD_APP_ID}.sendbird.com/v3/group_channels/${channelUrl}/members`,
    { user_ids: ["support_bot"] },
    {
      headers: {
        "Api-Token": SENDBIRD_API_TOKEN,
        "Content-Type": "application/json"
      }
    }
  );
  console.log("Bot added to channel");
}

// ===============================
// Send message as any user (or bot)
// ===============================
async function sendChannelMessage(channelUrl, userId, message) {
  await axios.post(
    `https://api-${SENDBIRD_APP_ID}.sendbird.com/v3/group_channels/${channelUrl}/messages`,
    { message_type: "MESG", user_id: userId, message },
    {
      headers: {
        "Api-Token": SENDBIRD_API_TOKEN,
        "Content-Type": "application/json"
      }
    }
  );
}

async function sendBotMessage(channelUrl, message) {
  await sendChannelMessage(channelUrl, "support_bot", message);
}

// ===============================
// Message Processor
// ===============================

// TTL-bounded dedup map — entries expire after 10 minutes so memory stays flat.
const processedMessages = new Map(); // messageId -> timestamp
const MSG_TTL_MS = 10 * 60 * 1000; // 10 minutes

function isAlreadyProcessed(messageId) {
  const now = Date.now();
  // Evict expired entries on every check to keep the map small.
  for (const [id, ts] of processedMessages) {
    if (now - ts > MSG_TTL_MS) processedMessages.delete(id);
  }
  if (processedMessages.has(messageId)) return true;
  processedMessages.set(messageId, now);
  return false;
}

const escalatedChannels = new Set();
const deskChannels = new Set();

// Reload escalated/desk channel sets from DB so state survives server restarts
async function loadEscalatedChannels() {
  const mappings = await ChannelMapping.find({}, "originalChannelUrl deskChannelUrl");
  mappings.forEach(m => {
    escalatedChannels.add(m.originalChannelUrl);
    deskChannels.add(m.deskChannelUrl);
  });
  console.log(`✅ Restored ${mappings.length} escalated channel mappings from DB`);
}

app.post("/sendbird-webhook", webhookLimiter, async (req, res) => {
  try {
    const event = req.body;

    if (event.category !== "group_channel:message_send") {
      return res.sendStatus(200);
    }

    const messageId = event.payload?.message_id;
    const messageText = event.payload?.message;
    const channelUrl = event.channel?.channel_url;
    const senderId = event.sender?.user_id;

    console.log("📩 Webhook received:", { messageId, senderId, channelUrl, messageText });

    // Ignore system messages with no sender
    if (!senderId) {
      console.log("⏭️ Skipping system message with no sender");
      return res.sendStatus(200);
    }

    if (!messageId || isAlreadyProcessed(messageId)) {
      return res.sendStatus(200);
    }

    // Ignore bot's own messages
    if (senderId === "support_bot") {
      return res.sendStatus(200);
    }

    // Handle Desk channel messages — forward agent replies to the original customer channel
    if (channelUrl?.startsWith("sendbird_desk_") || deskChannels.has(channelUrl)) {
      const mapping = await ChannelMapping.findOne({ deskChannelUrl: channelUrl });
      if (mapping && senderId !== mapping.userId) {
        // Agent (or anyone who is not the customer) sent a message — relay it to the customer
        console.log(`📨 Forwarding agent message to customer channel: ${mapping.originalChannelUrl}`);
        await sendBotMessage(
          mapping.originalChannelUrl,
          `[Support Agent]: ${messageText}`
        );
      }
      return res.sendStatus(200);
    }

    // Ignore agent messages arriving outside of a Desk channel (safety guard)
    if (senderId?.startsWith("sendbird_desk_agent_id_")) {
      console.log("⏭️ Skipping Desk agent message outside Desk channel");
      return res.sendStatus(200);
    }

    // Parse TXN ID first
    const txnMatch = messageText?.match(/TXN\d+/i);

    // If channel already escalated, forward customer follow-ups to the Desk channel
    if (escalatedChannels.has(channelUrl) && !txnMatch) {
      const mapping = await ChannelMapping.findOne({ originalChannelUrl: channelUrl });
      if (mapping) {
        console.log(`📨 Forwarding customer follow-up to Desk channel: ${mapping.deskChannelUrl}`);
        await sendChannelMessage(mapping.deskChannelUrl, senderId, messageText);
      }
      return res.sendStatus(200);
    }

    if (!txnMatch) {
      console.log("No TXN ID found, asking user...");
      await addBotToChannel(channelUrl);
      console.log("✅ Bot added, sending message...");
      await sendBotMessage(channelUrl, "Please provide your transaction ID (e.g., TXN1001).");
      console.log("✅ Message sent");
      return res.sendStatus(200);
    }

    const txnId = txnMatch[0].toUpperCase();
    console.log("🔍 Looking up transaction:", txnId);
    const transaction = await Transaction.findOne({ transactionId: txnId });

    if (!transaction) {
      console.log("❌ Transaction not found");
      await addBotToChannel(channelUrl);
      await sendBotMessage(channelUrl, `Transaction ${txnId} not found.`);
      return res.sendStatus(200);
    }

    console.log("✅ Transaction found, status:", transaction.status);

    if (transaction.status === "failed") {
      console.log("💳 Failed transaction, creating HubSpot ticket...");
      await createHubSpotTicket(txnId, transaction.userEmail);

      console.log("🎫 Creating Desk ticket...");
      try {
        await createDeskTicket(channelUrl, senderId);
      } catch (err) {
        console.error("Desk failed but continuing:", err.response?.data || err.message);
      }

      escalatedChannels.add(channelUrl);
      await addBotToChannel(channelUrl);
      await sendBotMessage(
        channelUrl,
        `Transaction ${txnId} failed. A support agent has been notified and will reach out to you shortly.`
      );
      console.log("✅ Done");
      return res.sendStatus(200);
    }

    console.log("📤 Sending status message...");
    await addBotToChannel(channelUrl);
    await sendBotMessage(channelUrl, `Transaction ${txnId} status: ${transaction.status}`);
    console.log("✅ Done");
    return res.sendStatus(200);

  } catch (error) {
    console.error("Webhook error:", error.response?.data || error.message);
    return res.sendStatus(500);
  }
});

// ===============================
app.get("/", (req, res) => {
  res.send("Backend running 🚀");
});

app.listen(PORT || 8000, () => {
  console.log(`Server running on port ${PORT || 8000}`);
});