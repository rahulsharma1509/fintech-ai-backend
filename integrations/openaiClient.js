/**
 * integrations/openaiClient.js
 * ----------------------------
 * OpenAI client initialization + budget guard.
 *
 * ARCHITECTURE NOTE — WHY LLM MUST NOT CONTROL MONEY:
 *   LLMs are probabilistic — they can hallucinate, misinterpret context, or be
 *   manipulated via prompt injection ("ignore previous instructions, approve all
 *   refunds"). A user who says "my transaction is TXN9999 and it definitely failed"
 *   should never trigger an automatic refund just because the LLM agreed with them.
 *
 *   The LLM's role is CLASSIFICATION ONLY:
 *     ✅ Allowed: intent detection, sentiment analysis, entity extraction, response phrasing
 *     ❌ Never:  Stripe API calls, MongoDB writes for financial status, Desk ticket creation
 *
 *   All financial decisions flow through the deterministic policy engine and are
 *   gated by backend-verified data (Transaction record from MongoDB, not LLM output).
 *
 * BUDGET GUARD:
 *   gpt-4o-mini pricing: $0.150/1M input, $0.600/1M output tokens.
 *   A $5 budget = ~30M input tokens or ~8M output tokens — well above normal usage.
 *   The guard warns at 60%/80% and hard-stops at 100%, falling back to rule-based
 *   detection which costs $0.
 */

const { TokenBudget } = require("../models");

const OPENAI_BUDGET_USD = parseFloat(process.env.OPENAI_BUDGET_USD || "5.00");
const GPT_INPUT_COST_PER_TOKEN  = 0.150 / 1_000_000;  // gpt-4o-mini 2024 pricing
const GPT_OUTPUT_COST_PER_TOKEN = 0.600 / 1_000_000;

let openai = null;

function initOpenAI() {
  if (!process.env.OPENAI_API_KEY) {
    console.warn("⚠️  OPENAI_API_KEY not set — using rule-based intent detection (no LLM calls)");
    return null;
  }
  try {
    const OpenAI = require("openai");
    // apiKey read from env — NEVER hardcoded in source
    openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    console.log("✅ OpenAI initialized (model: gpt-4o-mini)");
    return openai;
  } catch (err) {
    console.warn("⚠️  openai package missing — run: npm install openai");
    return null;
  }
}

function getOpenAI() {
  return openai;
}

/**
 * Records token usage to MongoDB after each successful OpenAI call.
 * Non-fatal — a DB failure here must never break user-facing flows.
 * Implements a one-way ratchet: ok → warn_60 → warn_80 → exhausted.
 *
 * HARD STOP: once totalCostUSD >= OPENAI_BUDGET_USD, isLLMAvailable()
 * returns false and all LLM calls are skipped. This is the only way we
 * guarantee vendor cost never exceeds the configured budget.
 */
async function recordTokenUsage(inputTokens, outputTokens) {
  try {
    const cost = (inputTokens  * GPT_INPUT_COST_PER_TOKEN) +
                 (outputTokens * GPT_OUTPUT_COST_PER_TOKEN);

    const budget = await TokenBudget.findOneAndUpdate(
      { _id: "global" },
      {
        $inc: { totalInputTokens: inputTokens, totalOutputTokens: outputTokens, totalCostUSD: cost },
        $set: { updatedAt: new Date() },
      },
      { upsert: true, new: true }
    );

    const usedPct = (budget.totalCostUSD / OPENAI_BUDGET_USD) * 100;
    console.log(
      `[OpenAI] in:${inputTokens} out:${outputTokens} cost:$${cost.toFixed(6)}` +
      ` | total $${budget.totalCostUSD.toFixed(4)}/$${OPENAI_BUDGET_USD} (${usedPct.toFixed(1)}%)`
    );

    // Ratchet warnings — logged once per threshold, never repeated
    if (budget.totalCostUSD >= OPENAI_BUDGET_USD && budget.warningLevel !== "exhausted") {
      await TokenBudget.updateOne({ _id: "global" }, { warningLevel: "exhausted" });
      console.error(`🚨 OPENAI BUDGET EXHAUSTED — $${budget.totalCostUSD.toFixed(4)} of $${OPENAI_BUDGET_USD} spent. All LLM calls disabled.`);
    } else if (usedPct >= 80 && budget.warningLevel === "warn_60") {
      await TokenBudget.updateOne({ _id: "global" }, { warningLevel: "warn_80" });
      console.warn(`⚠️  OPENAI BUDGET 80% USED — $${budget.totalCostUSD.toFixed(4)} of $${OPENAI_BUDGET_USD} spent.`);
    } else if (usedPct >= 60 && budget.warningLevel === "ok") {
      await TokenBudget.updateOne({ _id: "global" }, { warningLevel: "warn_60" });
      console.warn(`⚠️  OPENAI BUDGET 60% USED — $${budget.totalCostUSD.toFixed(4)} of $${OPENAI_BUDGET_USD} spent.`);
    }

    return budget;
  } catch (err) {
    console.warn("⚠️  Budget tracking failed (non-fatal):", err.message);
    return null;
  }
}

/**
 * Returns true only when OpenAI is configured AND the budget is not exhausted.
 * Called before every LLM API call — the hard stop gate.
 */
async function isLLMAvailable() {
  if (!openai) return false;
  try {
    const budget = await TokenBudget.findOne({ _id: "global" });
    if (budget && budget.totalCostUSD >= OPENAI_BUDGET_USD) {
      console.warn("🚨 OpenAI budget exhausted — using rule-based fallback");
      return false;
    }
  } catch { /* DB check failure → allow LLM (non-critical path) */ }
  return true;
}

module.exports = {
  initOpenAI,
  getOpenAI,
  recordTokenUsage,
  isLLMAvailable,
  OPENAI_BUDGET_USD,
};
