/**
 * integrations/stripeClient.js
 * ----------------------------
 * Stripe initialization and reusable helpers.
 *
 * HARD STOP on spend:
 *   Stripe charges per successful transaction — not per API call.
 *   The risk here is creating many checkout sessions that users then
 *   complete, leading to real charges. The 20-user limit in RegisteredUser
 *   combined with rate limiting per user provides the spending cap.
 *
 *   For webhooks, we ALWAYS verify the Stripe signature before processing.
 *   An unverified webhook could be crafted to mark transactions as "success"
 *   without any real payment occurring — a critical security vulnerability.
 */

let stripe = null;

function initStripe() {
  if (!process.env.STRIPE_SECRET_KEY) {
    console.warn("⚠️  STRIPE_SECRET_KEY not set — running in demo mode (no real payments)");
    return null;
  }
  try {
    stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
    console.log("✅ Stripe initialized");
    return stripe;
  } catch (err) {
    console.warn("⚠️  stripe package missing — run: npm install stripe");
    return null;
  }
}

function getStripe() {
  return stripe;
}

/**
 * Create a Stripe Checkout session for retrying a failed payment.
 * Returns the session URL.
 *
 * @param {object} params
 * @param {string} params.txnId
 * @param {number} params.amount  in dollars
 * @param {string} params.channelUrl
 * @param {string} params.userId
 * @param {string} params.frontendUrl
 */
async function createCheckoutSession({ txnId, amount, channelUrl, userId, frontendUrl }) {
  const session = await stripe.checkout.sessions.create({
    payment_method_types: ["card"],
    mode: "payment",
    line_items: [
      {
        price_data: {
          currency: "usd",
          product_data: {
            name: `Retry Payment — ${txnId}`,
            description: `Re-attempt for failed transaction ${txnId}`,
          },
          unit_amount: amount * 100, // Stripe expects cents
        },
        quantity: 1,
      },
    ],
    success_url: `${frontendUrl}?payment=success&txn=${txnId}`,
    cancel_url:  `${frontendUrl}?payment=cancelled&txn=${txnId}`,
    metadata: { txnId, channelUrl, userId },
  });
  return session.url;
}

/**
 * Create a refund via Stripe API.
 * amount = null → full refund; number → partial refund in dollars.
 * Non-fatal — in test/demo mode Stripe errors are logged but not re-thrown.
 */
async function createStripeRefund(paymentIntentId, amount = null) {
  const params = { payment_intent: paymentIntentId };
  if (amount !== null) params.amount = Math.round(amount * 100); // dollars → cents
  await stripe.refunds.create(params);
}

/**
 * Verify a Stripe webhook event signature.
 * CRITICAL: without this check, anyone can POST a fake event to /payment-webhook
 * and mark transactions as paid without actually paying.
 *
 * @param {Buffer} rawBody - the raw request body buffer
 * @param {string} signature - value of stripe-signature header
 * @param {string} secret - STRIPE_WEBHOOK_SECRET from env
 * @returns {object} verified Stripe event
 * @throws {Error} if signature is invalid
 */
function constructWebhookEvent(rawBody, signature, secret) {
  return stripe.webhooks.constructEvent(rawBody, signature, secret);
}

module.exports = {
  initStripe,
  getStripe,
  createCheckoutSession,
  createStripeRefund,
  constructWebhookEvent,
};
