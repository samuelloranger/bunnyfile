import { beforeAll, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';

const testRoot = await mkdtemp(join(tmpdir(), 'bunnyfile-file-library-'));
process.env.DB_PATH = join(testRoot, 'test.sqlite');
process.env.DATA_DIR = join(testRoot, 'data');
process.env.BETTER_AUTH_SECRET = 'test-secret';

/**
 * Compensation suites need `mock.module`, which is process-wide and permanent,
 * so each one runs in its own `bun test` child. Failing the parent on a
 * non-zero exit keeps them wired into the normal `bun test` run.
 */
function runIsolatedSuite(fileName: string): void {
  const proc = Bun.spawnSync(['bun', 'test', join(import.meta.dir, fileName)], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (proc.exitCode !== 0) {
    console.error(proc.stdout.toString());
    console.error(proc.stderr.toString());
  }
  expect(proc.exitCode).toBe(0);
}

const [{ runMigrations }, { db }, { fileIndex, user }, library, { openStream }, search] =
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

describe('File Library — upload / createLibraryFolder', () => {
  beforeAll(async () => {
    await mkdir(process.env.DATA_DIR!, { recursive: true });
    runMigrations();
    await db
      .insert(user)
      .values([
        {
          id: 'lib-user',
          name: 'Lib User',
          email: 'lib@example.com',
          emailVerified: true,
          role: 'admin',
        },
        {
          id: 'other-user',
          name: 'Other User',
          email: 'other@example.com',
          emailVerified: true,
          role: 'user',
        },
      ])
      .onConflictDoNothing();
  });

  test('upload compensates bytes, index, and search when metadata fails after index upsert', () => {
    runIsolatedSuite('library-compensate-isolated.ts');
  });

  test('failed overwrite never deletes the target bytes', () => {
    runIsolatedSuite('library-overwrite-compensate-isolated.ts');
  });

  test('upload writes bytes, index row, and search hit', async () => {
    const path = `up-${crypto.randomUUID().slice(0, 8)}.txt`;
    const result = await library.upload(path, streamFromText('hello library'), {
      mime: 'text/plain',
      uploadedByUserId: 'lib-user',
    });
    expect(result.path).toBe(path);
    expect(result.size).toBe(13);
    expect(result.sha256).toHaveLength(64);

    const { stat } = await openStream(path);
    expect(stat.size).toBe(13);

    const row = db.select().from(fileIndex).where(eq(fileIndex.path, path)).get();
    expect(row?.size).toBe(13);
    expect(row?.uploadedByUserId).toBe('lib-user');

    const hits = await search.searchFiles(path.slice(0, 8), 20);
    expect(hits.some((h) => h.path === path)).toBe(true);
  });

  test('createLibraryFolder makes listing-visible empty dir', async () => {
    const path = `dir-${crypto.randomUUID().slice(0, 8)}`;
    const result = await library.createLibraryFolder(path);
    expect(result.path).toBe(path);
    const { listImmediateDirectories } = await import('./store');
    const dirs = await listImmediateDirectories('');
    expect(dirs).toContain(path);
  });
});

describe('File Library — move', () => {
  test('move compensates bytes and index when metadata fails after rename', () => {
    runIsolatedSuite('library-move-compensate-isolated.ts');
  });

  test('move updates bytes, index path, and search', async () => {
    const from = `mv-from-${crypto.randomUUID().slice(0, 8)}.txt`;
    const to = `mv-to-${crypto.randomUUID().slice(0, 8)}.txt`;
    await library.upload(from, streamFromText('move me'), {
      mime: 'text/plain',
      uploadedByUserId: 'lib-user',
    });
    const result = await library.move(from, to);
    expect(result.path).toBe(to);

    await expect(openStream(from)).rejects.toBeInstanceOf((await import('./store')).PathError);
    const { stat } = await openStream(to);
    expect(stat.size).toBe(7);

    expect(db.select().from(fileIndex).where(eq(fileIndex.path, from)).get()).toBeUndefined();
    expect(db.select().from(fileIndex).where(eq(fileIndex.path, to)).get()?.size).toBe(7);

    const hits = await search.searchFiles(to.slice(0, 8), 20);
    expect(hits.some((h) => h.path === to)).toBe(true);
  });
});

describe('File Library — trash', () => {
  test('trashFile removes from index and search; restore path kept in trash_item', async () => {
    const { trashItem } = await import('../db/schema');
    const path = `tr-${crypto.randomUUID().slice(0, 8)}.txt`;
    await library.upload(path, streamFromText('bye'), {
      mime: 'text/plain',
      uploadedByUserId: 'lib-user',
    });
    await library.trashFile(path, 'lib-user');

    expect(db.select().from(fileIndex).where(eq(fileIndex.path, path)).get()).toBeUndefined();
    const row = db.select().from(trashItem).where(eq(trashItem.originalPath, path)).get();
    expect(row?.kind).toBe('file');
    expect(row?.deletedByUserId).toBe('lib-user');
    await expect(openStream(path)).rejects.toBeInstanceOf((await import('./store')).PathError);
  });

  test('trashFolder removes subtree index rows', async () => {
    const { trashItem } = await import('../db/schema');
    const folder = `tf-${crypto.randomUUID().slice(0, 8)}`;
    const child = `${folder}/child.txt`;
    await library.createLibraryFolder(folder);
    await library.upload(child, streamFromText('nested'), {
      mime: 'text/plain',
      uploadedByUserId: 'lib-user',
    });
    await library.trashFolder(folder, 'lib-user');

    expect(db.select().from(fileIndex).where(eq(fileIndex.path, child)).get()).toBeUndefined();
    const row = db.select().from(trashItem).where(eq(trashItem.originalPath, folder)).get();
    expect(row?.kind).toBe('dir');
  });

  test('trash compensates bytes, index, search and trash row when metadata fails', () => {
    runIsolatedSuite('library-trash-compensate-isolated.ts');
  });
});

describe('File Library — restore / remove', () => {
  test('restore file brings bytes and index back', async () => {
    const { trashItem } = await import('../db/schema');
    const path = `rs-${crypto.randomUUID().slice(0, 8)}.txt`;
    await library.upload(path, streamFromText('back'), {
      mime: 'text/plain',
      uploadedByUserId: 'lib-user',
    });
    await library.trashFile(path, 'lib-user');
    const tid = db.select().from(trashItem).where(eq(trashItem.originalPath, path)).get()!.id;

    const result = await library.restore(tid, { userId: 'lib-user', role: 'admin' });
    expect(result.path).toBe(path);
    const { stat } = await openStream(path);
    expect(stat.size).toBe(4);
    expect(db.select().from(fileIndex).where(eq(fileIndex.path, path)).get()?.size).toBe(4);
  });

  test('remove permanently deletes trash bytes and row', async () => {
    const { trashItem } = await import('../db/schema');
    const path = `rm-${crypto.randomUUID().slice(0, 8)}.txt`;
    await library.upload(path, streamFromText('gone'), {
      mime: 'text/plain',
      uploadedByUserId: 'lib-user',
    });
    await library.trashFile(path, 'lib-user');
    const tid = db.select().from(trashItem).where(eq(trashItem.originalPath, path)).get()!.id;

    await library.remove(tid, { userId: 'lib-user', role: 'admin' });
    expect(db.select().from(trashItem).where(eq(trashItem.id, tid)).get()).toBeUndefined();
  });

  test('restore rejects another user trash row as not_found', async () => {
    const { trashItem } = await import('../db/schema');
    const path = `rs-own-${crypto.randomUUID().slice(0, 8)}.txt`;
    await library.upload(path, streamFromText('private'), {
      mime: 'text/plain',
      uploadedByUserId: 'other-user',
    });
    await library.trashFile(path, 'other-user');
    const tid = db.select().from(trashItem).where(eq(trashItem.originalPath, path)).get()!.id;

    try {
      await library.restore(tid, { userId: 'lib-user', role: 'user' });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(library.LibraryError);
      expect(err).toMatchObject({ code: 'not_found' });
    }
  });

  test('remove rejects another user trash row as not_found', async () => {
    const { trashItem } = await import('../db/schema');
    const path = `rm-own-${crypto.randomUUID().slice(0, 8)}.txt`;
    await library.upload(path, streamFromText('private'), {
      mime: 'text/plain',
      uploadedByUserId: 'other-user',
    });
    await library.trashFile(path, 'other-user');
    const tid = db.select().from(trashItem).where(eq(trashItem.originalPath, path)).get()!.id;

    try {
      await library.remove(tid, { userId: 'lib-user', role: 'user' });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(library.LibraryError);
      expect(err).toMatchObject({ code: 'not_found' });
    }
    expect(db.select().from(trashItem).where(eq(trashItem.id, tid)).get()).toBeDefined();
  });
});

describe('File Library — emptyTrash', () => {
  test('non-admin only empties their own trash rows', async () => {
    const { trashItem } = await import('../db/schema');
    const mine = `et-mine-${crypto.randomUUID().slice(0, 8)}.txt`;
    const theirs = `et-theirs-${crypto.randomUUID().slice(0, 8)}.txt`;
    for (const [path, owner] of [
      [mine, 'lib-user'],
      [theirs, 'other-user'],
    ] as const) {
      await library.upload(path, streamFromText('bye'), {
        mime: 'text/plain',
        uploadedByUserId: owner,
      });
      await library.trashFile(path, owner);
    }

    const { removed } = await library.emptyTrash({ userId: 'lib-user', role: 'user' });
    expect(removed).toBeGreaterThanOrEqual(1);
    expect(
      db.select().from(trashItem).where(eq(trashItem.originalPath, mine)).get(),
    ).toBeUndefined();
    expect(
      db.select().from(trashItem).where(eq(trashItem.originalPath, theirs)).get(),
    ).toBeDefined();
  });

  test('admin empties every trash row and deletes the bytes', async () => {
    const { trashItem } = await import('../db/schema');
    const path = `et-admin-${crypto.randomUUID().slice(0, 8)}.txt`;
    await library.upload(path, streamFromText('bye'), {
      mime: 'text/plain',
      uploadedByUserId: 'other-user',
    });
    await library.trashFile(path, 'other-user');
    const trashPath = db
      .select()
      .from(trashItem)
      .where(eq(trashItem.originalPath, path))
      .get()!.trashPath;

    await library.emptyTrash({ userId: 'lib-user', role: 'admin' });
    expect(db.select().from(trashItem).all()).toHaveLength(0);
    const { DATA_ROOT } = await import('./store');
    expect(await Bun.file(join(DATA_ROOT, trashPath)).exists()).toBe(false);
  });
});
