import { describe, expect, test } from 'bun:test';
import { userRel } from './user-path';

describe('userRel', () => {
  test('allows normal paths', () => {
    expect(userRel('docs/a.txt')).toBe('docs/a.txt');
    expect(userRel('')).toBe('');
  });

  test('rejects reserved top segments', () => {
    for (const top of ['s3', '.trash', '.multipart', '.shares']) {
      expect(userRel(top)).toBeNull();
      expect(userRel(`${top}/x`)).toBeNull();
    }
  });

  test('rejects traversal via safeRelPath', () => {
    expect(userRel('../x')).toBeNull();
  });
});
