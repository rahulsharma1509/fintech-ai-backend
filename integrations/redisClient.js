/**
 * integrations/redisClient.js
 * ---------------------------
 * WHY REDIS:
 *   Redis is an in-memory data store with microsecond latency.
 *   We use it for three purposes in this stack:
 *
 *   1. Short-term idempotency cache (TTL 5 min) — faster than hitting MongoDB
 *      on every webhook request. Redis answers in <1ms; MongoDB takes ~5-20ms.
 *      At 600 req/min (our webhook rate limit) that 20ms saving prevents
 *      request pile-ups under load.
 *
 *   2. Per-user rate limiting (sliding window) — must be atomic and shared
 *      across multiple server instances. A local counter would allow each
 *      pod to accept 10 req/min individually = 10×N effective rate.
 *      Redis ZADD/ZCOUNT gives a single source of truth across all pods.
 *
 *   3. Conversation short-memory cache — the last user session is cached
 *      for 15 minutes so frequent messages don't hit MongoDB every call.
 *
 *   ALL Redis operations fall back gracefully to MongoDB/in-memory when
 *   Redis is unavailable — the app never crashes due to Redis downtime.
 */

let client = null;
let connectionAttempted = false;

async function initRedis() {
  if (connectionAttempted) return client;
  connectionAttempted = true;

  if (!process.env.REDIS_URL) {
    console.warn("⚠️  REDIS_URL not set — Redis features disabled (using in-memory/MongoDB fallback)");
    return null;
  }

  try {
    const Redis = require("ioredis");
    client = new Redis(process.env.REDIS_URL, {
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      connectTimeout: 3000,
      lazyConnect: false,
    });

    client.on("error", (err) => {
      console.warn("⚠️  Redis error — falling back to MongoDB/in-memory:", err.message);
      client = null;
    });

    client.on("reconnecting", () => {
      console.log("🔄 Redis reconnecting...");
    });

    await client.ping();
    console.log("✅ Redis connected");
  } catch (err) {
    console.warn("⚠️  Redis unavailable:", err.message, "— falling back to MongoDB/in-memory");
    client = null;
  }

  return client;
}

function getClient() {
  return client;
}

/**
 * Short-term idempotency check using Redis SET NX EX.
 * Returns true if the key already existed (= already processed).
 * Returns false if key was newly set (= first time we see this event).
 * Falls back to null on Redis failure so caller can check MongoDB.
 *
 * @param {string} key - unique event ID
 * @param {number} ttlSeconds - expiry in seconds (default: 300 = 5 min)
 */
async function checkAndSetIdempotency(key, ttlSeconds = 300) {
  if (!client) return null; // signal: Redis unavailable, use fallback

  try {
    // SET NX EX: atomically sets key only if it doesn't exist.
    // Returns "OK" on first set, null if already existed.
    const result = await client.set(`idem:${key}`, "1", "EX", ttlSeconds, "NX");
    return result === null; // true = already processed
  } catch (err) {
    console.warn("⚠️  Redis idempotency check failed:", err.message);
    return null; // signal: Redis failed, use fallback
  }
}

/**
 * Per-user sliding window rate limiter using Redis sorted sets.
 *
 * Algorithm: store timestamps in a sorted set keyed by userId.
 * On each request:
 *   1. Remove timestamps older than windowMs
 *   2. Count remaining entries
 *   3. If count >= limit → rate limited
 *   4. Else → add current timestamp, set TTL
 *
 * Returns { allowed: bool, remaining: number, resetMs: number }
 * Returns { allowed: true } if Redis unavailable (fail open for UX).
 *
 * @param {string} userId
 * @param {string} scope - e.g. "min" or "day"
 * @param {number} limit - max requests in window
 * @param {number} windowMs - window size in milliseconds
 */
async function checkRateLimit(userId, scope, limit, windowMs) {
  if (!client) return { allowed: true, remaining: limit }; // fail open when Redis is down

  const key = `rl:${userId}:${scope}`;
  const now = Date.now();
  const windowStart = now - windowMs;

  try {
    const pipeline = client.pipeline();
    // Remove entries outside the window
    pipeline.zremrangebyscore(key, "-inf", windowStart);
    // Count remaining entries in window
    pipeline.zcard(key);
    // Add current request timestamp (score=ts, member=ts+random for uniqueness)
    pipeline.zadd(key, now, `${now}-${Math.random()}`);
    // Set TTL to window duration so key auto-expires
    pipeline.expire(key, Math.ceil(windowMs / 1000));

    const results = await pipeline.exec();
    const count = results[1][1]; // count BEFORE adding current request

    if (count >= limit) {
      return {
        allowed: false,
        remaining: 0,
        resetMs: windowMs,
      };
    }

    return {
      allowed: true,
      remaining: limit - count - 1, // -1 for the request we just added
    };
  } catch (err) {
    console.warn("⚠️  Redis rate limit check failed:", err.message);
    return { allowed: true, remaining: limit }; // fail open
  }
}

/**
 * Cache a user session object in Redis with TTL.
 * @param {string} userId
 * @param {object} session
 * @param {number} ttlSeconds - default 15 minutes
 */
async function cacheSession(userId, session, ttlSeconds = 900) {
  if (!client) return;
  try {
    await client.set(`sess:${userId}`, JSON.stringify(session), "EX", ttlSeconds);
  } catch (err) {
    console.warn("⚠️  Redis session cache write failed:", err.message);
  }
}

/**
 * Retrieve cached session from Redis.
 * Returns null on miss or failure.
 * @param {string} userId
 */
async function getCachedSession(userId) {
  if (!client) return null;
  try {
    const raw = await client.get(`sess:${userId}`);
    return raw ? JSON.parse(raw) : null;
  } catch (err) {
    console.warn("⚠️  Redis session cache read failed:", err.message);
    return null;
  }
}

/**
 * Invalidate cached session for a user (call after session update).
 * @param {string} userId
 */
async function invalidateSession(userId) {
  if (!client) return;
  try {
    await client.del(`sess:${userId}`);
  } catch (err) {
    console.warn("⚠️  Redis session invalidation failed:", err.message);
  }
}

module.exports = {
  initRedis,
  getClient,
  checkAndSetIdempotency,
  checkRateLimit,
  cacheSession,
  getCachedSession,
  invalidateSession,
};
