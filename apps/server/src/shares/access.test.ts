import { beforeAll, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';

const testRoot = await mkdtemp(join(tmpdir(), 'bunnyfile-share-access-'));
process.env.DB_PATH = join(testRoot, 'test.sqlite');
process.env.DATA_DIR = join(testRoot, 'data');
process.env.BETTER_AUTH_SECRET = 'test-secret';

const [{ runMigrations }, { db }, { fileIndex, shareLink, user }, { writeUpload }, access] =
  await Promise.all([
    import('../db/migrate'),
    import('../db'),
    import('../db/schema'),
    import('../files/store'),
    import('./access'),
  ]);

function streamFromText(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(c) {
      c.enqueue(new TextEncoder().encode(text));
      c.close();
    },
  });
}

describe('Public Share Access — inspect', () => {
  beforeAll(async () => {
    await mkdir(process.env.DATA_DIR!, { recursive: true });
    runMigrations();
    await db.insert(user).values({
      id: 'access-user',
      name: 'Access User',
      email: 'access@example.com',
      emailVerified: true,
      role: 'admin',
    });
    const info = await writeUpload('hello.txt', streamFromText('hello world'));
    await db.insert(fileIndex).values({
      path: 'hello.txt',
      size: info.size,
      mtimeMs: info.mtimeMs,
      inode: info.inode,
      sha256: info.sha256,
      mime: 'text/plain',
      uploadedByUserId: 'access-user',
    });
  });

  test('not_found for unknown token', async () => {
    const r = await access.inspect('missing-token');
    expect(r.status).toBe('unavailable');
    if (r.status === 'unavailable') expect(r.reason).toBe('not_found');
  });

  test('locked omits path/name/size/mime', async () => {
    const token = crypto.randomUUID();
    await db.insert(shareLink).values({
      id: crypto.randomUUID(),
      token,
      path: 'hello.txt',
      passwordHash: await Bun.password.hash('secret'),
      createdByUserId: 'access-user',
    });
    const r = await access.inspect(token);
    expect(r.status).toBe('locked');
    if (r.status === 'locked') {
      expect(r.requiresPassword).toBe(true);
      expect('path' in r).toBe(false);
      expect('name' in r).toBe(false);
      expect('size' in r).toBe(false);
      expect('mime' in r).toBe(false);
    }
  });

  test('unlocked open share returns file meta', async () => {
    const token = crypto.randomUUID();
    await db.insert(shareLink).values({
      id: crypto.randomUUID(),
      token,
      path: 'hello.txt',
      createdByUserId: 'access-user',
    });
    const r = await access.inspect(token);
    expect(r.status).toBe('unlocked');
    if (r.status === 'unlocked') {
      expect(r.name).toBe('hello.txt');
      expect(r.size).toBeGreaterThan(0);
      expect(r.mime).toBe('text/plain');
      expect(r.requiresPassword).toBe(false);
    }
  });

  test('expired / revoked / max_downloads are unavailable', async () => {
    const expiredToken = crypto.randomUUID();
    await db.insert(shareLink).values({
      id: crypto.randomUUID(),
      token: expiredToken,
      path: 'hello.txt',
      expiresAt: new Date(Date.now() - 60_000),
      createdByUserId: 'access-user',
    });
    expect((await access.inspect(expiredToken)).status).toBe('unavailable');

    const revokedToken = crypto.randomUUID();
    await db.insert(shareLink).values({
      id: crypto.randomUUID(),
      token: revokedToken,
      path: 'hello.txt',
      revokedAt: new Date(),
      createdByUserId: 'access-user',
    });
    const revoked = await access.inspect(revokedToken);
    expect(revoked.status).toBe('unavailable');
    if (revoked.status === 'unavailable') expect(revoked.reason).toBe('revoked');

    const maxedToken = crypto.randomUUID();
    await db.insert(shareLink).values({
      id: crypto.randomUUID(),
      token: maxedToken,
      path: 'hello.txt',
      maxDownloads: 1,
      downloadCount: 1,
      createdByUserId: 'access-user',
    });
    const maxed = await access.inspect(maxedToken);
    expect(maxed.status).toBe('unavailable');
    if (maxed.status === 'unavailable') expect(maxed.reason).toBe('max_downloads');
  });
});

describe('Public Share Access — verify', () => {
  test('wrong password → unauthorized', async () => {
    const token = crypto.randomUUID();
    await db.insert(shareLink).values({
      id: crypto.randomUUID(),
      token,
      path: 'hello.txt',
      passwordHash: await Bun.password.hash('secret'),
      createdByUserId: 'access-user',
    });
    const r = await access.verify(token, 'nope');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('unauthorized');
  });

  test('correct password → unlocked meta', async () => {
    const token = crypto.randomUUID();
    await db.insert(shareLink).values({
      id: crypto.randomUUID(),
      token,
      path: 'hello.txt',
      passwordHash: await Bun.password.hash('secret'),
      createdByUserId: 'access-user',
    });
    const r = await access.verify(token, 'secret');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.name).toBe('hello.txt');
      expect(r.requiresPassword).toBe(true);
      expect(r.size).toBeGreaterThan(0);
    }
  });

  test('open share verify without password still unlocks', async () => {
    const token = crypto.randomUUID();
    await db.insert(shareLink).values({
      id: crypto.randomUUID(),
      token,
      path: 'hello.txt',
      createdByUserId: 'access-user',
    });
    const r = await access.verify(token);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.requiresPassword).toBe(false);
  });

  test('revoked share verify → unavailable', async () => {
    const token = crypto.randomUUID();
    await db.insert(shareLink).values({
      id: crypto.randomUUID(),
      token,
      path: 'hello.txt',
      revokedAt: new Date(),
      createdByUserId: 'access-user',
    });
    const r = await access.verify(token, 'secret');
    expect(r.ok).toBe(false);
    if (!r.ok && r.error === 'unavailable') expect(r.reason).toBe('revoked');
  });
});

describe('Public Share Access — beginDownload (file)', () => {
  test('downloads open file bytes', async () => {
    const token = crypto.randomUUID();
    await db.insert(shareLink).values({
      id: crypto.randomUUID(),
      token,
      path: 'hello.txt',
      createdByUserId: 'access-user',
    });
    const r = await access.beginDownload(token);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.headers['Content-Type']).toBe('text/plain');
    const text = await new Response(r.stream).text();
    expect(text).toBe('hello world');
  });

  test('wrong password → unauthorized', async () => {
    const token = crypto.randomUUID();
    await db.insert(shareLink).values({
      id: crypto.randomUUID(),
      token,
      path: 'hello.txt',
      passwordHash: await Bun.password.hash('secret'),
      createdByUserId: 'access-user',
    });
    const r = await access.beginDownload(token, 'wrong');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('unauthorized');
  });

  test('max downloads: cancel releases lease', async () => {
    const token = crypto.randomUUID();
    const id = crypto.randomUUID();
    await db.insert(shareLink).values({
      id,
      token,
      path: 'hello.txt',
      maxDownloads: 1,
      downloadCount: 0,
      createdByUserId: 'access-user',
    });

    const first = await access.beginDownload(token);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const reader = first.stream.getReader();
    await reader.read();
    await reader.cancel();

    let released = false;
    for (let i = 0; i < 50; i++) {
      const row = await db
        .select()
        .from(shareLink)
        .where(eq(shareLink.id, id))
        .then((r) => r[0]!);
      if (row.downloadCount === 0) {
        released = true;
        break;
      }
      await Bun.sleep(10);
    }
    expect(released).toBe(true);

    const second = await access.beginDownload(token);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    await new Response(second.stream).arrayBuffer();
    let committed = false;
    for (let i = 0; i < 50; i++) {
      const after = await db
        .select()
        .from(shareLink)
        .where(eq(shareLink.id, id))
        .then((r) => r[0]!);
      if (after.downloadCount === 1) {
        committed = true;
        break;
      }
      await Bun.sleep(10);
    }
    expect(committed).toBe(true);

    const third = await access.beginDownload(token);
    expect(third.ok).toBe(false);
    if (!third.ok && third.error === 'unavailable') {
      expect(third.reason).toBe('max_downloads');
    }
  });
});
