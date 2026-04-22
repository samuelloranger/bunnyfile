import { afterAll, describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
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
