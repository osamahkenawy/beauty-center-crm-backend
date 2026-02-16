import { S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

// ── S3 Configuration ──
const BUCKET = process.env.AWS_S3_BUCKET || 'trasealla-crm-uploads';
const REGION = process.env.AWS_REGION || 'us-east-1';

const s3Client = new S3Client({
  region: REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

console.log(`☁️  S3 storage configured (bucket: ${BUCKET}, region: ${REGION})`);

/**
 * Upload a file buffer to AWS S3
 */
export async function uploadToS3(buffer, key, contentType) {
  const command = new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    Body: buffer,
    ContentType: contentType,
  });
  await s3Client.send(command);
  const url = `https://${BUCKET}.s3.${REGION}.amazonaws.com/${key}`;
  console.log(`✅ Uploaded to S3: ${url}`);
  return { url, key };
}

/**
 * Delete a file from AWS S3
 */
export async function deleteFromS3(key) {
  const command = new DeleteObjectCommand({
    Bucket: BUCKET,
    Key: key,
  });
  await s3Client.send(command);
  console.log(`🗑️  Deleted from S3: ${key}`);
}

/**
 * Get a signed URL for temporary private access
 */
export async function getSignedDownloadUrl(key, expiresIn = 3600) {
  const command = new GetObjectCommand({
    Bucket: BUCKET,
    Key: key,
  });
  return getSignedUrl(s3Client, command, { expiresIn });
}

/**
 * Generate a unique S3 key for a file
 */
export function generateS3Key(tenantId, folder, originalName) {
  const ext = originalName.split('.').pop();
  const timestamp = Date.now();
  const random = Math.random().toString(36).substring(2, 8);
  return `tenants/${tenantId}/${folder}/${timestamp}-${random}.${ext}`;
}

export { s3Client, BUCKET };
