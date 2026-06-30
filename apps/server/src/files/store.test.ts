import { afterAll, describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dataDir = await mkdtemp(join(tmpdir(), 'bunnyfile-store-test-'));
process.env.DATA_DIR = dataDir;

const { PathError, createFolder, listImmediateDirectories, moveFile, openStream, writeUpload } =
  await import('./store');

function streamFromText(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

function streamFromBytes(bytes: Uint8Array, chunk = 64 * 1024): ReadableStream<Uint8Array> {
  let off = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (off >= bytes.length) {
        controller.close();
        return;
      }
      controller.enqueue(bytes.subarray(off, off + chunk));
      off += chunk;
    },
  });
}

describe('writeUpload integrity', () => {
  it('round-trips bytes exactly and reports a correct sha256', async () => {
    // Multi-chunk binary payload — exercises streaming, not just a tiny string.
    const bytes = crypto.getRandomValues(new Uint8Array(300_000));
    const expected = createHash('sha256').update(bytes).digest('hex');
    const rel = `rt-${crypto.randomUUID().slice(0, 8)}.bin`;

    const res = await writeUpload(rel, streamFromBytes(bytes));
    expect(res.size).toBe(bytes.length);
    expect(res.sha256).toBe(expected);

    const { path, stat } = await openStream(rel);
    expect(stat.size).toBe(bytes.length);
    const onDisk = new Uint8Array(await Bun.file(path).arrayBuffer());
    expect(createHash('sha256').update(onDisk).digest('hex')).toBe(expected);
  });

  it('leaves no .tmp- artifact behind after a successful write', async () => {
    const rel = `clean-${crypto.randomUUID().slice(0, 8)}.txt`;
    await writeUpload(rel, streamFromText('done'));
    const names = await readdir(dataDir);
    expect(names.some((n) => n.includes('.tmp-'))).toBe(false);
  });
});

describe('moveFile', () => {
  it('moves file and keeps bytes intact', async () => {
    const id = crypto.randomUUID().slice(0, 8);
    const source = `hello-${id}.txt`;
    const target = `docs/greeting-${id}.txt`;
    await writeUpload(source, streamFromText('hello world'));
    await moveFile(source, target);

    await expect(openStream(source)).rejects.toBeInstanceOf(PathError);
    const moved = await openStream(target);
    expect(moved.stat.size).toBe(11);
  });

  it('fails when destination already exists', async () => {
    const id = crypto.randomUUID().slice(0, 8);
    const a = `a-${id}.txt`;
    const b = `b-${id}.txt`;
    await writeUpload(a, streamFromText('a'));
    await writeUpload(b, streamFromText('b'));

    await expect(moveFile(a, b)).rejects.toMatchObject({ code: 'exists' });
  });
});

describe('folders', () => {
  it('creates a folder and lists it even when empty', async () => {
    await createFolder('empty-dir');
    const dirs = await listImmediateDirectories('');
    expect(dirs).toContain('empty-dir');
  });
});

afterAll(async () => {
  await rm(dataDir, { recursive: true, force: true });
});
