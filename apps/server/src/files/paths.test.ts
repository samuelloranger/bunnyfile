import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveInRoot, safeRelPath } from './paths';

describe('safeRelPath', () => {
  test('normalizes empty and dot to root', () => {
    expect(safeRelPath(null)).toBe('');
    expect(safeRelPath(undefined)).toBe('');
    expect(safeRelPath('')).toBe('');
    expect(safeRelPath('.')).toBe('');
    expect(safeRelPath('/')).toBe('');
  });

  test('strips leading slashes and collapses separators', () => {
    expect(safeRelPath('/docs/a.txt')).toBe('docs/a.txt');
    expect(safeRelPath('docs\\\\a.txt')).toBe('docs/a.txt');
    expect(safeRelPath('docs//a.txt')).toBe('docs/a.txt');
    expect(safeRelPath('docs/a.txt/')).toBe('docs/a.txt');
  });

  test('rejects traversal and NUL', () => {
    expect(safeRelPath('../x')).toBeNull();
    expect(safeRelPath('a/../b')).toBeNull();
    expect(safeRelPath('a/./b')).toBeNull();
    expect(safeRelPath('a\0b')).toBeNull();
  });
});

describe('resolveInRoot', () => {
  test('resolves under root and rejects escape', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bf-paths-'));
    try {
      expect(resolveInRoot(root, 'a.txt')).toBe(join(root, 'a.txt'));
      expect(resolveInRoot(root, 'sub/b')).toBe(join(root, 'sub/b'));
      expect(resolveInRoot(root, '/abs')).toBeNull();
      // `..` relative escapes — resolve() would leave root
      expect(resolveInRoot(root, join('..', 'outside'))).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
