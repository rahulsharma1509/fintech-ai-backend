require("dotenv").config();

const express = require("express");
const mongoose = require("mongoose");
const axios = require("axios");
const cors = require("cors");
const rateLimit = require("express-rate-limit");

// ===============================
// STRIPE — optional
// Gracefully disabled when STRIPE_SECRET_KEY is not set (demo mode).
// ===============================
let stripe = null;
if (process.env.STRIPE_SECRET_KEY) {
  try {
    stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
    console.log("✅ Stripe initialized");
  } catch (err) {
    console.warn("⚠️  stripe package missing — run: npm install stripe");
  }
}

// ===============================
// EXPRESS SETUP
// express.json verify callback saves req.rawBody only for /payment-webhook
// so Stripe signature verification works while the rest of the app uses parsed JSON.
// ===============================
const app = express();
app.use(cors());
app.use(
  express.json({
    verify: (req, _res, buf) => {
      if (req.originalUrl === "/payment-webhook") req.rawBody = buf;
    },
  })
);

// ===============================
// LOGGING MIDDLEWARE
// Logs every request with method, path, status code, and duration.
// ===============================
app.use((req, res, next) => {
  const start = Date.now();
  res.on("finish", () => {
    console.log(
      `[${new Date().toISOString()}] ${req.method} ${req.path} ${res.statusCode} ${Date.now() - start}ms`
    );
  });
  next();
});

// ===============================
// RATE LIMITING
// ===============================
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests, please try again later." },
});
app.use(globalLimiter);

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
  HUBSPOT_TOKEN,
  STRIPE_WEBHOOK_SECRET,
  FRONTEND_URL,
} = process.env;

if (!SENDBIRD_APP_ID || !SENDBIRD_API_TOKEN || !SENDBIRDDESKAPITOKEN) {
  console.error("❌ Missing required Sendbird environment variables");
  process.exit(1);
}

// ===============================
// MongoDB
// ===============================
mongoose
  .connect(MONGO_URI)
  .then(() => {
    console.log("MongoDB Connected");
    seedTransactions();
    ensureBotUser();
    loadEscalatedChannels();
  })
  .catch((err) => console.error("Mongo Error:", err));

// ===============================
// Schemas
// ===============================
const transactionSchema = new mongoose.Schema({
  transactionId: String,
  amount: Number,
  status: String,
  userEmail: String,
});
const Transaction = mongoose.model("Transaction", transactionSchema);

// Maps a Sendbird Desk ticket channel → original customer channel so agent
// replies can be routed back to the customer.
const channelMappingSchema = new mongoose.Schema({
  deskChannelUrl: { type: String, unique: true },
  originalChannelUrl: String,
  userId: String,
  createdAt: { type: Date, default: Date.now },
});
const ChannelMapping = mongoose.model("ChannelMapping", channelMappingSchema);

// Tracks unique users to enforce the 20-user hard limit.
const registeredUserSchema = new mongoose.Schema({
  userId: { type: String, unique: true },
  createdAt: { type: Date, default: Date.now },
});
const RegisteredUser = mongoose.model("RegisteredUser", registeredUserSchema);

const USER_LIMIT = 20;

// ===============================
// REDIS — optional idempotency store
// When REDIS_URL is set, processed message IDs are stored in Redis with a
// 10-minute TTL.  On any Redis failure the code falls back transparently to
// the in-memory TTL map below.
// ===============================
let redisClient = null;

(async function initRedis() {
  if (!process.env.REDIS_URL) return;
  try {
    const Redis = require("ioredis");
    redisClient = new Redis(process.env.REDIS_URL, {
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      connectTimeout: 3000,
    });
    redisClient.on("error", (err) => {
      console.warn("⚠️  Redis error — switching to in-memory fallback:", err.message);
      redisClient = null;
    });
    await redisClient.ping();
    console.log("✅ Redis connected for idempotency");
  } catch (err) {
    console.warn("⚠️  Redis unavailable — using in-memory idempotency fallback:", err.message);
    redisClient = null;
  }
})();

// In-memory fallback — TTL-bounded map that evicts entries on each lookup.
const processedMessages = new Map();
const MSG_TTL_MS = 10 * 60 * 1000; // 10 minutes

async function isAlreadyProcessed(messageId) {
  if (redisClient) {
    try {
      // SET NX EX: returns "OK" if key was newly set, null if it already existed.
      const result = await redisClient.set(`msg:${messageId}`, "1", "EX", 600, "NX");
      return result === null;
    } catch (err) {
      console.warn("Redis check failed — falling through to in-memory:", err.message);
    }
  }
  const now = Date.now();
  for (const [id, ts] of processedMessages) {
    if (now - ts > MSG_TTL_MS) processedMessages.delete(id);
  }
  if (processedMessages.has(messageId)) return true;
  processedMessages.set(messageId, now);
  return false;
}

// In-memory channel state — restored from DB on each server startup.
const escalatedChannels = new Set();
const deskChannels = new Set();

// ===============================
// MOCK KNOWLEDGE BASE
// A simple keyword-indexed FAQ store.  Replace with a real vector/search DB
// in production.
// ===============================
const KNOWLEDGE_BASE = [
  {
    keywords: ["refund", "money back", "return", "reimburse"],
    answer:
      "Refund Policy: Failed transaction refunds are processed within 5–7 business days back to your original payment method. Successfully completed transactions are non-refundable unless an error occurred on our end. Contact support for special cases.",
  },
  {
    keywords: ["cancel", "cancellation", "cancel transaction"],
    answer:
      "Cancellation Policy: Pending transactions can be cancelled within 30 minutes of initiation. Failed transactions are automatically cancelled — no action needed. For manual cancellations, please contact our support team.",
  },
  {
    keywords: [
      "failed",
      "decline",
      "declined",
      "why fail",
      "payment fail",
      "payment failed",
      "not work",
      "unsuccessful",
    ],
    answer:
      "Common Payment Failure Reasons: (1) Insufficient funds, (2) Incorrect card details, (3) Bank security block on online transactions, (4) Card expired or daily limit exceeded, (5) Network timeout during processing. Try retrying the payment or contact your bank to lift any restrictions.",
  },
  {
    keywords: ["fee", "charge", "cost", "pricing"],
    answer:
      "Fee Policy: We do not charge additional fees for failed or retried transactions. Standard processing fees apply only to successfully completed transactions.",
  },
  {
    keywords: ["time", "long", "how long", "process", "processing", "days"],
    answer:
      "Processing Times: Successful payments reflect within 1–2 business days. Refunds take 5–7 business days. Dispute resolution may take up to 14 business days.",
  },
];

function queryKnowledgeBase(query) {
  const lower = (query || "").toLowerCase();
  for (const item of KNOWLEDGE_BASE) {
    if (item.keywords.some((k) => lower.includes(k))) {
      return { found: true, answer: item.answer };
    }
  }
  return { found: false, answer: null };
}

// ===============================
// INTENT DETECTION
// Returns one of: transaction_status | payment_retry | escalation | faq | unknown
// ===============================
function detectIntent(message) {
  const lower = (message || "").toLowerCase();
  if (/txn\d+/i.test(message)) return "transaction_status";
  if (/\b(retry|pay again|retry payment|repay|try again)\b/.test(lower)) return "payment_retry";
  if (
    /\b(human|agent|speak|talk to|connect me|escalate|real person|support team|representative)\b/.test(
      lower
    )
  )
    return "escalation";
  if (
    /\b(refund|cancel|fee|policy|failed|why|how|what|charge|time|long|process|decline)\b/.test(lower)
  )
    return "faq";
  return "unknown";
}

// ===============================
// SEED
// ===============================
async function seedTransactions() {
  const count = await Transaction.countDocuments();
  if (count === 0) {
    await Transaction.insertMany([
      { transactionId: "TXN1001", amount: 500, status: "failed", userEmail: "rahul@test.com" },
      { transactionId: "TXN1002", amount: 1200, status: "success", userEmail: "rahul@test.com" },
      { transactionId: "TXN1003", amount: 300, status: "pending", userEmail: "rahul@test.com" },
    ]);
    console.log("Seed data inserted");
  }
}

// ===============================
// ENSURE BOT USER EXISTS
// ===============================
async function ensureBotUser() {
  try {
    await axios.get(`https://api-${SENDBIRD_APP_ID}.sendbird.com/v3/users/support_bot`, {
      headers: { "Api-Token": SENDBIRD_API_TOKEN },
    });
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
// HUBSPOT
// ===============================
async function createHubSpotTicket(txnId, email) {
  if (!HUBSPOT_TOKEN) return;
  await axios.post(
    "https://api.hubapi.com/crm/v3/objects/tickets",
    {
      properties: {
        subject: `Failed Transaction ${txnId}`,
        content: `Transaction ${txnId} failed for ${email}`,
        hs_pipeline: "0",
        hs_pipeline_stage: "1",
      },
    },
    {
      headers: {
        Authorization: `Bearer ${HUBSPOT_TOKEN}`,
        "Content-Type": "application/json",
      },
    }
  );
  console.log("HubSpot ticket created");
}

// ===============================
// DESK TICKET
// Unchanged from original — creates a Sendbird Desk ticket and links it to
// the customer's original channel via ChannelMapping.
// ===============================
async function createDeskTicket(channelUrl, userId) {
  const headers = {
    SENDBIRDDESKAPITOKEN: SENDBIRDDESKAPITOKEN,
    "Content-Type": "application/json",
  };
  const baseUrl = `https://desk-api-${SENDBIRD_APP_ID}.sendbird.com/platform/v1`;

  // Step 1: Find or create Desk customer
  let customerId;
  let searchRes;
  try {
    searchRes = await axios.get(`${baseUrl}/customers?sendbird_id=${userId}`, { headers });
    console.log("🔍 Desk customer search response:", JSON.stringify(searchRes.data));
  } catch (err) {
    console.error(
      "❌ Desk customer search failed:",
      err.response?.status,
      JSON.stringify(err.response?.data) || err.message
    );
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
      console.error(
        "❌ Desk customer creation failed:",
        err.response?.status,
        JSON.stringify(err.response?.data) || err.message
      );
      throw err;
    }
  }

  // Step 2: Create the ticket
  let ticketRes;
  try {
    ticketRes = await axios.post(
      `${baseUrl}/tickets`,
      { channelName: `Support - ${userId}`, customerId },
      { headers }
    );
    console.log("🎫 Desk ticket creation response:", JSON.stringify(ticketRes.data));
  } catch (err) {
    console.error(
      "❌ Desk ticket creation failed:",
      err.response?.status,
      JSON.stringify(err.response?.data) || err.message
    );
    throw err;
  }

  const deskChannelUrl = ticketRes.data.channelUrl;
  deskChannels.add(deskChannelUrl);
  console.log("Desk ticket created! Desk channel:", deskChannelUrl);

  // Persist mapping so agent replies can be routed back to the customer
  await ChannelMapping.findOneAndUpdate(
    { deskChannelUrl },
    { deskChannelUrl, originalChannelUrl: channelUrl, userId },
    { upsert: true, new: true }
  );
  console.log("✅ Channel mapping saved to DB");

  // Step 3: Add agents + customer to the Desk channel
  const agentIds = await getOnlineAgents();
  const memberIds = [userId, ...agentIds];
  console.log("Adding members to Desk channel:", memberIds);

  await axios.put(
    `https://api-${SENDBIRD_APP_ID}.sendbird.com/v3/group_channels/${deskChannelUrl}/members`,
    { user_ids: memberIds },
    { headers: { "Api-Token": SENDBIRD_API_TOKEN, "Content-Type": "application/json" } }
  );
  console.log("✅ Members added to Desk channel");

  // Step 4: Send initial message to activate the Desk ticket
  await axios.post(
    `https://api-${SENDBIRD_APP_ID}.sendbird.com/v3/group_channels/${deskChannelUrl}/messages`,
    {
      message_type: "MESG",
      user_id: userId,
      message: `Hi, I need help with my failed transaction. Ref: ${channelUrl}`,
    },
    { headers: { "Api-Token": SENDBIRD_API_TOKEN, "Content-Type": "application/json" } }
  );
  console.log(`✅ Initial message sent in Desk channel for user: ${userId}`);
}

// ===============================
// GET ONLINE DESK AGENTS
// ===============================
async function getOnlineAgents() {
  const res = await axios.get(
    `https://desk-api-${SENDBIRD_APP_ID}.sendbird.com/platform/v1/agents?connection=ONLINE&status=ACTIVE&limit=100`,
    { headers: { SENDBIRDDESKAPITOKEN: SENDBIRDDESKAPITOKEN } }
  );
  const agents = res.data.results?.map((a) => a.sendbirdId).filter(Boolean) || [];
  console.log("🧑‍💼 Online agents found:", agents);
  return agents;
}

// ===============================
// SENDBIRD CHANNEL HELPERS
// ===============================
async function addBotToChannel(channelUrl) {
  await axios.put(
    `https://api-${SENDBIRD_APP_ID}.sendbird.com/v3/group_channels/${channelUrl}/members`,
    { user_ids: ["support_bot"] },
    { headers: { "Api-Token": SENDBIRD_API_TOKEN, "Content-Type": "application/json" } }
  );
  console.log("Bot added to channel");
}

// data = plain JS object — JSON-serialised into Sendbird's message.data field.
// The frontend parses this to render interactive UI elements (e.g. action buttons).
async function sendChannelMessage(channelUrl, userId, message, data = null) {
  const payload = { message_type: "MESG", user_id: userId, message };
  if (data) payload.data = JSON.stringify(data);
  await axios.post(
    `https://api-${SENDBIRD_APP_ID}.sendbird.com/v3/group_channels/${channelUrl}/messages`,
    payload,
    { headers: { "Api-Token": SENDBIRD_API_TOKEN, "Content-Type": "application/json" } }
  );
}

async function sendBotMessage(channelUrl, message, data = null) {
  await sendChannelMessage(channelUrl, "support_bot", message, data);
}

// ===============================
// RESTORE CHANNEL STATE FROM DB
// Called on startup so escalatedChannels / deskChannels survive server restarts.
// ===============================
async function loadEscalatedChannels() {
  const mappings = await ChannelMapping.find({}, "originalChannelUrl deskChannelUrl");
  mappings.forEach((m) => {
    escalatedChannels.add(m.originalChannelUrl);
    deskChannels.add(m.deskChannelUrl);
  });
  console.log(`✅ Restored ${mappings.length} escalated channel mappings from DB`);
}

// ===============================
// STRUCTURED ERROR HELPER
// Centralises error logging and response so every endpoint looks the same.
// ===============================
function handleError(res, err, context = "Internal error") {
  const detail = err.response?.data?.message || err.message || context;
  console.error(`❌ ${context}:`, detail);
  return res.status(500).json({ error: context, detail });
}

// ============================================================
// ENDPOINTS
// ============================================================

// ----------------------------------------------------------
// POST /register-user
// Checks the 20-user hard limit before allowing a new user in.
// Existing users always pass through immediately.
// ----------------------------------------------------------
app.post("/register-user", async (req, res) => {
  try {
    const { userId } = req.body;
    if (!userId || typeof userId !== "string" || !userId.trim()) {
      return res.status(400).json({ error: "userId is required" });
    }
    const id = userId.trim();
    if (id === "support_bot") return res.json({ allowed: true });

    const existing = await RegisteredUser.findOne({ userId: id });
    if (existing) return res.json({ allowed: true });

    const count = await RegisteredUser.countDocuments();
    if (count >= USER_LIMIT) {
      return res.status(403).json({
        allowed: false,
        message: `This app has reached its ${USER_LIMIT}-user limit. Please contact support to get access.`,
      });
    }

    await RegisteredUser.create({ userId: id });
    return res.status(201).json({ allowed: true });
  } catch (err) {
    return handleError(res, err, "register-user");
  }
});

// ----------------------------------------------------------
// POST /knowledge-base
// Queries the mock KB and returns the best-matching FAQ entry.
// { query: string } → { found: bool, answer: string|null }
// ----------------------------------------------------------
app.post("/knowledge-base", async (req, res) => {
  try {
    const { query } = req.body;
    if (!query) return res.status(400).json({ error: "query is required" });
    return res.json(queryKnowledgeBase(query));
  } catch (err) {
    return handleError(res, err, "knowledge-base");
  }
});

// ----------------------------------------------------------
// POST /retry-payment
// Creates a Stripe Checkout session for a failed transaction and returns the
// hosted payment URL.  Falls back to demo mode when Stripe is not configured.
//
// Body: { txnId, channelUrl, userId }
// Response: { paymentUrl, demo? }
// ----------------------------------------------------------
app.post("/retry-payment", async (req, res) => {
  try {
    const { txnId, channelUrl, userId } = req.body;
    if (!txnId || !channelUrl || !userId) {
      return res.status(400).json({ error: "txnId, channelUrl, and userId are required" });
    }

    const transaction = await Transaction.findOne({ transactionId: txnId.toUpperCase() });
    if (!transaction) {
      return res.status(404).json({ error: `Transaction ${txnId} not found` });
    }

    // Demo mode — Stripe not configured
    if (!stripe) {
      await addBotToChannel(channelUrl);
      await sendBotMessage(
        channelUrl,
        `[DEMO] Stripe is not configured yet. In production, clicking "Retry Payment" would open a secure Stripe Checkout for $${transaction.amount} (${txnId}). Add STRIPE_SECRET_KEY to enable real payments.`
      );
      return res.json({
        paymentUrl: "https://stripe.com/docs/testing",
        demo: true,
        message: "Add STRIPE_SECRET_KEY to enable real Stripe Checkout.",
      });
    }

    const frontendUrl = FRONTEND_URL || "http://localhost:3000";
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      mode: "payment",
      line_items: [
        {
          price_data: {
            currency: "usd",
            product_data: {
              name: `Retry Payment — ${txnId}`,
              description: `Re-attempt for failed transaction ${txnId}`,
            },
            unit_amount: transaction.amount * 100,
          },
          quantity: 1,
        },
      ],
      success_url: `${frontendUrl}?payment=success&txn=${txnId}`,
      cancel_url: `${frontendUrl}?payment=cancelled&txn=${txnId}`,
      metadata: { txnId, channelUrl, userId },
    });

    await addBotToChannel(channelUrl);
    await sendBotMessage(
      channelUrl,
      `Your secure payment link for ${txnId} ($${transaction.amount}) is ready. Complete the payment — you'll be redirected back here when done.`
    );

    return res.json({ paymentUrl: session.url });
  } catch (err) {
    return handleError(res, err, "retry-payment");
  }
});

// ----------------------------------------------------------
// POST /payment-webhook
// Stripe calls this after a successful checkout.session.completed event.
// Verifies the Stripe signature, updates the transaction to "success", and
// sends a confirmation message to the customer channel.
// ----------------------------------------------------------
app.post("/payment-webhook", async (req, res) => {
  try {
    if (!stripe || !STRIPE_WEBHOOK_SECRET) {
      console.warn("Payment webhook called but Stripe is not configured — ignoring");
      return res.sendStatus(200);
    }

    const sig = req.headers["stripe-signature"];
    let event;
    try {
      // req.rawBody is populated by the express.json verify callback above.
      event = stripe.webhooks.constructEvent(req.rawBody, sig, STRIPE_WEBHOOK_SECRET);
    } catch (err) {
      console.error("Stripe signature verification failed:", err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    if (event.type === "checkout.session.completed") {
      const session = event.data.object;
      const { txnId, channelUrl, userId } = session.metadata || {};

      if (txnId) {
        await Transaction.updateOne({ transactionId: txnId }, { status: "success" });
        console.log(`✅ Transaction ${txnId} updated to success via Stripe webhook`);
      }

      if (channelUrl) {
        await sendBotMessage(
          channelUrl,
          `Payment for ${txnId} was successful! Your transaction is now complete. Thank you.`
        );
      }

      // If there was an open escalation, notify the Desk channel so agents know
      if (channelUrl && escalatedChannels.has(channelUrl)) {
        const mapping = await ChannelMapping.findOne({ originalChannelUrl: channelUrl });
        if (mapping) {
          await sendBotMessage(
            mapping.deskChannelUrl,
            `Customer ${userId} successfully retried payment for ${txnId}. Ticket can be closed.`
          );
        }
      }
    }

    return res.sendStatus(200);
  } catch (err) {
    return handleError(res, err, "payment-webhook");
  }
});

// ----------------------------------------------------------
// POST /sendbird-webhook
// Main bot logic — unchanged escalation flow, extended with intent detection,
// KB fallback, and action button messages for failed transactions.
// ----------------------------------------------------------
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
    if (!senderId) return res.sendStatus(200);

    // Deduplication
    if (!messageId || (await isAlreadyProcessed(messageId))) return res.sendStatus(200);

    // Ignore bot's own messages
    if (senderId === "support_bot") return res.sendStatus(200);

    // ── Desk channel: forward agent replies back to the customer ──
    if (channelUrl?.startsWith("sendbird_desk_") || deskChannels.has(channelUrl)) {
      const mapping = await ChannelMapping.findOne({ deskChannelUrl: channelUrl });
      if (mapping && senderId !== mapping.userId) {
        console.log(`📨 Forwarding agent message to customer channel: ${mapping.originalChannelUrl}`);
        await sendBotMessage(mapping.originalChannelUrl, `[Support Agent]: ${messageText}`);
      }
      return res.sendStatus(200);
    }

    // Safety guard: drop stray Desk agent messages
    if (senderId?.startsWith("sendbird_desk_agent_id_")) return res.sendStatus(200);

    const txnMatch = messageText?.match(/TXN\d+/i);

    // ── Already escalated: forward customer follow-ups to Desk ──
    if (escalatedChannels.has(channelUrl) && !txnMatch) {
      const mapping = await ChannelMapping.findOne({ originalChannelUrl: channelUrl });
      if (mapping) {
        console.log(`📨 Forwarding customer follow-up to Desk channel: ${mapping.deskChannelUrl}`);
        await sendChannelMessage(mapping.deskChannelUrl, senderId, messageText);
      }
      return res.sendStatus(200);
    }

    // ── No TXN ID — intent detection → KB lookup → fallback ──
    if (!txnMatch) {
      const intent = detectIntent(messageText);
      await addBotToChannel(channelUrl);

      if (intent === "escalation") {
        if (!escalatedChannels.has(channelUrl)) {
          try {
            await createDeskTicket(channelUrl, senderId);
            escalatedChannels.add(channelUrl);
          } catch (err) {
            console.error("Desk escalation failed (non-fatal):", err.message);
          }
        }
        await sendBotMessage(
          channelUrl,
          "Connecting you with a human support agent now. Please hold on — an agent will be with you shortly."
        );
        return res.sendStatus(200);
      }

      if (intent === "payment_retry") {
        await sendBotMessage(
          channelUrl,
          "Please provide your transaction ID (e.g., TXN1001) so I can initiate the retry."
        );
        return res.sendStatus(200);
      }

      const kbResult = queryKnowledgeBase(messageText);
      if (kbResult.found) {
        await sendBotMessage(channelUrl, kbResult.answer);
        return res.sendStatus(200);
      }

      // Unknown intent — prompt for TXN ID
      await sendBotMessage(
        channelUrl,
        "Please provide your transaction ID (e.g., TXN1001), or ask about our refund, cancellation, or fee policies."
      );
      return res.sendStatus(200);
    }

    // ── TXN ID found ──
    const txnId = txnMatch[0].toUpperCase();
    console.log("🔍 Looking up transaction:", txnId);
    const transaction = await Transaction.findOne({ transactionId: txnId });

    if (!transaction) {
      await addBotToChannel(channelUrl);
      await sendBotMessage(
        channelUrl,
        `Transaction ${txnId} was not found in our system. Please check the ID and try again.`
      );
      return res.sendStatus(200);
    }

    console.log("✅ Transaction found, status:", transaction.status);
    await addBotToChannel(channelUrl);

    if (transaction.status === "failed") {
      // Create HubSpot + Desk tickets (non-fatal if they fail)
      try {
        await createHubSpotTicket(txnId, transaction.userEmail);
      } catch (err) {
        console.error("HubSpot (non-fatal):", err.message);
      }
      try {
        await createDeskTicket(channelUrl, senderId);
        escalatedChannels.add(channelUrl);
      } catch (err) {
        console.error("Desk (non-fatal):", err.message);
      }

      // Send structured message with action buttons.
      // The frontend parses message.data to render interactive buttons inline.
      await sendBotMessage(
        channelUrl,
        `Your transaction ${txnId} ($${transaction.amount}) has failed. A support case has been opened. How would you like to proceed?`,
        {
          type: "action_buttons",
          txnId,
          buttons: [
            { label: "Retry Payment", action: "retry_payment", txnId },
            { label: "Talk to Human", action: "escalate" },
            { label: "View FAQ", action: "faq" },
          ],
        }
      );
      return res.sendStatus(200);
    }

    // Non-failed transaction — return status
    await sendBotMessage(
      channelUrl,
      `Transaction ${txnId} status: ${transaction.status}. Amount: $${transaction.amount}.`
    );
    return res.sendStatus(200);
  } catch (error) {
    console.error("Webhook error:", error.response?.data || error.message);
    return res.sendStatus(500);
  }
});

// ----------------------------------------------------------
// GET / — health check
// ----------------------------------------------------------
app.get("/", (_req, res) => {
  res.json({
    status: "ok",
    service: "fintech-ai-backend",
    redis: redisClient ? "connected" : "in-memory fallback",
    stripe: stripe ? "configured" : "not configured (demo mode)",
  });
});

app.listen(PORT || 8000, () => {
  console.log(`Server running on port ${PORT || 8000}`);
});
