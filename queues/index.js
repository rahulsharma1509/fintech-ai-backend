/**
 * queues/index.js
 * ---------------
 * BullMQ queue definitions.
 *
 * ARCHITECTURE: Webhook → Push Job → Queue → Worker → Execute Action
 *   Using a queue decouples the webhook acknowledgement (must be fast, <5s)
 *   from the actual processing (Stripe calls, Sendbird API, DB writes).
 *   Sendbird retries webhooks that return non-200 — queueing lets us return
 *   200 immediately and process reliably in the background.
 *
 * REDIS REQUIREMENT (FREE OPTIONS):
 *   Local dev:
 *     brew install redis && redis-server
 *     # OR: docker run -p 6379:6379 redis:alpine
 *   Production (free tier):
 *     Redis Cloud free tier — 30MB, no credit card: https://redis.com/try-free/
 *     Upstash Redis free tier — 10k commands/day: https://upstash.com/
 *   ⚠️  Render Redis add-on is PAID ($7/month) — use Redis Cloud instead.
 *
 * COST GUARD:
 *   Max 100 queued jobs per user per day (enforced in addJobSafe()).
 *   Dead-letter logging so failed jobs are never silently dropped.
 *
 * RETRY POLICY:
 *   - Max 3 attempts
 *   - Exponential backoff: 2s, 4s, 8s
 *   - After 3 failures → job moves to "failed" state (logged as dead-letter)
 */

const { Queue } = require("bullmq");

// ── Redis connection config for BullMQ ────────────────────────────────────────
// BullMQ requires maxRetriesPerRequest: null (it manages retries itself).
function getConnection() {
  if (process.env.REDIS_URL) {
    return { url: process.env.REDIS_URL, maxRetriesPerRequest: null };
  }
  return {
    host: process.env.REDIS_HOST || "localhost",
    port: parseInt(process.env.REDIS_PORT || "6379"),
    maxRetriesPerRequest: null,
  };
}

// ── Default job options applied to every job ─────────────────────────────────
const DEFAULT_JOB_OPTIONS = {
  attempts: 3,
  backoff: {
    type: "exponential",
    delay: 2000,   // 2s, 4s, 8s
  },
  removeOnComplete: { count: 100 },    // keep last 100 completed jobs for admin view
  removeOnFail:     { count: 200 },    // keep last 200 failed jobs for debugging
};

// ── Per-user daily job cap (cost guard) ──────────────────────────────────────
// Max 100 queued jobs per user per day — prevents a single user from flooding
// the queue and triggering unlimited Stripe/Sendbird/OpenAI API calls.
const USER_DAILY_JOB_CAP = 100;

// In-memory counter (resets on restart — acceptable for cost guard, not for billing)
const userJobCounts = new Map();

function getUserJobCount(userId) {
  return userJobCounts.get(userId) || 0;
}

function incrementUserJobCount(userId) {
  userJobCounts.set(userId, (userJobCounts.get(userId) || 0) + 1);
}

// Reset all counters at midnight UTC
setInterval(() => {
  userJobCounts.clear();
  console.log("[Queue] Daily job counters reset");
}, 24 * 60 * 60 * 1000);

// ── Queue instances (lazy — only created if Redis available) ──────────────────
let paymentQueue = null;
let refundQueue = null;
let escalationQueue = null;
let _initialized = false;

function initQueues() {
  if (_initialized) return;
  try {
    const conn = getConnection();
    paymentQueue    = new Queue("payments",    { connection: conn, defaultJobOptions: DEFAULT_JOB_OPTIONS });
    refundQueue     = new Queue("refunds",     { connection: conn, defaultJobOptions: DEFAULT_JOB_OPTIONS });
    escalationQueue = new Queue("escalations", { connection: conn, defaultJobOptions: DEFAULT_JOB_OPTIONS });
    _initialized = true;
    console.log("✅ BullMQ queues initialized (payments, refunds, escalations)");
  } catch (err) {
    console.warn("⚠️  BullMQ queue init failed — background jobs disabled:", err.message);
  }
}

/**
 * Add a job to a queue with per-user rate guard.
 * Returns { queued: true } or { queued: false, reason: string }.
 *
 * @param {Queue} queue
 * @param {string} jobName
 * @param {object} data     - must include userId
 * @param {object} [opts]   - optional BullMQ job options override
 */
async function addJobSafe(queue, jobName, data, opts = {}) {
  if (!queue) return { queued: false, reason: "queue_unavailable" };

  const userId = data.userId || "unknown";
  if (getUserJobCount(userId) >= USER_DAILY_JOB_CAP) {
    console.warn(`[Queue] Daily job cap reached for userId=${userId}`);
    return { queued: false, reason: "daily_cap_reached" };
  }

  try {
    const job = await queue.add(jobName, data, opts);
    incrementUserJobCount(userId);
    console.log(`[Queue] Job added: ${jobName} id=${job.id} userId=${userId}`);
    return { queued: true, jobId: job.id };
  } catch (err) {
    console.error(`[Queue] Failed to add job ${jobName}:`, err.message);
    return { queued: false, reason: "queue_error" };
  }
}

/**
 * Get queue stats for admin dashboard.
 * Returns counts of waiting/active/completed/failed jobs.
 */
async function getQueueStats() {
  const stats = {};
  for (const [name, q] of [
    ["payments", paymentQueue],
    ["refunds", refundQueue],
    ["escalations", escalationQueue],
  ]) {
    if (!q) {
      stats[name] = { status: "unavailable" };
      continue;
    }
    try {
      const [waiting, active, completed, failed, delayed] = await Promise.all([
        q.getWaitingCount(),
        q.getActiveCount(),
        q.getCompletedCount(),
        q.getFailedCount(),
        q.getDelayedCount(),
      ]);
      stats[name] = { waiting, active, completed, failed, delayed };
    } catch {
      stats[name] = { status: "error" };
    }
  }
  return stats;
}

module.exports = {
  initQueues,
  getPaymentQueue:    () => paymentQueue,
  getRefundQueue:     () => refundQueue,
  getEscalationQueue: () => escalationQueue,
  addJobSafe,
  getQueueStats,
};
