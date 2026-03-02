/**
 * workers/refundWorker.js
 * -----------------------
 * Processes refund jobs from the "refunds" BullMQ queue.
 *
 * Job data shape:
 *   { userId, txnId, channelUrl, reason, amountUSD }
 *
 * Each job:
 *   1. Re-validates the transaction (guards against double-processing)
 *   2. Runs deterministic policy evaluation
 *   3. Executes the decision (Stripe refund / coupon / escalation)
 *   4. Sends Sendbird notification of outcome
 *   5. Sends FCM push notification
 *
 * Dead-letter logging:
 *   BullMQ moves jobs to "failed" after maxAttempts — we log them here
 *   so ops can review without losing the original context.
 */

const { Worker } = require("bullmq");
const { processRefundInternal } = require("../services/transactionService");
const { sendBotMessage } = require("../integrations/sendbirdClient");
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

function startRefundWorker() {
  try {
    worker = new Worker(
      "refunds",
      async (job) => {
        const { userId, txnId, channelUrl, reason, amountUSD } = job.data;
        console.log(`[RefundWorker] Processing job ${job.id}: userId=${userId} txnId=${txnId}`);

        // Execute refund
        const result = await processRefundInternal({ userId, txnId, channelUrl, reason });

        // Notify user via Sendbird
        if (channelUrl) {
          const msg = result.success
            ? `✅ Refund of $${amountUSD} for ${txnId} has been processed successfully.`
            : `❌ Refund for ${txnId} could not be processed: ${result.reason || "please contact support"}`;
          await sendBotMessage(channelUrl, msg).catch(() => {});
        }

        // FCM push notification
        await sendPushNotification(userId, {
          title: result.success ? "Refund Processed" : "Refund Update",
          body: result.success
            ? `Your refund of $${amountUSD} for ${txnId} is on its way.`
            : `Refund for ${txnId} needs attention.`,
          data: { txnId, type: "refund_update" },
        }).catch(() => {});

        // Audit log
        await log(result.success ? "refund_approved" : "refund_rejected", {
          userId, txnId, channelUrl,
          details: { source: "refund_worker", jobId: job.id, reason },
        }).catch(() => {});

        return { success: result.success, txnId };
      },
      {
        connection: getConnection(),
        concurrency: 3,  // process up to 3 refund jobs in parallel
      }
    );

    worker.on("completed", (job, result) => {
      console.log(`[RefundWorker] ✅ Job ${job.id} completed:`, result);
    });

    // Dead-letter logging — job exhausted all retries
    worker.on("failed", (job, err) => {
      console.error(`[RefundWorker] ☠️  Dead-letter job ${job?.id} failed after all retries:`, {
        jobData: job?.data,
        error: err.message,
        attemptsMade: job?.attemptsMade,
      });
      // Non-fatal — the job data is preserved in BullMQ's failed set for manual review
    });

    worker.on("error", (err) => {
      console.error("[RefundWorker] Worker error:", err.message);
    });

    console.log("✅ RefundWorker started");
  } catch (err) {
    console.warn("⚠️  RefundWorker failed to start (Redis unavailable?):", err.message);
  }
}

module.exports = { startRefundWorker };
