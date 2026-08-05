/**
 * Runs in its own `bun test` process (spawned from library.test.ts).
 *
 * `mock.module` patches a module for the whole process and cannot be undone,
 * so every suite that needs a *failing* dependency lives in its own file —
 * otherwise the injected failure would leak into the happy-path assertions.
 * The first broadcast is allowed through so the fixture upload can succeed;
 * only the move's broadcast fails.
 *
 * What is pinned here: a move that fails after the rename must put the bytes
 * back at the source and leave its metadata pointing there.
 */
import { beforeAll, describe, expect, mock, test } from 'bun:test';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';

const testRoot = await mkdtemp(join(tmpdir(), 'bunnyfile-lib-move-compensate-'));
process.env.DB_PATH = join(testRoot, 'test.sqlite');
process.env.DATA_DIR = join(testRoot, 'data');
process.env.BETTER_AUTH_SECRET = 'test-secret';

const eventsModule = await import('./events');

let broadcastCallCount = 0;

mock.module('./events', () => ({
  ...eventsModule,
  broadcastFilesChanged: () => {
    broadcastCallCount++;
    if (broadcastCallCount > 1) {
      throw new Error('injected broadcastFilesChanged failure');
    }
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

describe('File Library — move compensation (isolated)', () => {
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

  test('move restores bytes to fromRel when metadata fails after rename', async () => {
    const from = `mv-comp-from-${crypto.randomUUID().slice(0, 8)}.txt`;
    const to = `mv-comp-to-${crypto.randomUUID().slice(0, 8)}.txt`;
    await library.upload(from, streamFromText('compensate move'), {
      mime: 'text/plain',
      uploadedByUserId: 'lib-user',
    });

    await expect(library.move(from, to)).rejects.toThrow('injected broadcastFilesChanged failure');

    const { stat } = await store.openStream(from);
    expect(stat.size).toBe(15);

    await expect(store.openStream(to)).rejects.toThrow('not found');

    expect(db.select().from(fileIndex).where(eq(fileIndex.path, to)).get()).toBeUndefined();
    const fromRow = db.select().from(fileIndex).where(eq(fileIndex.path, from)).get();
    expect(fromRow?.size).toBe(15);
    expect(fromRow?.uploadedByUserId).toBe('lib-user');

    const fromHits = await search.searchFiles(from.slice(0, 8), 20);
    expect(fromHits.some((h) => h.path === from)).toBe(true);
    const toHits = await search.searchFiles(to.slice(0, 8), 20);
    expect(toHits.some((h) => h.path === to)).toBe(false);
  });
});
