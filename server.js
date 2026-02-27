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

// Render (and most PaaS) sit behind a proxy — trust the first hop so that
// express-rate-limit can read the real client IP from X-Forwarded-For.
app.set("trust proxy", 1);

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
// Global limiter applies only to non-webhook routes.
// The webhook is excluded because Sendbird fires events for every message
// (including bot replies), so heavy testing quickly burns through a low limit.
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.path === "/sendbird-webhook",
  message: { error: "Too many requests, please try again later." },
});
app.use(globalLimiter);

// Webhook gets its own generous limiter — 600 req/min covers bursts from
// Sendbird retries and simultaneous users without blocking legitimate traffic.
const webhookLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 600,
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
  paymentIntentId: String,  // Stripe payment_intent ID — stored after checkout; used for actual refund API calls
  refundedAmount: Number,   // set when a partial or full refund is issued
});
const Transaction = mongoose.model("Transaction", transactionSchema);

// ── Refund Negotiation Engine ──────────────────────────────────────────────
// Tracks the multi-step refund negotiation state for each user/transaction.
const refundRequestSchema = new mongoose.Schema({
  userId: String,
  txnId: String,
  channelUrl: String,
  refundStage: { type: String, default: "reason_asked" }, // reason_asked | policy_evaluated | offer_sent | completed
  refundReason: String,   // duplicate | service_issue | accidental | fraud | other
  negotiationAttempts: { type: Number, default: 0 },
  finalDecision: String,  // AUTO_REFUND | OFFER_PARTIAL | OFFER_COUPON | ESCALATE_HIGH | ESCALATE_NORMAL
  status: { type: String, default: "pending" }, // pending | approved | rejected | refunded
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});
const RefundRequest = mongoose.model("RefundRequest", refundRequestSchema);

// ── Conversation Memory ─────────────────────────────────────────────────────
// Per-channel state so the bot understands follow-ups without the user
// repeating the transaction ID ("What about it?" → resolved via activeTxnId).
const conversationStateSchema = new mongoose.Schema({
  channelUrl: { type: String, unique: true },
  userId: String,
  lastIntent: String,
  activeTxnId: String,        // last TXN the user was discussing
  refundStage: String,
  escalationStatus: { type: String, default: "none" }, // none | normal | high
  priority: { type: String, default: "normal" },
  updatedAt: { type: Date, default: Date.now },
});
const ConversationState = mongoose.model("ConversationState", conversationStateSchema);

// ── Analytics ───────────────────────────────────────────────────────────────
// Append-only event log — never deleted, never blocks core flows.
const analyticsEventSchema = new mongoose.Schema({
  eventType: String, // refund_request | refund_approved | refund_rejected | escalation | payment_retry
  userId: String,
  txnId: String,
  channelUrl: String,
  metadata: mongoose.Schema.Types.Mixed,
  createdAt: { type: Date, default: Date.now },
});
const AnalyticsEvent = mongoose.model("AnalyticsEvent", analyticsEventSchema);

// Maps a Sendbird Desk ticket channel → original customer channel so agent
// replies can be routed back to the customer.
const channelMappingSchema = new mongoose.Schema({
  deskChannelUrl: { type: String, unique: true },
  originalChannelUrl: String,
  userId: String,
  ticketId: String,
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
// SENTIMENT + PRIORITY DETECTION
// Rule-based scan for keywords that signal legal threats, fraud, regulatory
// bodies, or social-media escalation.  Returns priority "HIGH" or "NORMAL".
// ===============================
function detectSentiment(message) {
  const lower = (message || "").toLowerCase();
  const HIGH_TRIGGERS = [
    "fraud", "complaint", "legal", "rbi", "chargeback", "social media",
    "twitter", "consumer court", "fir", "police", "lawyer", "sue", "dispute",
    "unauthorized", "scam",
  ];
  const triggers = HIGH_TRIGGERS.filter((k) => lower.includes(k));
  return { priority: triggers.length > 0 ? "HIGH" : "NORMAL", triggers };
}

// ===============================
// POLICY ENGINE
// Central function that decides what to do for a refund request.
// context = { amount, reason, sentiment, attempts, hasDuplicate }
// Returns { action, message } where action is one of:
//   AUTO_REFUND | OFFER_PARTIAL | OFFER_COUPON | ESCALATE_HIGH | ESCALATE_NORMAL
// ===============================
function evaluatePolicy({ amount, reason, sentiment, attempts = 0, hasDuplicate = false }) {
  // Fraud reason or any HIGH-priority sentiment → immediate senior escalation
  if (reason === "fraud" || sentiment?.priority === "HIGH") {
    return {
      action: "ESCALATE_HIGH",
      message: "🚨 This case has been flagged as high priority. A senior agent has been notified and will contact you immediately.",
    };
  }
  // Amounts < $200 qualify for automatic refund without negotiation
  if (amount < 200) {
    return {
      action: "AUTO_REFUND",
      message: `Your refund of $${amount} qualifies for automatic approval under our small-transaction policy. Processing now.`,
    };
  }
  // Duplicate charge: verify by checking recent same-amount transactions
  if (reason === "duplicate") {
    if (hasDuplicate) {
      return {
        action: "AUTO_REFUND",
        message: "We found a matching duplicate charge on your account. Your full refund has been approved.",
      };
    }
    return {
      action: "ESCALATE_NORMAL",
      message: "We couldn't automatically verify the duplicate charge. Escalating to an agent for manual review.",
    };
  }
  // Service issue → offer a compensation coupon instead of cash refund
  if (reason === "service_issue") {
    return {
      action: "OFFER_COUPON",
      message: "We're sorry for the service inconvenience. We'd like to offer you a compensation coupon.",
    };
  }
  // Accidental payment → offer 50% on first attempt; escalate if already tried
  if (reason === "accidental") {
    if (attempts > 0) {
      return {
        action: "ESCALATE_NORMAL",
        message: "Connecting you with an agent to further assist with your refund request.",
      };
    }
    return {
      action: "OFFER_PARTIAL",
      message: `For accidental payments we can offer a 50% refund ($${(amount * 0.5).toFixed(2)}) immediately.`,
    };
  }
  // "other" or unrecognised → normal escalation
  return {
    action: "ESCALATE_NORMAL",
    message: "Connecting you with an agent to review your refund request.",
  };
}

// ===============================
// ANALYTICS — fire-and-forget
// Never throws; guaranteed not to break any core flow.
// ===============================
async function trackAnalytics(eventType, { userId, txnId, channelUrl, metadata = {} } = {}) {
  try {
    await AnalyticsEvent.create({ eventType, userId, txnId, channelUrl, metadata });
  } catch (err) {
    console.warn("⚠️ Analytics tracking failed (non-fatal):", err.message);
  }
}

// ===============================
// CONVERSATION STATE HELPERS
// Lightweight per-channel memory: stores activeTxnId, lastIntent, refundStage
// so the bot can handle follow-ups like "What about it?" correctly.
// ===============================
async function getConversationState(channelUrl) {
  return ConversationState.findOne({ channelUrl });
}

async function updateConversationState(channelUrl, userId, updates) {
  return ConversationState.findOneAndUpdate(
    { channelUrl },
    { ...updates, userId, updatedAt: new Date() },
    { upsert: true, new: true }
  );
}

// ===============================
// INTENT DETECTION
// Returns one of: transaction_status | payment_retry | refund_request |
//                 escalation | faq | unknown
// ===============================
function detectIntent(message) {
  const lower = (message || "").toLowerCase();
  if (/txn\d+/i.test(message)) return "transaction_status";
  if (/\b(retry|pay again|retry payment|repay|try again)\b/.test(lower)) return "payment_retry";
  // Refund intent checked before generic escalation so "want refund" routes to the
  // negotiation engine, not straight to a human agent.
  if (/\b(refund|money back|reimburse|return my money|want refund|need refund|get refund|claim refund)\b/.test(lower)) return "refund_request";
  if (
    /\b(human|agent|speak|talk to|connect me|escalate|real person|support team|representative)\b/.test(
      lower
    )
  )
    return "escalation";
  if (
    /\b(cancel|fee|policy|failed|why|how|what|charge|time|long|process|decline)\b/.test(lower)
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
  const ticketId = ticketRes.data.id;
  deskChannels.add(deskChannelUrl);
  console.log(`Desk ticket created! ID: ${ticketId}, Desk channel: ${deskChannelUrl}, status: ${ticketRes.data.status}`);

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

  // Step 3: Try to add agents + customer to the Desk backing channel (non-fatal).
  // This was the approach that worked on Feb 25. Even if the PUT returns a 500
  // (Sendbird occasionally rejects Chat API member-management on Desk channels),
  // we still continue to Step 4 so the activation message always runs.
  try {
    let agentIds = [];
    try {
      agentIds = await getOnlineAgents();
    } catch (e) {
      console.warn("⚠️ getOnlineAgents failed (non-fatal):", e.message);
    }
    const memberIds = [userId, ...agentIds];
    await axios.put(
      `https://api-${SENDBIRD_APP_ID}.sendbird.com/v3/group_channels/${deskChannelUrl}/members`,
      { user_ids: memberIds },
      { headers: { "Api-Token": SENDBIRD_API_TOKEN, "Content-Type": "application/json" } }
    );
    console.log(`✅ Members added to Desk channel: ${memberIds.join(", ")}`);
  } catch (err) {
    console.warn(`⚠️ Adding members to Desk channel failed (non-fatal): HTTP ${err.response?.status} — ${JSON.stringify(err.response?.data) || err.message}`);
  }

  // Step 4: Send initial message as the customer to activate the ticket.
  // This is what triggers INITIALIZED → UNASSIGNED when agents are connected to the
  // Desk portal (auto-routing fires). Uses the Chat Platform API — the Desk Platform
  // API /tickets/{id}/messages endpoint returns 404 and does not exist.
  try {
    await axios.post(
      `https://api-${SENDBIRD_APP_ID}.sendbird.com/v3/group_channels/${deskChannelUrl}/messages`,
      {
        message_type: "MESG",
        user_id: userId,
        message: `Hi, I need help with my failed payment. Original channel: ${channelUrl}`,
      },
      { headers: { "Api-Token": SENDBIRD_API_TOKEN, "Content-Type": "application/json" } }
    );
    console.log(`✅ Activation message sent via Chat Platform API`);
  } catch (err) {
    console.warn(`⚠️ Chat API activation message failed (non-fatal): HTTP ${err.response?.status} — ${JSON.stringify(err.response?.data) || err.message}`);
  }

  return { ticketId, deskChannelUrl };
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
// INTERNAL REFUND PROCESSOR
// Single function that executes a refund end-to-end:
//   1. Stripe refund API (if paymentIntentId stored and Stripe configured)
//   2. MongoDB transaction status → "refunded"
//   3. RefundRequest record → status "refunded"
//   4. Customer notification in chat
// amount = null means full refund; a number means partial.
// Always succeeds from the customer's perspective — Stripe errors are non-fatal
// in test/demo mode.
// ===============================
async function processRefundInternal(txnId, channelUrl, userId, transaction, amount = null) {
  const refundAmount = amount !== null ? amount : transaction.amount;

  if (stripe && transaction.paymentIntentId) {
    try {
      const params = { payment_intent: transaction.paymentIntentId };
      if (amount !== null) params.amount = Math.round(amount * 100); // cents for partial
      await stripe.refunds.create(params);
      console.log(`✅ Stripe refund created for ${txnId}: $${refundAmount}`);
    } catch (err) {
      // Non-fatal: continue to update DB and notify customer
      console.warn(`⚠️ Stripe refund API call failed (non-fatal): ${err.message}`);
    }
  } else {
    console.log(`[DEMO] Refund for ${txnId}: $${refundAmount} — no Stripe paymentIntentId, test mode only`);
  }

  // Update transaction status and record refunded amount
  await Transaction.updateOne(
    { transactionId: txnId },
    { status: "refunded", refundedAmount: refundAmount }
  );

  // Mark the negotiation record as completed
  await RefundRequest.findOneAndUpdate(
    { txnId, channelUrl },
    { status: "refunded", refundStage: "completed", updatedAt: new Date() }
  );

  // Notify the customer in their chat channel
  await sendBotMessage(
    channelUrl,
    `✅ Refund of $${Number(refundAmount).toFixed(2)} for ${txnId} has been approved and initiated. ` +
      "It will reflect in your account within 5–7 business days.",
    { type: "refund_status", status: "refunded", txnId, amount: refundAmount }
  );
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
// POST /escalate
// Called directly by the "Talk to Agent" button on the frontend.
// Creates a Desk ticket immediately without relying on webhook intent detection.
//
// Body: { channelUrl, userId }
// Response: { success, message }
// ----------------------------------------------------------
app.post("/escalate", async (req, res) => {
  try {
    const { channelUrl, userId } = req.body;
    if (!channelUrl || !userId) {
      return res.status(400).json({ error: "channelUrl and userId are required" });
    }

    await addBotToChannel(channelUrl);

    if (escalatedChannels.has(channelUrl)) {
      // Verify a real, ACTIVE Desk ticket still exists for this channel.
      // If the mapping is stale (ticket INITIALIZED / channel deleted / no DB record),
      // clear the flag and fall through to re-create.
      const mapping = await ChannelMapping.findOne({ originalChannelUrl: channelUrl });
      if (mapping) {
        let ticketIsActive = false;
        try {
          // Check ticket status via Desk API — INITIALIZED tickets are invisible to agents.
          if (mapping.ticketId) {
            const deskBaseUrl = `https://desk-api-${SENDBIRD_APP_ID}.sendbird.com/platform/v1`;
            const deskHeaders = { SENDBIRDDESKAPITOKEN: SENDBIRDDESKAPITOKEN };
            const ticketCheck = await axios.get(
              `${deskBaseUrl}/tickets/${mapping.ticketId}`,
              { headers: deskHeaders }
            );
            const ticketStatus = ticketCheck.data.status2 || ticketCheck.data.status;
            console.log(`🎫 Existing ticket #${mapping.ticketId} status: ${ticketStatus}`);
            if (ticketStatus && ticketStatus !== "INITIALIZED") {
              ticketIsActive = true;
            } else {
              console.warn(`⚠️ Ticket #${mapping.ticketId} is ${ticketStatus} (invisible to agents) — will re-escalate.`);
            }
          } else {
            // No ticketId stored — mapping is from before ticketId was tracked.
            // Treat as stale so a fresh ticket (with proper tracking) is created.
            console.warn("⚠️ No ticketId in mapping — treating as stale, will re-escalate.");
          }
        } catch {
          console.warn("⚠️ Could not verify ticket status — re-escalating to be safe.");
        }

        if (ticketIsActive) {
          // Check if the agent has already replied in this channel.
          // If so, skip the bot message — "join shortly" is wrong when they've already joined.
          let agentHasReplied = false;
          try {
            const msgRes = await axios.get(
              `https://api-${SENDBIRD_APP_ID}.sendbird.com/v3/group_channels/${channelUrl}/messages` +
              `?prev_limit=20&message_ts=${Date.now()}&include=false`,
              { headers: { "Api-Token": SENDBIRD_API_TOKEN } }
            );
            agentHasReplied = (msgRes.data.messages || []).some(
              (m) => m.message?.startsWith("[Support Agent]:")
            );
          } catch (err) {
            console.warn("⚠️ Could not fetch channel messages for agent-reply check:", err.message);
          }

          if (!agentHasReplied) {
            await sendBotMessage(
              channelUrl,
              `Your support ticket is already open (Ticket #${mapping.ticketId || mapping.deskChannelUrl}). ` +
              `An agent will join shortly.`
            );
          }
          return res.json({ success: true, message: "Already escalated" });
        }

        // Ticket is INITIALIZED or unverifiable — delete stale mapping and re-escalate.
        await ChannelMapping.deleteOne({ originalChannelUrl: channelUrl });
        escalatedChannels.delete(channelUrl);
      } else {
        // In-memory flag set but no DB record — clear stale flag and re-escalate.
        console.warn("⚠️ escalatedChannels has channel but no DB mapping — clearing stale state.");
        escalatedChannels.delete(channelUrl);
      }
    }

    try {
      const ticket = await createDeskTicket(channelUrl, userId);
      escalatedChannels.add(channelUrl);
      const ticketRef = ticket?.ticketId ? ` (Ticket #${ticket.ticketId})` : "";
      await sendBotMessage(
        channelUrl,
        `Support ticket created${ticketRef}. An agent will join shortly.\n\n` +
        `In your Sendbird Desk dashboard, go to → All Tickets (or New/Unassigned) to find this ticket.`
      );
    } catch (err) {
      const errDetail = `${err.message} | HTTP ${err.response?.status} | ${JSON.stringify(err.response?.data)}`;
      console.error("Desk ticket creation failed:", errDetail);
      await sendBotMessage(channelUrl, `DEBUG — ticket creation failed: ${errDetail}`);
      return res.status(500).json({ error: "Failed to create support ticket", detail: errDetail });
    }

    return res.json({ success: true });
  } catch (err) {
    return handleError(res, err, "escalate");
  }
});

// ----------------------------------------------------------
// POST /refund-action
// Handles all refund negotiation button clicks from the frontend.
// Routes every step of the refund lifecycle in one endpoint:
//   action="refund_start"           → start flow, ask reason (buttons sent via bot)
//   action="refund_reason"          → evaluate policy, execute decision
//   action="refund_accept_partial"  → user accepts 50% offer
//   action="refund_decline"         → user declines offer
// Body: { channelUrl, userId, txnId, action, reason? }
// ----------------------------------------------------------
app.post("/refund-action", async (req, res) => {
  try {
    const { channelUrl, userId, txnId, action, reason } = req.body;
    if (!channelUrl || !userId || !txnId || !action) {
      return res.status(400).json({ error: "channelUrl, userId, txnId, and action are required" });
    }

    const txnKey = txnId.toUpperCase();
    const transaction = await Transaction.findOne({ transactionId: txnKey });
    if (!transaction) return res.status(404).json({ error: `Transaction ${txnId} not found` });

    await addBotToChannel(channelUrl);

    // ── START: ask the user to pick a reason ─────────────────────────────────
    if (action === "refund_start" || action === "start") {
      if (transaction.status === "refunded") {
        await sendBotMessage(channelUrl, `A refund for ${txnKey} has already been processed.`);
        return res.json({ success: true });
      }
      if (transaction.status !== "success") {
        await sendBotMessage(
          channelUrl,
          `Refunds are only available for successful transactions. ${txnKey} has status: ${transaction.status}.`
        );
        return res.json({ success: true });
      }

      // Create/reset the refund request record
      await RefundRequest.findOneAndUpdate(
        { userId, txnId: txnKey, channelUrl },
        {
          userId, txnId: txnKey, channelUrl,
          refundStage: "reason_asked", status: "pending",
          negotiationAttempts: 0, updatedAt: new Date(),
        },
        { upsert: true }
      );
      await updateConversationState(channelUrl, userId, {
        activeTxnId: txnKey, refundStage: "reason_asked", lastIntent: "refund_start",
      });
      await trackAnalytics("refund_request", { userId, txnId: txnKey, channelUrl });

      await sendBotMessage(
        channelUrl,
        `I can help with a refund for ${txnKey} ($${transaction.amount}). Please select the reason for your request:`,
        {
          type: "action_buttons",
          txnId: txnKey,
          buttons: [
            { label: "Duplicate Charge", action: "refund_reason", reason: "duplicate" },
            { label: "Service Issue",    action: "refund_reason", reason: "service_issue" },
            { label: "Accidental Pay",   action: "refund_reason", reason: "accidental" },
            { label: "Fraud Concern",    action: "refund_reason", reason: "fraud" },
            { label: "Other",            action: "refund_reason", reason: "other" },
          ],
        }
      );
      return res.json({ success: true });
    }

    // ── REASON: run policy engine and execute decision ────────────────────────
    if (action === "refund_reason") {
      if (!reason) return res.status(400).json({ error: "reason is required" });

      const existing = await RefundRequest.findOne({ userId, txnId: txnKey, channelUrl });
      const attempts = existing?.negotiationAttempts || 0;

      // For duplicate claims: check last 5 transactions for a same-amount match
      let hasDuplicate = false;
      if (reason === "duplicate") {
        const recentTxns = await Transaction.find({ userEmail: transaction.userEmail })
          .sort({ _id: -1 }).limit(5);
        hasDuplicate = recentTxns.some(
          (t) => t.amount === transaction.amount && t.transactionId !== txnKey
        );
        console.log(`🔍 Duplicate check for ${txnKey}: hasDuplicate=${hasDuplicate}`);
      }

      const policyResult = evaluatePolicy({
        amount: transaction.amount,
        reason,
        sentiment: detectSentiment(reason),
        attempts,
        hasDuplicate,
      });

      // Persist the decision
      await RefundRequest.findOneAndUpdate(
        { userId, txnId: txnKey, channelUrl },
        {
          refundReason: reason,
          refundStage: "policy_evaluated",
          finalDecision: policyResult.action,
          negotiationAttempts: attempts + 1,
          updatedAt: new Date(),
        },
        { upsert: true }
      );
      await updateConversationState(channelUrl, userId, {
        refundStage: "policy_evaluated", lastIntent: "refund_reason",
      });

      if (policyResult.action === "AUTO_REFUND") {
        await processRefundInternal(txnKey, channelUrl, userId, transaction);
        await trackAnalytics("refund_approved", {
          userId, txnId: txnKey, channelUrl,
          metadata: { reason, action: "AUTO_REFUND" },
        });

      } else if (policyResult.action === "OFFER_PARTIAL") {
        const half = (transaction.amount * 0.5).toFixed(2);
        await sendBotMessage(
          channelUrl,
          `${policyResult.message} Would you like to accept a 50% refund of $${half}?`,
          {
            type: "action_buttons",
            txnId: txnKey,
            buttons: [
              { label: `Accept $${half} Refund`, action: "refund_accept_partial", txnId: txnKey },
              { label: "Decline",                action: "refund_decline",         txnId: txnKey },
            ],
          }
        );

      } else if (policyResult.action === "OFFER_COUPON") {
        const coupon = `COUP-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
        await RefundRequest.findOneAndUpdate(
          { userId, txnId: txnKey, channelUrl },
          { status: "approved", finalDecision: "OFFER_COUPON", refundStage: "completed", updatedAt: new Date() }
        );
        await sendBotMessage(
          channelUrl,
          `${policyResult.message} Your compensation coupon: **${coupon}** (valid 30 days on your next transaction).`,
          { type: "refund_status", status: "coupon_issued", txnId: txnKey, couponCode: coupon }
        );
        await trackAnalytics("refund_approved", {
          userId, txnId: txnKey, channelUrl,
          metadata: { reason, action: "OFFER_COUPON", couponCode: coupon },
        });

      } else if (policyResult.action === "ESCALATE_HIGH") {
        if (!escalatedChannels.has(channelUrl)) {
          try { await createDeskTicket(channelUrl, userId); escalatedChannels.add(channelUrl); } catch (e) { console.error(e.message); }
        }
        await sendBotMessage(channelUrl, policyResult.message,
          { type: "priority_badge", priority: "HIGH", txnId: txnKey }
        );
        await trackAnalytics("escalation", {
          userId, txnId: txnKey, channelUrl,
          metadata: { reason, priority: "HIGH" },
        });

      } else { // ESCALATE_NORMAL
        if (!escalatedChannels.has(channelUrl)) {
          try { await createDeskTicket(channelUrl, userId); escalatedChannels.add(channelUrl); } catch (e) { console.error(e.message); }
        }
        await sendBotMessage(channelUrl, policyResult.message,
          { type: "priority_badge", priority: "NORMAL", txnId: txnKey }
        );
        await trackAnalytics("escalation", {
          userId, txnId: txnKey, channelUrl,
          metadata: { reason, priority: "NORMAL" },
        });
      }

      return res.json({ success: true, decision: policyResult.action });
    }

    // ── ACCEPT PARTIAL: user agreed to 50% ───────────────────────────────────
    if (action === "refund_accept_partial") {
      const partialAmt = transaction.amount * 0.5;
      await processRefundInternal(txnKey, channelUrl, userId, transaction, partialAmt);
      await trackAnalytics("refund_approved", {
        userId, txnId: txnKey, channelUrl,
        metadata: { action: "OFFER_PARTIAL", amount: partialAmt },
      });
      return res.json({ success: true, decision: "OFFER_PARTIAL" });
    }

    // ── DECLINE: user rejected the partial/coupon offer ───────────────────────
    if (action === "refund_decline") {
      await RefundRequest.findOneAndUpdate(
        { userId, txnId: txnKey, channelUrl },
        { status: "rejected", refundStage: "completed", updatedAt: new Date() }
      );
      await sendBotMessage(
        channelUrl,
        `Understood. Your refund request for ${txnKey} has been cancelled. Is there anything else I can help you with?`
      );
      await trackAnalytics("refund_rejected", { userId, txnId: txnKey, channelUrl });
      return res.json({ success: true, decision: "declined" });
    }

    return res.status(400).json({ error: `Unknown refund action: ${action}` });
  } catch (err) {
    return handleError(res, err, "refund-action");
  }
});

// ----------------------------------------------------------
// POST /process-refund
// Direct refund execution — requires an existing approved/pending RefundRequest
// as an authorization gate, then calls Stripe (test mode) and updates MongoDB.
// Also notifies the Desk channel if the ticket was escalated.
// Body: { txnId, channelUrl, userId, amount? }
// ----------------------------------------------------------
app.post("/process-refund", async (req, res) => {
  try {
    const { txnId, channelUrl, userId, amount } = req.body;
    if (!txnId || !channelUrl || !userId) {
      return res.status(400).json({ error: "txnId, channelUrl, and userId are required" });
    }

    const txnKey = txnId.toUpperCase();
    const transaction = await Transaction.findOne({ transactionId: txnKey });
    if (!transaction) return res.status(404).json({ error: `Transaction ${txnId} not found` });

    // Gate: an approved/pending RefundRequest must exist for authorization
    const refundReq = await RefundRequest.findOne({
      txnId: txnKey,
      userId,
      status: { $in: ["pending", "approved"] },
    });
    if (!refundReq) {
      return res.status(403).json({ error: "No approved refund request found for this transaction." });
    }

    const refundAmount = amount != null ? Number(amount) : transaction.amount;
    await processRefundInternal(txnKey, channelUrl, userId, transaction, refundAmount);

    // Notify Desk channel if ticket is open so the agent knows the refund is done
    if (escalatedChannels.has(channelUrl)) {
      const mapping = await ChannelMapping.findOne({ originalChannelUrl: channelUrl });
      if (mapping) {
        await sendBotMessage(
          mapping.deskChannelUrl,
          `Refund of $${refundAmount.toFixed(2)} for ${txnKey} has been processed for customer ${userId}. Ticket can be closed.`
        );
      }
    }

    await trackAnalytics("refund_approved", {
      userId, txnId: txnKey, channelUrl,
      metadata: { source: "process-refund", amount: refundAmount },
    });
    return res.json({ success: true, refundAmount });
  } catch (err) {
    return handleError(res, err, "process-refund");
  }
});

// ----------------------------------------------------------
// GET /analytics
// Returns aggregated metrics from the AnalyticsEvent collection:
//   - refund request count, approval rate, auto-resolution rate
//   - escalation count, payment retry count
//   - last 20 events (for a live feed / dashboard)
// ----------------------------------------------------------
app.get("/analytics", async (req, res) => {
  try {
    const [refundRequests, refundApproved, refundRejected, escalations, paymentRetries] =
      await Promise.all([
        AnalyticsEvent.countDocuments({ eventType: "refund_request" }),
        AnalyticsEvent.countDocuments({ eventType: "refund_approved" }),
        AnalyticsEvent.countDocuments({ eventType: "refund_rejected" }),
        AnalyticsEvent.countDocuments({ eventType: "escalation" }),
        AnalyticsEvent.countDocuments({ eventType: "payment_retry" }),
      ]);

    const autoRefunds = await AnalyticsEvent.countDocuments({
      eventType: "refund_approved",
      "metadata.action": "AUTO_REFUND",
    });

    const approvalRate =
      refundRequests > 0 ? ((refundApproved / refundRequests) * 100).toFixed(1) : "0.0";
    const autoResolutionRate =
      refundRequests > 0 ? ((autoRefunds / refundRequests) * 100).toFixed(1) : "0.0";

    const recentEvents = await AnalyticsEvent.find().sort({ createdAt: -1 }).limit(20).lean();

    return res.json({
      refundRequests,
      refundApprovalRate: `${approvalRate}%`,
      autoResolutionRate: `${autoResolutionRate}%`,
      escalationCount: escalations,
      paymentRetryCount: paymentRetries,
      breakdown: { refundApproved, refundRejected, autoRefunds },
      recentEvents,
    });
  } catch (err) {
    return handleError(res, err, "analytics");
  }
});

// ----------------------------------------------------------
// GET /debug-desk?userId=<userId>
// Diagnostic endpoint: tests Desk API connectivity step-by-step
// ----------------------------------------------------------
// DELETE /clear-escalation?channelUrl=<url>
// Clears the stale escalation state for a channel so a fresh ticket can be created.
// ----------------------------------------------------------
app.get("/clear-escalation", async (req, res) => {
  const { channelUrl } = req.query;
  if (channelUrl) {
    escalatedChannels.delete(channelUrl);
    const del = await ChannelMapping.deleteOne({ originalChannelUrl: channelUrl });
    return res.json({ success: true, deleted: del.deletedCount, channelUrl });
  }
  // No channelUrl — clear ALL escalation state
  escalatedChannels.clear();
  const del = await ChannelMapping.deleteMany({});
  res.json({ success: true, message: "Cleared all escalation mappings", deleted: del.deletedCount });
});

// ----------------------------------------------------------
// and returns the raw API responses so we can see what the Desk
// API actually creates and where the ticket ends up.
// ----------------------------------------------------------
app.get("/debug-desk", async (req, res) => {
  const userId = req.query.userId || "debug_user";
  const baseUrl = `https://desk-api-${SENDBIRD_APP_ID}.sendbird.com/platform/v1`;
  const headers = { SENDBIRDDESKAPITOKEN: SENDBIRDDESKAPITOKEN, "Content-Type": "application/json" };
  const result = {};

  // Step 1: Search for customer
  try {
    const r = await axios.get(`${baseUrl}/customers?sendbird_id=${userId}`, { headers });
    result.customerSearch = { status: r.status, data: r.data };
  } catch (err) {
    result.customerSearch = { error: err.response?.status, detail: err.response?.data || err.message };
    return res.json({ step_failed: "customerSearch", result });
  }

  // Step 2: Create customer if not found
  let customerId = result.customerSearch.data?.results?.[0]?.id;
  if (!customerId) {
    try {
      const r = await axios.post(`${baseUrl}/customers`, { sendbirdId: userId, displayName: userId }, { headers });
      customerId = r.data.id;
      result.customerCreate = { status: r.status, data: r.data };
    } catch (err) {
      result.customerCreate = { error: err.response?.status, detail: err.response?.data || err.message };
      return res.json({ step_failed: "customerCreate", result });
    }
  } else {
    result.customerCreate = { skipped: true, customerId };
  }

  // Step 3: Create ticket
  try {
    const r = await axios.post(`${baseUrl}/tickets`, { channelName: `Debug - ${userId}`, customerId }, { headers });
    result.ticketCreate = { status: r.status, data: r.data };
  } catch (err) {
    result.ticketCreate = { error: err.response?.status, detail: err.response?.data || err.message };
    return res.json({ step_failed: "ticketCreate", result });
  }

  return res.json({ all_steps_passed: true, result });
});

// ----------------------------------------------------------
// GET /desk-info
// Returns the Desk routing groups, recent tickets, and agent list so we can
// diagnose why tickets aren't appearing in the dashboard.
// ----------------------------------------------------------
app.get("/desk-info", async (req, res) => {
  const baseUrl = `https://desk-api-${SENDBIRD_APP_ID}.sendbird.com/platform/v1`;
  const headers = { SENDBIRDDESKAPITOKEN: SENDBIRDDESKAPITOKEN, "Content-Type": "application/json" };
  const result = {};

  // Fetch agent groups (routing groups)
  try {
    const r = await axios.get(`${baseUrl}/agent_groups?limit=20`, { headers });
    result.agent_groups = r.data;
  } catch (err) {
    result.agent_groups = { error: err.response?.status, detail: err.response?.data || err.message };
  }

  // Fetch recent tickets (last 10, all statuses)
  try {
    const r = await axios.get(`${baseUrl}/tickets?limit=10&offset=0`, { headers });
    result.recent_tickets = r.data;
  } catch (err) {
    result.recent_tickets = { error: err.response?.status, detail: err.response?.data || err.message };
  }

  // Fetch active agents
  try {
    const r = await axios.get(`${baseUrl}/agents?status=ACTIVE&limit=20`, { headers });
    result.active_agents = r.data;
  } catch (err) {
    result.active_agents = { error: err.response?.status, detail: err.response?.data || err.message };
  }

  res.json(result);
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
        // Store the Stripe payment_intent ID so we can issue refunds later via the API
        const updateFields = { status: "success" };
        if (session.payment_intent) updateFields.paymentIntentId = session.payment_intent;
        await Transaction.updateOne({ transactionId: txnId }, updateFields);
        console.log(`✅ Transaction ${txnId} updated to success via Stripe webhook`);
        await trackAnalytics("payment_retry", {
          userId, txnId, channelUrl,
          metadata: { status: "success", paymentIntentId: session.payment_intent },
        });
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
    // When an agent replies in the Desk portal, Sendbird fires the Chat webhook
    // for that message. We detect it's a Desk backing channel, look up the original
    // customer channel from the mapping, and relay the message via the bot.
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

    // ── Sentiment check — HIGH priority keywords trigger immediate escalation ──
    // Runs for non-escalated channels only (escalated channels are forwarded above).
    // Keywords: fraud, legal, RBI, chargeback, social media, etc.
    const { priority: msgPriority, triggers: sentimentTriggers } = detectSentiment(messageText);
    if (msgPriority === "HIGH") {
      console.log(`🚨 HIGH priority sentiment detected: ${sentimentTriggers.join(", ")}`);
      await addBotToChannel(channelUrl);
      if (!escalatedChannels.has(channelUrl)) {
        try {
          await createDeskTicket(channelUrl, senderId);
          escalatedChannels.add(channelUrl);
        } catch (err) {
          console.error("High-priority escalation failed:", err.message);
        }
      }
      await updateConversationState(channelUrl, senderId, {
        escalationStatus: "high",
        priority: "HIGH",
        lastIntent: "sentiment_escalation",
      });
      await trackAnalytics("escalation", {
        userId: senderId, channelUrl,
        metadata: { priority: "HIGH", triggers: sentimentTriggers },
      });
      await sendBotMessage(
        channelUrl,
        "🚨 Your message has been flagged as high priority. A senior support agent has been notified and will contact you immediately.",
        { type: "priority_badge", priority: "HIGH" }
      );
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

      // ── Refund request — start negotiation engine ──
      // Uses conversation memory (activeTxnId) if the user didn't specify a TXN.
      if (intent === "refund_request") {
        const state = await getConversationState(channelUrl);
        const activeTxnId = state?.activeTxnId;

        if (!activeTxnId) {
          await sendBotMessage(
            channelUrl,
            "To start a refund request, please provide your transaction ID first (e.g., TXN1001)."
          );
          return res.sendStatus(200);
        }

        const refundTxn = await Transaction.findOne({ transactionId: activeTxnId });
        if (!refundTxn || refundTxn.status === "failed") {
          await sendBotMessage(
            channelUrl,
            `Transaction ${activeTxnId} is not eligible for a refund (refunds apply to successful transactions only).`
          );
          return res.sendStatus(200);
        }
        if (refundTxn.status === "refunded") {
          await sendBotMessage(channelUrl, `A refund for ${activeTxnId} has already been processed.`);
          return res.sendStatus(200);
        }

        // Upsert a pending refund request record
        await RefundRequest.findOneAndUpdate(
          { userId: senderId, txnId: activeTxnId, channelUrl },
          {
            userId: senderId, txnId: activeTxnId, channelUrl,
            refundStage: "reason_asked", status: "pending",
            negotiationAttempts: 0, updatedAt: new Date(),
          },
          { upsert: true }
        );
        await updateConversationState(channelUrl, senderId, {
          lastIntent: "refund_request",
          refundStage: "reason_asked",
        });
        await trackAnalytics("refund_request", { userId: senderId, txnId: activeTxnId, channelUrl });

        await sendBotMessage(
          channelUrl,
          `I can help with a refund for ${activeTxnId} ($${refundTxn.amount}). Please select the reason:`,
          {
            type: "action_buttons",
            txnId: activeTxnId,
            buttons: [
              { label: "Duplicate Charge", action: "refund_reason", reason: "duplicate" },
              { label: "Service Issue",    action: "refund_reason", reason: "service_issue" },
              { label: "Accidental Pay",   action: "refund_reason", reason: "accidental" },
              { label: "Fraud Concern",    action: "refund_reason", reason: "fraud" },
              { label: "Other",            action: "refund_reason", reason: "other" },
            ],
          }
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

    // Store this TXN in conversation memory so follow-ups work contextually
    await updateConversationState(channelUrl, senderId, {
      activeTxnId: txnId,
      lastIntent: "transaction_status",
    });

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

      await trackAnalytics("payment_retry", {
        userId: senderId, txnId, channelUrl,
        metadata: { status: "failed", amount: transaction.amount },
      });

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

    if (transaction.status === "success") {
      // Successful transaction: inform the user and offer refund or agent options
      await sendBotMessage(
        channelUrl,
        `Transaction ${txnId} completed successfully ✅. Amount: $${transaction.amount}.\nNeed help with this transaction?`,
        {
          type: "action_buttons",
          txnId,
          buttons: [
            { label: "Request Refund", action: "refund_start", txnId },
            { label: "Talk to Agent",  action: "escalate" },
          ],
        }
      );
      return res.sendStatus(200);
    }

    // Pending / refunded / other statuses
    await sendBotMessage(
      channelUrl,
      `Transaction ${txnId} status: ${transaction.status} ⏳. Amount: $${transaction.amount}.`
    );
    return res.sendStatus(200);
  } catch (error) {
    console.error("Webhook error:", error.response?.data || error.message);
    return res.sendStatus(500);
  }
});

// ----------------------------------------------------------
// GET / and GET /health — health check (used by uptime monitors to keep the
// Render service awake; excluded from rate limiting via the skip rule above)
// ----------------------------------------------------------
const healthHandler = (_req, res) => {
  res.json({
    status: "ok",
    service: "fintech-ai-backend",
    stripe: stripe ? "configured" : "not configured (demo mode)",
    stripe_webhook_secret: STRIPE_WEBHOOK_SECRET ? "set" : "MISSING ⚠️ — MongoDB won't update after payment",
    frontend_url: FRONTEND_URL || "MISSING ⚠️ — Stripe redirects to localhost:3000 instead of your app",
    sendbird_app_id: SENDBIRD_APP_ID || "MISSING ⚠️",
    sendbird_api_token: SENDBIRD_API_TOKEN ? "set" : "MISSING ⚠️",
    sendbird_desk_token: SENDBIRDDESKAPITOKEN ? "set" : "MISSING ⚠️ — desk ticket creation will fail",
    mongodb: mongoose.connection.readyState === 1 ? "connected" : "disconnected",
    escalated_channels_in_memory: escalatedChannels.size,
    features: "refund-negotiation, policy-engine, sentiment-detection, conversation-memory, analytics",
  });
};
app.get("/", healthHandler);
app.get("/health", healthHandler);

app.listen(PORT || 8000, () => {
  console.log(`Server running on port ${PORT || 8000}`);
});
