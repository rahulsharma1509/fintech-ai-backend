/**
 * workers/escalationWorker.js
 * ---------------------------
 * Processes escalation jobs from the "escalations" BullMQ queue.
 *
 * Job data shape:
 *   { userId, channelUrl, reason, priority, txnId? }
 *
 * Each job:
 *   1. Creates a Sendbird Desk ticket
 *   2. Sends FCM push notification to user confirming escalation
 *   3. Schedules agent-away fallback timer
 */

const { Worker } = require("bullmq");
const {
  createDeskTicket,
  escalatedChannels,
  scheduleAgentAwayFallback,
} = require("../services/deskService");
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

function startEscalationWorker() {
  try {
    worker = new Worker(
      "escalations",
      async (job) => {
        const { userId, channelUrl, reason, priority = "normal", txnId } = job.data;
        console.log(`[EscalationWorker] Processing job ${job.id}: userId=${userId} priority=${priority}`);

        // Idempotency: skip if already escalated
        if (escalatedChannels.has(channelUrl)) {
          console.log(`[EscalationWorker] Channel ${channelUrl} already escalated — skipping`);
          return { skipped: true, reason: "already_escalated" };
        }

        await createDeskTicket(channelUrl, userId);
        escalatedChannels.add(channelUrl);
        scheduleAgentAwayFallback(channelUrl);

        if (channelUrl) {
          await sendBotMessage(
            channelUrl,
            "✅ You've been connected to a support agent. They'll respond shortly."
          ).catch(() => {});
        }

        await sendPushNotification(userId, {
          title: "Agent Assigned",
          body: "A support agent has been assigned to your case.",
          data: { type: "escalation", priority, txnId: txnId || "" },
        }).catch(() => {});

        await log("escalation", {
          userId, channelUrl, txnId,
          details: { source: "escalation_worker", jobId: job.id, priority, reason },
        }).catch(() => {});

        return { success: true, channelUrl };
      },
      {
        connection: getConnection(),
        concurrency: 2,  // escalations are lower volume, keep concurrency low
      }
    );

    worker.on("completed", (job, result) => {
      console.log(`[EscalationWorker] ✅ Job ${job.id} completed:`, result);
    });

    worker.on("failed", (job, err) => {
      console.error(`[EscalationWorker] ☠️  Dead-letter job ${job?.id}:`, {
        jobData: job?.data,
        error: err.message,
        attemptsMade: job?.attemptsMade,
      });
    });

    worker.on("error", (err) => {
      console.error("[EscalationWorker] Worker error:", err.message);
    });

    console.log("✅ EscalationWorker started");
  } catch (err) {
    console.warn("⚠️  EscalationWorker failed to start:", err.message);
  }
}

module.exports = { startEscalationWorker };
