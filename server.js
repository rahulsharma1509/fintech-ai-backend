// ===============================
// 1️⃣ Load Environment Variables
// ===============================
require("dotenv").config();

// ===============================
// 2️⃣ Import Dependencies
// ===============================
const express = require("express");
const mongoose = require("mongoose");
const axios = require("axios");
const cors = require("cors");

// ===============================
// 3️⃣ Initialize Express
// ===============================
const app = express();
app.use(cors());
app.use(express.json());

console.log("Starting server...");

// ===============================
// 4️⃣ Global Rate Limiter
// ===============================
let lastBotMessageTime = 0;
const BOT_DELAY = 2000;

// ===============================
// 5️⃣ MongoDB Connection
// ===============================
mongoose.connect(process.env.MONGO_URI)
  .then(() => {
    console.log("MongoDB Connected");
    seedTransactions();
  })
  .catch(err => console.error("MongoDB Error:", err));

// ===============================
// 6️⃣ Transaction Schema
// ===============================
const transactionSchema = new mongoose.Schema({
  transactionId: String,
  amount: Number,
  status: String,
  userEmail: String
});

const Transaction = mongoose.model("Transaction", transactionSchema);

// ===============================
// 7️⃣ Seed Dummy Data
// ===============================
async function seedTransactions() {
  const existing = await Transaction.find();
  if (existing.length === 0) {
    await Transaction.insertMany([
      { transactionId: "TXN1001", amount: 500, status: "failed", userEmail: "rahul@test.com" },
      { transactionId: "TXN1002", amount: 1200, status: "success", userEmail: "rahul@test.com" },
      { transactionId: "TXN1003", amount: 300, status: "pending", userEmail: "rahul@test.com" }
    ]);
    console.log("Dummy transactions inserted");
  }
}

// ===============================
// 8️⃣ Desk Ticket Creation
// ===============================
await axios.post(
  "https://api.sendbirddesk.com/v1/platform/tickets",
  {
    channel_url: channelUrl,
    subject: "Transaction Escalation",
    customer: {
      id: senderId,
      name: senderId
    }
  },
  {
    headers: {
      "Api-Token": process.env.SENDBIRD_DESK_API_TOKEN,
      "Content-Type": "application/json"
    }
  }
);

// ===============================
// 9️⃣ HubSpot Ticket Creation
// ===============================
async function createHubSpotTicket(txnId, userEmail) {
  await axios.post(
    "https://api.hubapi.com/crm/v3/objects/tickets",
    {
      properties: {
        subject: `Failed Transaction ${txnId}`,
        content: `Transaction ${txnId} failed for ${userEmail}`,
        hs_pipeline: "0",
        hs_pipeline_stage: "1"
      }
    },
    {
      headers: {
        Authorization: `Bearer ${process.env.HUBSPOT_TOKEN}`,
        "Content-Type": "application/json"
      }
    }
  );
}

// ===============================
// 🔟 AI / Orchestration Logic
// ===============================
async function handleMessage(userMessage, channelUrl) {

  const txnMatch = userMessage.match(/TXN\d+/i);

  if (!txnMatch) {
    return {
      message: "Please provide your transaction ID (e.g., TXN1001).",
      escalate: false
    };
  }

  const txnId = txnMatch[0].toUpperCase();

  const transaction = await Transaction.findOne({
    transactionId: txnId
  });

  if (!transaction) {
    return {
      message: `Transaction ${txnId} not found.`,
      escalate: false
    };
  }

  if (transaction.status === "failed") {

    // Create CRM record
    await createHubSpotTicket(txnId, transaction.userEmail);

    return {
      message: `Transaction ${txnId} failed. Escalating to human support.`,
      escalate: true
    };
  }

  return {
    message: `Transaction ${txnId} status: ${transaction.status}`,
    escalate: false
  };
}

// ===============================
// 1️⃣1️⃣ Send Message As Bot
// ===============================
async function sendMessageAsBot(channelUrl, message) {

  const now = Date.now();
  const diff = now - lastBotMessageTime;

  if (diff < BOT_DELAY) {
    await new Promise(resolve =>
      setTimeout(resolve, BOT_DELAY - diff)
    );
  }

  await axios.post(
    `https://api-${process.env.SENDBIRD_APP_ID}.sendbird.com/v3/group_channels/${channelUrl}/messages`,
    {
      message_type: "MESG",
      user_id: "support_bot",
      message: message
    },
    {
      headers: {
        "Api-Token": process.env.SENDBIRD_API_TOKEN,
        "Content-Type": "application/json"
      }
    }
  );

  lastBotMessageTime = Date.now();
}

// ===============================
// 1️⃣2️⃣ Webhook Route
// ===============================
app.post("/sendbird-webhook", async (req, res) => {
  try {
    const event = req.body;

    if (event.category !== "group_channel:message_send") {
      return res.sendStatus(200);
    }

    const userMessage = event.payload?.message;
    const channelUrl = event.channel?.channel_url;
    const senderId = event.sender?.user_id;

    if (!userMessage || !channelUrl || !senderId) {
      return res.sendStatus(200);
    }

    // 🔥 VERY IMPORTANT — prevent infinite loop
    if (senderId === "support_bot") {
      console.log("Ignored bot message");
      return res.sendStatus(200);
    }

    const response = await handleMessage(userMessage, channelUrl);

    await sendMessageAsBot(channelUrl, response.message);

    if (response.escalate) {
      console.log("Creating Desk ticket...");
      await createDeskTicket(channelUrl);
    }

    return res.sendStatus(200);

  } catch (error) {
    console.error("Webhook error:", error.response?.data || error.message);
    return res.sendStatus(500);
  }
});

// ===============================
// 1️⃣3️⃣ Health Check
// ===============================
app.get("/", (req, res) => {
  res.send("Fintech Backend Running 🚀");
});

// ===============================
// 🚀 START SERVER
// ===============================
const PORT = process.env.PORT || 8000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});