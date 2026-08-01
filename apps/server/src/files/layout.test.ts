import { describe, expect, test } from 'bun:test';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureDataLayout, LAYOUT_MARKER } from './layout';

async function exists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch {
    try {
      const { stat } = await import('node:fs/promises');
      await stat(path);
      return true;
    } catch {
      return false;
    }
  }
}

describe('ensureDataLayout', () => {
  test('fresh: creates siblings + marker', async () => {
    const dataDir = join(tmpdir(), `bf-layout-fresh-${crypto.randomUUID()}`);
    await mkdir(dataDir, { recursive: true });
    try {
      await ensureDataLayout(dataDir);
      expect(await exists(join(dataDir, 'files'))).toBe(true);
      expect(await exists(join(dataDir, 's3'))).toBe(true);
      expect(await exists(join(dataDir, 'trash'))).toBe(true);
      expect(await exists(join(dataDir, 'shares'))).toBe(true);
      expect(await exists(join(dataDir, 'multipart'))).toBe(true);
      expect(await exists(join(dataDir, LAYOUT_MARKER))).toBe(true);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  test('legacy: moves user files into files/, renames dotted internals', async () => {
    const dataDir = join(tmpdir(), `bf-layout-legacy-${crypto.randomUUID()}`);
    await mkdir(dataDir, { recursive: true });
    try {
      await writeFile(join(dataDir, 'a.txt'), 'x');
      await mkdir(join(dataDir, 's3', 'b'), { recursive: true });
      await mkdir(join(dataDir, '.trash'), { recursive: true });
      await mkdir(join(dataDir, '.shares'), { recursive: true });
      await mkdir(join(dataDir, '.multipart'), { recursive: true });
      await ensureDataLayout(dataDir);
      expect(await readFile(join(dataDir, 'files', 'a.txt'), 'utf8')).toBe('x');
      expect(await exists(join(dataDir, 's3', 'b'))).toBe(true);
      expect(await exists(join(dataDir, 'trash'))).toBe(true);
      expect(await exists(join(dataDir, '.trash'))).toBe(false);
      expect(await exists(join(dataDir, LAYOUT_MARKER))).toBe(true);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  test('idempotent when files/ exists', async () => {
    const dataDir = join(tmpdir(), `bf-layout-idem-${crypto.randomUUID()}`);
    await mkdir(dataDir, { recursive: true });
    try {
      await ensureDataLayout(dataDir);
      await writeFile(join(dataDir, 'files', 'keep.txt'), 'y');
      await ensureDataLayout(dataDir);
      expect(await readFile(join(dataDir, 'files', 'keep.txt'), 'utf8')).toBe('y');
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});
