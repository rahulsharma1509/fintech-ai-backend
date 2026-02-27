/**
 * services/transactionService.js
 * --------------------------------
 * Transaction management: seeding, lookup, refund processing.
 * All operations are scoped by userId to prevent cross-user data leakage.
 */

const { Transaction, RefundRequest, ChannelMapping } = require("../models");
const { sendBotMessage } = require("../integrations/sendbirdClient");
const { createStripeRefund, getStripe } = require("../integrations/stripeClient");

/**
 * Create 5 demo transactions scoped to the given userId if none exist yet.
 * Using userId as isolation key means one user's refund never touches another.
 * This replaces the old global seedTransactions() which caused the cross-user bug.
 *
 * @param {string} userId
 */
async function ensureUserTransactions(userId) {
  const count = await Transaction.countDocuments({ userId });
  if (count > 0) return; // already seeded for this user

  await Transaction.insertMany([
    { transactionId: "TXN1001", userId, amount: 500,  status: "failed",  userEmail: `${userId}@test.com`, createdAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000) },
    { transactionId: "TXN1002", userId, amount: 1200, status: "success", userEmail: `${userId}@test.com`, createdAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000) },
    { transactionId: "TXN1003", userId, amount: 300,  status: "pending", userEmail: `${userId}@test.com`, createdAt: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000) },
    { transactionId: "TXN1004", userId, amount: 750,  status: "success", userEmail: `${userId}@test.com`, createdAt: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000) },
    { transactionId: "TXN1005", userId, amount: 200,  status: "failed",  userEmail: `${userId}@test.com`, createdAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000) },
  ]);
  console.log(`✅ 5 demo transactions seeded for user: ${userId}`);
}

/**
 * Find a transaction by ID for a specific user.
 * Always scoped to userId — never returns records from other users.
 *
 * @param {string} txnId
 * @param {string} userId
 */
async function findTransaction(txnId, userId) {
  return Transaction.findOne({ transactionId: txnId.toUpperCase(), userId });
}

/**
 * Get the last N transactions for a user.
 * @param {string} userId
 * @param {number} limit
 */
async function getUserTransactions(userId, limit = 5) {
  return Transaction.find({ userId }).sort({ _id: -1 }).limit(limit);
}

/**
 * Execute a refund end-to-end:
 *   1. Stripe refund API (if paymentIntentId stored and Stripe configured)
 *   2. MongoDB transaction status → "refunded"
 *   3. RefundRequest record → status "refunded"
 *   4. Customer notification in chat
 *
 * amount = null → full refund; a number → partial refund in dollars.
 * Stripe errors are non-fatal in test/demo mode.
 *
 * @param {string} txnId
 * @param {string} channelUrl
 * @param {string} userId
 * @param {object} transaction - MongoDB Transaction document
 * @param {number|null} amount - override amount (null = full)
 */
async function processRefundInternal(txnId, channelUrl, userId, transaction, amount = null) {
  const refundAmount = amount !== null ? amount : transaction.amount;
  const stripe = getStripe();

  if (stripe && transaction.paymentIntentId) {
    try {
      await createStripeRefund(transaction.paymentIntentId, amount);
      console.log(`✅ Stripe refund created for ${txnId}: $${refundAmount}`);
    } catch (err) {
      // Non-fatal: continue to update DB and notify customer
      console.warn(`⚠️ Stripe refund API call failed (non-fatal): ${err.message}`);
    }
  } else {
    console.log(`[DEMO] Refund for ${txnId}: $${refundAmount} — no Stripe paymentIntentId, test mode only`);
  }

  // Update transaction status — scoped to userId so one user's refund
  // never mutates the same TXN record for a different user.
  await Transaction.updateOne(
    { transactionId: txnId, userId },
    { status: "refunded", refundedAmount: refundAmount }
  );

  // Mark the negotiation record as completed
  await RefundRequest.findOneAndUpdate(
    { txnId, channelUrl },
    { status: "refunded", refundStage: "completed", updatedAt: new Date() }
  );

  // Notify the customer in their chat channel
  await sendBotMessage(
    channelUrl,
    `✅ Refund of $${Number(refundAmount).toFixed(2)} for ${txnId} has been approved and initiated. ` +
      "It will reflect in your account within 5–7 business days.",
    { type: "refund_status", status: "refunded", txnId, amount: refundAmount }
  );
}

module.exports = {
  ensureUserTransactions,
  findTransaction,
  getUserTransactions,
  processRefundInternal,
};
