import { beforeAll, describe, expect, it, mock } from 'bun:test';
import { mkdir, mkdtemp, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Elysia } from 'elysia';
import { unzipSync } from 'fflate';

const testRoot = await mkdtemp(join(tmpdir(), 'bunnyfile-folder-share-test-'));
process.env.DB_PATH = join(testRoot, 'test.sqlite');
process.env.DATA_DIR = join(testRoot, 'data');
process.env.BETTER_AUTH_SECRET = 'test-secret';

mock.module('../auth/auth', () => ({
  auth: {
    api: {
      getSession: async () => ({ user: { id: 'folder-share-user' } }),
    },
  },
}));

const [
  { runMigrations },
  { db },
  { fileIndex, user },
  { sharesRoutes },
  { writeUpload, absFromRelOrThrow },
] = await Promise.all([
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

function request(path: string, init?: RequestInit) {
  return app.handle(new Request(`http://localhost${path}`, init));
}

describe('folder shares', () => {
  beforeAll(async () => {
    await mkdir(process.env.DATA_DIR!, { recursive: true });
    runMigrations();
    await db.insert(user).values({
      id: 'folder-share-user',
      name: 'Folder Share User',
      email: 'folder-share@example.com',
      emailVerified: true,
      role: 'admin',
    });
  });

  it('create → metadata → download zip → delete removes the cached zip', async () => {
    const folder = `docs-${crypto.randomUUID()}`;
    const info = await writeUpload(`${folder}/a.txt`, streamFromText('hi'));
    await db.insert(fileIndex).values({
      path: `${folder}/a.txt`,
      size: info.size,
      mtimeMs: info.mtimeMs,
      inode: info.inode,
      sha256: info.sha256,
      mime: 'text/plain',
      uploadedByUserId: 'folder-share-user',
    });

    // 1. create a share for the folder
    const createRes = await request('/api/shares', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: folder }),
    });
    expect(createRes.status).toBe(200);
    const created = (await createRes.json()) as { id: string; token: string };
    expect(created.token).toBeTruthy();

    // zip materialized on disk
    const zipAbs = absFromRelOrThrow(`.shares/${created.id}/${folder}.zip`);
    expect((await stat(zipAbs)).size).toBeGreaterThan(0);

    // 2. public metadata reports a zip
    const meta = (await (await request(`/api/shares/public/${created.token}`)).json()) as {
      mime: string;
      name: string;
      size: number;
    };
    expect(meta.mime).toBe('application/zip');
    expect(meta.name).toBe(`${folder}.zip`);
    expect(meta.size).toBeGreaterThan(0);

    // 3. public download returns the zip bytes
    const dl = await request(`/api/shares/public/${created.token}/file`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(dl.headers.get('content-type')).toBe('application/zip');
    expect(dl.headers.get('content-disposition')).toContain(`filename="${folder}.zip"`);
    const files = unzipSync(new Uint8Array(await dl.arrayBuffer()));
    expect(new TextDecoder().decode(files['a.txt'])).toBe('hi');

    // 4. delete the share → zip dir gone
    const del = await request(`/api/shares/${created.id}`, { method: 'DELETE' });
    expect(del.status).toBe(200);
    await expect(stat(zipAbs)).rejects.toThrow();
  });

  it('404s when the shared path does not exist', async () => {
    const res = await request('/api/shares', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: `nope-${crypto.randomUUID()}` }),
    });
    expect(res.status).toBe(404);
  });
});
