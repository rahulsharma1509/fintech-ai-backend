/**
 * server.js — Entry point
 * -----------------------
 * Handles: Express setup, middleware, routes, vendor init, startup hooks.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ARCHITECTURE OVERVIEW
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * /models          — Mongoose schemas
 * /integrations    — Vendor clients (Redis, OpenAI, Stripe, Sendbird, S3, Firebase, Telegram)
 * /middleware      — Cross-cutting concerns (idempotency, rate limits, signatures, feature flags, admin auth)
 * /policies        — Deterministic business rules (RefundPolicyEngine, FraudEngine)
 * /services        — Orchestration layer (intent, session, audit, desk, push notifications)
 * /queues          — BullMQ queue definitions
 * /workers         — BullMQ job processors (payment, refund, escalation)
 * /controllers     — HTTP route handlers
 * /admin           — Admin dashboard static HTML
 *
 * DATA FLOW (typical webhook):
 *   Sendbird → POST /sendbird-webhook
 *   → verifySendbirdSignature → idempotencyMiddleware → userRateLimitMiddleware
 *   → webhookController → intentService → FraudEngine → RefundPolicyEngine
 *   → transactionService / refundController → Stripe / Sendbird API
 *   → auditService (compliance trail)
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * FREE TIER SUMMARY
 * ─────────────────────────────────────────────────────────────────────────────
 *   MongoDB Atlas:  512MB free (M0 cluster)
 *   Redis Cloud:    30MB free — https://redis.com/try-free/
 *   Render:         750 hrs/month free (web service)
 *   OpenAI:         Pay-per-use — guarded by OPENAI_BUDGET_USD ($5 default)
 *   Sendbird:       Free tier — 100 MAU, 1000 channels
 *   Stripe:         Free sandbox — no charges in test mode
 *   Telegram Bot:   Completely free
 *   Firebase FCM:   Completely free (Spark plan)
 *   AWS S3:         5GB / 12 months free — then ~$0.023/GB
 * ─────────────────────────────────────────────────────────────────────────────
 */

require("dotenv").config();

const express   = require("express");
const mongoose  = require("mongoose");
const cors      = require("cors");
const rateLimit = require("express-rate-limit");
const path      = require("path");

// ── Vendor initializers ───────────────────────────────────────────────────────
const { initOpenAI }    = require("./integrations/openaiClient");
const { initStripe }    = require("./integrations/stripeClient");
const { initRedis }     = require("./integrations/redisClient");
const { initFirebase }  = require("./integrations/firebaseClient");
const { initS3 }        = require("./integrations/s3Client");
const { ensureBotUser } = require("./integrations/sendbirdClient");

// ── Queue + worker initializers ───────────────────────────────────────────────
const { initQueues }            = require("./queues/index");
const { startPaymentWorker }    = require("./workers/paymentWorker");
const { startRefundWorker }     = require("./workers/refundWorker");
const { startEscalationWorker } = require("./workers/escalationWorker");

// ── Route controllers ─────────────────────────────────────────────────────────
const webhookController               = require("./controllers/webhookController");
const { sendbirdWebhookHandler }      = require("./controllers/webhookController");
const refundController                = require("./controllers/refundController");
const transactionController           = require("./controllers/transactionController");
const userController                  = require("./controllers/userController");
const telegramController              = require("./controllers/telegramController");
const uploadController                = require("./controllers/uploadController");
const adminController                 = require("./controllers/adminController");

// ── Middleware ────────────────────────────────────────────────────────────────
const { idempotencyMiddleware }    = require("./middleware/idempotencyMiddleware");
const { userRateLimitMiddleware }  = require("./middleware/rateLimitMiddleware");
const { verifySendbirdSignature }  = require("./middleware/webhookSignatureMiddleware");
const { seedFeatureFlags }         = require("./middleware/featureFlagMiddleware");

// ── Services ──────────────────────────────────────────────────────────────────
const { loadEscalatedChannels }  = require("./services/deskService");

// ── Models ────────────────────────────────────────────────────────────────────
const { TokenBudget, UserSession } = require("./models");

// ===============================
// EXPRESS SETUP
// ===============================
const app = express();
app.use(cors());

// express.json with rawBody capture for webhook signature verification.
// Sendbird and Stripe both require the raw bytes to verify HMAC signatures.
app.use(
  express.json({
    verify: (req, _res, buf) => {
      if (req.originalUrl === "/payment-webhook" || req.originalUrl === "/sendbird-webhook") {
        req.rawBody = buf;
      }
    },
  })
);

// Trust first proxy hop (required on Render/Heroku for correct IP in rate limiting)
app.set("trust proxy", 1);

// ── Request logging ───────────────────────────────────────────────────────────
app.use((req, res, next) => {
  const start = Date.now();
  res.on("finish", () => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.path} ${res.statusCode} ${Date.now() - start}ms`);
  });
  next();
});

// ===============================
// HTTP-LEVEL RATE LIMITING
// ===============================
// Global: 200 req/15min per IP — covers all non-webhook routes
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.path === "/sendbird-webhook",
  message: { error: "Too many requests, please try again later." },
});
app.use(globalLimiter);

// Webhook: 600 req/min — generous to cover Sendbird burst retries
const webhookLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 600,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Webhook rate limit exceeded." },
});

// ===============================
// ENV VALIDATION
// ===============================
const {
  PORT,
  MONGO_URI,
  SENDBIRD_APP_ID,
  SENDBIRD_API_TOKEN,
  SENDBIRDDESKAPITOKEN,
} = process.env;

if (!SENDBIRD_APP_ID || !SENDBIRD_API_TOKEN || !SENDBIRDDESKAPITOKEN) {
  console.error("❌ Missing required Sendbird environment variables");
  process.exit(1);
}

// ===============================
// VENDOR INITIALIZATION
// ===============================
console.log("Starting server...");

initOpenAI();
initStripe();
initFirebase();   // FCM — no-op if FIREBASE_CONFIG_PATH not set
initS3();         // AWS S3 — no-op if AWS credentials not set

(async () => {
  await initRedis();
  // Queues + workers start after Redis is ready
  initQueues();
  startPaymentWorker();
  startRefundWorker();
  startEscalationWorker();
})();

// ===============================
// MongoDB + startup hooks
// ===============================
mongoose
  .connect(MONGO_URI)
  .then(async () => {
    console.log("MongoDB Connected");
    await ensureBotUser();
    await loadEscalatedChannels();
    await seedFeatureFlags();   // seed default feature flags if not present
  })
  .catch((err) => console.error("Mongo Error:", err));

// ===============================
// ROUTES
// ===============================

// ── Sendbird webhook — full middleware chain ──────────────────────────────────
app.post(
  "/sendbird-webhook",
  webhookLimiter,
  verifySendbirdSignature,
  idempotencyMiddleware,
  userRateLimitMiddleware,
  sendbirdWebhookHandler
);

// ── Telegram webhook — rate limited at the controller level ──────────────────
app.use("/", telegramController);

// ── File uploads ──────────────────────────────────────────────────────────────
app.use("/", uploadController);

// ── Other bot/payment routes ──────────────────────────────────────────────────
app.use("/", webhookController);
app.use("/", refundController);
app.use("/", transactionController);
app.use("/", userController);

// ── Admin dashboard — protected by Basic Auth ─────────────────────────────────
// Route: /admin → serves admin/index.html
// Route: /admin/api/* → JSON data endpoints
app.use("/admin", adminController);

// ── FCM push token registration ───────────────────────────────────────────────
// Frontend calls this after requesting notification permission.
// Stores the FCM device token in UserSession for push delivery.
// ⚠️  MANUAL STEP: frontend must call this after Firebase SDK init.
app.post("/register-push-token", async (req, res) => {
  const { userId, fcmToken } = req.body;
  if (!userId || !fcmToken) {
    return res.status(400).json({ error: "userId and fcmToken are required" });
  }
  try {
    await UserSession.findOneAndUpdate(
      { userId },
      { fcmToken, updatedAt: new Date() },
      { upsert: true }
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===============================
// DIAGNOSTIC / UTILITY ENDPOINTS
// ===============================

// GET /llm-budget — live OpenAI spend vs configured budget
app.get("/llm-budget", async (req, res) => {
  try {
    const { OPENAI_BUDGET_USD, getOpenAI } = require("./integrations/openaiClient");
    const budget = await TokenBudget.findOne({ _id: "global" }) || {};
    const spent     = budget.totalCostUSD      || 0;
    const remaining = Math.max(0, OPENAI_BUDGET_USD - spent);
    const usedPct   = (spent / OPENAI_BUDGET_USD) * 100;
    return res.json({
      budget_usd:           OPENAI_BUDGET_USD,
      spent_usd:            parseFloat(spent.toFixed(6)),
      remaining_usd:        parseFloat(remaining.toFixed(6)),
      used_pct:             parseFloat(usedPct.toFixed(2)),
      status:               budget.warningLevel || "ok",
      total_input_tokens:   budget.totalInputTokens  || 0,
      total_output_tokens:  budget.totalOutputTokens || 0,
      llm_enabled:          getOpenAI() !== null,
      note: "LLM calls are disabled automatically when spent_usd >= budget_usd",
    });
  } catch (err) {
    return res.status(500).json({ error: "llm-budget", detail: err.message });
  }
});

// GET /clear-escalation?channelUrl=<url> — reset stale escalation state
app.get("/clear-escalation", async (req, res) => {
  const { ChannelMapping } = require("./models");
  const { escalatedChannels } = require("./services/deskService");
  const { channelUrl } = req.query;
  if (channelUrl) {
    escalatedChannels.delete(channelUrl);
    const del = await ChannelMapping.deleteOne({ originalChannelUrl: channelUrl });
    return res.json({ success: true, deleted: del.deletedCount, channelUrl });
  }
  escalatedChannels.clear();
  const del = await ChannelMapping.deleteMany({});
  res.json({ success: true, message: "Cleared all escalation mappings", deleted: del.deletedCount });
});

// GET /audit-logs — compliance audit trail (also available under /admin/api/audit-logs with auth)
app.get("/audit-logs", async (req, res) => {
  try {
    const { AuditLog } = require("./models");
    const query = {};
    if (req.query.userId) query.userId = req.query.userId;
    if (req.query.actionType) query.actionType = req.query.actionType;
    const limit = Math.min(parseInt(req.query.limit || "50", 10), 200);
    const logs = await AuditLog.find(query).sort({ createdAt: -1 }).limit(limit).lean();
    res.json({ count: logs.length, logs });
  } catch (err) {
    res.status(500).json({ error: "audit-logs", detail: err.message });
  }
});

// GET /debug-desk — test Desk API connectivity step-by-step
app.get("/debug-desk", async (req, res) => {
  const axios = require("axios");
  const userId = req.query.userId || "debug_user";
  const baseUrl = `https://desk-api-${SENDBIRD_APP_ID}.sendbird.com/platform/v1`;
  const headers = { SENDBIRDDESKAPITOKEN: SENDBIRDDESKAPITOKEN, "Content-Type": "application/json" };
  const result = {};
  try {
    const r = await axios.get(`${baseUrl}/customers?sendbird_id=${userId}`, { headers });
    result.customerSearch = { status: r.status, data: r.data };
  } catch (err) {
    result.customerSearch = { error: err.response?.status, detail: err.response?.data || err.message };
    return res.json({ step_failed: "customerSearch", result });
  }
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
  try {
    const r = await axios.post(`${baseUrl}/tickets`, { channelName: `Debug - ${userId}`, customerId }, { headers });
    result.ticketCreate = { status: r.status, data: r.data };
  } catch (err) {
    result.ticketCreate = { error: err.response?.status, detail: err.response?.data || err.message };
    return res.json({ step_failed: "ticketCreate", result });
  }
  return res.json({ all_steps_passed: true, result });
});

// GET / and GET /health — health check
const healthHandler = async (_req, res) => {
  const { getOpenAI, OPENAI_BUDGET_USD } = require("./integrations/openaiClient");
  const { getStripe } = require("./integrations/stripeClient");
  const { getClient: getRedisClient } = require("./integrations/redisClient");
  const { getMessaging } = require("./integrations/firebaseClient");
  const { getS3 } = require("./integrations/s3Client");
  const { escalatedChannels } = require("./services/deskService");
  const { getQueueStats } = require("./queues/index");

  let budgetStatus = "N/A";
  try {
    const budget = await TokenBudget.findOne({ _id: "global" });
    if (budget) {
      budgetStatus = `$${budget.totalCostUSD.toFixed(4)}/$${OPENAI_BUDGET_USD} (${budget.warningLevel})`;
    }
  } catch {}

  let queueStatus = "unavailable";
  try {
    const qs = await getQueueStats();
    queueStatus = Object.keys(qs).length > 0 ? "ready" : "unavailable";
  } catch {}

  res.json({
    status: "ok",
    service: "fintech-ai-backend",
    architecture: "layered (controllers/services/policies/queues/workers/integrations/middleware/models)",
    llm_mode: getOpenAI() ? "hybrid (gpt-4o-mini + rule-based fallback)" : "rule-based only",
    llm_budget: budgetStatus,
    stripe: getStripe() ? "configured" : "demo mode",
    redis: getRedisClient() ? "connected" : "not connected (in-memory fallback)",
    mongodb: mongoose.connection.readyState === 1 ? "connected" : "disconnected",
    firebase_fcm: getMessaging() ? "configured" : "not configured",
    s3: getS3() ? "configured" : "not configured",
    telegram: process.env.TELEGRAM_BOT_TOKEN ? "configured" : "not configured",
    queues: queueStatus,
    escalated_channels: escalatedChannels.size,
    features: [
      "persistent-idempotency (Redis+MongoDB)",
      "per-user-rate-limiting (10/min, 100/day)",
      "webhook-signature-verification (master-token)",
      "conversation-memory (UserSession+Redis cache)",
      "refund-policy-engine (7-day window, fraud score)",
      "fraud-engine (deterministic rules, no LLM)",
      "audit-logging",
      "hybrid-llm-intent",
      "agent-away-fallback-timer",
      "bullmq-background-jobs",
      "telegram-bridge",
      "fcm-push-notifications",
      "s3-file-uploads",
      "feature-flags (MongoDB)",
      "admin-dashboard (/admin)",
    ].join(", "),
  });
};
app.get("/", healthHandler);
app.get("/health", healthHandler);

// ===============================
// START
// ===============================
app.listen(PORT || 8000, () => {
  console.log(`Server running on port ${PORT || 8000}`);
});
