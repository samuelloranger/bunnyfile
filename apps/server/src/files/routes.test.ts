import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
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
    await db
      .insert(user)
      .values({
        id: 'files-test-user',
        name: 'Files Test User',
        email: 'files-test@example.com',
        emailVerified: true,
        role: 'admin',
      })
      .onConflictDoNothing();
  });

  it('creates folder, uploads, lists, reads, moves and deletes file', async () => {
    // Unique names so shared DB/DATA_DIR across parallel bun:test files cannot collide.
    const folder = `docs-${crypto.randomUUID().slice(0, 8)}`;
    const file = `hello-${crypto.randomUUID().slice(0, 8)}.txt`;
    const moved = `${folder}/${file}`;

    const createFolderRes = await request('/api/files/folder', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: folder }),
    });
    expect(createFolderRes.status).toBe(200);

    const fd = new FormData();
    fd.set('path', file);
    fd.set('file', new File(['hello world'], file, { type: 'text/plain' }));
    const uploadRes = await request('/api/files/upload', {
      method: 'POST',
      body: fd,
    });
    expect(uploadRes.status).toBe(200);

    const listRes = await request('/api/files?prefix=&limit=500&offset=0');
    expect(listRes.status).toBe(200);
    const list = (await listRes.json()) as { entries: Array<{ path: string }>; total: number };
    expect(list.total).toBeGreaterThanOrEqual(2);
    expect(list.entries.some((entry) => entry.path === folder)).toBeTrue();
    expect(list.entries.some((entry) => entry.path === file)).toBeTrue();

    const contentRes = await request(`/api/files/content?path=${encodeURIComponent(file)}`);
    expect(contentRes.status).toBe(200);
    expect(await contentRes.text()).toBe('hello world');

    const rangeRes = await request(`/api/files/content?path=${encodeURIComponent(file)}`, {
      headers: { range: 'bytes=0-4' },
    });
    expect(rangeRes.status).toBe(206);
    expect(await rangeRes.text()).toBe('hello');

    const moveRes = await request('/api/files', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: file, newPath: moved }),
    });
    expect(moveRes.status).toBe(200);

    const movedContentRes = await request(`/api/files/content?path=${encodeURIComponent(moved)}`);
    expect(movedContentRes.status).toBe(200);
    expect(await movedContentRes.text()).toBe('hello world');

    const deleteRes = await request('/api/files', {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: moved }),
    });
    expect(deleteRes.status).toBe(200);

    const deletedReadRes = await request(`/api/files/content?path=${encodeURIComponent(moved)}`);
    expect(deletedReadRes.status).toBe(404);

    const trashRes = await request('/api/trash');
    expect(trashRes.status).toBe(200);
    const trash = (await trashRes.json()) as {
      entries: Array<{ id: string; originalPath: string }>;
    };
    const trashed = trash.entries.find((entry) => entry.originalPath === moved);
    expect(trashed).toBeTruthy();

    const restoreRes = await request(`/api/trash/${trashed!.id}/restore`, { method: 'POST' });
    expect(restoreRes.status).toBe(200);

    const restoredReadRes = await request(`/api/files/content?path=${encodeURIComponent(moved)}`);
    expect(restoredReadRes.status).toBe(200);
    expect(await restoredReadRes.text()).toBe('hello world');

    const deleteFolderViaFileEndpointRes = await request('/api/files', {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: folder }),
    });
    expect(deleteFolderViaFileEndpointRes.status).toBe(400);

    const stillRestoredReadRes = await request(
      `/api/files/content?path=${encodeURIComponent(moved)}`,
    );
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
    const path = `page-${crypto.randomUUID().slice(0, 8)}.html`;
    const fd = new FormData();
    fd.set('path', path);
    fd.set('file', new File(['<script>alert(1)</script>'], path, { type: 'text/html' }));
    await request('/api/files/upload', { method: 'POST', body: fd });

    const res = await request(`/api/files/content?path=${encodeURIComponent(path)}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('content-security-policy')).toContain('sandbox');
  });

  it('serves a suffix byte range (last N bytes)', async () => {
    const path = `range-${crypto.randomUUID().slice(0, 8)}.txt`;
    const fd = new FormData();
    fd.set('path', path);
    fd.set('file', new File(['0123456789'], path, { type: 'text/plain' }));
    await request('/api/files/upload', { method: 'POST', body: fd });

    const res = await request(`/api/files/content?path=${encodeURIComponent(path)}`, {
      headers: { Range: 'bytes=-3' },
    });
    expect(res.status).toBe(206);
    expect(await res.text()).toBe('789');
  });

  it('keeps the S3 object tree out of the files browser', async () => {
    // S3 lives at DATA_DIR/s3 (sibling of files/); creating a user folder named
    // s3 under FILES_ROOT is allowed, but the real S3 tree must not appear.
    await mkdir(join(process.env.DATA_DIR!, 's3', 'bucket'), { recursive: true });
    await writeFile(join(process.env.DATA_DIR!, 's3', 'bucket', 'secret.txt'), 'nope');

    const rootRes = await request('/api/files?prefix=&limit=500');
    expect(rootRes.status).toBe(200);
    const root = (await rootRes.json()) as { entries: Array<{ path: string }> };
    expect(root.entries.some((e) => e.path === 's3')).toBe(false);

    // Listing via API cannot reach DATA_DIR/s3 — prefix s3 is under FILES_ROOT.
    const s3List = await request('/api/files?prefix=s3&limit=500');
    expect(s3List.status).toBe(200);
    const listed = (await s3List.json()) as { entries: Array<{ path: string }> };
    expect(listed.entries.some((e) => e.path.includes('secret'))).toBe(false);
  });
});

afterAll(async () => {
  await rm(testRoot, { recursive: true, force: true });
});
