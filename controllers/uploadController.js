/**
 * controllers/uploadController.js
 * ---------------------------------
 * POST /upload-proof — accept a payment screenshot and store in S3.
 *
 * SAFEGUARDS:
 *   - Max file size: 5MB
 *   - Allowed MIME types: image/jpeg, image/png, image/webp, image/gif
 *   - Max 20 uploads per user per day (Redis rate limit)
 *   - Files stored privately in S3 with pre-signed URL access
 *
 * REQUEST FORMAT: multipart/form-data
 *   - file:   (required) image file
 *   - userId: (required) Sendbird userId
 *   - txnId:  (optional) associated transaction ID
 *
 * RESPONSE:
 *   { success: true, url: "https://...", s3Key: "proofs/..." }
 */

const express = require("express");
const router  = express.Router();
const multer  = require("multer");

const { uploadFile, getS3 } = require("../integrations/s3Client");
const { UploadProof }        = require("../models");
const { checkRateLimit }     = require("../integrations/redisClient");
const { isEnabled }          = require("../middleware/featureFlagMiddleware");

// ── Multer config: in-memory storage (buffer → S3, no local disk needed) ─────
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 5 * 1024 * 1024,   // 5MB hard limit
    files: 1,
  },
  fileFilter: (_req, file, cb) => {
    const ALLOWED = ["image/jpeg", "image/png", "image/webp", "image/gif"];
    if (ALLOWED.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error(`File type not allowed. Accepted: ${ALLOWED.join(", ")}`));
    }
  },
});

// Max 20 uploads per user per day
const UPLOAD_DAILY_LIMIT = 20;
const UPLOAD_WINDOW_MS   = 24 * 60 * 60 * 1000;

async function checkUploadRateLimit(userId) {
  try {
    const key = `upload_rate:${userId}`;
    const count = await checkRateLimit(key, UPLOAD_WINDOW_MS, UPLOAD_DAILY_LIMIT);
    return count <= UPLOAD_DAILY_LIMIT;
  } catch {
    return true;
  }
}

// ── POST /upload-proof ────────────────────────────────────────────────────────
router.post("/upload-proof", upload.single("file"), async (req, res) => {
  // Feature flag check
  // S3 uploads are gated behind a feature flag so they can be disabled
  // without redeploying (e.g. if AWS free tier is about to expire).
  if (!(await isEnabled("S3_UPLOADS_ENABLED"))) {
    return res.status(503).json({ error: "File uploads are currently disabled." });
  }

  if (!getS3()) {
    return res.status(503).json({
      error: "S3 not configured. Set AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, and AWS_BUCKET_NAME.",
    });
  }

  const { userId, txnId } = req.body;
  if (!userId) return res.status(400).json({ error: "userId is required" });
  if (!req.file) return res.status(400).json({ error: "file is required" });

  // Rate limit
  const allowed = await checkUploadRateLimit(userId);
  if (!allowed) {
    return res.status(429).json({
      error: "Daily upload limit reached. Please try again tomorrow.",
    });
  }

  try {
    const { s3Key, s3Url } = await uploadFile(
      req.file.buffer,
      req.file.originalname,
      userId,
      req.file.mimetype
    );

    // Persist record in MongoDB
    const proof = await UploadProof.create({
      userId,
      txnId: txnId || null,
      s3Key,
      s3Url,
      fileSize: req.file.size,
      mimeType: req.file.mimetype,
    });

    res.json({
      success: true,
      proofId: proof._id,
      url: s3Url,
      s3Key,
      note: "URL expires in 1 hour. Re-fetch /upload-proof/:id to refresh.",
    });
  } catch (err) {
    console.error("[Upload] Error:", err.message);
    res.status(500).json({ error: "Upload failed: " + err.message });
  }
});

// Handle multer errors (file too large, wrong type)
router.use("/upload-proof", (err, _req, res, _next) => {
  if (err.code === "LIMIT_FILE_SIZE") {
    return res.status(413).json({ error: "File too large. Maximum size is 5MB." });
  }
  res.status(400).json({ error: err.message });
});

module.exports = router;
