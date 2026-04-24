# S3 Phase 4 Remaining Features Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement multipart uploads, CopyObject, presigned GET/PUT URLs, per-user SQLite access keys with encrypted secrets, and a settings UI — completing Phase 4 so rclone/kopia/restic can use BunnyFile as an S3 target.

**Architecture:** Multipart logic lives in `s3/multipart.ts`; access key CRUD and encryption in `s3/access-keys.ts`; `sigv4.ts` gains a `verifyPresigned` export and switches from a static config struct to a `lookupKey` callback so both env-var keys and SQLite keys work. `routes.ts` dispatches to these modules and gains CopyObject inline.

**Tech Stack:** Bun, Elysia, drizzle-orm/bun-sqlite, TanStack Query, Tailwind v4. Tests use `bun:test` with `mock.module` for auth.

---

## File Map

| Action | Path | Responsibility |
|---|---|---|
| Create | `apps/server/src/s3/multipart.ts` | All 5 multipart S3 operations |
| Create | `apps/server/src/s3/multipart.test.ts` | Multipart integration tests |
| Create | `apps/server/src/s3/access-keys.ts` | AES-GCM crypto, key lookup, Elysia CRUD routes |
| Create | `apps/server/src/s3/access-keys.test.ts` | Crypto round-trip + HTTP CRUD tests |
| Create | `apps/server/src/db/migrations/0005_s3_multipart_and_access_keys.sql` | Migration DDL |
| Create | `apps/web/src/routes/_app.settings.tsx` | Settings page — S3 access keys UI |
| Modify | `apps/server/src/db/schema.ts` | Add s3MultipartUpload, s3MultipartPart, s3AccessKey |
| Modify | `apps/server/src/db/migrations/meta/_journal.json` | Register migration 0005 |
| Modify | `apps/server/src/s3/sigv4.ts` | lookupKey callback + verifyPresigned export |
| Modify | `apps/server/src/s3/routes.ts` | Presigned dispatch, multipart dispatch, CopyObject, updated s3Config |
| Modify | `apps/server/src/s3/routes.test.ts` | CopyObject test + presigned GET/PUT tests |
| Modify | `apps/server/src/index.ts` | Register accessKeyRoutes |

---

## Task 1: DB Schema — three new tables

**Files:**
- Modify: `apps/server/src/db/schema.ts`
- Create: `apps/server/src/db/migrations/0005_s3_multipart_and_access_keys.sql`
- Modify: `apps/server/src/db/migrations/meta/_journal.json`

- [ ] **Step 1: Add `primaryKey` to the drizzle sqlite-core import in schema.ts**

Current first line of `apps/server/src/db/schema.ts`:
```typescript
import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
```
Change to:
```typescript
import { index, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';
```

- [ ] **Step 2: Append three tables at the end of schema.ts (after `ShareLinkRow` and `S3ObjectRow` exports)**

```typescript
export const s3MultipartUpload = sqliteTable(
  's3_multipart_upload',
  {
    uploadId: text('upload_id').primaryKey(),
    bucket: text('bucket').notNull(),
    key: text('key').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
  },
  (t) => [index('s3_mpu_bucket_key_idx').on(t.bucket, t.key)],
);

export const s3MultipartPart = sqliteTable(
  's3_multipart_part',
  {
    uploadId: text('upload_id')
      .notNull()
      .references(() => s3MultipartUpload.uploadId, { onDelete: 'cascade' }),
    partNumber: integer('part_number').notNull(),
    size: integer('size').notNull(),
    md5: text('md5').notNull(),
    path: text('path').notNull(),
  },
  (t) => [primaryKey({ columns: [t.uploadId, t.partNumber] })],
);

export const s3AccessKey = sqliteTable(
  's3_access_key',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    accessKeyId: text('access_key_id').notNull().unique(),
    secretKeyEncrypted: text('secret_key_encrypted').notNull(),
    name: text('name').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
  },
  (t) => [
    index('s3_access_key_user_id_idx').on(t.userId),
    index('s3_access_key_access_key_id_idx').on(t.accessKeyId),
  ],
);

export type S3MultipartUploadRow = typeof s3MultipartUpload.$inferSelect;
export type S3MultipartPartRow = typeof s3MultipartPart.$inferSelect;
export type S3AccessKeyRow = typeof s3AccessKey.$inferSelect;
```

- [ ] **Step 3: Create migration SQL**

`apps/server/src/db/migrations/0005_s3_multipart_and_access_keys.sql`:
```sql
CREATE TABLE `s3_multipart_upload` (
	`upload_id` text PRIMARY KEY NOT NULL,
	`bucket` text NOT NULL,
	`key` text NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `s3_mpu_bucket_key_idx` ON `s3_multipart_upload` (`bucket`, `key`);
--> statement-breakpoint
CREATE TABLE `s3_multipart_part` (
	`upload_id` text NOT NULL,
	`part_number` integer NOT NULL,
	`size` integer NOT NULL,
	`md5` text NOT NULL,
	`path` text NOT NULL,
	PRIMARY KEY(`upload_id`, `part_number`),
	FOREIGN KEY (`upload_id`) REFERENCES `s3_multipart_upload`(`upload_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `s3_access_key` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`access_key_id` text NOT NULL UNIQUE,
	`secret_key_encrypted` text NOT NULL,
	`name` text NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `s3_access_key_user_id_idx` ON `s3_access_key` (`user_id`);
--> statement-breakpoint
CREATE INDEX `s3_access_key_access_key_id_idx` ON `s3_access_key` (`access_key_id`);
```

- [ ] **Step 4: Add migration 0005 to `_journal.json`**

Append inside the `entries` array (after the 0004 entry):
```json
    ,{
      "idx": 5,
      "version": "6",
      "when": 1776967200000,
      "tag": "0005_s3_multipart_and_access_keys",
      "breakpoints": true
    }
```

- [ ] **Step 5: Verify typecheck passes**

Run: `bun run typecheck`
Expected: `@bunnyfile/server typecheck: Exited with code 0`

- [ ] **Step 6: Commit**
```bash
git add apps/server/src/db/schema.ts \
        apps/server/src/db/migrations/0005_s3_multipart_and_access_keys.sql \
        apps/server/src/db/migrations/meta/_journal.json
git commit -m "feat: add s3 multipart, access key DB tables (migration 0005)"
```

---

## Task 2: sigv4.ts — lookupKey callback + verifyPresigned

**Files:**
- Modify: `apps/server/src/s3/sigv4.ts`

- [ ] **Step 1: Replace `SigV4Config` type**

Find and replace:
```typescript
type SigV4Config = {
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  service: string;
};
```
With:
```typescript
export type SigV4Config = {
  region: string;
  service: string;
  lookupKey: (accessKeyId: string) => string | null;
};
```

- [ ] **Step 2: Update `verifySigV4` to use `lookupKey`**

Find inside `verifySigV4`:
```typescript
  if (parsed.accessKeyId !== config.accessKeyId) {
    return asErr('InvalidAccessKeyId', 'Unknown access key');
  }
```
Replace with:
```typescript
  const secretAccessKey = config.lookupKey(parsed.accessKeyId);
  if (secretAccessKey === null) {
    return asErr('InvalidAccessKeyId', 'Unknown access key');
  }
```

Then find the signing key derivation inside `verifySigV4`:
```typescript
  const signingKey = deriveSigningKey(
    config.secretAccessKey,
    dateStamp,
    config.region,
    config.service,
  );
```
Replace with:
```typescript
  const signingKey = deriveSigningKey(
    secretAccessKey,
    dateStamp,
    config.region,
    config.service,
  );
```

- [ ] **Step 3: Add `verifyPresigned` export at the end of sigv4.ts**

```typescript
export async function verifyPresigned(
  request: Request,
  config: SigV4Config,
): Promise<SigV4Result> {
  const url = new URL(request.url);

  const algorithm = url.searchParams.get('X-Amz-Algorithm');
  if (algorithm !== 'AWS4-HMAC-SHA256') {
    return asErr('AuthorizationQueryParametersError', 'Unsupported algorithm');
  }

  const credential = url.searchParams.get('X-Amz-Credential');
  const amzDate = url.searchParams.get('X-Amz-Date');
  const expiresStr = url.searchParams.get('X-Amz-Expires');
  const signedHeadersParam = url.searchParams.get('X-Amz-SignedHeaders');
  const signature = url.searchParams.get('X-Amz-Signature');

  if (!credential || !amzDate || !expiresStr || !signedHeadersParam || !signature) {
    return asErr('AuthorizationQueryParametersError', 'Missing presigned URL parameter');
  }
  if (amzDate.length !== 16 || amzDate[8] !== 'T' || !amzDate.endsWith('Z')) {
    return asErr('AccessDenied', 'Invalid X-Amz-Date');
  }

  const expiresSeconds = Number.parseInt(expiresStr, 10);
  if (Number.isNaN(expiresSeconds) || expiresSeconds < 1 || expiresSeconds > 604800) {
    return asErr('AuthorizationQueryParametersError', 'X-Amz-Expires must be 1–604800');
  }

  const requestTime = new Date(
    `${amzDate.slice(0, 4)}-${amzDate.slice(4, 6)}-${amzDate.slice(6, 8)}T` +
      `${amzDate.slice(9, 11)}:${amzDate.slice(11, 13)}:${amzDate.slice(13, 15)}Z`,
  ).getTime();
  if (Number.isNaN(requestTime)) {
    return asErr('AccessDenied', 'Unparseable X-Amz-Date');
  }
  const now = Date.now();
  // Allow 5-minute future skew; reject if past expiry.
  if (now < requestTime - 5 * 60 * 1000) {
    return asErr('RequestTimeTooSkewed', 'Request timestamp is too far in the future');
  }
  if (now > requestTime + expiresSeconds * 1000) {
    return asErr('ExpiredToken', 'Presigned URL has expired');
  }

  const slash = credential.indexOf('/');
  if (slash <= 0) {
    return asErr('AuthorizationQueryParametersError', 'Invalid X-Amz-Credential');
  }
  const accessKeyId = credential.slice(0, slash);
  const scope = credential.slice(slash + 1);
  const dateStamp = amzDate.slice(0, 8);
  const expectedScope = `${dateStamp}/${config.region}/${config.service}/aws4_request`;
  if (scope !== expectedScope) {
    return asErr('AuthorizationQueryParametersError', 'Credential scope mismatch');
  }

  const secretAccessKey = config.lookupKey(accessKeyId);
  if (secretAccessKey === null) {
    return asErr('InvalidAccessKeyId', 'Unknown access key');
  }

  const signedHeaderNames = signedHeadersParam.split(';').filter(Boolean).sort();
  const canonicalHeaders = signedHeaderNames
    .map((name) => {
      const value = request.headers.get(name);
      return `${name}:${(value ?? '').trim().replace(/\s+/g, ' ')}`;
    })
    .join('\n');

  // Canonical query excludes X-Amz-Signature.
  const filteredParams = new URL(request.url).searchParams;
  filteredParams.delete('X-Amz-Signature');
  const pairs: Array<[string, string]> = [];
  for (const [k, v] of filteredParams.entries()) {
    pairs.push([encodeURIComponent(k), encodeURIComponent(v)]);
  }
  pairs.sort((a, b) => (a[0] === b[0] ? a[1].localeCompare(b[1]) : a[0].localeCompare(b[0])));
  const canonicalQueryStr = pairs.map(([k, v]) => `${k}=${v}`).join('&');

  const canonicalRequest = [
    request.method.toUpperCase(),
    canonicalUri(url.pathname),
    canonicalQueryStr,
    `${canonicalHeaders}\n`,
    signedHeaderNames.join(';'),
    'UNSIGNED-PAYLOAD',
  ].join('\n');

  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    expectedScope,
    sha256Hex(canonicalRequest),
  ].join('\n');

  const signingKey = deriveSigningKey(secretAccessKey, dateStamp, config.region, config.service);
  const expectedSignature = createHmac('sha256', signingKey).update(stringToSign).digest('hex');
  const left = Buffer.from(expectedSignature, 'utf8');
  const right = Buffer.from(signature, 'utf8');
  if (left.length !== right.length || !timingSafeEqual(left, right)) {
    return asErr('SignatureDoesNotMatch', 'Signature mismatch');
  }

  return { ok: true, accessKeyId, scope, signedHeaders: signedHeaderNames };
}
```

- [ ] **Step 4: Run existing S3 tests to confirm the refactor hasn't broken anything**

Run: `bun test apps/server/src/s3/routes.test.ts`

This will fail because `routes.ts` still passes the old `SigV4Config` shape to `verifySigV4`. That's expected — routes.ts is fixed in Task 5. For now, just confirm the TypeScript diagnostics come only from `routes.ts`, not from `sigv4.ts` itself.

Run: `cd apps/server && bun run tsc --noEmit 2>&1 | grep sigv4`
Expected: no output (no errors in sigv4.ts).

- [ ] **Step 5: Commit**
```bash
git add apps/server/src/s3/sigv4.ts
git commit -m "feat: sigv4 lookupKey callback + verifyPresigned export"
```

---

## Task 3: access-keys.ts — crypto helpers, key lookup, Elysia routes

**Files:**
- Create: `apps/server/src/s3/access-keys.ts`
- Create: `apps/server/src/s3/access-keys.test.ts`

- [ ] **Step 1: Write failing tests for crypto helpers**

Create `apps/server/src/s3/access-keys.test.ts`:
```typescript
import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
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

const [{ runMigrations }, { db }, { user, s3AccessKey }, { encryptSecret, decryptSecret, generateAccessKeyId, generateSecretAccessKey, lookupS3SecretKey, accessKeyRoutes }] =
  await Promise.all([
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
    const body = await res.json();
    expect(body.accessKeyId).toMatch(/^BFAK/);
    expect(body.secretAccessKey).toBeTruthy();
    expect(body.secretAccessKey.length).toBeGreaterThan(20);
  });

  it('GET /api/settings/s3-keys lists keys without exposing secrets', async () => {
    const res = await app.handle(
      new Request('http://localhost/api/settings/s3-keys'),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
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
    const { accessKeyId, secretAccessKey } = await createRes.json();
    // lookupS3SecretKey must return the original secret after decryption.
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
    const { id, accessKeyId } = await createRes.json();
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
```

- [ ] **Step 2: Run to confirm tests fail**

Run: `bun test apps/server/src/s3/access-keys.test.ts`
Expected: fails with `Cannot find module './access-keys'`.

- [ ] **Step 3: Create `apps/server/src/s3/access-keys.ts`**

```typescript
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import Elysia, { t } from 'elysia';
import { auth } from '../auth/auth';
import { db } from '../db';
import { s3AccessKey } from '../db/schema';

const SALT = Buffer.from('bunnyfile-s3-access-keys-v1', 'utf8');
const INFO = Buffer.from('AES-256-GCM-key', 'utf8');

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

/** Used by routes.ts to resolve a key for SigV4 verification. */
export function lookupS3SecretKey(accessKeyId: string): string | null {
  const envKeyId = Bun.env.S3_ACCESS_KEY_ID ?? 'dev-access-key';
  if (accessKeyId === envKeyId) {
    return Bun.env.S3_SECRET_ACCESS_KEY ?? 'dev-secret-key';
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
```

- [ ] **Step 4: Run tests — expect pass**

Run: `bun test apps/server/src/s3/access-keys.test.ts`
Expected: all tests pass.

- [ ] **Step 5: Commit**
```bash
git add apps/server/src/s3/access-keys.ts apps/server/src/s3/access-keys.test.ts
git commit -m "feat: s3 access key crypto helpers, lookup, and CRUD routes"
```

---

## Task 4: routes.ts — update s3Config, presigned dispatch

**Files:**
- Modify: `apps/server/src/s3/routes.ts`

- [ ] **Step 1: Replace imports and s3Config**

Add to imports at top of `routes.ts`:
```typescript
import { lookupS3SecretKey } from './access-keys';
import { verifyPresigned } from './sigv4';
```

Replace the import of `verifySigV4`:
```typescript
import { verifySigV4 } from './sigv4';
```
With:
```typescript
import { verifySigV4, verifyPresigned } from './sigv4';
```

Replace `s3Config()` function:
```typescript
function s3Config() {
  return {
    region: Bun.env.S3_REGION ?? 'us-east-1',
    service: 's3',
    lookupKey: lookupS3SecretKey,
  };
}
```

- [ ] **Step 2: Add presigned dispatch at the top of the handler body**

Inside `createS3Handler`, replace:
```typescript
    const verification = await verifySigV4(request, s3Config());
```
With:
```typescript
    const isPresigned = url.searchParams.has('X-Amz-Signature');
    const verification = isPresigned
      ? await verifyPresigned(request, s3Config())
      : await verifySigV4(request, s3Config());
```

Note: `url` is already declared later in the handler. Move the `const url = new URL(request.url);` line to BEFORE the verification call (it was previously declared after). Find:
```typescript
    const url = new URL(request.url);
    const pathname = url.pathname;
```
And move it to before the `isPresigned` check, so the full top of the handler body is:
```typescript
    const url = new URL(request.url);
    const pathname = url.pathname;
    const isPresigned = url.searchParams.has('X-Amz-Signature');
    const verification = isPresigned
      ? await verifyPresigned(request, s3Config())
      : await verifySigV4(request, s3Config());
    if (!verification.ok) {
      return s3Err(
        set,
        verification.code === 'SignatureDoesNotMatch' ? 403 : 400,
        verification.code,
        verification.message,
        pathname,
      );
    }
```

- [ ] **Step 3: Run existing tests to confirm nothing regressed**

Run: `bun test apps/server/src/s3/routes.test.ts`
Expected: 5 pass, 0 fail.

- [ ] **Step 4: Commit**
```bash
git add apps/server/src/s3/routes.ts
git commit -m "feat: wire presigned URL dispatch + access key lookup into S3 routes"
```

---

## Task 5: routes.test.ts — presigned URL tests

**Files:**
- Modify: `apps/server/src/s3/routes.test.ts`

- [ ] **Step 1: Add presigned URL helper and tests**

In `routes.test.ts`, add this helper function after `signedRequest`:

```typescript
/** Builds a presigned URL for GET or PUT. Expiry is 3600 seconds from now. */
function presignedUrl({
  method,
  path,
  expiresSeconds = 3600,
}: {
  method: string;
  path: string;
  expiresSeconds?: number;
}): string {
  const host = 'localhost';
  const now = new Date();
  const amzDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const dateStamp = amzDate.slice(0, 8);
  const region = process.env.S3_REGION!;
  const service = 's3';
  const accessKeyId = process.env.S3_ACCESS_KEY_ID!;
  const scope = `${dateStamp}/${region}/${service}/aws4_request`;
  const credential = `${accessKeyId}/${scope}`;
  const signedHeaders = 'host';

  const url = new URL(`http://${host}${path}`);
  url.searchParams.set('X-Amz-Algorithm', 'AWS4-HMAC-SHA256');
  url.searchParams.set('X-Amz-Credential', credential);
  url.searchParams.set('X-Amz-Date', amzDate);
  url.searchParams.set('X-Amz-Expires', String(expiresSeconds));
  url.searchParams.set('X-Amz-SignedHeaders', signedHeaders);

  // Build canonical request without X-Amz-Signature
  const pairs = [...url.searchParams.entries()]
    .map(([k, v]) => [encodeURIComponent(k), encodeURIComponent(v)] as [string, string])
    .sort((a, b) => (a[0] === b[0] ? a[1].localeCompare(b[1]) : a[0].localeCompare(b[0])));
  const canonicalQuery = pairs.map(([k, v]) => `${k}=${v}`).join('&');
  const canonicalHeaders = `host:${host}\n`;
  const canonicalRequest = [
    method,
    canonicalUriPath(url.pathname),
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    'UNSIGNED-PAYLOAD',
  ].join('\n');
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonicalRequest)].join('\n');
  const signingKey = deriveSigningKey(process.env.S3_SECRET_ACCESS_KEY!, dateStamp, region, service);
  const signature = createHmac('sha256', signingKey).update(stringToSign).digest('hex');
  url.searchParams.set('X-Amz-Signature', signature);

  return url.toString().replace(`http://${host}`, '');
}
```

Then add a new `describe` block at the end of the file, before `afterAll`:
```typescript
describe('presigned URLs', () => {
  const presignBucket = `presign-bucket-${crypto.randomUUID().slice(0, 8)}`;

  beforeAll(async () => {
    await app.handle(signedRequest({ method: 'PUT', path: `/api/s3/${presignBucket}` }));
    await app.handle(
      signedRequest({
        method: 'PUT',
        path: `/api/s3/${presignBucket}/hello.txt`,
        body: 'hello presigned',
      }),
    );
  });

  it('presigned GET downloads an object without Authorization header', async () => {
    const path = presignedUrl({ method: 'GET', path: `/api/s3/${presignBucket}/hello.txt` });
    const res = await app.handle(new Request(`http://localhost${path}`, { method: 'GET', headers: { host: 'localhost' } }));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('hello presigned');
  });

  it('presigned PUT uploads an object without Authorization header', async () => {
    const path = presignedUrl({ method: 'PUT', path: `/api/s3/${presignBucket}/uploaded.txt` });
    const putRes = await app.handle(
      new Request(`http://localhost${path}`, {
        method: 'PUT',
        headers: { host: 'localhost' },
        body: 'uploaded via presigned',
      }),
    );
    expect(putRes.status).toBe(200);
    const getRes = await app.handle(
      signedRequest({ method: 'GET', path: `/api/s3/${presignBucket}/uploaded.txt` }),
    );
    expect(await getRes.text()).toBe('uploaded via presigned');
  });

  it('expired presigned URL returns 400', async () => {
    const path = presignedUrl({
      method: 'GET',
      path: `/api/s3/${presignBucket}/hello.txt`,
      expiresSeconds: -1,
    });
    const res = await app.handle(new Request(`http://localhost${path}`, { method: 'GET', headers: { host: 'localhost' } }));
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('ExpiredToken');
  });
});
```

- [ ] **Step 2: Run tests**

Run: `bun test apps/server/src/s3/routes.test.ts`
Expected: all tests pass including the 3 new presigned tests.

- [ ] **Step 3: Commit**
```bash
git add apps/server/src/s3/routes.test.ts
git commit -m "test: presigned GET and PUT URL verification"
```

---

## Task 6: routes.ts — CopyObject

**Files:**
- Modify: `apps/server/src/s3/routes.ts`

- [ ] **Step 1: Add `copyFile` to the `node:fs/promises` import**

Find: `import { mkdir, readdir, rm, stat } from 'node:fs/promises';`
Replace with: `import { copyFile, mkdir, readdir, rm, stat } from 'node:fs/promises';`

- [ ] **Step 2: Add `createHash` import and `hashOnDisk` import from store**

Find: `import { openStream, readRange, removeFile, writeUpload } from '../files/store';`
Replace with: `import { DATA_ROOT, hashOnDisk, openStream, readRange, removeFile, writeUpload } from '../files/store';`

Add to imports: `import { createHash } from 'node:crypto';` (at top of file with other node imports).

- [ ] **Step 3: Add `rename` to the `node:fs/promises` import**

Find: `import { copyFile, mkdir, readdir, rm, stat } from 'node:fs/promises';`
Replace with: `import { copyFile, mkdir, readdir, rename, rm, stat } from 'node:fs/promises';`

- [ ] **Step 4: Add CopyObject handler inside `createS3Handler`, within the `if (request.method === 'PUT')` block for objects**

Find the object PUT handler:
```typescript
    const rel = objectRel(bucket, key);
    if (request.method === 'PUT') {
      let result: { size: number; sha256: string; md5: string; mtimeMs: number; inode: number };
      try {
        await mkdir(resolve(S3_ROOT, bucket), { recursive: true });
        result = await writeUpload(
```

Insert BEFORE the `let result` line:
```typescript
      const copySource = request.headers.get('x-amz-copy-source');
      if (copySource) {
        // CopyObject: x-amz-copy-source is /srcBucket/srcKey (URL-encoded)
        const decoded = decodePathPart(copySource.startsWith('/') ? copySource.slice(1) : copySource);
        if (!decoded) return s3Err(set, 400, 'InvalidArgument', 'Invalid x-amz-copy-source', pathname);
        const slashIdx = decoded.indexOf('/');
        if (slashIdx <= 0) return s3Err(set, 400, 'InvalidArgument', 'x-amz-copy-source must be /bucket/key', pathname);
        const srcBucket = decoded.slice(0, slashIdx);
        const srcKey = decoded.slice(slashIdx + 1);
        if (!validateBucket(srcBucket) || !srcKey) {
          return s3Err(set, 400, 'InvalidArgument', 'Invalid copy source', pathname);
        }
        if (srcKey.includes('\0') || srcKey.split('/').some((s) => s === '..' || s === '.')) {
          return s3Err(set, 400, 'InvalidArgument', 'Invalid copy source key', pathname);
        }
        const srcRel = objectRel(srcBucket, srcKey);
        let srcStat: Awaited<ReturnType<typeof stat>>;
        try {
          const opened = await openStream(srcRel);
          srcStat = opened.stat;
        } catch {
          return s3Err(set, 404, 'NoSuchKey', 'Copy source not found', pathname);
        }
        // Reuse stored MD5 if available; else compute from disk.
        const srcDbRow = db
          .select({ md5: s3Object.md5 })
          .from(s3Object)
          .where(eq(s3Object.path, srcRel))
          .get();
        const srcMd5 = srcDbRow?.md5 ?? (await hashOnDisk(srcRel, 'md5'));
        const srcAbs = resolve(DATA_ROOT, srcRel);
        const destAbs = resolve(DATA_ROOT, rel);
        await mkdir(dirname(destAbs), { recursive: true });
        const tmp = `${destAbs}.tmp-${crypto.randomUUID().slice(0, 8)}`;
        await copyFile(srcAbs, tmp);
        await rename(tmp, destAbs);
        const destStat = await stat(destAbs);
        await db
          .insert(s3Object)
          .values({
            path: rel,
            bucket,
            key,
            size: destStat.size,
            mtimeMs: Math.round(destStat.mtimeMs),
            inode: Number(destStat.ino),
            md5: srcMd5,
          })
          .onConflictDoUpdate({
            target: s3Object.path,
            set: {
              size: destStat.size,
              mtimeMs: Math.round(destStat.mtimeMs),
              inode: Number(destStat.ino),
              md5: srcMd5,
            },
          });
        const lastModified = new Date(destStat.mtimeMs).toISOString();
        return xmlResponse(
          xmlDocument({
            name: 'CopyObjectResult',
            attributes: { xmlns: S3_XMLNS },
            children: [
              { name: 'ETag', value: `"${srcMd5}"` },
              { name: 'LastModified', value: lastModified },
            ],
          }),
        );
      }
```

- [ ] **Step 5: Fix `hashOnDisk` — it only accepts `sha256` currently; add md5 support**

Open `apps/server/src/files/store.ts`.

Find:
```typescript
export async function hashOnDisk(rel: string): Promise<string> {
  const path = absFromRelOrThrow(rel);
  const node = createReadStream(path);
  const h = createHash('sha256');
  for await (const chunk of node) {
    h.update(chunk);
  }
  return h.digest('hex');
}
```

Replace with:
```typescript
export async function hashOnDisk(rel: string, algorithm: 'sha256' | 'md5' = 'sha256'): Promise<string> {
  const path = absFromRelOrThrow(rel);
  const node = createReadStream(path);
  const h = createHash(algorithm);
  for await (const chunk of node) {
    h.update(chunk);
  }
  return h.digest('hex');
}
```

- [ ] **Step 6: Add CopyObject test to `routes.test.ts`**

Append inside the existing `describe('s3 routes', ...)` block:
```typescript
  it('CopyObject copies an object server-side', async () => {
    const bucket = `copy-bucket-${crypto.randomUUID().slice(0, 8)}`;
    await app.handle(signedRequest({ method: 'PUT', path: `/api/s3/${bucket}` }));
    await app.handle(
      signedRequest({ method: 'PUT', path: `/api/s3/${bucket}/original.txt`, body: 'original content' }),
    );

    // Copy to a new key in the same bucket.
    const copyReq = signedRequest({ method: 'PUT', path: `/api/s3/${bucket}/copy.txt` });
    const copyReqWithHeader = new Request(copyReq.url, {
      method: 'PUT',
      headers: new Headers([
        ...copyReq.headers.entries(),
        ['x-amz-copy-source', `/${bucket}/original.txt`],
      ]),
    });
    const copyRes = await app.handle(copyReqWithHeader);
    expect(copyRes.status).toBe(200);
    const copyXml = await copyRes.text();
    expect(copyXml).toContain('<CopyObjectResult');
    expect(copyXml).toContain('<ETag>');

    const getRes = await app.handle(
      signedRequest({ method: 'GET', path: `/api/s3/${bucket}/copy.txt` }),
    );
    expect(getRes.status).toBe(200);
    expect(await getRes.text()).toBe('original content');

    // Cleanup
    for (const key of ['original.txt', 'copy.txt']) {
      await app.handle(signedRequest({ method: 'DELETE', path: `/api/s3/${bucket}/${key}` }));
    }
    await app.handle(signedRequest({ method: 'DELETE', path: `/api/s3/${bucket}` }));
  });
```

- [ ] **Step 7: Run tests**

Run: `bun test apps/server/src/s3/routes.test.ts`
Expected: all tests pass.

- [ ] **Step 8: Commit**
```bash
git add apps/server/src/s3/routes.ts apps/server/src/s3/routes.test.ts \
        apps/server/src/files/store.ts
git commit -m "feat: CopyObject server-side copy with MD5 preservation"
```

---

## Task 7: multipart.ts — CreateMultipartUpload + UploadPart

**Files:**
- Create: `apps/server/src/s3/multipart.ts`
- Create: `apps/server/src/s3/multipart.test.ts`

- [ ] **Step 1: Write failing multipart tests**

Create `apps/server/src/s3/multipart.test.ts`:
```typescript
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, createHmac } from 'node:crypto';

const testRoot = await mkdtemp(join(tmpdir(), 'bunnyfile-s3-mpu-test-'));
process.env.DB_PATH = join(testRoot, 'test.sqlite');
process.env.DATA_DIR = join(testRoot, 'data');
process.env.S3_ACCESS_KEY_ID = 'mpu-access-key';
process.env.S3_SECRET_ACCESS_KEY = 'mpu-secret-key';
process.env.S3_REGION = 'us-east-1';

const [{ app }, { runMigrations }] = await Promise.all([
  import('../index'),
  import('../db/migrate'),
]);

// ── helpers (same as routes.test.ts) ──────────────────────────────────────────

function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}
function hmac(key: string | Buffer, data: string): Buffer {
  return createHmac('sha256', key).update(data).digest();
}
function deriveSigningKey(secret: string, date: string, region: string, service: string): Buffer {
  return hmac(hmac(hmac(hmac(`AWS4${secret}`, date), region), service), 'aws4_request');
}
function canonicalUriPath(pathname: string): string {
  return (
    pathname.split('/').map((seg) =>
      encodeURIComponent(seg).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`),
    ).join('/') || '/'
  );
}

function signedRequest({ method, path, body }: { method: string; path: string; body?: string | Uint8Array }): Request {
  const host = 'localhost';
  const now = new Date();
  const amzDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const dateStamp = amzDate.slice(0, 8);
  const region = process.env.S3_REGION!;
  const payloadHash = 'UNSIGNED-PAYLOAD';
  const url = new URL(`http://${host}${path}`);
  const pairs = [...url.searchParams.entries()]
    .map(([k, v]) => [encodeURIComponent(k), encodeURIComponent(v)] as [string, string])
    .sort((a, b) => (a[0] === b[0] ? a[1].localeCompare(b[1]) : a[0].localeCompare(b[0])));
  const canonicalQuery = pairs.map(([k, v]) => `${k}=${v}`).join('&');
  const canonicalHeaders = `host:${host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`;
  const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';
  const canonicalRequest = [method, canonicalUriPath(url.pathname), canonicalQuery, canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const scope = `${dateStamp}/${region}/s3/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonicalRequest)].join('\n');
  const signingKey = deriveSigningKey(process.env.S3_SECRET_ACCESS_KEY!, dateStamp, region, 's3');
  const signature = createHmac('sha256', signingKey).update(stringToSign).digest('hex');
  const authorization = `AWS4-HMAC-SHA256 Credential=${process.env.S3_ACCESS_KEY_ID!}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return new Request(`http://${host}${path}`, {
    method,
    body,
    headers: { authorization, host, 'x-amz-date': amzDate, 'x-amz-content-sha256': payloadHash },
  });
}

// ── tests ─────────────────────────────────────────────────────────────────────

const mpuBucket = `mpu-bucket-${crypto.randomUUID().slice(0, 8)}`;

describe('multipart uploads', () => {
  beforeAll(async () => {
    await mkdir(process.env.DATA_DIR!, { recursive: true });
    runMigrations();
    await app.handle(signedRequest({ method: 'PUT', path: `/api/s3/${mpuBucket}` }));
  });

  it('CreateMultipartUpload returns UploadId', async () => {
    const res = await app.handle(
      signedRequest({ method: 'POST', path: `/api/s3/${mpuBucket}/file.bin?uploads` }),
    );
    expect(res.status).toBe(200);
    const xml = await res.text();
    expect(xml).toContain('<InitiateMultipartUploadResult');
    expect(xml).toContain('<UploadId>');
  });

  it('full lifecycle: initiate → 3 parts → complete → download', async () => {
    // 1. Initiate
    const initRes = await app.handle(
      signedRequest({ method: 'POST', path: `/api/s3/${mpuBucket}/multi.txt?uploads` }),
    );
    const initXml = await initRes.text();
    const uploadId = initXml.match(/<UploadId>([^<]+)<\/UploadId>/)![1]!;

    // 2. Upload 3 parts (each ~6 bytes to keep test small)
    const parts = ['hello ', 'world', '!'];
    const etags: string[] = [];
    for (let i = 0; i < parts.length; i++) {
      const partRes = await app.handle(
        signedRequest({
          method: 'PUT',
          path: `/api/s3/${mpuBucket}/multi.txt?partNumber=${i + 1}&uploadId=${uploadId}`,
          body: parts[i],
        }),
      );
      expect(partRes.status).toBe(200);
      const etag = partRes.headers.get('etag');
      expect(etag).toMatch(/^"[0-9a-f]{32}"$/);
      etags.push(etag!);
    }

    // 3. ListParts
    const listRes = await app.handle(
      signedRequest({ method: 'GET', path: `/api/s3/${mpuBucket}/multi.txt?uploadId=${uploadId}` }),
    );
    expect(listRes.status).toBe(200);
    expect(await listRes.text()).toContain('<ListPartsResult');

    // 4. Complete
    const completeBody = `<CompleteMultipartUpload>${parts
      .map((_, i) => `<Part><PartNumber>${i + 1}</PartNumber><ETag>${etags[i]}</ETag></Part>`)
      .join('')}</CompleteMultipartUpload>`;
    const completeRes = await app.handle(
      signedRequest({
        method: 'POST',
        path: `/api/s3/${mpuBucket}/multi.txt?uploadId=${uploadId}`,
        body: completeBody,
      }),
    );
    expect(completeRes.status).toBe(200);
    const completeXml = await completeRes.text();
    expect(completeXml).toContain('<CompleteMultipartUploadResult');
    // Multipart ETag ends with -3 (three parts)
    expect(completeXml).toMatch(/-3"/);

    // 5. Download and verify content
    const getRes = await app.handle(
      signedRequest({ method: 'GET', path: `/api/s3/${mpuBucket}/multi.txt` }),
    );
    expect(getRes.status).toBe(200);
    expect(await getRes.text()).toBe('hello world!');
  });

  it('AbortMultipartUpload cleans up temp parts', async () => {
    const initRes = await app.handle(
      signedRequest({ method: 'POST', path: `/api/s3/${mpuBucket}/aborted.bin?uploads` }),
    );
    const uploadId = (await initRes.text()).match(/<UploadId>([^<]+)<\/UploadId>/)![1]!;
    await app.handle(
      signedRequest({ method: 'PUT', path: `/api/s3/${mpuBucket}/aborted.bin?partNumber=1&uploadId=${uploadId}`, body: 'data' }),
    );
    const abortRes = await app.handle(
      signedRequest({ method: 'DELETE', path: `/api/s3/${mpuBucket}/aborted.bin?uploadId=${uploadId}` }),
    );
    expect(abortRes.status).toBe(204);
    // After abort, CompleteMultipartUpload should fail with NoSuchUpload.
    const completeRes = await app.handle(
      signedRequest({
        method: 'POST',
        path: `/api/s3/${mpuBucket}/aborted.bin?uploadId=${uploadId}`,
        body: '<CompleteMultipartUpload><Part><PartNumber>1</PartNumber><ETag>"abc"</ETag></Part></CompleteMultipartUpload>',
      }),
    );
    expect(completeRes.status).toBe(404);
  });
});

afterAll(async () => {
  await rm(testRoot, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run to confirm tests fail**

Run: `bun test apps/server/src/s3/multipart.test.ts`
Expected: fails because multipart.ts doesn't exist yet.

- [ ] **Step 3: Create `apps/server/src/s3/multipart.ts`**

```typescript
import { createHash } from 'node:crypto';
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { and, eq } from 'drizzle-orm';
import { db } from '../db';
import { s3MultipartPart, s3MultipartUpload, s3Object } from '../db/schema';
import { DATA_ROOT, absFromRelOrThrow } from '../files/store';
import { s3ErrorXml, xmlDocument } from './xml';

const MULTIPART_DIR = resolve(DATA_ROOT, '.multipart');
const S3_XMLNS = 'http://s3.amazonaws.com/doc/2006-03-01/';

function xmlResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { 'content-type': 'application/xml; charset=utf-8' },
  });
}

function s3Err(
  set: { status?: number | string },
  status: number,
  code: string,
  message: string,
  resource: string,
): Response {
  set.status = status;
  return xmlResponse(s3ErrorXml(code, message, resource), status);
}

function partFilePath(uploadId: string, partNumber: number): string {
  return resolve(MULTIPART_DIR, uploadId, String(partNumber).padStart(5, '0'));
}

async function writePart(
  uploadId: string,
  partNumber: number,
  stream: ReadableStream<Uint8Array>,
): Promise<{ size: number; md5: string; path: string }> {
  const path = partFilePath(uploadId, partNumber);
  await mkdir(dirname(path), { recursive: true });

  const hash = createHash('md5');
  let size = 0;
  const tmp = `${path}.tmp-${crypto.randomUUID().slice(0, 8)}`;
  const writer = Bun.file(tmp).writer();
  const reader = stream.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        hash.update(value);
        size += value.byteLength;
        writer.write(value);
      }
    }
    await writer.end();
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
  await rename(tmp, path);
  return { size, md5: hash.digest('hex'), path };
}

function parseCompleteBody(xml: string): Array<{ partNumber: number; etag: string }> | null {
  const parts: Array<{ partNumber: number; etag: string }> = [];
  const re =
    /<Part\b[^>]*>[\s\S]*?<PartNumber[^>]*>(\d+)<\/PartNumber>[\s\S]*?<ETag[^>]*>([^<]+)<\/ETag>[\s\S]*?<\/Part>/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(xml)) !== null) {
    const partNumber = Number.parseInt(match[1]!, 10);
    // Strip quotes and XML entities from ETag value
    const etag = match[2]!.trim().replace(/&quot;/g, '').replace(/^"|"$/g, '');
    if (Number.isNaN(partNumber) || partNumber < 1 || partNumber > 10000) return null;
    parts.push({ partNumber, etag });
  }
  return parts.sort((a, b) => a.partNumber - b.partNumber);
}

function multipartEtag(parts: Array<{ md5: string }>): string {
  const combined = Buffer.concat(parts.map((p) => Buffer.from(p.md5, 'hex')));
  const hash = createHash('md5').update(combined).digest('hex');
  return `"${hash}-${parts.length}"`;
}

// ── Operation handlers ────────────────────────────────────────────────────────

async function createMultipartUpload(
  set: { status?: number | string },
  bucket: string,
  key: string,
): Promise<Response> {
  const uploadId = crypto.randomUUID();
  await db.insert(s3MultipartUpload).values({ uploadId, bucket, key });
  await mkdir(resolve(MULTIPART_DIR, uploadId), { recursive: true });
  return xmlResponse(
    xmlDocument({
      name: 'InitiateMultipartUploadResult',
      attributes: { xmlns: S3_XMLNS },
      children: [
        { name: 'Bucket', value: bucket },
        { name: 'Key', value: key },
        { name: 'UploadId', value: uploadId },
      ],
    }),
  );
}

async function uploadPart(
  request: Request,
  set: { status?: number | string },
  uploadId: string,
  partNumber: number,
): Promise<Response> {
  const upload = db
    .select({ uploadId: s3MultipartUpload.uploadId })
    .from(s3MultipartUpload)
    .where(eq(s3MultipartUpload.uploadId, uploadId))
    .get();
  if (!upload) return s3Err(set, 404, 'NoSuchUpload', 'Upload not found', uploadId);

  const { size, md5, path } = await writePart(
    uploadId,
    partNumber,
    request.body ?? new ReadableStream<Uint8Array>({ start: (c) => c.close() }),
  );
  await db
    .insert(s3MultipartPart)
    .values({ uploadId, partNumber, size, md5, path })
    .onConflictDoUpdate({
      target: [s3MultipartPart.uploadId, s3MultipartPart.partNumber],
      set: { size, md5, path },
    });
  return new Response(null, { status: 200, headers: { ETag: `"${md5}"` } });
}

async function completeMultipartUpload(
  request: Request,
  set: { status?: number | string },
  bucket: string,
  key: string,
  uploadId: string,
  pathname: string,
): Promise<Response> {
  const upload = db
    .select({ uploadId: s3MultipartUpload.uploadId })
    .from(s3MultipartUpload)
    .where(eq(s3MultipartUpload.uploadId, uploadId))
    .get();
  if (!upload) return s3Err(set, 404, 'NoSuchUpload', 'Upload not found', pathname);

  const bodyText = await request.text();
  const clientParts = parseCompleteBody(bodyText);
  if (!clientParts || clientParts.length === 0) {
    return s3Err(set, 400, 'MalformedXML', 'Could not parse CompleteMultipartUpload body', pathname);
  }

  const dbParts = db
    .select({
      partNumber: s3MultipartPart.partNumber,
      md5: s3MultipartPart.md5,
      path: s3MultipartPart.path,
      size: s3MultipartPart.size,
    })
    .from(s3MultipartPart)
    .where(eq(s3MultipartPart.uploadId, uploadId))
    .all()
    .sort((a, b) => a.partNumber - b.partNumber);

  // Verify client ETags match stored MD5s.
  for (const cp of clientParts) {
    const dp = dbParts.find((p) => p.partNumber === cp.partNumber);
    if (!dp) return s3Err(set, 400, 'InvalidPart', `Part ${cp.partNumber} not found`, pathname);
    if (dp.md5 !== cp.etag) {
      return s3Err(set, 400, 'InvalidPart', `ETag mismatch for part ${cp.partNumber}`, pathname);
    }
  }

  // Assemble parts into final destination (write-then-rename).
  const destRel = `s3/${bucket}/${key}`;
  const destAbs = absFromRelOrThrow(destRel);
  await mkdir(dirname(destAbs), { recursive: true });
  const tmp = `${destAbs}.tmp-${crypto.randomUUID().slice(0, 8)}`;
  const writer = Bun.file(tmp).writer();
  let totalSize = 0;
  for (const part of dbParts) {
    const data = await Bun.file(part.path).arrayBuffer();
    writer.write(new Uint8Array(data));
    totalSize += data.byteLength;
  }
  await writer.end();
  await rename(tmp, destAbs);

  const destStat = await stat(destAbs);
  const etag = multipartEtag(dbParts);

  await db
    .insert(s3Object)
    .values({
      path: destRel,
      bucket,
      key,
      size: totalSize,
      mtimeMs: Math.round(destStat.mtimeMs),
      inode: Number(destStat.ino),
      md5: etag.replace(/^"|"$/g, ''), // store without surrounding quotes
    })
    .onConflictDoUpdate({
      target: s3Object.path,
      set: {
        size: totalSize,
        mtimeMs: Math.round(destStat.mtimeMs),
        inode: Number(destStat.ino),
        md5: etag.replace(/^"|"$/g, ''),
      },
    });

  // Clean up temp files and DB records.
  for (const part of dbParts) {
    await rm(part.path, { force: true }).catch(() => {});
  }
  const uploadDir = resolve(MULTIPART_DIR, uploadId);
  await rm(uploadDir, { recursive: true, force: true }).catch(() => {});
  await db.delete(s3MultipartUpload).where(eq(s3MultipartUpload.uploadId, uploadId));

  return xmlResponse(
    xmlDocument({
      name: 'CompleteMultipartUploadResult',
      attributes: { xmlns: S3_XMLNS },
      children: [
        { name: 'Location', value: `/${bucket}/${key}` },
        { name: 'Bucket', value: bucket },
        { name: 'Key', value: key },
        { name: 'ETag', value: etag },
      ],
    }),
  );
}

async function abortMultipartUpload(
  set: { status?: number | string },
  uploadId: string,
  pathname: string,
): Promise<Response> {
  const parts = db
    .select({ path: s3MultipartPart.path })
    .from(s3MultipartPart)
    .where(eq(s3MultipartPart.uploadId, uploadId))
    .all();
  for (const part of parts) {
    await rm(part.path, { force: true }).catch(() => {});
  }
  const uploadDir = resolve(MULTIPART_DIR, uploadId);
  await rm(uploadDir, { recursive: true, force: true }).catch(() => {});
  await db.delete(s3MultipartUpload).where(eq(s3MultipartUpload.uploadId, uploadId));
  return new Response(null, { status: 204 });
}

async function listParts(
  set: { status?: number | string },
  uploadId: string,
  pathname: string,
): Promise<Response> {
  const upload = db
    .select({ bucket: s3MultipartUpload.bucket, key: s3MultipartUpload.key })
    .from(s3MultipartUpload)
    .where(eq(s3MultipartUpload.uploadId, uploadId))
    .get();
  if (!upload) return s3Err(set, 404, 'NoSuchUpload', 'Upload not found', pathname);

  const parts = db
    .select({
      partNumber: s3MultipartPart.partNumber,
      md5: s3MultipartPart.md5,
      size: s3MultipartPart.size,
    })
    .from(s3MultipartPart)
    .where(eq(s3MultipartPart.uploadId, uploadId))
    .all()
    .sort((a, b) => a.partNumber - b.partNumber);

  return xmlResponse(
    xmlDocument({
      name: 'ListPartsResult',
      attributes: { xmlns: S3_XMLNS },
      children: [
        { name: 'Bucket', value: upload.bucket },
        { name: 'Key', value: upload.key },
        { name: 'UploadId', value: uploadId },
        ...parts.map((p) => ({
          name: 'Part',
          children: [
            { name: 'PartNumber', value: String(p.partNumber) },
            { name: 'ETag', value: `"${p.md5}"` },
            { name: 'Size', value: String(p.size) },
          ],
        })),
      ],
    }),
  );
}

// ── Public dispatch entry point ───────────────────────────────────────────────

export async function handleMultipart(
  request: Request,
  set: { status?: number | string },
  bucket: string,
  key: string,
  url: URL,
): Promise<Response> {
  const method = request.method;
  const uploadId = url.searchParams.get('uploadId');
  const partNumberStr = url.searchParams.get('partNumber');
  const isInitiate = url.searchParams.has('uploads');

  if (method === 'POST' && isInitiate) return createMultipartUpload(set, bucket, key);

  if (method === 'PUT' && partNumberStr && uploadId) {
    const partNumber = Number.parseInt(partNumberStr, 10);
    if (Number.isNaN(partNumber) || partNumber < 1 || partNumber > 10000) {
      return s3Err(set, 400, 'InvalidArgument', 'Part number must be 1–10000', url.pathname);
    }
    return uploadPart(request, set, uploadId, partNumber);
  }

  if (method === 'POST' && uploadId) {
    return completeMultipartUpload(request, set, bucket, key, uploadId, url.pathname);
  }

  if (method === 'DELETE' && uploadId) return abortMultipartUpload(set, uploadId, url.pathname);

  if (method === 'GET' && uploadId) return listParts(set, uploadId, url.pathname);

  return s3Err(set, 405, 'MethodNotAllowed', 'Method not allowed', url.pathname);
}
```

- [ ] **Step 4: Run multipart tests**

Run: `bun test apps/server/src/s3/multipart.test.ts`

Note: tests will fail because multipart is not yet dispatched from `routes.ts`. The test imports `app` directly so multipart routes need to be wired. Skip to Task 8 (dispatch wiring) if tests fail at the routing level, then come back to re-run.

Alternatively run: `bun run typecheck` — expected: code 0 (no type errors in multipart.ts).

- [ ] **Step 5: Commit**
```bash
git add apps/server/src/s3/multipart.ts apps/server/src/s3/multipart.test.ts
git commit -m "feat: multipart upload handler (Create, UploadPart, Complete, Abort, ListParts)"
```

---

## Task 8: routes.ts — wire multipart dispatch

**Files:**
- Modify: `apps/server/src/s3/routes.ts`

- [ ] **Step 1: Add handleMultipart import**

Add to imports at top of `routes.ts`:
```typescript
import { handleMultipart } from './multipart';
```

- [ ] **Step 2: Add multipart dispatch inside the object-level handler**

Find (inside `createS3Handler`, after `const rel = objectRel(bucket, key);`):
```typescript
    const rel = objectRel(bucket, key);
    if (request.method === 'PUT') {
```

Insert BETWEEN `const rel` and `if (request.method === 'PUT')`:
```typescript
    // Multipart operations are detected by the presence of multipart query params.
    if (
      url.searchParams.has('uploads') ||
      url.searchParams.has('uploadId') ||
      url.searchParams.has('partNumber')
    ) {
      return handleMultipart(request, set, bucket, key, url);
    }
```

- [ ] **Step 3: Run all S3 tests**

Run: `bun test apps/server/src/s3/`
Expected: all tests pass (routes.test.ts + multipart.test.ts + access-keys.test.ts).

- [ ] **Step 4: Run full test suite**

Run: `bun test`
Expected: 0 fail.

- [ ] **Step 5: Commit**
```bash
git add apps/server/src/s3/routes.ts
git commit -m "feat: wire multipart dispatch into S3 routes handler"
```

---

## Task 9: index.ts — register accessKeyRoutes

**Files:**
- Modify: `apps/server/src/index.ts`

- [ ] **Step 1: Add import and use**

Add to imports in `apps/server/src/index.ts`:
```typescript
import { accessKeyRoutes } from './s3/access-keys';
```

Add `.use(accessKeyRoutes)` to the Elysia app chain, **before** `.use(s3Routes)`:
```typescript
export const app = new Elysia({ serve: { maxRequestBodySize: 50 * 1024 ** 3 } })
  // ... existing uses ...
  .use(accessKeyRoutes)
  .use(s3Routes)
  // ... rest unchanged
```

- [ ] **Step 2: Run typecheck and tests**

Run: `bun test && bun run typecheck`
Expected: all pass.

- [ ] **Step 3: Commit**
```bash
git add apps/server/src/index.ts
git commit -m "feat: register S3 access key management routes in server"
```

---

## Task 10: Web UI — Settings page with S3 Access Keys

**Files:**
- Create: `apps/web/src/routes/_app.settings.tsx`

Note: The sidebar at `apps/web/src/components/layout/sidebar.tsx` already includes a `Settings` nav link pointing to `/settings`. No sidebar changes needed.

- [ ] **Step 1: Create `apps/web/src/routes/_app.settings.tsx`**

```tsx
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { Copy, KeyRound, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Button } from '~/components/ui/button';
import { ConfirmDialog } from '~/components/ui/confirm-dialog';
import { Input } from '~/components/ui/input';
import { Label } from '~/components/ui/label';
import { Modal, ModalClose, ModalContent, ModalTitle } from '~/components/ui/modal';
import { api } from '~/lib/api';

export const Route = createFileRoute('/_app/settings')({
  component: SettingsPage,
});

type AccessKey = {
  id: string;
  accessKeyId: string;
  name: string;
  createdAt: string | number | Date;
};

type NewKey = {
  id: string;
  accessKeyId: string;
  secretAccessKey: string;
};

function SettingsPage() {
  const qc = useQueryClient();
  const [showCreate, setShowCreate] = useState(false);
  const [newKeyName, setNewKeyName] = useState('');
  const [generatedKey, setGeneratedKey] = useState<NewKey | null>(null);
  const [confirmed, setConfirmed] = useState(false);

  const keys = useQuery({
    queryKey: ['s3-keys'],
    queryFn: async () => {
      const { data, error } = await api.api.settings['s3-keys'].get();
      if (error) throw error;
      return (data ?? []) as AccessKey[];
    },
  });

  const createKey = useMutation({
    mutationFn: async (name: string) => {
      const { data, error } = await api.api.settings['s3-keys'].post({ name });
      if (error) throw error;
      return data as NewKey;
    },
    onSuccess: (data) => {
      setGeneratedKey(data);
      setShowCreate(false);
      setNewKeyName('');
      qc.invalidateQueries({ queryKey: ['s3-keys'] });
    },
  });

  const revokeKey = useMutation({
    mutationFn: async (id: string) => {
      await api.api.settings['s3-keys']({ id }).delete();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['s3-keys'] }),
  });

  return (
    <div className="mx-auto max-w-2xl px-6 py-8">
      <h1 className="text-xl font-semibold">Settings</h1>

      <section className="mt-8">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-base font-medium">S3 Access Keys</h2>
            <p className="mt-0.5 text-sm text-[hsl(var(--muted-foreground))]">
              Use these credentials with rclone, kopia, restic, or any S3-compatible tool.
            </p>
          </div>
          <Button size="sm" leftIcon={<Plus className="size-4" />} onClick={() => setShowCreate(true)}>
            New key
          </Button>
        </div>

        <div className="mt-4 divide-y divide-[hsl(var(--border))] rounded-lg border border-[hsl(var(--border))]">
          {keys.data?.length === 0 && (
            <p className="px-4 py-6 text-center text-sm text-[hsl(var(--muted-foreground))]">
              No access keys yet.
            </p>
          )}
          {keys.data?.map((key) => (
            <div key={key.id} className="flex items-center gap-3 px-4 py-3">
              <KeyRound className="size-4 shrink-0 text-[hsl(var(--muted-foreground))]" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{key.name}</p>
                <p className="font-mono text-xs text-[hsl(var(--muted-foreground))]">
                  {key.accessKeyId}
                </p>
              </div>
              <span className="text-xs text-[hsl(var(--muted-foreground))]">
                {new Date(key.createdAt).toLocaleDateString()}
              </span>
              <ConfirmDialog
                title="Revoke access key?"
                description={`"${key.name}" will stop working immediately. This cannot be undone.`}
                confirmLabel="Revoke"
                onConfirm={() => revokeKey.mutate(key.id)}
              >
                <Button variant="ghost" size="icon-sm" aria-label="Revoke key">
                  <Trash2 className="size-4" />
                </Button>
              </ConfirmDialog>
            </div>
          ))}
        </div>
      </section>

      {/* Create key modal */}
      <Modal open={showCreate} onOpenChange={setShowCreate}>
        <ModalContent>
          <ModalTitle>New S3 Access Key</ModalTitle>
          <form
            className="mt-4 space-y-4"
            onSubmit={(e: React.FormEvent) => {
              e.preventDefault();
              if (newKeyName.trim()) createKey.mutate(newKeyName.trim());
            }}
          >
            <div className="space-y-1.5">
              <Label htmlFor="key-name">Key name</Label>
              <Input
                id="key-name"
                placeholder="e.g. rclone backup"
                value={newKeyName}
                onChange={(e) => setNewKeyName(e.target.value)}
                autoFocus
              />
            </div>
            <div className="flex justify-end gap-2">
              <ModalClose asChild>
                <Button variant="ghost" type="button">Cancel</Button>
              </ModalClose>
              <Button type="submit" disabled={!newKeyName.trim() || createKey.isPending}>
                Generate
              </Button>
            </div>
          </form>
        </ModalContent>
      </Modal>

      {/* One-time secret display modal */}
      <Modal
        open={!!generatedKey && !confirmed}
        onOpenChange={(open) => {
          if (!open) { setGeneratedKey(null); setConfirmed(false); }
        }}
      >
        <ModalContent>
          <ModalTitle>Save your secret access key</ModalTitle>
          <p className="mt-2 text-sm text-[hsl(var(--muted-foreground))]">
            This is the only time you'll see the secret. Copy it now.
          </p>
          <div className="mt-4 space-y-3">
            <SecretField label="Access Key ID" value={generatedKey?.accessKeyId ?? ''} />
            <SecretField label="Secret Access Key" value={generatedKey?.secretAccessKey ?? ''} />
          </div>
          <div className="mt-4 flex justify-end">
            <Button onClick={() => { setConfirmed(true); setGeneratedKey(null); }}>
              I've saved my key
            </Button>
          </div>
        </ModalContent>
      </Modal>
    </div>
  );
}

function SecretField({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard.writeText(value);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  return (
    <div className="space-y-1">
      <Label>{label}</Label>
      <div className="flex items-center gap-2">
        <code className="flex-1 rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--muted))] px-3 py-1.5 font-mono text-xs break-all">
          {value}
        </code>
        <Button variant="ghost" size="icon-sm" onClick={copy} aria-label={`Copy ${label}`}>
          <Copy className="size-4" />
          {copied && <span className="sr-only">Copied</span>}
        </Button>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Run typecheck for the web package**

Run: `bun run typecheck`
Expected: all three packages exit with code 0.

If there are import errors (e.g. `Modal`, `ModalClose`, `ModalTitle` not exported from `~/components/ui/modal`), check the existing people page imports and adjust to match the exact exports available.

- [ ] **Step 3: Start dev server and verify the settings page loads**

Run: `bun run dev`
Open `http://localhost:3900/settings` — expect the S3 Access Keys section to render, "New key" button to open the create modal, generated key to show a one-time secret display, and revoke to remove the row.

- [ ] **Step 4: Commit**
```bash
git add apps/web/src/routes/_app.settings.tsx
git commit -m "feat: settings page with S3 access key management UI"
```

---

## Task 11: Final verification

- [ ] **Step 1: Run full test suite**

Run: `bun test`
Expected: 0 fail across all packages.

- [ ] **Step 2: Run typecheck**

Run: `bun run typecheck`
Expected: all packages exit 0.

- [ ] **Step 3: Run lint**

Run: `bun run lint`
Expected: no errors (warnings are OK).

- [ ] **Step 4: Update PLAN.md to mark Phase 4 items complete**

In `PLAN.md`, check off:
```markdown
- [x] Multipart uploads: CreateMultipartUpload, UploadPart, CompleteMultipartUpload, AbortMultipartUpload, ListParts
- [x] CopyObject (server-side copy)
- [x] Presigned URL verification for GET / PUT
- [x] Access keys in SQLite (per-user, multiple keys per user)
- [x] UI to manage S3 credentials (form + table)
```

- [ ] **Step 5: Commit**
```bash
git add PLAN.md
git commit -m "docs: mark Phase 4 S3 remaining features complete"
```
