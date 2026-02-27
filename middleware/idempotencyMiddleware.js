/**
 * middleware/idempotencyMiddleware.js
 * ------------------------------------
 * WHY PERSISTENT IDEMPOTENCY MATTERS:
 *   Sendbird retries webhook delivery up to 3 times if our server doesn't
 *   return 200 quickly. Without idempotency, a transient 500 error causes
 *   the same message to be processed 2–3 times — potentially:
 *     - Creating 3 Desk tickets for one customer complaint
 *     - Issuing 3 refunds for one request
 *     - Sending 3 duplicate bot messages
 *
 *   The original code used an in-memory Map (processedMessages). This works
 *   for a single server instance but breaks when:
 *     1. The server restarts (Map is empty — first retry after restart re-processes)
 *     2. Multiple instances run (each has its own Map — inter-pod races)
 *
 *   This middleware uses a THREE-LAYER approach:
 *     Layer 1: Redis SET NX (< 1ms, shared across pods, survives most restarts)
 *     Layer 2: MongoDB ProcessedEvent (survives all restarts, ~10ms, TTL index)
 *     Layer 3: In-memory Map (last resort if both Redis and MongoDB are unavailable)
 *
 *   Only Layer 3 loses data on restart — but that's acceptable as a last resort
 *   when the primary stores are unreachable.
 */

const { ProcessedEvent } = require("../models");
const { checkAndSetIdempotency } = require("../integrations/redisClient");

// In-memory fallback (used only when both Redis and MongoDB are unavailable)
const inMemoryCache = new Map();
const MEM_TTL_MS = 10 * 60 * 1000; // 10 minutes

function cleanMemoryCache() {
  const now = Date.now();
  for (const [id, ts] of inMemoryCache) {
    if (now - ts > MEM_TTL_MS) inMemoryCache.delete(id);
  }
}

/**
 * Check if an event has already been processed.
 * Returns true if it's a duplicate (should be skipped).
 * Returns false if it's new (proceed with processing).
 *
 * @param {string} eventId - unique message/event identifier
 * @param {string} source  - "sendbird" | "stripe"
 */
async function isDuplicate(eventId, source = "sendbird") {
  // Layer 1: Redis (fast, shared, survives most restarts)
  const redisResult = await checkAndSetIdempotency(eventId, 300); // 5-min TTL
  if (redisResult === true)  return true;  // Redis says already processed
  if (redisResult === false) {
    // Redis says it's new — also write to MongoDB for persistence
    try {
      await ProcessedEvent.create({ eventId, source });
    } catch (mongoErr) {
      if (mongoErr.code !== 11000) { // 11000 = duplicate key — already written by another pod
        console.warn("⚠️  ProcessedEvent MongoDB write failed (non-fatal):", mongoErr.message);
      }
    }
    return false;
  }

  // Layer 2: Redis unavailable — check MongoDB
  try {
    // insertOne with duplicate key error = already processed
    await ProcessedEvent.create({ eventId, source });
    return false; // successfully inserted → first time we see this event
  } catch (err) {
    if (err.code === 11000) {
      return true; // duplicate key → already processed
    }
    console.warn("⚠️  MongoDB idempotency check failed — falling through to in-memory:", err.message);
  }

  // Layer 3: In-memory fallback
  cleanMemoryCache();
  if (inMemoryCache.has(eventId)) return true;
  inMemoryCache.set(eventId, Date.now());
  return false;
}

/**
 * Express middleware for the Sendbird webhook.
 * Extracts the message_id and rejects duplicates with 200 (Sendbird expects 200).
 */
async function idempotencyMiddleware(req, res, next) {
  const messageId = req.body?.payload?.message_id;

  if (!messageId) {
    return next(); // no ID to check — let controller handle it
  }

  try {
    const duplicate = await isDuplicate(String(messageId), "sendbird");
    if (duplicate) {
      console.log(`[Idempotency] Duplicate event ${messageId} — skipping`);
      return res.sendStatus(200);
    }
  } catch (err) {
    console.warn("⚠️  Idempotency middleware error (non-fatal):", err.message);
    // On error, allow processing (fail open) to avoid blocking all webhooks
  }

  next();
}

module.exports = { idempotencyMiddleware, isDuplicate };
