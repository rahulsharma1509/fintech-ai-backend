// ===============================
// 1️⃣ Load Environment Variables
// ===============================
require("dotenv").config();

// ===============================
// 2️⃣ Import Dependencies
// ===============================
const mongoose = require("mongoose");
const express = require("express");
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
// 4️⃣ Connect to MongoDB
// ===============================
mongoose.connect(process.env.MONGO_URI)
  .then(() => {
    console.log("MongoDB Connected");
    seedTransactions();
  })
  .catch(err => console.error("MongoDB Error:", err));

// ===============================
// 5️⃣ Transaction Schema
// ===============================
const transactionSchema = new mongoose.Schema({
  transactionId: String,
  amount: Number,
  status: String,
  userEmail: String
});

const Transaction = mongoose.model("Transaction", transactionSchema);

// ===============================
// 6️⃣ Seed Dummy Data
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
// 7️⃣ HELPER FUNCTIONS
// ===============================
async function callDelightAI(userMessage) {
  if (userMessage.includes("TXN1001")) {
    return "I see your transaction TXN1001 failed. Let me escalate this.";
  }
  return "Thank you for your message. Our team will assist you.";
}

async function sendMessageAsBot(channelUrl, message) {
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
}

// ===============================
// 8️⃣ ROUTES
// ===============================

// Health check
app.get("/", (req, res) => {
  res.send("Fintech Backend Running 🚀");
});

// Transaction lookup
app.get("/transaction/:id", async (req, res) => {
  try {
    const transaction = await Transaction.findOne({
      transactionId: req.params.id
    });

    if (!transaction) {
      return res.status(404).json({ message: "Transaction not found" });
    }

    res.json(transaction);

  } catch (error) {
    res.status(500).json({ error: "Error fetching transaction" });
  }
});

// HubSpot ticket creation
app.post("/create-ticket", async (req, res) => {
  try {
    const { email, issue } = req.body;

    const response = await axios.post(
      "https://api.hubapi.com/crm/v3/objects/tickets",
      {
        properties: {
          subject: issue,
          content: issue,
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

    res.status(200).json({
      message: "Ticket created successfully",
      ticketId: response.data.id
    });

  } catch (error) {
    console.error("HubSpot Error:", error.response?.data || error.message);
    res.status(500).json({ error: "Ticket creation failed" });
  }
});

// Sendbird webhook
app.post("/sendbird-webhook", async (req, res) => {
  try {
    const event = req.body;

    console.log("Webhook Event:", event.category);

    if (event.category === "group_channel:message_send") {

      const userMessage = event.payload.message;
      const channelUrl = event.payload.channel.channel_url;

      if (event.payload.sender.user_id === "support_bot") {
        return res.sendStatus(200);
      }

      const aiReply = await callDelightAI(userMessage);
      await sendMessageAsBot(channelUrl, aiReply);
    }

    res.sendStatus(200);

  } catch (error) {
    console.error("Webhook error:", error);
    res.sendStatus(500);
  }
});

// ===============================
// 🔟 START SERVER (ONLY ONCE)
// ===============================
const PORT = process.env.PORT || 8000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});