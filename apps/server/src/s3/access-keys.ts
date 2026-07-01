import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import Elysia, { t } from 'elysia';
import { auth } from '../auth/auth';
import { db } from '../db';
import { s3AccessKey } from '../db/schema';

const SALT = Buffer.from('bunnyfile-s3-access-keys-v1', 'utf8');
const INFO = Buffer.from('AES-256-GCM-key', 'utf8');

if (!Bun.env.BETTER_AUTH_SECRET) {
  console.warn(
    '[s3] BETTER_AUTH_SECRET is not set — S3 access-key secrets are encrypted with an insecure default. Set it before storing real keys, and note that changing it later invalidates all stored keys.',
  );
}

function deriveKey(): Buffer {
  const secret = Bun.env.BETTER_AUTH_SECRET ?? 'insecure-dev-secret';
  return Buffer.from(hkdfSync('sha256', secret, SALT, INFO, 32));
}

export function encryptSecret(plain: string): string {
  const key = deriveKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${Buffer.concat([encrypted, tag]).toString('hex')}`;
}

export function decryptSecret(stored: string): string {
  const key = deriveKey();
  const colonIdx = stored.indexOf(':');
  if (colonIdx < 0) throw new Error('invalid encrypted secret format');
  const iv = Buffer.from(stored.slice(0, colonIdx), 'hex');
  const data = Buffer.from(stored.slice(colonIdx + 1), 'hex');
  const tag = data.subarray(data.length - 16);
  const ciphertext = data.subarray(0, data.length - 16);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return decipher.update(ciphertext).toString('utf8') + decipher.final('utf8');
}

const CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

export function generateAccessKeyId(): string {
  const bytes = randomBytes(16);
  return `BFAK${Array.from(bytes)
    .map((b) => CHARS[b % CHARS.length])
    .join('')}`;
}

export function generateSecretAccessKey(): string {
  return randomBytes(32).toString('base64url');
}

export function lookupS3SecretKey(accessKeyId: string): string | null {
  const envKeyId = Bun.env.S3_ACCESS_KEY_ID;
  if (envKeyId && accessKeyId === envKeyId) {
    return Bun.env.S3_SECRET_ACCESS_KEY ?? null;
  }
  const row = db
    .select({ secretKeyEncrypted: s3AccessKey.secretKeyEncrypted })
    .from(s3AccessKey)
    .where(eq(s3AccessKey.accessKeyId, accessKeyId))
    .get();
  if (!row) return null;
  try {
    return decryptSecret(row.secretKeyEncrypted);
  } catch {
    return null;
  }
}

export const accessKeyRoutes = new Elysia({ name: 's3-access-keys' })
  .get('/api/settings/s3-keys', async ({ request, set }) => {
    const session = await auth.api.getSession({ headers: request.headers });
    if (!session?.user) {
      set.status = 401;
      return { error: 'Unauthorized' };
    }
    return db
      .select({
        id: s3AccessKey.id,
        accessKeyId: s3AccessKey.accessKeyId,
        name: s3AccessKey.name,
        createdAt: s3AccessKey.createdAt,
      })
      .from(s3AccessKey)
      .where(eq(s3AccessKey.userId, session.user.id))
      .all();
  })
  .post(
    '/api/settings/s3-keys',
    async ({ request, set, body }) => {
      const session = await auth.api.getSession({ headers: request.headers });
      if (!session?.user) {
        set.status = 401;
        return { error: 'Unauthorized' };
      }
      const id = crypto.randomUUID();
      const accessKeyId = generateAccessKeyId();
      const secretAccessKey = generateSecretAccessKey();
      await db.insert(s3AccessKey).values({
        id,
        userId: session.user.id,
        accessKeyId,
        secretKeyEncrypted: encryptSecret(secretAccessKey),
        name: body.name,
      });
      return { id, accessKeyId, secretAccessKey };
    },
    { body: t.Object({ name: t.String({ minLength: 1, maxLength: 100 }) }) },
  )
  .delete('/api/settings/s3-keys/:id', async ({ request, set, params }) => {
    const session = await auth.api.getSession({ headers: request.headers });
    if (!session?.user) {
      set.status = 401;
      return { error: 'Unauthorized' };
    }
    const condition =
      session.user.role === 'admin'
        ? eq(s3AccessKey.id, params.id)
        : and(eq(s3AccessKey.id, params.id), eq(s3AccessKey.userId, session.user.id));
    await db.delete(s3AccessKey).where(condition);
    set.status = 204;
    return null;
  });
