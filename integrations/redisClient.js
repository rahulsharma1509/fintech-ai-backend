/**
 * integrations/redisClient.js
 * ---------------------------
 * Shared Redis client for app features + BullMQ.
 */

const Redis = require("ioredis");

let client = null;
let redisStatus = "fallback";
let connectionAttempted = false;

function createRedisClient(url = process.env.REDIS_URL) {
  if (!url) return null;

  // Do not force TLS. Use REDIS_URL scheme exactly as provided (redis:// or rediss://).
  return new Redis(url, {
    maxRetriesPerRequest: null,
    enableOfflineQueue: false,
    connectTimeout: 3000,
    lazyConnect: true,
    retryStrategy: (times) => Math.min(times * 100, 2000),
  });
}

async function initRedis() {
  if (connectionAttempted) return client;
  connectionAttempted = true;

  if (!process.env.REDIS_URL) {
    redisStatus = "fallback";
    console.warn("⚠️ REDIS_URL not set — Redis features disabled (using in-memory fallback)");
    return null;
  }

  client = createRedisClient(process.env.REDIS_URL);

  if (!client) {
    redisStatus = "fallback";
    return null;
  }

  client.on("connect", () => {
    redisStatus = "connected";
    console.log("✅ Redis connected");
  });

  client.on("ready", () => {
    redisStatus = "connected";
    console.log("✅ Redis ready");
  });

  client.on("reconnecting", () => {
    redisStatus = "reconnecting";
    console.log("🔄 Redis reconnecting...");
  });

  client.on("end", () => {
    redisStatus = "fallback";
    console.warn("⚠️ Redis connection ended — fallback mode enabled");
  });

  client.on("error", (err) => {
    redisStatus = "fallback";
    console.warn("⚠️ Redis error:", err.message);
  });

  try {
    await client.connect();
    await client.ping();
    redisStatus = "connected";
  } catch (err) {
    redisStatus = "fallback";
    console.warn("⚠️ Redis unavailable:", err.message, "— using fallback mode");
  }

  return client;
}

function getClient() {
  if (!client || redisStatus !== "connected") return null;
  return client;
}

function getRedisStatus() {
  return redisStatus;
}

function getBullMQConnection() {
  return getClient();
}

async function checkAndSetIdempotency(key, ttlSeconds = 300) {
  const redis = getClient();
  if (!redis) return null;

  try {
    const result = await redis.set(`idem:${key}`, "1", "EX", ttlSeconds, "NX");
    return result === null;
  } catch (err) {
    console.warn("⚠️ Redis idempotency check failed:", err.message);
    return null;
  }
}

async function checkRateLimit(userId, scope, limit, windowMs) {
  const redis = getClient();
  if (!redis) return { allowed: true, remaining: limit };

  const key = `rl:${userId}:${scope}`;
  const now = Date.now();
  const windowStart = now - windowMs;

  try {
    // Remove old requests outside window
    await redis.zremrangebyscore(key, "-inf", windowStart);

    const count = await redis.zcard(key);

    if (count >= limit) {
      return { allowed: false, remaining: 0, resetMs: windowMs };
    }

    // Add request timestamp
    await redis.zadd(key, now, `${now}-${Math.random()}`);

    // Auto-expire key
    await redis.expire(key, Math.ceil(windowMs / 1000));

    return {
      allowed: true,
      remaining: limit - count - 1,
    };
  } catch (err) {
    console.warn("⚠️ Redis rate limit check failed:", err.message);
    return { allowed: true, remaining: limit };
  }
}

async function cacheSession(userId, session, ttlSeconds = 900) {
  const redis = getClient();
  if (!redis) return;

  try {
    await redis.set(`sess:${userId}`, JSON.stringify(session), "EX", ttlSeconds);
  } catch (err) {
    console.warn("⚠️ Redis session cache write failed:", err.message);
  }
}

async function getCachedSession(userId) {
  const redis = getClient();
  if (!redis) return null;

  try {
    const raw = await redis.get(`sess:${userId}`);
    return raw ? JSON.parse(raw) : null;
  } catch (err) {
    console.warn("⚠️ Redis session cache read failed:", err.message);
    return null;
  }
}

async function invalidateSession(userId) {
  const redis = getClient();
  if (!redis) return;

  try {
    await redis.del(`sess:${userId}`);
  } catch (err) {
    console.warn("⚠️ Redis session invalidation failed:", err.message);
  }
}

module.exports = {
  initRedis,
  getClient,
  getRedisStatus,
  getBullMQConnection,
  checkAndSetIdempotency,
  checkRateLimit,
  cacheSession,
  getCachedSession,
  invalidateSession,
};