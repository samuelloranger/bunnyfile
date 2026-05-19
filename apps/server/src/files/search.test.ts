import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import {
  deleteFileSearchPrefix,
  rebuildFileSearchIndex,
  searchFiles,
  upsertFileSearch,
} from './search';

const testRoot = await mkdtemp(join(tmpdir(), 'bunnyfile-search-test-'));
process.env.DB_PATH = join(testRoot, 'test.sqlite');
process.env.DATA_DIR = join(testRoot, 'data');

const { db } = await import('../db');
const { runMigrations } = await import('../db/migrate');
const { fileIndex } = await import('../db/schema');

describe('file search (FTS5)', () => {
  beforeAll(async () => {
    await mkdir(process.env.DATA_DIR!, { recursive: true });
    runMigrations();
    await db.insert(fileIndex).values([
      {
        path: 'photos/vacation.jpg',
        size: 100,
        mtimeMs: Date.now(),
        inode: 1,
        sha256: null,
        mime: 'image/jpeg',
      },
      {
        path: 'docs/report-final.pdf',
        size: 200,
        mtimeMs: Date.now(),
        inode: 2,
        sha256: null,
        mime: 'application/pdf',
      },
      {
        path: 'archive/backup-2024.tar.gz',
        size: 300,
        mtimeMs: Date.now(),
        inode: 3,
        sha256: null,
        mime: 'application/gzip',
      },
    ]);
    await rebuildFileSearchIndex();
  });

  it('finds files by filename prefix', async () => {
    const hits = await searchFiles('vacation');
    expect(hits.some((h) => h.path === 'photos/vacation.jpg')).toBe(true);
  });

  it('finds files by partial token', async () => {
    const hits = await searchFiles('report');
    expect(hits.some((h) => h.path === 'docs/report-final.pdf')).toBe(true);
  });

  it('updates index on upsert', async () => {
    await db.insert(fileIndex).values({
      path: 'notes/todo.txt',
      size: 10,
      mtimeMs: Date.now(),
      inode: 4,
      sha256: null,
      mime: 'text/plain',
    });
    await upsertFileSearch('notes/todo.txt');
    const hits = await searchFiles('todo');
    expect(hits.some((h) => h.path === 'notes/todo.txt')).toBe(true);
  });

  it('removes folder descendants from the search index', async () => {
    await db.insert(fileIndex).values([
      {
        path: 'delete-me/report.txt',
        size: 10,
        mtimeMs: Date.now(),
        inode: 5,
        sha256: null,
        mime: 'text/plain',
      },
      {
        path: 'delete-me/nested/report.txt',
        size: 10,
        mtimeMs: Date.now(),
        inode: 6,
        sha256: null,
        mime: 'text/plain',
      },
    ]);
    await upsertFileSearch('delete-me/report.txt');
    await upsertFileSearch('delete-me/nested/report.txt');

    await db.delete(fileIndex).where(eq(fileIndex.path, 'delete-me/report.txt'));
    await db.delete(fileIndex).where(eq(fileIndex.path, 'delete-me/nested/report.txt'));
    await deleteFileSearchPrefix('delete-me');

    const hits = await searchFiles('report');
    expect(hits.some((h) => h.path.startsWith('delete-me/'))).toBe(false);
  });
});

afterAll(async () => {
  await rm(testRoot, { recursive: true, force: true });
});
