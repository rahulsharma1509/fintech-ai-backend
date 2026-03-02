/**
 * integrations/s3Client.js
 * -------------------------
 * AWS S3 file upload client for payment proof screenshots.
 *
 * ============================================================
 * MANUAL SETUP REQUIRED — AWS FREE TIER
 * ============================================================
 * AWS S3 Free Tier: 5GB storage, 20,000 GET, 2,000 PUT requests/month
 * Free for 12 months after account creation.
 *
 * SETUP STEPS:
 * 1. Create AWS account: https://aws.amazon.com/free/
 * 2. Go to S3 → Create bucket
 *    - Choose a unique bucket name (e.g. fintech-proofs-yourname)
 *    - Select region (e.g. us-east-1)
 *    - Block all public access: ON (we use pre-signed URLs, not public)
 * 3. Go to IAM → Users → Create user
 *    - Attach policy: AmazonS3FullAccess (or create a scoped policy for your bucket only)
 *    - Security credentials → Create access key → "Application running outside AWS"
 * 4. Add to .env:
 *      AWS_ACCESS_KEY_ID=AKIA...
 *      AWS_SECRET_ACCESS_KEY=...
 *      AWS_BUCKET_NAME=your-bucket-name
 *      AWS_REGION=us-east-1
 *
 * ⚠️  COST WARNING: Free tier expires after 12 months.
 *     After that, S3 costs ~$0.023/GB storage + $0.0004/1k PUT requests.
 *     For a small fintech app, this is typically < $1/month.
 *
 * SECURITY:
 *   Files are stored with private ACL. Access via pre-signed URLs (1-hour expiry).
 *   Never serve files publicly — payment screenshots may contain PII.
 * ============================================================
 */

const { S3Client, PutObjectCommand, GetObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const crypto = require("crypto");
const path = require("path");

let _s3 = null;

function initS3() {
  const { AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_REGION, AWS_BUCKET_NAME } = process.env;

  if (!AWS_ACCESS_KEY_ID || !AWS_SECRET_ACCESS_KEY || !AWS_BUCKET_NAME) {
    console.log("ℹ️  AWS credentials not set — S3 file upload disabled");
    return;
  }

  _s3 = new S3Client({
    region: AWS_REGION || "us-east-1",
    credentials: {
      accessKeyId: AWS_ACCESS_KEY_ID,
      secretAccessKey: AWS_SECRET_ACCESS_KEY,
    },
  });

  console.log(`✅ S3 client initialized (bucket: ${AWS_BUCKET_NAME}, region: ${AWS_REGION || "us-east-1"})`);
}

function getS3() {
  return _s3;
}

/**
 * Upload a file buffer to S3.
 * Returns the S3 key and a 1-hour pre-signed URL for viewing.
 *
 * @param {Buffer} buffer       - file content
 * @param {string} originalName - original filename (for extension)
 * @param {string} userId       - for folder namespacing
 * @param {string} mimeType
 * @returns {Promise<{s3Key: string, s3Url: string}>}
 */
async function uploadFile(buffer, originalName, userId, mimeType) {
  if (!_s3) throw new Error("S3 not configured — set AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_BUCKET_NAME");

  const ext = path.extname(originalName) || ".jpg";
  const uniqueId = crypto.randomBytes(8).toString("hex");
  // Folder structure: proofs/{userId}/{timestamp}-{random}.{ext}
  const s3Key = `proofs/${userId}/${Date.now()}-${uniqueId}${ext}`;

  await _s3.send(new PutObjectCommand({
    Bucket: process.env.AWS_BUCKET_NAME,
    Key: s3Key,
    Body: buffer,
    ContentType: mimeType,
    // No ACL = private by default (bucket block-public-access handles this)
  }));

  // Generate 1-hour pre-signed URL for viewing
  const s3Url = await getSignedUrl(
    _s3,
    new GetObjectCommand({ Bucket: process.env.AWS_BUCKET_NAME, Key: s3Key }),
    { expiresIn: 3600 }
  );

  console.log(`[S3] Uploaded ${s3Key} (${buffer.length} bytes)`);
  return { s3Key, s3Url };
}

module.exports = { initS3, getS3, uploadFile };
