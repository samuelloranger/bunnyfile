import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Elysia } from 'elysia';

const testRoot = await mkdtemp(join(tmpdir(), 'bunnyfile-files-routes-test-'));
process.env.DB_PATH = join(testRoot, 'test.sqlite');
process.env.DATA_DIR = join(testRoot, 'data');
process.env.BETTER_AUTH_SECRET = 'test-secret';

mock.module('../auth/auth', () => ({
  auth: {
    api: {
      getSession: async () => ({
        user: { id: 'files-test-user', role: 'admin' },
      }),
    },
  },
}));

const [{ runMigrations }, { db }, { user }, { filesRoutes }] = await Promise.all([
  import('../db/migrate'),
  import('../db'),
  import('../db/schema'),
  import('./routes'),
]);

const app = new Elysia().use(filesRoutes);

async function request(path: string, init?: RequestInit) {
  return app.handle(new Request(`http://localhost${path}`, init));
}

describe('files routes', () => {
  beforeAll(async () => {
    await mkdir(process.env.DATA_DIR!, { recursive: true });
    runMigrations();
    await db.insert(user).values({
      id: 'files-test-user',
      name: 'Files Test User',
      email: 'files-test@example.com',
      emailVerified: true,
      role: 'admin',
    });
  });

  it('creates folder, uploads, lists, reads, moves and deletes file', async () => {
    const createFolderRes = await request('/api/files/folder', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: 'docs' }),
    });
    expect(createFolderRes.status).toBe(200);

    const fd = new FormData();
    fd.set('path', 'hello.txt');
    fd.set('file', new File(['hello world'], 'hello.txt', { type: 'text/plain' }));
    const uploadRes = await request('/api/files/upload', {
      method: 'POST',
      body: fd,
    });
    expect(uploadRes.status).toBe(200);

    const listRes = await request('/api/files?prefix=&limit=10&offset=0');
    expect(listRes.status).toBe(200);
    const list = (await listRes.json()) as { entries: Array<{ path: string }>; total: number };
    expect(list.total).toBeGreaterThanOrEqual(2);
    expect(list.entries.some((entry) => entry.path === 'docs')).toBeTrue();
    expect(list.entries.some((entry) => entry.path === 'hello.txt')).toBeTrue();

    const contentRes = await request('/api/files/content?path=hello.txt');
    expect(contentRes.status).toBe(200);
    expect(await contentRes.text()).toBe('hello world');

    const rangeRes = await request('/api/files/content?path=hello.txt', {
      headers: { range: 'bytes=0-4' },
    });
    expect(rangeRes.status).toBe(206);
    expect(await rangeRes.text()).toBe('hello');

    const moveRes = await request('/api/files', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: 'hello.txt', newPath: 'docs/hello.txt' }),
    });
    expect(moveRes.status).toBe(200);

    const movedContentRes = await request('/api/files/content?path=docs/hello.txt');
    expect(movedContentRes.status).toBe(200);
    expect(await movedContentRes.text()).toBe('hello world');

    const deleteRes = await request('/api/files', {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: 'docs/hello.txt' }),
    });
    expect(deleteRes.status).toBe(200);

    const deletedReadRes = await request('/api/files/content?path=docs/hello.txt');
    expect(deletedReadRes.status).toBe(404);

    const trashRes = await request('/api/trash');
    expect(trashRes.status).toBe(200);
    const trash = (await trashRes.json()) as {
      entries: Array<{ id: string; originalPath: string }>;
    };
    const trashed = trash.entries.find((entry) => entry.originalPath === 'docs/hello.txt');
    expect(trashed).toBeTruthy();

    const restoreRes = await request(`/api/trash/${trashed!.id}/restore`, { method: 'POST' });
    expect(restoreRes.status).toBe(200);

    const restoredReadRes = await request('/api/files/content?path=docs/hello.txt');
    expect(restoredReadRes.status).toBe(200);
    expect(await restoredReadRes.text()).toBe('hello world');

    const deleteFolderViaFileEndpointRes = await request('/api/files', {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: 'docs' }),
    });
    expect(deleteFolderViaFileEndpointRes.status).toBe(400);

    const stillRestoredReadRes = await request('/api/files/content?path=docs/hello.txt');
    expect(stillRestoredReadRes.status).toBe(200);
    expect(await stillRestoredReadRes.text()).toBe('hello world');
  });

  it('returns usage, recent, and rescan payloads', async () => {
    const usageRes = await request('/api/files/usage');
    expect(usageRes.status).toBe(200);
    const usage = (await usageRes.json()) as {
      usedBytes: number;
      fileCount: number;
      totalBytes: number | null;
      freeBytes: number | null;
    };
    expect(typeof usage.usedBytes).toBe('number');
    expect(typeof usage.fileCount).toBe('number');
    expect(usage.totalBytes === null || typeof usage.totalBytes === 'number').toBeTrue();
    expect(usage.freeBytes === null || typeof usage.freeBytes === 'number').toBeTrue();

    const recentRes = await request('/api/files/recent?limit=5');
    expect(recentRes.status).toBe(200);
    const recent = (await recentRes.json()) as { entries: unknown[] };
    expect(Array.isArray(recent.entries)).toBeTrue();

    const rescanRes = await request('/api/files/rescan', { method: 'POST' });
    expect(rescanRes.status).toBe(200);
    const rescan = (await rescanRes.json()) as { added: number; updated: number; removed: number };
    expect(typeof rescan.added).toBe('number');
    expect(typeof rescan.updated).toBe('number');
    expect(typeof rescan.removed).toBe('number');
  });

  it('serves file content with stored-XSS-neutralizing headers', async () => {
    const fd = new FormData();
    fd.set('path', 'page.html');
    fd.set('file', new File(['<script>alert(1)</script>'], 'page.html', { type: 'text/html' }));
    await request('/api/files/upload', { method: 'POST', body: fd });

    const res = await request('/api/files/content?path=page.html');
    expect(res.status).toBe(200);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('content-security-policy')).toContain('sandbox');
  });

  it('serves a suffix byte range (last N bytes)', async () => {
    const fd = new FormData();
    fd.set('path', 'range.txt');
    fd.set('file', new File(['0123456789'], 'range.txt', { type: 'text/plain' }));
    await request('/api/files/upload', { method: 'POST', body: fd });

    const res = await request('/api/files/content?path=range.txt', {
      headers: { Range: 'bytes=-3' },
    });
    expect(res.status).toBe(206);
    expect(await res.text()).toBe('789');
  });

  it('rejects reserved internal prefixes from the files API', async () => {
    // Listing, creating, and deleting under s3/ / .multipart must be refused so
    // the web file API cannot touch the S3 object tree or scratch dirs.
    expect((await request('/api/files?prefix=s3')).status).toBe(400);
    const createRes = await request('/api/files/folder', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: 's3/evil' }),
    });
    expect(createRes.status).toBe(400);
    const deleteRes = await request('/api/files', {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: '.multipart' }),
    });
    expect(deleteRes.status).toBe(400);
  });
});

afterAll(async () => {
  await rm(testRoot, { recursive: true, force: true });
});
