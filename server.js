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

  const authString = `${process.env.SENDBIRDDESKAPITOKEN}:`;
  const encodedAuth = Buffer.from(authString).toString("base64");

  await axios.post(
    `https://desk-api-${process.env.SENDBIRD_APP_ID}.sendbird.com/platform/v1/tickets`,
    {
      channel_url: channelUrl,
      subject: "Transaction Escalation",
      customer: {
        id: userId,
        name: userId
      }
    },
    {
      headers: {
        Authorization: `Basic ${encodedAuth}`,
        "Content-Type": "application/json"
      }
    }
  );

  console.log("Desk ticket created");
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

    if (!messageId || processedMessages.has(messageId)) {
      return res.sendStatus(200);
    }

    processedMessages.add(messageId);

    if (senderId === "support_bot") {
      return res.sendStatus(200);
    }

    const txnMatch = messageText?.match(/TXN\d+/i);

    if (!txnMatch) {
      await sendBotMessage(channelUrl, "Please provide your transaction ID (e.g., TXN1001).");
      return res.sendStatus(200);
    }

    const txnId = txnMatch[0].toUpperCase();
    const transaction = await Transaction.findOne({ transactionId: txnId });

    if (!transaction) {
      await sendBotMessage(channelUrl, `Transaction ${txnId} not found.`);
      return res.sendStatus(200);
    }

    if (transaction.status === "failed") {

      await createHubSpotTicket(txnId, transaction.userEmail);
      await createDeskTicket(channelUrl, senderId);

      await sendBotMessage(channelUrl, `Transaction ${txnId} failed. Escalating to human support.`);

      return res.sendStatus(200);
    }

    await sendBotMessage(channelUrl, `Transaction ${txnId} status: ${transaction.status}`);
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