/**
 * controllers/adminController.js
 * --------------------------------
 * Admin dashboard API endpoints and UI serving.
 *
 * All routes are protected by Basic Auth (adminAuth middleware).
 * The HTML dashboard is served at GET /admin.
 *
 * ENDPOINTS:
 *   GET  /admin                    — dashboard HTML
 *   GET  /admin/api/stats          — overview counts
 *   GET  /admin/api/transactions   — recent transactions
 *   GET  /admin/api/refunds        — recent refund requests
 *   GET  /admin/api/fraud-logs     — recent fraud evaluations
 *   GET  /admin/api/audit-logs     — recent audit trail
 *   GET  /admin/api/feature-flags  — all feature flags
 *   POST /admin/api/feature-flags/:name/toggle — toggle a flag
 *   GET  /admin/api/queue-status   — BullMQ queue health
 *   GET  /admin/api/llm-usage      — OpenAI spend summary
 */

const express = require("express");
const router  = express.Router();
const path    = require("path");

const {
  Transaction,
  RefundRequest,
  FraudLog,
  AuditLog,
  TokenBudget,
} = require("../models");

const { adminAuth }             = require("../middleware/adminAuthMiddleware");
const { getAllFlags, toggleFlag } = require("../middleware/featureFlagMiddleware");
const { getQueueStats }          = require("../queues/index");

// All /admin routes require Basic Auth
router.use(adminAuth);

// ── Serve the dashboard HTML ──────────────────────────────────────────────────
router.get("/", (_req, res) => {
  res.sendFile(path.join(__dirname, "../admin/index.html"));
});

// ── GET /admin/api/stats ──────────────────────────────────────────────────────
router.get("/api/stats", async (_req, res) => {
  try {
    const [txnCount, refundCount, fraudCount, auditCount, budget] = await Promise.all([
      Transaction.countDocuments(),
      RefundRequest.countDocuments(),
      FraudLog.countDocuments(),
      AuditLog.countDocuments(),
      TokenBudget.findOne({ _id: "global" }).lean(),
    ]);
    const { OPENAI_BUDGET_USD } = require("../integrations/openaiClient");
    res.json({
      transactions: txnCount,
      refundRequests: refundCount,
      fraudLogs: fraudCount,
      auditLogs: auditCount,
      llm: {
        spent_usd: budget?.totalCostUSD || 0,
        budget_usd: OPENAI_BUDGET_USD,
        used_pct: budget ? ((budget.totalCostUSD / OPENAI_BUDGET_USD) * 100).toFixed(1) : 0,
        total_calls: (budget?.totalInputTokens || 0) + (budget?.totalOutputTokens || 0),
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /admin/api/transactions ───────────────────────────────────────────────
router.get("/api/transactions", async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit || "50"), 200);
    const txns = await Transaction.find({})
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();
    res.json({ count: txns.length, data: txns });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /admin/api/refunds ────────────────────────────────────────────────────
router.get("/api/refunds", async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit || "50"), 200);
    const refunds = await RefundRequest.find({})
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();
    res.json({ count: refunds.length, data: refunds });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /admin/api/fraud-logs ─────────────────────────────────────────────────
router.get("/api/fraud-logs", async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit || "50"), 200);
    const logs = await FraudLog.find({})
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();
    res.json({ count: logs.length, data: logs });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /admin/api/audit-logs ─────────────────────────────────────────────────
router.get("/api/audit-logs", async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit || "100"), 500);
    const query = {};
    if (req.query.userId) query.userId = req.query.userId;
    if (req.query.actionType) query.actionType = req.query.actionType;
    const logs = await AuditLog.find(query)
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();
    res.json({ count: logs.length, data: logs });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /admin/api/feature-flags ──────────────────────────────────────────────
router.get("/api/feature-flags", async (_req, res) => {
  try {
    const flags = await getAllFlags();
    res.json(flags);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /admin/api/feature-flags/:name/toggle ───────────────────────────────
router.post("/api/feature-flags/:name/toggle", async (req, res) => {
  try {
    const { name } = req.params;
    const { enabled } = req.body;
    if (typeof enabled !== "boolean") {
      return res.status(400).json({ error: "enabled must be a boolean" });
    }
    const flag = await toggleFlag(name, enabled);
    if (!flag) return res.status(404).json({ error: `Flag "${name}" not found` });
    res.json({ success: true, flag });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /admin/api/queue-status ───────────────────────────────────────────────
router.get("/api/queue-status", async (_req, res) => {
  try {
    const stats = await getQueueStats();
    res.json(stats);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /admin/api/llm-usage ──────────────────────────────────────────────────
router.get("/api/llm-usage", async (_req, res) => {
  try {
    const { OPENAI_BUDGET_USD, getOpenAI } = require("../integrations/openaiClient");
    const budget = await TokenBudget.findOne({ _id: "global" }).lean();
    res.json({
      budget_usd:          OPENAI_BUDGET_USD,
      spent_usd:           budget?.totalCostUSD || 0,
      remaining_usd:       Math.max(0, OPENAI_BUDGET_USD - (budget?.totalCostUSD || 0)),
      used_pct:            budget ? ((budget.totalCostUSD / OPENAI_BUDGET_USD) * 100).toFixed(2) : 0,
      warning_level:       budget?.warningLevel || "ok",
      total_input_tokens:  budget?.totalInputTokens || 0,
      total_output_tokens: budget?.totalOutputTokens || 0,
      llm_enabled:         getOpenAI() !== null,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
