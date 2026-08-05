/**
 * Runs in its own `bun test` process (spawned from library.test.ts).
 *
 * `mock.module` patches a module for the whole process and cannot be undone,
 * so every suite that needs a *failing* dependency lives in its own file.
 *
 * What is pinned here: when trashing fails partway, the rollback must undo the
 * database writes too — not just move the bytes back. Otherwise the file
 * reappears in the library while a phantom `trash_item` row points at a path
 * that no longer exists.
 */
import { beforeAll, describe, expect, mock, test } from 'bun:test';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';

const testRoot = await mkdtemp(join(tmpdir(), 'bunnyfile-lib-trash-compensate-'));
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

const [{ runMigrations }, { db }, { fileIndex, trashItem, user }, library, store, search] =
  await Promise.all([
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

describe('File Library — trash compensation (isolated)', () => {
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

  test('trashFile restores bytes, index, search and drops the trash row', async () => {
    const path = `tr-comp-${crypto.randomUUID().slice(0, 8)}.txt`;
    failBroadcast = false;
    await library.upload(path, streamFromText('keep me'), {
      mime: 'text/plain',
      uploadedByUserId: 'lib-user',
    });

    failBroadcast = true;
    await expect(library.trashFile(path, 'lib-user')).rejects.toThrow(
      'injected broadcastFilesChanged failure',
    );
    failBroadcast = false;

    const { stat } = await store.openStream(path);
    expect(stat.size).toBe(7);
    const row = db.select().from(fileIndex).where(eq(fileIndex.path, path)).get();
    expect(row?.size).toBe(7);
    expect(row?.uploadedByUserId).toBe('lib-user');
    expect(
      db.select().from(trashItem).where(eq(trashItem.originalPath, path)).get(),
    ).toBeUndefined();
    const hits = await search.searchFiles(path.slice(0, 8), 20);
    expect(hits.some((h) => h.path === path)).toBe(true);
  });

  test('trashFolder restores the subtree and drops the trash row', async () => {
    const folder = `tf-comp-${crypto.randomUUID().slice(0, 8)}`;
    const child = `${folder}/child.txt`;
    failBroadcast = false;
    await library.createLibraryFolder(folder);
    await library.upload(child, streamFromText('nested'), {
      mime: 'text/plain',
      uploadedByUserId: 'lib-user',
    });

    failBroadcast = true;
    await expect(library.trashFolder(folder, 'lib-user')).rejects.toThrow(
      'injected broadcastFilesChanged failure',
    );
    failBroadcast = false;

    const { stat } = await store.openStream(child);
    expect(stat.size).toBe(6);
    expect(db.select().from(fileIndex).where(eq(fileIndex.path, child)).get()?.size).toBe(6);
    expect(
      db.select().from(trashItem).where(eq(trashItem.originalPath, folder)).get(),
    ).toBeUndefined();
  });
});
