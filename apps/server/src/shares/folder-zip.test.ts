import { afterAll, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unzipSync } from 'fflate';

const testRoot = await mkdtemp(join(tmpdir(), 'bunnyfile-folder-zip-test-'));
process.env.DB_PATH = join(testRoot, 'test.sqlite');
process.env.DATA_DIR = join(testRoot, 'data');
process.env.BETTER_AUTH_SECRET = 'test-secret-folder-zip';
await mkdir(process.env.DATA_DIR, { recursive: true });

const { db } = await import('../db');
const { runMigrations } = await import('../db/migrate');
const { fileIndex } = await import('../db/schema');
const { absFromRelOrThrow, removeShareZip, SHARES_ROOT, writeUpload } = await import(
  '../files/store'
);
const { buildShareZip, ensureShareZip, folderFingerprint, zipRelForShare } = await import(
  './folder-zip'
);

runMigrations();

async function seedFile(path: string, bytes: string) {
  await writeUpload(path, new Response(bytes).body as ReadableStream<Uint8Array>);
  const abs = absFromRelOrThrow(path);
  const st = await stat(abs);
  await db
    .insert(fileIndex)
    .values({
      path,
      size: st.size,
      mtimeMs: Math.round(st.mtimeMs),
      inode: Number(st.ino),
      mime: 'text/plain',
    })
    .onConflictDoUpdate({
      target: fileIndex.path,
      set: { size: st.size, mtimeMs: Math.round(st.mtimeMs) },
    });
}

describe('folder-zip cache', () => {
  test('fingerprint changes when contents change', async () => {
    const folder = `fz-${crypto.randomUUID()}`;
    await seedFile(`${folder}/a.txt`, 'one');
    const fp1 = await folderFingerprint(folder);
    await seedFile(`${folder}/b.txt`, 'two');
    const fp2 = await folderFingerprint(folder);
    expect(fp1).not.toBe(fp2);
  });

  test('ensureShareZip builds once then reuses until fingerprint drifts', async () => {
    const id = crypto.randomUUID();
    const folder = `fz-${crypto.randomUUID()}`;
    await seedFile(`${folder}/a.txt`, 'one');
    try {
      await buildShareZip(id, folder);
      const sidecarFp = await readFile(join(SHARES_ROOT, id, '.fp'), 'utf8');
      expect(sidecarFp).toBe(await folderFingerprint(folder));

      const first = await ensureShareZip(id, folder);
      const mtime1 = (await stat(first.abs)).mtimeMs;

      const again = await ensureShareZip(id, folder);
      expect((await stat(again.abs)).mtimeMs).toBe(mtime1);

      await seedFile(`${folder}/c.txt`, 'three');
      const rebuilt = await ensureShareZip(id, folder);
      const names = Object.keys(unzipSync(new Uint8Array(await readFile(rebuilt.abs)))).sort();
      expect(names).toEqual(['a.txt', 'c.txt']);
      expect(rebuilt.size).toBeGreaterThan(0);
      expect(zipRelForShare(id, folder)).toBe(`shares/${id}/${folder}.zip`);
    } finally {
      await removeShareZip(id);
      await rm(absFromRelOrThrow(folder), { recursive: true, force: true });
    }
  });
});

afterAll(async () => {
  await rm(testRoot, { recursive: true, force: true });
});
