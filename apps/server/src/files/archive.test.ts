import { beforeAll, describe, expect, it, mock } from 'bun:test';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Elysia } from 'elysia';
import { unzipSync } from 'fflate';

const testRoot = await mkdtemp(join(tmpdir(), 'bunnyfile-archive-test-'));
process.env.DB_PATH = join(testRoot, 'test.sqlite');
process.env.DATA_DIR = join(testRoot, 'data');
process.env.BETTER_AUTH_SECRET = 'test-secret';

mock.module('../auth/auth', () => ({
  auth: {
    api: {
      getSession: async () => ({ user: { id: 'archive-test-user' } }),
    },
  },
}));

const [{ runMigrations }, { filesRoutes }, { absFromRelOrThrow }] = await Promise.all([
  import('../db/migrate'),
  import('./routes'),
  import('./store'),
]);

const app = new Elysia().use(filesRoutes);

function request(path: string, init?: RequestInit) {
  return app.handle(new Request(`http://localhost${path}`, init));
}

describe('GET /api/files/archive', () => {
  beforeAll(async () => {
    await mkdir(process.env.DATA_DIR!, { recursive: true });
    runMigrations();
  });

  it('streams a folder as a store-level zip', async () => {
    const folder = `arch-${crypto.randomUUID()}`;
    await mkdir(absFromRelOrThrow(`${folder}/sub`), { recursive: true });
    await writeFile(absFromRelOrThrow(`${folder}/a.txt`), 'hi');
    await writeFile(absFromRelOrThrow(`${folder}/sub/b.txt`), 'deep');

    const res = await request(`/api/files/archive?path=${encodeURIComponent(folder)}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/zip');
    expect(res.headers.get('content-disposition')).toContain(`filename="${folder}.zip"`);

    const files = unzipSync(new Uint8Array(await res.arrayBuffer()));
    expect(new TextDecoder().decode(files['a.txt'])).toBe('hi');
    expect(new TextDecoder().decode(files['sub/b.txt'])).toBe('deep');
  });

  it('404s when the path is a file, not a folder', async () => {
    await writeFile(absFromRelOrThrow('lonely.txt'), 'x');
    const res = await request('/api/files/archive?path=lonely.txt');
    expect(res.status).toBe(404);
  });

  it('rejects a missing/empty path', async () => {
    const res = await request('/api/files/archive?path=');
    // Elysia's `minLength: 1` schema rejects an empty path (422) before the handler.
    expect(res.status).toBe(422);
  });
});
