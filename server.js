require("dotenv").config();

const express = require("express");
const mongoose = require("mongoose");
const axios = require("axios");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

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
    ensureBotUser(); // ✅ Ensure support_bot exists on startup
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

  // Step 1: Find or create Desk customer using sendbirdId
  let customerId;
  const searchRes = await axios.get(
    `${baseUrl}/customers?sendbird_id=${userId}`,
    { headers }
  );

  if (searchRes.data.results && searchRes.data.results.length > 0) {
    customerId = searchRes.data.results[0].id;
    console.log("Existing Desk customer found:", customerId);
  } else {
    const createRes = await axios.post(
      `${baseUrl}/customers`,
      { sendbirdId: userId, displayName: userId },
      { headers }
    );
    customerId = createRes.data.id;
    console.log("New Desk customer created:", customerId);
  }

  // Step 2: Create the ticket
  const ticketRes = await axios.post(
    `${baseUrl}/tickets`,
    {
      channelName: `Support - ${userId}`,
      customerId: customerId,
      relatedChannelUrls: channelUrl
    },
    { headers }
  );

  const deskChannelUrl = ticketRes.data.channelUrl;
  console.log("Desk ticket created successfully! Desk channel:", deskChannelUrl);

  // Step 3: Send initial message as the user in Desk channel
  // This activates the ticket from INITIALIZED → PENDING so agents can see it
  await axios.post(
    `https://api-${SENDBIRD_APP_ID}.sendbird.com/v3/group_channels/${deskChannelUrl}/messages`,
    {
      message_type: "MESG",
      user_id: userId,
      message: `Hi, I need help with my failed transaction. Channel ref: ${channelUrl}`
    },
    {
      headers: {
        "Api-Token": SENDBIRD_API_TOKEN,
        "Content-Type": "application/json"
      }
    }
  );
  console.log("✅ Initial message sent in Desk channel — ticket is now PENDING");
}

// ===============================
// Ensure Bot User Exists
// ===============================
async function ensureBotUser() {
  try {
    await axios.get(
      `https://api-${SENDBIRD_APP_ID}.sendbird.com/v3/users/support_bot`,
      {
        headers: {
          "Api-Token": SENDBIRD_API_TOKEN
        }
      }
    );
    console.log("support_bot user exists");
  } catch (err) {
    if (err.response?.status === 400) {
      // User doesn't exist, create it
      await axios.post(
        `https://api-${SENDBIRD_APP_ID}.sendbird.com/v3/users`,
        {
          user_id: "support_bot",
          nickname: "Support Bot",
          profile_url: ""
        },
        {
          headers: {
            "Api-Token": SENDBIRD_API_TOKEN,
            "Content-Type": "application/json"
          }
        }
      );
      console.log("support_bot user created");
    }
  }
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
// Send message as bot
// ===============================
async function sendBotMessage(channelUrl, message) {
  await axios.post(
    `https://api-${SENDBIRD_APP_ID}.sendbird.com/v3/group_channels/${channelUrl}/messages`,
    {
      message_type: "MESG",
      user_id: "support_bot",
      message
    },
    {
      headers: {
        "Api-Token": SENDBIRD_API_TOKEN,
        "Content-Type": "application/json"
      }
    }
  );
}

// ===============================
// Message Processor
// ===============================
const processedMessages = new Set();
const escalatedChannels = new Set(); // ✅ Track channels already escalated

app.post("/sendbird-webhook", async (req, res) => {
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

    if (!messageId || processedMessages.has(messageId)) {
      return res.sendStatus(200);
    }

    processedMessages.add(messageId);

    // Ignore bot's own messages
    if (senderId === "support_bot") {
      return res.sendStatus(200);
    }

    // If this channel is already escalated, ignore further messages
    if (escalatedChannels.has(channelUrl)) {
      console.log("⏭️ Channel already escalated, skipping...");
      return res.sendStatus(200);
    }

    // Ignore Desk auto-generated channels
    if (channelUrl?.startsWith("sendbird_desk_")) {
      console.log("⏭️ Skipping Desk system channel message");
      return res.sendStatus(200);
    }

    const txnMatch = messageText?.match(/TXN\d+/i);

    if (!txnMatch) {
      console.log("No TXN ID found, asking user...");
      escalatedChannels.add(channelUrl); // ✅ Mark channel as escalated
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

      console.log("🤖 Adding bot and sending escalation message...");
      await addBotToChannel(channelUrl);
      await sendBotMessage(
        channelUrl,
        `Transaction ${txnId} failed. Escalating to human support.`
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