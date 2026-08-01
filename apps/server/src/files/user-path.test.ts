import { describe, expect, test } from 'bun:test';
import { userRel } from './user-path';

describe('userRel', () => {
  test('allows normal paths including former reserved names under files/', () => {
    expect(userRel('docs/a.txt')).toBe('docs/a.txt');
    expect(userRel('')).toBe('');
    expect(userRel('s3')).toBe('s3');
    expect(userRel('s3/x')).toBe('s3/x');
  });

  test('rejects traversal via safeRelPath', () => {
    expect(userRel('../x')).toBeNull();
  });
});
