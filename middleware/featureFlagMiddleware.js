/**
 * middleware/featureFlagMiddleware.js
 * -------------------------------------
 * MongoDB-backed feature flag system.
 *
 * FLAGS (seeded on startup if absent):
 *   LLM_ENABLED                  — enables OpenAI intent detection
 *   AUTO_REFUND_ENABLED          — allows automatic refund approval without agent
 *   FRAUD_ENGINE_ENABLED         — runs FraudEngine before every refund
 *   TELEGRAM_ENABLED             — processes incoming Telegram messages
 *   PUSH_NOTIFICATIONS_ENABLED   — sends FCM push notifications
 *   S3_UPLOADS_ENABLED           — allows /upload-proof endpoint
 *   QUEUES_ENABLED               — routes work through BullMQ instead of inline
 *
 * FLAGS ARE CACHED IN-MEMORY for 30 seconds to avoid a DB hit on every request.
 * Toggle from the admin dashboard → change takes effect within 30 seconds.
 *
 * USAGE:
 *   // Check in route handler:
 *   if (!(await isEnabled("LLM_ENABLED"))) { ... fallback ... }
 *
 *   // As Express middleware (returns 503 if flag is off):
 *   router.post("/my-route", requireFlag("TELEGRAM_ENABLED"), handler);
 */

const { FeatureFlag } = require("../models");

// ── In-memory cache (30-second TTL) ──────────────────────────────────────────
const _cache = new Map();          // name → { enabled, expiresAt }
const CACHE_TTL_MS = 30 * 1000;

// ── Default flag values (seeded on startup) ───────────────────────────────────
const DEFAULT_FLAGS = [
  { name: "LLM_ENABLED",                enabled: true,  description: "Enable OpenAI GPT-4o-mini for intent detection. Disable to use rule-based fallback only (zero LLM cost)." },
  { name: "AUTO_REFUND_ENABLED",        enabled: true,  description: "Allow automatic refund approval for eligible transactions. Disable to force all refunds through agent review." },
  { name: "FRAUD_ENGINE_ENABLED",       enabled: true,  description: "Run FraudEngine before every refund request. Disable to skip fraud checks (not recommended for production)." },
  { name: "TELEGRAM_ENABLED",           enabled: false, description: "Process incoming Telegram messages. Requires TELEGRAM_BOT_TOKEN in .env." },
  { name: "PUSH_NOTIFICATIONS_ENABLED", enabled: false, description: "Send FCM push notifications. Requires FIREBASE_CONFIG_PATH in .env." },
  { name: "S3_UPLOADS_ENABLED",         enabled: false, description: "Enable /upload-proof endpoint. Requires AWS credentials in .env. AWS S3 free tier: 5GB/month." },
  { name: "QUEUES_ENABLED",             enabled: false, description: "Route background work through BullMQ. Requires Redis. Enables async job processing with retries." },
];

/**
 * Seed default feature flags on startup.
 * Uses upsert with $setOnInsert so existing flags are never overwritten
 * (preserves admin-toggled values across restarts).
 */
async function seedFeatureFlags() {
  try {
    for (const flag of DEFAULT_FLAGS) {
      await FeatureFlag.findOneAndUpdate(
        { name: flag.name },
        { $setOnInsert: { name: flag.name, enabled: flag.enabled, description: flag.description } },
        { upsert: true, new: false }
      );
    }
    console.log("✅ Feature flags seeded");
  } catch (err) {
    console.error("⚠️  Feature flag seeding failed:", err.message);
  }
}

/**
 * Check if a feature flag is enabled.
 * Uses in-memory cache with 30s TTL for performance.
 *
 * @param {string} name - flag name (e.g. "LLM_ENABLED")
 * @returns {Promise<boolean>}
 */
async function isEnabled(name) {
  const cached = _cache.get(name);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.enabled;
  }

  try {
    const flag = await FeatureFlag.findOne({ name }).lean();
    const enabled = flag ? flag.enabled : false;
    _cache.set(name, { enabled, expiresAt: Date.now() + CACHE_TTL_MS });
    return enabled;
  } catch (err) {
    console.warn(`⚠️  Feature flag lookup failed for ${name}:`, err.message);
    return false; // fail closed — unknown flags are disabled
  }
}

/**
 * Invalidate cache for a flag (call after toggling via admin dashboard).
 */
function invalidateFlagCache(name) {
  _cache.delete(name);
}

/**
 * Express middleware factory — returns 503 if the flag is disabled.
 * Use to gate entire routes.
 *
 * @param {string} flagName
 * @param {string} [message] - custom error message
 */
function requireFlag(flagName, message) {
  return async (req, res, next) => {
    const enabled = await isEnabled(flagName);
    if (!enabled) {
      return res.status(503).json({
        error: message || `Feature "${flagName}" is currently disabled.`,
      });
    }
    next();
  };
}

/**
 * GET /feature-flags — public read of all flags (no sensitive data).
 * Used by the admin dashboard.
 */
async function getAllFlags() {
  try {
    return await FeatureFlag.find({}).sort({ name: 1 }).lean();
  } catch (err) {
    console.error("⚠️  getAllFlags failed:", err.message);
    return [];
  }
}

/**
 * Toggle a flag by name. Returns the updated flag.
 */
async function toggleFlag(name, enabled) {
  const flag = await FeatureFlag.findOneAndUpdate(
    { name },
    { enabled, updatedAt: new Date() },
    { new: true }
  );
  invalidateFlagCache(name);
  console.log(`[FeatureFlag] ${name} → ${enabled}`);
  return flag;
}

module.exports = { seedFeatureFlags, isEnabled, requireFlag, getAllFlags, toggleFlag };
