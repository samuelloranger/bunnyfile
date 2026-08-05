import { beforeAll, describe, expect, mock, test } from 'bun:test';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';

const testRoot = await mkdtemp(join(tmpdir(), 'bunnyfile-lib-compensate-'));
process.env.DB_PATH = join(testRoot, 'test.sqlite');
process.env.DATA_DIR = join(testRoot, 'data');
process.env.BETTER_AUTH_SECRET = 'test-secret';

const eventsModule = await import('./events');

mock.module('./events', () => ({
  ...eventsModule,
  broadcastFilesChanged: () => {
    throw new Error('injected broadcastFilesChanged failure');
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

describe('File Library — upload compensation (isolated)', () => {
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

  test('upload removes bytes, index, and search when metadata fails after index upsert', async () => {
    const path = `comp-${crypto.randomUUID().slice(0, 8)}.txt`;
    await expect(
      library.upload(path, streamFromText('compensate me'), {
        mime: 'text/plain',
        uploadedByUserId: 'lib-user',
      }),
    ).rejects.toThrow('injected broadcastFilesChanged failure');

    await expect(store.openStream(path)).rejects.toThrow('not found');

    const row = db.select().from(fileIndex).where(eq(fileIndex.path, path)).get();
    expect(row).toBeUndefined();

    const hits = await search.searchFiles(path.slice(0, 8), 20);
    expect(hits.some((h) => h.path === path)).toBe(false);
  });
});
