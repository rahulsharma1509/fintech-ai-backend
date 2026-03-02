/**
 * workers/paymentWorker.js
 * ------------------------
 * Processes payment retry jobs from the "payments" BullMQ queue.
 *
 * Job data shape:
 *   { userId, txnId, channelUrl, stripePaymentMethodId? }
 *
 * Each job:
 *   1. Looks up the failed transaction
 *   2. Creates a Stripe Checkout session (or demo mode)
 *   3. Sends the payment link back via Sendbird
 *   4. Sends FCM push notification
 */

const { Worker } = require("bullmq");
const { Transaction } = require("../models");
const { sendBotMessage } = require("../integrations/sendbirdClient");
const { getStripe } = require("../integrations/stripeClient");
const { sendPushNotification } = require("../services/pushNotificationService");
const { log } = require("../services/auditService");

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

let worker = null;

function startPaymentWorker() {
  try {
    worker = new Worker(
      "payments",
      async (job) => {
        const { userId, txnId, channelUrl } = job.data;
        console.log(`[PaymentWorker] Processing job ${job.id}: userId=${userId} txnId=${txnId}`);

        const txn = await Transaction.findOne({ transactionId: txnId, userId });
        if (!txn) throw new Error(`Transaction ${txnId} not found for user ${userId}`);
        if (txn.status !== "failed") {
          console.log(`[PaymentWorker] Skipping ${txnId} — status is ${txn.status}`);
          return { skipped: true, reason: "not_failed" };
        }

        const stripe = getStripe();
        let replyMsg;

        if (stripe) {
          // ⚠️ Stripe cost note: Checkout sessions are free to create.
          // Stripe charges 2.9% + $0.30 per successful transaction only.
          const session = await stripe.checkout.sessions.create({
            payment_method_types: ["card"],
            line_items: [{
              price_data: {
                currency: "usd",
                product_data: { name: `Retry: ${txnId}` },
                unit_amount: Math.round(txn.amount * 100),
              },
              quantity: 1,
            }],
            mode: "payment",
            success_url: `${process.env.FRONTEND_URL || "http://localhost:3000"}/success?txn=${txnId}`,
            cancel_url:  `${process.env.FRONTEND_URL || "http://localhost:3000"}/cancel`,
            metadata: { txnId, userId },
          });
          replyMsg = `🔗 Retry payment for ${txnId} ($${txn.amount}): ${session.url}`;
        } else {
          // Demo mode — no Stripe configured
          replyMsg = `[Demo] Retry initiated for ${txnId} ($${txn.amount}). No real payment processed.`;
        }

        if (channelUrl) {
          await sendBotMessage(channelUrl, replyMsg).catch(() => {});
        }

        await sendPushNotification(userId, {
          title: "Payment Retry Ready",
          body: `Your retry link for ${txnId} is ready.`,
          data: { txnId, type: "payment_retry" },
        }).catch(() => {});

        await log("payment_retry", {
          userId, txnId, channelUrl,
          details: { source: "payment_worker", jobId: job.id },
        }).catch(() => {});

        return { success: true, txnId };
      },
      {
        connection: getConnection(),
        concurrency: 5,
      }
    );

    worker.on("completed", (job, result) => {
      console.log(`[PaymentWorker] ✅ Job ${job.id} completed:`, result);
    });

    worker.on("failed", (job, err) => {
      console.error(`[PaymentWorker] ☠️  Dead-letter job ${job?.id}:`, {
        jobData: job?.data,
        error: err.message,
        attemptsMade: job?.attemptsMade,
      });
    });

    worker.on("error", (err) => {
      console.error("[PaymentWorker] Worker error:", err.message);
    });

    console.log("✅ PaymentWorker started");
  } catch (err) {
    console.warn("⚠️  PaymentWorker failed to start:", err.message);
  }
}

module.exports = { startPaymentWorker };
