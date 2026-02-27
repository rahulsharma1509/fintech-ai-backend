/**
 * services/intentService.js
 * --------------------------
 * Hybrid LLM + rule-based intent detection and response generation.
 *
 * ARCHITECTURE — WHY LLM MUST NOT CONTROL MONEY (repeated here for clarity):
 *   The LLM output from detectIntent() is used ONLY for routing —
 *   deciding which flow to enter (refund, retry, FAQ, etc.).
 *   The actual financial action (Stripe charge, MongoDB update, Desk ticket)
 *   is executed by deterministic backend code after verifying data from DB.
 *
 *   Example of correct flow:
 *     LLM says: { intent: "refund_request", transaction_id: "TXN1001" }
 *     Backend: finds TXN1001 in MongoDB, verifies status === "success"
 *     Policy: evaluates refund eligibility using DB-verified amount + date
 *     Stripe: called with policy decision (never with LLM output directly)
 *
 *   If LLM said "TXN9999" but that doesn't exist in DB → no refund issued.
 *   The LLM NEVER triggers money movement on its own.
 */

const { getOpenAI, isLLMAvailable, recordTokenUsage } = require("../integrations/openaiClient");
const { buildSessionContext, updateUserSession } = require("./sessionService");
const { logLLMDecision } = require("./auditService");

// ── Rule-based fallback (no LLM cost) ────────────────────────────────────────
function detectIntentRuleBased(message) {
  const lower = (message || "").toLowerCase();
  if (/txn\d+/i.test(message)) {
    return {
      intent: "transaction_lookup",
      transaction_id: (message.match(/TXN\d+/i) || [])[0]?.toUpperCase() || null,
      sentiment: "neutral",
      suggested_action: "lookup_transaction",
    };
  }
  if (/\b(retry|pay again|retry payment|repay|try again)\b/.test(lower)) {
    return { intent: "retry_payment", transaction_id: null, sentiment: "neutral", suggested_action: "retry_payment" };
  }
  // Refund checked before escalation so "want refund" never skips the negotiation engine
  if (/\b(refund|money back|reimburse|return my money|want refund|need refund|get refund|claim refund)\b/.test(lower)) {
    return { intent: "refund_request", transaction_id: null, sentiment: "neutral", suggested_action: "start_refund_flow" };
  }
  if (/\b(human|agent|speak|talk to|connect me|escalate|real person|support team|representative)\b/.test(lower)) {
    return { intent: "escalation", transaction_id: null, sentiment: "neutral", suggested_action: "create_desk_ticket" };
  }
  if (/\b(cancel|fee|policy|failed|why|how|what|charge|time|long|process|decline)\b/.test(lower)) {
    return { intent: "faq", transaction_id: null, sentiment: "neutral", suggested_action: "query_kb" };
  }
  return { intent: "unknown", transaction_id: null, sentiment: "neutral", suggested_action: "ask_for_txn_id" };
}

/**
 * Hybrid intent detection.
 * Primary: gpt-4o-mini with session context injection (reduces token cost)
 * Fallback: rule-based (zero cost, used when LLM unavailable or budget exhausted)
 *
 * Returns: { intent, transaction_id, sentiment, suggested_action }
 * intent values: transaction_lookup | refund_request | escalation | faq | retry_payment | unknown
 * sentiment values: neutral | frustrated | angry | happy
 *
 * @param {string} message
 * @param {string} userId - used to load session context
 * @param {Array}  conversationHistory - last N messages [{role, content}]
 */
async function detectIntent(message, userId = null, conversationHistory = []) {
  if (!(await isLLMAvailable())) {
    return detectIntentRuleBased(message);
  }

  const openai = getOpenAI();

  try {
    // Build compact session context to inject (replaces raw history, saves tokens)
    const sessionCtx = userId ? await buildSessionContext(userId) : "";
    const trimmedHistory = (conversationHistory || []).slice(-6); // max 6 messages for context

    const systemPrompt =
      "You are a fintech AI support assistant.\n" +
      "Analyse the user message and return ONLY valid JSON — no markdown, no explanation:\n" +
      "{\n" +
      '  "intent": one of [transaction_lookup, refund_request, escalation, faq, retry_payment, unknown],\n' +
      '  "transaction_id": "<TXN string if mentioned or inferable from context, else null>",\n' +
      '  "sentiment": one of [neutral, frustrated, angry, happy],\n' +
      '  "suggested_action": "<short action string>"\n' +
      "}\n\n" +
      "Rules:\n" +
      "- transaction_lookup  → user asks about a specific payment or transaction\n" +
      "- refund_request      → user wants money back\n" +
      "- retry_payment       → user wants to redo / retry a payment\n" +
      "- escalation          → user wants a human agent\n" +
      "- faq                 → user asks about policies, fees, timelines\n" +
      "- unknown             → none of the above\n" +
      "- Extract transaction_id (format TXN + digits) from message OR session context\n" +
      "- sentiment = angry or frustrated if user sounds upset, impatient, or uses strong language\n" +
      (sessionCtx ? `\nSession context: ${sessionCtx}\n` : "") +
      "JSON only. No extra text.";

    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0,       // deterministic classification
      max_tokens: 150,      // intent JSON is tiny; hard cap prevents runaway cost
      messages: [
        { role: "system", content: systemPrompt },
        ...trimmedHistory.map((m) => ({ role: m.role, content: m.content })),
        { role: "user", content: message },
      ],
    });

    const inputTokens  = response.usage.prompt_tokens;
    const outputTokens = response.usage.completion_tokens;
    await recordTokenUsage(inputTokens, outputTokens);

    const parsed = JSON.parse(response.choices[0]?.message?.content?.trim());
    console.log(`[LLM intent] ${JSON.stringify(parsed)}`);

    // Update session memory and log LLM decision (non-fatal async)
    if (userId) {
      updateUserSession(userId, {
        lastIntent: parsed.intent,
        lastSentiment: parsed.sentiment,
        ...(parsed.transaction_id ? { lastTransactionId: parsed.transaction_id } : {}),
      }).catch(() => {});
    }
    logLLMDecision({ userId, intent: parsed.intent, sentiment: parsed.sentiment, inputTokens, outputTokens }).catch(() => {});

    return parsed;
  } catch (err) {
    console.warn("⚠️  LLM intent detection failed — using rule-based fallback:", err.message);
    return detectIntentRuleBased(message);
  }
}

/**
 * Generate a natural-language response wrapping backend-verified data.
 *
 * CRITICAL CONSTRAINT: LLM only rephrases data we already verified.
 * It never invents transaction status, amounts, or outcomes.
 * The `extra` field provides a deterministic fallback so we never
 * depend on the LLM for correctness — only for tone.
 *
 * @param {object} contextData - { intent, txnId, status, amount, extra }
 * @returns {Promise<string>}
 */
async function generateNaturalResponse(contextData) {
  const { intent, txnId, status, amount, extra = "" } = contextData;

  if (!(await isLLMAvailable())) {
    // Deterministic fallback text
    if (intent === "transaction_status" && txnId) {
      if (status === "failed")  return `Your transaction ${txnId} ($${amount}) has failed. A support case has been opened. How would you like to proceed?`;
      if (status === "success") return `Transaction ${txnId} completed successfully ✅. Amount: $${amount}.\nNeed help with this transaction?`;
    }
    return extra || "How can I assist you further?";
  }

  const openai = getOpenAI();

  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.3,  // slight variation in phrasing, never in facts
      max_tokens: 120,   // concise responses — keep cost low
      messages: [
        {
          role: "system",
          content:
            "You are a polite, empathetic fintech customer-support assistant.\n" +
            "Given backend-verified transaction data, write a short response (2–3 sentences max).\n" +
            "Rules:\n" +
            "- Use the EXACT status and amount from the data — never invent or assume financial info\n" +
            "- Warm but professional tone\n" +
            "- If transaction failed, briefly acknowledge and offer next steps\n" +
            "- No jargon, no disclaimers, no legal language",
        },
        {
          role: "user",
          content: `Transaction data: ${JSON.stringify(contextData)}\nWrite the customer-facing message:`,
        },
      ],
    });

    await recordTokenUsage(response.usage.prompt_tokens, response.usage.completion_tokens);
    return response.choices[0]?.message?.content?.trim() || extra;
  } catch (err) {
    console.warn("⚠️  generateNaturalResponse failed — using static fallback:", err.message);
    return extra || "How can I assist you further?";
  }
}

// ── Sentiment detection (rule-based, no LLM cost) ────────────────────────────
const HIGH_TRIGGERS = [
  "fraud", "complaint", "legal", "rbi", "chargeback", "social media",
  "twitter", "consumer court", "fir", "police", "lawyer", "sue", "dispute",
  "unauthorized", "scam",
];

function detectSentiment(message) {
  const lower = (message || "").toLowerCase();
  const triggers = HIGH_TRIGGERS.filter((k) => lower.includes(k));
  return { priority: triggers.length > 0 ? "HIGH" : "NORMAL", triggers };
}

// ── Knowledge base (static FAQ) ───────────────────────────────────────────────
const KNOWLEDGE_BASE = [
  { keywords: ["refund", "money back", "return", "reimburse"],
    answer: "Refund Policy: Failed transaction refunds are processed within 5–7 business days back to your original payment method. Successfully completed transactions are non-refundable unless an error occurred on our end." },
  { keywords: ["cancel", "cancellation"],
    answer: "Cancellation Policy: Pending transactions can be cancelled within 30 minutes. Failed transactions are automatically cancelled — no action needed." },
  { keywords: ["failed", "decline", "declined", "payment fail", "not work", "unsuccessful"],
    answer: "Common Payment Failure Reasons: (1) Insufficient funds, (2) Incorrect card details, (3) Bank security block, (4) Card expired or limit exceeded, (5) Network timeout. Try retrying or contact your bank." },
  { keywords: ["fee", "charge", "cost", "pricing"],
    answer: "Fee Policy: We do not charge additional fees for failed or retried transactions. Standard fees apply only to successfully completed transactions." },
  { keywords: ["time", "long", "how long", "process", "days"],
    answer: "Processing Times: Successful payments reflect within 1–2 business days. Refunds take 5–7 business days. Dispute resolution may take up to 14 business days." },
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

module.exports = {
  detectIntent,
  detectIntentRuleBased,
  generateNaturalResponse,
  detectSentiment,
  queryKnowledgeBase,
};
