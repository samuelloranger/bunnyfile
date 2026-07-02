import { describe, expect, test } from 'bun:test';
import { readFile, rm, stat } from 'node:fs/promises';
import { unzipSync } from 'fflate';
import { db } from '../db';
import { fileIndex } from '../db/schema';
import { absFromRelOrThrow, removeShareZip, writeUpload } from '../files/store';
import { buildShareZip, ensureShareZip, folderFingerprint, zipRelForShare } from './folder-zip';

async function seedFile(path: string, bytes: string) {
  await writeUpload(path, new Response(bytes).body as ReadableStream<Uint8Array>);
  // reflect into the index (the scanner would normally do this)
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
      const first = await ensureShareZip(id, folder);
      const mtime1 = (await stat(first.abs)).mtimeMs;

      const again = await ensureShareZip(id, folder); // unchanged → no rebuild
      expect((await stat(again.abs)).mtimeMs).toBe(mtime1);

      await seedFile(`${folder}/c.txt`, 'three'); // drift → rebuild
      const rebuilt = await ensureShareZip(id, folder);
      const names = Object.keys(unzipSync(new Uint8Array(await readFile(rebuilt.abs)))).sort();
      expect(names).toEqual(['a.txt', 'c.txt']);
      expect(rebuilt.size).toBeGreaterThan(0);
      expect(zipRelForShare(id, folder)).toBe(`.shares/${id}/${folder}.zip`);
    } finally {
      await removeShareZip(id);
      await rm(absFromRelOrThrow(folder), { recursive: true, force: true });
    }
  });
});
