/**
 * models/index.js
 * ---------------
 * Central export for all Mongoose schemas.
 * Import from here so every file shares the same registered model instances.
 *
 * Schema design notes:
 *  - All user-facing records include a `userId` field so one user's data
 *    never bleeds into another user's view (learned from the global-txn bug).
 *  - Append-only collections (AuditLog, AnalyticsEvent, ProcessedEvent) are
 *    never modified after creation — this preserves the audit trail integrity.
 */

const mongoose = require("mongoose");

// ──────────────────────────────────────────────────────────────────────────────
// TRANSACTION
// Each record belongs to exactly one user (userId field).
// ──────────────────────────────────────────────────────────────────────────────
const transactionSchema = new mongoose.Schema({
  transactionId: String,
  userId: String,         // scopes record to one user — prevents cross-user mutation
  amount: Number,
  status: String,         // failed | success | pending | refunded
  userEmail: String,
  paymentIntentId: String,
  refundedAmount: Number,
  createdAt: { type: Date, default: Date.now },
});
const Transaction = mongoose.model("Transaction", transactionSchema);

// ──────────────────────────────────────────────────────────────────────────────
// REFUND REQUEST — multi-step negotiation state machine
// ──────────────────────────────────────────────────────────────────────────────
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

// ──────────────────────────────────────────────────────────────────────────────
// CONVERSATION STATE — per-channel bot memory
// Stores the active TXN and refund stage so the bot handles follow-ups correctly.
// ──────────────────────────────────────────────────────────────────────────────
const conversationStateSchema = new mongoose.Schema({
  channelUrl: { type: String, unique: true },
  userId: String,
  lastIntent: String,
  activeTxnId: String,
  refundStage: String,
  escalationStatus: { type: String, default: "none" },
  priority: { type: String, default: "normal" },
  updatedAt: { type: Date, default: Date.now },
});
const ConversationState = mongoose.model("ConversationState", conversationStateSchema);

// ──────────────────────────────────────────────────────────────────────────────
// USER SESSION — enriched conversation memory used to reduce LLM token cost.
// Stores intent history + summary so the LLM system prompt can be shorter.
// WHY: sending 20 raw history messages to the LLM is expensive; a 1-sentence
// summary costs ~10 tokens instead of ~500, cutting API cost by ~95%.
// ──────────────────────────────────────────────────────────────────────────────
const userSessionSchema = new mongoose.Schema({
  userId: { type: String, unique: true, index: true },
  lastIntent: String,
  lastTransactionId: String,
  lastSentiment: String,
  conversationSummary: String,   // short LLM-generated recap injected as context
  messageCount: { type: Number, default: 0 },
  updatedAt: { type: Date, default: Date.now },
});
const UserSession = mongoose.model("UserSession", userSessionSchema);

// ──────────────────────────────────────────────────────────────────────────────
// ANALYTICS EVENT — append-only event log for metrics
// ──────────────────────────────────────────────────────────────────────────────
const analyticsEventSchema = new mongoose.Schema({
  eventType: String,
  userId: String,
  txnId: String,
  channelUrl: String,
  metadata: mongoose.Schema.Types.Mixed,
  createdAt: { type: Date, default: Date.now },
});
const AnalyticsEvent = mongoose.model("AnalyticsEvent", analyticsEventSchema);

// ──────────────────────────────────────────────────────────────────────────────
// AUDIT LOG — immutable compliance trail
// WHY: financial systems require auditability. Every refund decision, escalation,
// and LLM call must be traceable for regulatory compliance (PCI-DSS, RBI guidelines).
// Unlike analytics (aggregated metrics), audit logs are per-action records with
// full context — never modified, never deleted in a production system.
// ──────────────────────────────────────────────────────────────────────────────
const auditLogSchema = new mongoose.Schema({
  userId: { type: String, index: true },
  actionType: {
    type: String,
    enum: [
      "refund_attempt",
      "refund_approved",
      "refund_rejected",
      "escalation",
      "payment_retry",
      "llm_decision",
      "rate_limit_hit",
      "webhook_received",
      "policy_evaluation",
      "user_registered",
    ],
    index: true,
  },
  details: mongoose.Schema.Types.Mixed,
  channelUrl: String,
  txnId: String,
  ipAddress: String,
  createdAt: { type: Date, default: Date.now, index: true },
});
const AuditLog = mongoose.model("AuditLog", auditLogSchema);

// ──────────────────────────────────────────────────────────────────────────────
// PROCESSED EVENT — persistent idempotency store
// WHY: in-memory dedup is lost on server restart. If a Sendbird webhook fires
// during a deploy, the in-memory Set would allow the same event to be processed
// twice (once before crash, once after restart). MongoDB-backed idempotency
// survives restarts and horizontal scaling — critical for financial operations
// where double-processing a refund means real money being sent twice.
// ──────────────────────────────────────────────────────────────────────────────
const processedEventSchema = new mongoose.Schema({
  eventId: { type: String, unique: true, index: true },
  source: { type: String, default: "sendbird" }, // sendbird | stripe
  processedAt: { type: Date, default: Date.now, expires: 86400 }, // TTL: auto-purge after 24h
});
const ProcessedEvent = mongoose.model("ProcessedEvent", processedEventSchema);

// ──────────────────────────────────────────────────────────────────────────────
// CHANNEL MAPPING — links Desk ticket channel → customer channel
// ──────────────────────────────────────────────────────────────────────────────
const channelMappingSchema = new mongoose.Schema({
  deskChannelUrl: { type: String, unique: true },
  originalChannelUrl: String,
  userId: String,
  ticketId: String,
  createdAt: { type: Date, default: Date.now },
});
const ChannelMapping = mongoose.model("ChannelMapping", channelMappingSchema);

// ──────────────────────────────────────────────────────────────────────────────
// REGISTERED USER — hard cap on user count for the test environment
// ──────────────────────────────────────────────────────────────────────────────
const registeredUserSchema = new mongoose.Schema({
  userId: { type: String, unique: true },
  createdAt: { type: Date, default: Date.now },
});
const RegisteredUser = mongoose.model("RegisteredUser", registeredUserSchema);

// ──────────────────────────────────────────────────────────────────────────────
// TOKEN BUDGET — persists cumulative OpenAI cost across restarts
// ──────────────────────────────────────────────────────────────────────────────
const tokenBudgetSchema = new mongoose.Schema({
  _id: { type: String, default: "global" },
  totalInputTokens:  { type: Number, default: 0 },
  totalOutputTokens: { type: Number, default: 0 },
  totalCostUSD:      { type: Number, default: 0 },
  warningLevel: { type: String, default: "ok" }, // ok | warn_60 | warn_80 | exhausted
  updatedAt: { type: Date, default: Date.now },
});
const TokenBudget = mongoose.model("TokenBudget", tokenBudgetSchema);

// ──────────────────────────────────────────────────────────────────────────────
// FRAUD LOG — stores output of FraudEngine.evaluate() for every refund attempt
// Purely deterministic — no LLM involved. Used for admin review and policy tuning.
// ──────────────────────────────────────────────────────────────────────────────
const fraudLogSchema = new mongoose.Schema({
  userId: { type: String, index: true },
  txnId: String,
  riskScore: Number,           // 0–100
  riskLevel: {                 // LOW | MEDIUM | HIGH
    type: String,
    enum: ["LOW", "MEDIUM", "HIGH"],
  },
  action: {                    // APPROVE | PARTIAL | ESCALATE
    type: String,
    enum: ["APPROVE", "PARTIAL", "ESCALATE"],
  },
  triggers: [String],          // e.g. ["rapid_requests", "high_refund_amount"]
  refundAmountINR: Number,     // amount at time of evaluation
  refundsInLast30Days: Number, // snapshot of refund count used in evaluation
  createdAt: { type: Date, default: Date.now, index: true },
});
const FraudLog = mongoose.model("FraudLog", fraudLogSchema);

// ──────────────────────────────────────────────────────────────────────────────
// FEATURE FLAG — MongoDB-backed feature gates
// Toggle features at runtime without redeploying.
// Flags are seeded on startup if they don't exist.
// ──────────────────────────────────────────────────────────────────────────────
const featureFlagSchema = new mongoose.Schema({
  name: { type: String, unique: true, index: true },
  enabled: { type: Boolean, default: false },
  description: String,
  updatedAt: { type: Date, default: Date.now },
});
const FeatureFlag = mongoose.model("FeatureFlag", featureFlagSchema);

// ──────────────────────────────────────────────────────────────────────────────
// TELEGRAM USER — maps Telegram chat IDs to Sendbird user IDs
// Allows a Telegram user to interact with the same bot as a Sendbird user.
// ──────────────────────────────────────────────────────────────────────────────
const telegramUserSchema = new mongoose.Schema({
  telegramId: { type: String, unique: true, index: true }, // Telegram chat_id (string)
  sendbirdUserId: String,                                   // mapped Sendbird userId
  telegramUsername: String,                                 // @username (may be empty)
  channelUrl: String,                                       // active Sendbird channel
  createdAt: { type: Date, default: Date.now },
});
const TelegramUser = mongoose.model("TelegramUser", telegramUserSchema);

// ──────────────────────────────────────────────────────────────────────────────
// UPLOAD PROOF — S3 file upload records (payment screenshots)
// ──────────────────────────────────────────────────────────────────────────────
const uploadProofSchema = new mongoose.Schema({
  userId: { type: String, index: true },
  txnId: String,
  s3Key: String,         // S3 object key
  s3Url: String,         // public/pre-signed URL
  fileSize: Number,      // bytes
  mimeType: String,
  createdAt: { type: Date, default: Date.now },
});
const UploadProof = mongoose.model("UploadProof", uploadProofSchema);

module.exports = {
  Transaction,
  RefundRequest,
  ConversationState,
  UserSession,
  AnalyticsEvent,
  AuditLog,
  ProcessedEvent,
  ChannelMapping,
  RegisteredUser,
  TokenBudget,
  FraudLog,
  FeatureFlag,
  TelegramUser,
  UploadProof,
};
