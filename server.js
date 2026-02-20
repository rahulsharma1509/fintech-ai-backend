require("dotenv").config();

const express = require("express");
const mongoose = require("mongoose");
const axios = require("axios");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

console.log("Starting server...");

/* --------------------------
   GLOBAL BOT RATE LIMIT
--------------------------- */
let lastBotMessageTime = 0;
const BOT_DELAY = 2000;

/* --------------------------
   DATABASE
--------------------------- */
mongoose
  .connect(process.env.MONGO_URI)
  .then(() => {
    console.log("MongoDB Connected");
    seedTransactions();
  })
  .catch((err) => console.error("MongoDB Error:", err));

const transactionSchema = new mongoose.Schema({
  transactionId: String,
  amount: Number,
  status: String,
  userEmail: String,
});

const Transaction = mongoose.model("Transaction", transactionSchema);

async function seedTransactions() {
  const existing = await Transaction.find();
  if (existing.length === 0) {
    await Transaction.insertMany([
      { transactionId: "TXN1001", amount: 500, status: "failed", userEmail: "rahul@test.com" },
      { transactionId: "TXN1002", amount: 1200, status: "success", userEmail: "rahul@test.com" },
      { transactionId: "TXN1003", amount: 300, status: "pending", userEmail: "rahul@test.com" },
    ]);
    console.log("Dummy transactions inserted");
  }
}

/* --------------------------
   HUBSPOT TICKET
--------------------------- */
async function createHubSpotTicket(txnId, userEmail) {
  await axios.post(
    "https://api.hubapi.com/crm/v3/objects/tickets",
    {
      properties: {
        subject: `Failed Transaction ${txnId}`,
        content: `Transaction ${txnId} failed for ${userEmail}`,
        hs_pipeline: "0",
        hs_pipeline_stage: "1",
      },
    },
    {
      headers: {
        Authorization: `Bearer ${process.env.HUBSPOT_TOKEN}`,
        "Content-Type": "application/json",
      },
    }
  );
}

/* --------------------------
   DESK TICKET
--------------------------- */
async function createDeskTicket(channelUrl, senderId) {
  await axios.post(
    `https://desk-api-${process.env.SENDBIRD_APP_ID}.sendbird.com/platform/v1/tickets`,
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
}

/* --------------------------
   AI / BUSINESS LOGIC
--------------------------- */
async function handleMessage(userMessage) {
  const txnMatch = userMessage.match(/TXN\d+/i);

  if (!txnMatch) {
    return {
      message: "Please provide your transaction ID (e.g., TXN1001).",
      escalate: false,
    };
  }

  const txnId = txnMatch[0].toUpperCase();

  const transaction = await Transaction.findOne({
    transactionId: txnId,
  });

  if (!transaction) {
    return {
      message: `Transaction ${txnId} not found.`,
      escalate: false,
    };
  }

  if (transaction.status === "failed") {
    await createHubSpotTicket(txnId, transaction.userEmail);

    return {
      message: `Transaction ${txnId} failed. Escalating to human support.`,
      escalate: true,
      txnId,
      userEmail: transaction.userEmail,
    };
  }

  return {
    message: `Transaction ${txnId} status: ${transaction.status}`,
    escalate: false,
  };
}

/* --------------------------
   SEND BOT MESSAGE
--------------------------- */
async function sendMessageAsBot(channelUrl, message) {
  const now = Date.now();
  const diff = now - lastBotMessageTime;

  if (diff < BOT_DELAY) {
    await new Promise((resolve) =>
      setTimeout(resolve, BOT_DELAY - diff)
    );
  }

  await axios.post(
    `https://api-${process.env.SENDBIRD_APP_ID}.sendbird.com/v3/group_channels/${channelUrl}/messages`,
    {
      message_type: "MESG",
      user_id: "support_bot",
      message: message,
    },
    {
      headers: {
        "Api-Token": process.env.SENDBIRD_API_TOKEN,
        "Content-Type": "application/json",
      },
    }
  );

  lastBotMessageTime = Date.now();
}

/* --------------------------
   WEBHOOK
--------------------------- */
app.post("/sendbird-webhook", async (req, res) => {
  try {
    const event = req.body;

    if (event.category !== "group_channel:message_send") {
      return res.sendStatus(200);
    }

    const messageId = event.payload?.message_id;
    const userMessage = event.payload?.message;
    const channelUrl = event.channel?.channel_url;
    const senderId = event.sender?.user_id;

    if (!messageId || !userMessage || !channelUrl || !senderId) {
      return res.sendStatus(200);
    }

    // 🔥 Prevent duplicate processing
    if (processedMessages.has(messageId)) {
      return res.sendStatus(200);
    }

    processedMessages.add(messageId);

    if (senderId === "support_bot") {
      return res.sendStatus(200);
    }

    const response = await handleMessage(userMessage);

    await sendMessageAsBot(channelUrl, response.message);

    if (response.escalate) {
      await createDeskTicket(channelUrl, senderId);
    }

    return res.sendStatus(200);

  } catch (error) {
    console.error("Webhook error:", error.response?.data || error.message);
    return res.sendStatus(500);
  }
});

/* --------------------------
   HEALTH CHECK
--------------------------- */
app.get("/", (req, res) => {
  res.send("Fintech Backend Running 🚀");
});

/* --------------------------
   START SERVER
--------------------------- */
const PORT = process.env.PORT || 8000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});