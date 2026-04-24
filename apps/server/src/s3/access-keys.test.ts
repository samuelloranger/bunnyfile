import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const testRoot = await mkdtemp(join(tmpdir(), 'bunnyfile-s3-keys-test-'));
process.env.DB_PATH = join(testRoot, 'test.sqlite');
process.env.DATA_DIR = join(testRoot, 'data');
process.env.BETTER_AUTH_SECRET = 'test-secret-for-encryption';
process.env.S3_ACCESS_KEY_ID = 'test-access-key';
process.env.S3_SECRET_ACCESS_KEY = 'test-secret';

mock.module('../auth/auth', () => ({
  auth: {
    api: {
      getSession: async () => ({
        user: { id: 'test-user-id', role: 'admin', email: 'test@example.com' },
      }),
    },
  },
}));

const [
  { runMigrations },
  { db },
  { user },
  { encryptSecret, decryptSecret, generateAccessKeyId, lookupS3SecretKey, accessKeyRoutes },
] = await Promise.all([
  import('../db/migrate'),
  import('../db'),
  import('../db/schema'),
  import('./access-keys'),
]);

import { Elysia } from 'elysia';

const app = new Elysia().use(accessKeyRoutes);

describe('access-keys crypto', () => {
  beforeAll(async () => {
    await mkdir(process.env.DATA_DIR!, { recursive: true });
    runMigrations();
    await db.insert(user).values({
      id: 'test-user-id',
      name: 'Test User',
      email: 'test@example.com',
      emailVerified: true,
      role: 'admin',
    });
  });

  it('encrypts and decrypts a secret round-trip', () => {
    const plain = 'super-secret-key-abc123';
    const encrypted = encryptSecret(plain);
    expect(encrypted).toContain(':');
    expect(encrypted).not.toContain(plain);
    expect(decryptSecret(encrypted)).toBe(plain);
  });

  it('generates unique access key IDs with BFAK prefix', () => {
    const id1 = generateAccessKeyId();
    const id2 = generateAccessKeyId();
    expect(id1).toMatch(/^BFAK[A-Za-z0-9]{16}$/);
    expect(id1).not.toBe(id2);
  });

  it('lookupS3SecretKey returns env secret for env key ID', () => {
    expect(lookupS3SecretKey('test-access-key')).toBe('test-secret');
  });

  it('lookupS3SecretKey returns null for unknown key ID', () => {
    expect(lookupS3SecretKey('unknown-key')).toBeNull();
  });
});

describe('access-keys HTTP routes', () => {
  it('POST /api/settings/s3-keys creates a key and returns secret once', async () => {
    const res = await app.handle(
      new Request('http://localhost/api/settings/s3-keys', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'my rclone key' }),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { accessKeyId: string; secretAccessKey: string };
    expect(body.accessKeyId).toMatch(/^BFAK/);
    expect(body.secretAccessKey).toBeTruthy();
    expect(body.secretAccessKey.length).toBeGreaterThan(20);
  });

  it('GET /api/settings/s3-keys lists keys without exposing secrets', async () => {
    const res = await app.handle(new Request('http://localhost/api/settings/s3-keys'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<Record<string, unknown>>;
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBeGreaterThan(0);
    expect(body[0]).not.toHaveProperty('secretAccessKey');
    expect(body[0]).not.toHaveProperty('secretKeyEncrypted');
  });

  it('lookupS3SecretKey finds a DB key after creation', async () => {
    const createRes = await app.handle(
      new Request('http://localhost/api/settings/s3-keys', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'lookup test key' }),
      }),
    );
    const { accessKeyId, secretAccessKey } = (await createRes.json()) as {
      accessKeyId: string;
      secretAccessKey: string;
    };
    expect(lookupS3SecretKey(accessKeyId)).toBe(secretAccessKey);
  });

  it('DELETE /api/settings/s3-keys/:id revokes a key', async () => {
    const createRes = await app.handle(
      new Request('http://localhost/api/settings/s3-keys', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'to delete' }),
      }),
    );
    const { id, accessKeyId } = (await createRes.json()) as { id: string; accessKeyId: string };
    const delRes = await app.handle(
      new Request(`http://localhost/api/settings/s3-keys/${id}`, { method: 'DELETE' }),
    );
    expect(delRes.status).toBe(204);
    expect(lookupS3SecretKey(accessKeyId)).toBeNull();
  });
});

afterAll(async () => {
  await rm(testRoot, { recursive: true, force: true });
});
