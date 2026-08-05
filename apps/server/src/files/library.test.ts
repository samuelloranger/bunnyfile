import { beforeAll, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';

const testRoot = await mkdtemp(join(tmpdir(), 'bunnyfile-file-library-'));
process.env.DB_PATH = join(testRoot, 'test.sqlite');
process.env.DATA_DIR = join(testRoot, 'data');
process.env.BETTER_AUTH_SECRET = 'test-secret';

const compensateTestPath = join(import.meta.dir, 'library-compensate-isolated.ts');
const moveCompensateTestPath = join(import.meta.dir, 'library-move-compensate-isolated.ts');

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
      .values({
        id: 'lib-user',
        name: 'Lib User',
        email: 'lib@example.com',
        emailVerified: true,
        role: 'admin',
      })
      .onConflictDoNothing();
  });

  test('upload compensates bytes, index, and search when metadata fails after index upsert', async () => {
    const proc = Bun.spawnSync(['bun', 'test', compensateTestPath], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    if (proc.exitCode !== 0) {
      console.error(proc.stdout.toString());
      console.error(proc.stderr.toString());
    }
    expect(proc.exitCode).toBe(0);
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
  test('move compensates bytes and index when metadata fails after rename', async () => {
    const proc = Bun.spawnSync(['bun', 'test', moveCompensateTestPath], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    if (proc.exitCode !== 0) {
      console.error(proc.stdout.toString());
      console.error(proc.stderr.toString());
    }
    expect(proc.exitCode).toBe(0);
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
});
