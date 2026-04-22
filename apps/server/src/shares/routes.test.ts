import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Elysia } from 'elysia';

const testRoot = await mkdtemp(join(tmpdir(), 'bunnyfile-shares-routes-test-'));
process.env.DB_PATH = join(testRoot, 'test.sqlite');
process.env.DATA_DIR = join(testRoot, 'data');
process.env.BETTER_AUTH_SECRET = 'test-secret';

mock.module('../auth/auth', () => ({
  auth: {
    api: {
      getSession: async () => ({
        user: { id: 'shares-test-user' },
      }),
    },
  },
}));

const [{ runMigrations }, { db }, { fileIndex, user }, { sharesRoutes }, { writeUpload }] =
  await Promise.all([
    import('../db/migrate'),
    import('../db'),
    import('../db/schema'),
    import('./routes'),
    import('../files/store'),
  ]);

const app = new Elysia().use(sharesRoutes);

function streamFromText(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

async function request(path: string, init?: RequestInit) {
  return app.handle(new Request(`http://localhost${path}`, init));
}

describe('shares routes', () => {
  beforeAll(async () => {
    await mkdir(process.env.DATA_DIR!, { recursive: true });
    runMigrations();
    await db.insert(user).values({
      id: 'shares-test-user',
      name: 'Shares Test User',
      email: 'shares-test@example.com',
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
      uploadedByUserId: 'shares-test-user',
    });
  });

  it('creates share, validates password, and enforces max downloads', async () => {
    const createRes = await request('/api/shares', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        path: 'hello.txt',
        password: 'secret123',
        maxDownloads: 1,
      }),
    });
    if (createRes.status !== 200) {
      throw new Error(`create share failed: ${createRes.status} ${await createRes.text()}`);
    }
    const created = (await createRes.json()) as { token: string; url: string };
    expect(created.token.length).toBeGreaterThan(10);
    expect(created.url.includes(`/s/${created.token}`)).toBeTrue();

    const pageRes = await request(`/api/shares/public/${created.token}`);
    expect(pageRes.status).toBe(200);
    const page = (await pageRes.json()) as { status: string; requiresPassword: boolean };
    expect(page.status).toBe('ok');
    expect(page.requiresPassword).toBeTrue();

    const noPasswordRes = await request(`/api/shares/public/${created.token}/file`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(noPasswordRes.status).toBe(401);

    const downloadRes = await request(`/api/shares/public/${created.token}/file`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'secret123' }),
    });
    expect(downloadRes.status).toBe(200);
    expect(await downloadRes.text()).toBe('hello world');

    const secondDownload = await request(`/api/shares/public/${created.token}/file`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'secret123' }),
    });
    expect(secondDownload.status).toBe(410);
  });

  it('lists shares and supports expiry + revoke', async () => {
    const expiredCreate = await request('/api/shares', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        path: 'hello.txt',
        expiresAtMs: 1,
      }),
    });
    if (expiredCreate.status !== 200) {
      throw new Error(
        `create expired share failed: ${expiredCreate.status} ${await expiredCreate.text()}`,
      );
    }
    const expired = (await expiredCreate.json()) as { token: string };
    const expiredPage = await request(`/api/shares/public/${expired.token}`);
    expect(expiredPage.status).toBe(410);

    const activeCreate = await request('/api/shares', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        path: 'hello.txt',
      }),
    });
    expect(activeCreate.status).toBe(200);
    const active = (await activeCreate.json()) as { id: string; token: string };

    const listRes = await request('/api/shares');
    expect(listRes.status).toBe(200);
    const list = (await listRes.json()) as { entries: Array<{ id: string }> };
    expect(list.entries.some((entry) => entry.id === active.id)).toBeTrue();

    const revokeRes = await request(`/api/shares/${active.id}`, { method: 'DELETE' });
    expect(revokeRes.status).toBe(200);

    const revokedPage = await request(`/api/shares/public/${active.token}`);
    expect(revokedPage.status).toBe(410);
  });
});

afterAll(async () => {
  await rm(testRoot, { recursive: true, force: true });
});
