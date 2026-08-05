/**
 * Runs in its own `bun test` process (spawned from library.test.ts).
 *
 * `mock.module` patches a module for the whole process and cannot be undone,
 * so every suite that needs a *failing* dependency lives in its own file —
 * otherwise the injected failure would leak into the happy-path assertions.
 *
 * What is pinned here: an upload that overwrites existing bytes must never
 * delete those bytes when the metadata work fails afterwards. "Existing" means
 * present on disk, whether or not `file_index` knows about the path.
 */
import { beforeAll, describe, expect, mock, test } from 'bun:test';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';

const testRoot = await mkdtemp(join(tmpdir(), 'bunnyfile-lib-overwrite-'));
process.env.DB_PATH = join(testRoot, 'test.sqlite');
process.env.DATA_DIR = join(testRoot, 'data');
process.env.BETTER_AUTH_SECRET = 'test-secret';

const eventsModule = await import('./events');

let failBroadcast = false;

mock.module('./events', () => ({
  ...eventsModule,
  broadcastFilesChanged: () => {
    if (failBroadcast) throw new Error('injected broadcastFilesChanged failure');
  },
}));

const [{ runMigrations }, { db }, { fileIndex, user }, library, store, search] = await Promise.all([
  import('../db/migrate'),
  import('../db'),
  import('../db/schema'),
  import('./library'),
  import('./store'),
  import('./search'),
]);

function streamFromText(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(c) {
      c.enqueue(new TextEncoder().encode(text));
      c.close();
    },
  });
}

async function readBack(rel: string): Promise<string> {
  const { path } = await store.openStream(rel);
  return await Bun.file(path).text();
}

describe('File Library — overwrite compensation (isolated)', () => {
  beforeAll(async () => {
    await mkdir(process.env.DATA_DIR!, { recursive: true });
    runMigrations();
    await db
      .insert(user)
      .values({
        id: 'lib-user',
        name: 'Lib User',
        email: 'lib@example.com',
        emailVerified: true,
        role: 'admin',
      })
      .onConflictDoNothing();
  });

  test('failed overwrite keeps the bytes and the pre-existing index row', async () => {
    const path = `ow-${crypto.randomUUID().slice(0, 8)}.txt`;
    failBroadcast = false;
    await library.upload(path, streamFromText('original'), {
      mime: 'text/plain',
      uploadedByUserId: 'lib-user',
    });

    failBroadcast = true;
    await expect(
      library.upload(path, streamFromText('replacement'), {
        mime: 'text/plain',
        uploadedByUserId: 'lib-user',
      }),
    ).rejects.toThrow('injected broadcastFilesChanged failure');
    failBroadcast = false;

    // The overwrite is not rolled back — the new bytes are on disk — but the
    // file must still exist. Deleting it would destroy the user's data.
    expect(await readBack(path)).toBe('replacement');
    const row = db.select().from(fileIndex).where(eq(fileIndex.path, path)).get();
    expect(row).toBeDefined();
    const hits = await search.searchFiles(path.slice(0, 8), 20);
    expect(hits.some((h) => h.path === path)).toBe(true);
  });

  test('failed overwrite of an unindexed on-disk file keeps the bytes', async () => {
    // A file on disk with no `file_index` row: dropped in out-of-band, or
    // simply not scanned yet. Compensation must treat this as an overwrite.
    const path = `ow-unindexed-${crypto.randomUUID().slice(0, 8)}.txt`;
    await store.writeUpload(path, streamFromText('out-of-band'));
    expect(db.select().from(fileIndex).where(eq(fileIndex.path, path)).get()).toBeUndefined();

    failBroadcast = true;
    await expect(
      library.upload(path, streamFromText('replacement'), {
        mime: 'text/plain',
        uploadedByUserId: 'lib-user',
      }),
    ).rejects.toThrow('injected broadcastFilesChanged failure');
    failBroadcast = false;

    expect(await readBack(path)).toBe('replacement');
    // The index row this upload inserted *is* rolled back — we created it.
    expect(db.select().from(fileIndex).where(eq(fileIndex.path, path)).get()).toBeUndefined();
  });
});
