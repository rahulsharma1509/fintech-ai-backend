/**
 * server.js — Entry point
 * -----------------------
 * This file ONLY handles:
 *   1. Express app setup (CORS, body parsing, trust proxy)
 *   2. Global + webhook HTTP rate limiting (express-rate-limit)
 *   3. Vendor initialization (MongoDB, Redis, OpenAI, Stripe, Sendbird bot)
 *   4. Route registration (delegated to /controllers)
 *   5. Per-user rate limiting middleware (delegated to /middleware)
 *
 * Business logic lives in /controllers, /services, and /policies.
 * This separation means this file rarely needs to change.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ARCHITECTURE OVERVIEW
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * /models          — Mongoose schemas (Transaction, RefundRequest, AuditLog, etc.)
 * /integrations    — Vendor clients (Redis, OpenAI, Stripe, Sendbird API)
 * /middleware      — Cross-cutting concerns (idempotency, rate limits, signatures)
 * /policies        — Deterministic business rules (RefundPolicyEngine)
 * /services        — Orchestration layer (intentService, sessionService, auditService)
 * /controllers     — HTTP route handlers (webhookController, refundController, etc.)
 *
 * Data flow for a typical webhook:
 *   Sendbird → POST /sendbird-webhook
 *   → verifySendbirdSignature (middleware)
 *   → idempotencyMiddleware (middleware)
 *   → userRateLimitMiddleware (middleware)
 *   → webhookController.js (routes to intent/TXN handlers)
 *   → intentService.detectIntent() (LLM classification)
 *   → transactionService / refundController (DB operations)
 *   → RefundPolicyEngine.evaluate() (deterministic decision)
 *   → Stripe API / Sendbird API (financial execution)
 *   → auditService.log() (compliance trail)
 */

require("dotenv").config();

const express  = require("express");
const mongoose = require("mongoose");
const cors     = require("cors");
const rateLimit = require("express-rate-limit");

// ── Vendor initializers ───────────────────────────────────────────────────────
const { initOpenAI }  = require("./integrations/openaiClient");
const { initStripe }  = require("./integrations/stripeClient");
const { initRedis }   = require("./integrations/redisClient");
const { ensureBotUser } = require("./integrations/sendbirdClient");

// ── Route controllers ─────────────────────────────────────────────────────────
const webhookController               = require("./controllers/webhookController");
const { sendbirdWebhookHandler }      = require("./controllers/webhookController");
const refundController                = require("./controllers/refundController");
const transactionController = require("./controllers/transactionController");
const userController        = require("./controllers/userController");

// ── Middleware ────────────────────────────────────────────────────────────────
const { idempotencyMiddleware }      = require("./middleware/idempotencyMiddleware");
const { userRateLimitMiddleware }    = require("./middleware/rateLimitMiddleware");
const { verifySendbirdSignature }    = require("./middleware/webhookSignatureMiddleware");

// ── Services (startup hooks) ──────────────────────────────────────────────────
const { loadEscalatedChannels } = require("./services/deskService");

// ── Other model imports needed for diagnostic endpoints ───────────────────────
const { TokenBudget } = require("./models");

// ===============================
// EXPRESS SETUP
// ===============================
const app = express();
app.use(cors());

// express.json verify callback saves req.rawBody only for webhook routes
// so Stripe + Sendbird signature verification can access the raw bytes.
app.use(
  express.json({
    verify: (req, _res, buf) => {
      if (req.originalUrl === "/payment-webhook" || req.originalUrl === "/sendbird-webhook") {
        req.rawBody = buf;
      }
    },
  })
);

// Trust the first proxy hop so express-rate-limit reads the real client IP
// from X-Forwarded-For (required on Render, Heroku, Vercel, etc.)
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
// HTTP-LEVEL RATE LIMITING (express-rate-limit)
// ===============================
// Global: 200 req/15min per IP — protects all non-webhook routes
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

(async () => {
  await initRedis();
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
  })
  .catch((err) => console.error("Mongo Error:", err));

// ===============================
// ROUTES
// ===============================

// Sendbird webhook — layered middleware:
//   1. HTTP rate limiter (express-rate-limit)
//   2. Signature verification (HMAC)
//   3. Persistent idempotency (Redis + MongoDB)
//   4. Per-user rate limit (Redis sliding window)
//   5. Business logic (sendbirdWebhookHandler — registered directly, not via router)
//
// WHY app.post() instead of app.use() with a router:
//   app.use("/sendbird-webhook", router) strips the path prefix before passing
//   to the router, so router.post("/sendbird-webhook", ...) would never match.
//   Registering the handler directly as app.post() avoids that Express quirk.
app.post(
  "/sendbird-webhook",
  webhookLimiter,
  verifySendbirdSignature,
  idempotencyMiddleware,
  userRateLimitMiddleware,
  sendbirdWebhookHandler
);

// Other routes (no extra middleware beyond the global limiter above)
app.use("/", webhookController);       // /escalate, /payment-webhook
app.use("/", refundController);        // /refund-action, /process-refund
app.use("/", transactionController);   // /transaction-list, /view-transaction, /retry-payment, /analytics
app.use("/", userController);          // /register-user, /welcome, /knowledge-base

// ===============================
// DIAGNOSTIC / UTILITY ENDPOINTS
// ===============================

// GET /llm-budget — live OpenAI spend vs configured budget
app.get("/llm-budget", async (req, res) => {
  try {
    const { OPENAI_BUDGET_USD } = require("./integrations/openaiClient");
    const { getOpenAI } = require("./integrations/openaiClient");
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

// GET /debug-desk?userId=<userId> — test Desk API connectivity step-by-step
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

// GET /desk-info — routing groups, recent tickets, active agents
app.get("/desk-info", async (req, res) => {
  const axios = require("axios");
  const baseUrl = `https://desk-api-${SENDBIRD_APP_ID}.sendbird.com/platform/v1`;
  const headers = { SENDBIRDDESKAPITOKEN: SENDBIRDDESKAPITOKEN, "Content-Type": "application/json" };
  const result = {};
  try { const r = await axios.get(`${baseUrl}/agent_groups?limit=20`, { headers }); result.agent_groups = r.data; }
  catch (err) { result.agent_groups = { error: err.response?.status }; }
  try { const r = await axios.get(`${baseUrl}/tickets?limit=10&offset=0`, { headers }); result.recent_tickets = r.data; }
  catch (err) { result.recent_tickets = { error: err.response?.status }; }
  try { const r = await axios.get(`${baseUrl}/agents?status=ACTIVE&limit=20`, { headers }); result.active_agents = r.data; }
  catch (err) { result.active_agents = { error: err.response?.status }; }
  res.json(result);
});

// GET /audit-logs?userId=<id>&limit=<n> — compliance audit trail
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

// GET / and GET /health — health check
const healthHandler = async (_req, res) => {
  const { getOpenAI, OPENAI_BUDGET_USD } = require("./integrations/openaiClient");
  const { getStripe } = require("./integrations/stripeClient");
  const { getClient: getRedisClient } = require("./integrations/redisClient");
  const { escalatedChannels } = require("./services/deskService");

  let budgetStatus = "N/A";
  try {
    const budget = await TokenBudget.findOne({ _id: "global" });
    if (budget) {
      budgetStatus = `$${budget.totalCostUSD.toFixed(4)}/$${OPENAI_BUDGET_USD} (${budget.warningLevel})`;
    }
  } catch {}

  res.json({
    status: "ok",
    service: "fintech-ai-backend",
    architecture: "layered (controllers/services/policies/integrations/middleware/models)",
    llm_mode: getOpenAI() ? "hybrid (gpt-4o-mini + rule-based fallback)" : "rule-based only",
    llm_budget: budgetStatus,
    stripe: getStripe() ? "configured" : "demo mode",
    redis: getRedisClient() ? "connected" : "not connected (in-memory fallback)",
    mongodb: mongoose.connection.readyState === 1 ? "connected" : "disconnected",
    escalated_channels: escalatedChannels.size,
    features: [
      "persistent-idempotency (Redis+MongoDB)",
      "per-user-rate-limiting (10/min, 100/day)",
      "webhook-signature-verification",
      "conversation-memory (UserSession+Redis cache)",
      "refund-policy-engine (7-day window, fraud score)",
      "audit-logging",
      "hybrid-llm-intent",
      "agent-away-fallback-timer",
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
