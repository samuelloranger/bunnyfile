import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unzipSync } from 'fflate';
import { createFolderZipStream, zipFolderToFile } from './zip';

async function makeTree() {
  const root = await mkdtemp(join(tmpdir(), 'bf-zip-'));
  await writeFile(join(root, 'a.txt'), 'hello a');
  await mkdir(join(root, 'sub'), { recursive: true });
  await writeFile(join(root, 'sub', 'b.bin'), Buffer.from([0, 1, 2, 255, 254]));
  return root;
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  for await (const c of stream as unknown as AsyncIterable<Uint8Array>) chunks.push(c);
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

describe('zip engine', () => {
  test('stream round-trips folder byte-exactly', async () => {
    const root = await makeTree();
    try {
      const zipped = await collect(createFolderZipStream(root));
      const files = unzipSync(zipped);
      expect(new TextDecoder().decode(files['a.txt'])).toBe('hello a');
      expect(Array.from(files['sub/b.bin']!)).toEqual([0, 1, 2, 255, 254]);
      expect(Object.keys(files).sort()).toEqual(['a.txt', 'sub/b.bin']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('zipFolderToFile writes a valid zip', async () => {
    const root = await makeTree();
    const dest = join(root, '..', `out-${crypto.randomUUID()}.zip`);
    try {
      await zipFolderToFile(root, dest);
      const files = unzipSync(new Uint8Array(await readFile(dest)));
      expect(new TextDecoder().decode(files['a.txt'])).toBe('hello a');
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(dest, { force: true });
    }
  });

  test('empty folder produces a valid empty zip', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bf-zip-empty-'));
    try {
      const zipped = await collect(createFolderZipStream(root));
      expect(Object.keys(unzipSync(zipped))).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
