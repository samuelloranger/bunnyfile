import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Elysia } from 'elysia';

const testRoot = await mkdtemp(join(tmpdir(), 'bunnyfile-s3-console-'));
process.env.DB_PATH = join(testRoot, 'test.sqlite');
process.env.DATA_DIR = join(testRoot, 'data');
process.env.BETTER_AUTH_SECRET = 'test-secret-for-s3-console';

mock.module('../auth/auth', () => ({
  auth: {
    api: {
      getSession: async ({ headers }: { headers: Headers }) => {
        if (headers.get('x-test-auth') === '1') {
          return { user: { id: 'test-user-id', role: 'admin', email: 'test@example.com' } };
        }
        return null;
      },
    },
  },
}));

const [{ runMigrations }, { s3ConsoleRoutes }, { S3_ROOT }] = await Promise.all([
  import('../db/migrate'),
  import('./console-routes'),
  import('../files/store'),
]);

const app = new Elysia().use(s3ConsoleRoutes);

function authed(url: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set('x-test-auth', '1');
  return app.handle(new Request(url, { ...init, headers }));
}

beforeAll(async () => {
  await mkdir(process.env.DATA_DIR!, { recursive: true });
  await runMigrations();
});

afterAll(async () => {
  await rm(testRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  await rm(S3_ROOT, { recursive: true, force: true });
  await mkdir(S3_ROOT, { recursive: true });
});

describe('s3 console routes', () => {
  test('401 without session', async () => {
    const res = await app.handle(new Request('http://localhost/api/s3-console/buckets'));
    expect(res.status).toBe(401);
  });

  test('create list delete bucket', async () => {
    const created = await authed('http://localhost/api/s3-console/buckets', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 't' }),
    });
    expect(created.status).toBe(200);
    const listed = await authed('http://localhost/api/s3-console/buckets');
    expect(listed.status).toBe(200);
    const body = (await listed.json()) as { buckets: Array<{ name: string }> };
    expect(body.buckets.map((b) => b.name)).toContain('t');
    const deleted = await authed('http://localhost/api/s3-console/buckets/t', { method: 'DELETE' });
    expect(deleted.status).toBe(204);
  });

  test('upload list download delete object', async () => {
    await authed('http://localhost/api/s3-console/buckets', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'b' }),
    });
    const put = await authed('http://localhost/api/s3-console/buckets/b/objects?key=hi.txt', {
      method: 'POST',
      body: 'hello',
    });
    expect(put.status).toBe(200);
    const listed = await authed('http://localhost/api/s3-console/buckets/b/objects');
    const listBody = (await listed.json()) as { objects: Array<{ key: string }> };
    expect(listBody.objects.some((o) => o.key === 'hi.txt')).toBe(true);
    const got = await authed('http://localhost/api/s3-console/buckets/b/object?key=hi.txt');
    expect(got.status).toBe(200);
    expect(await got.text()).toBe('hello');
    const del = await authed('http://localhost/api/s3-console/buckets/b/object?key=hi.txt', {
      method: 'DELETE',
    });
    expect(del.status).toBe(204);
  });
});
