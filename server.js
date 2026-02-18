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
    seedTransactions(); // Seed after DB connects
  })
  .catch(err => console.error("MongoDB Error:", err));

// ===============================
// 5️⃣ Transaction Schema
// ===============================
const transactionSchema = new mongoose.Schema({
  transactionId: String,
  amount: Number,
  status: String, // success | failed | pending
  userEmail: String
});

const Transaction = mongoose.model("Transaction", transactionSchema);

// ===============================
// 6️⃣ Seed Dummy Data (One-time)
// ===============================
async function seedTransactions() {
  const existing = await Transaction.find();

  if (existing.length === 0) {
    await Transaction.insertMany([
      {
        transactionId: "TXN1001",
        amount: 500,
        status: "failed",
        userEmail: "rahul@test.com"
      },
      {
        transactionId: "TXN1002",
        amount: 1200,
        status: "success",
        userEmail: "rahul@test.com"
      },
      {
        transactionId: "TXN1003",
        amount: 300,
        status: "pending",
        userEmail: "rahul@test.com"
      }
    ]);

    console.log("Dummy transactions inserted");
  }
}

// ===============================
// 7️⃣ Health Check Route
// ===============================
app.get("/", (req, res) => {
  res.send("Fintech Backend Running 🚀");
});

// ===============================
// 8️⃣ Transaction Lookup API
// ===============================
app.get("/transaction/:id", async (req, res) => {
  try {
    const transaction = await Transaction.findOne({
      transactionId: req.params.id
    });

    if (!transaction) {
      return res.status(404).json({
        message: "Transaction not found"
      });
    }

    res.json(transaction);

  } catch (error) {
    res.status(500).json({
      error: "Error fetching transaction"
    });
  }
});

// ===============================
// 9️⃣ HubSpot Ticket Creation
// ===============================
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
    res.status(500).json({
      error: "Ticket creation failed"
    });
  }
});

// ===============================
// 🔟 Start Server
// ===============================
const PORT = process.env.PORT || 8000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
