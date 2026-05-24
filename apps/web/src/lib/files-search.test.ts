import { describe, expect, it } from 'bun:test';
import { parseFilesSearch, shouldUseGlobalSearch } from './files-search';

describe('parseFilesSearch', () => {
  it('returns defaults for empty search', () => {
    expect(parseFilesSearch({})).toEqual({
      path: '',
      q: '',
      mode: 'folder',
      upload: false,
    });
  });

  it('parses path and query', () => {
    expect(parseFilesSearch({ path: 'docs/reports', q: 'invoice' })).toEqual({
      path: 'docs/reports',
      q: 'invoice',
      mode: 'folder',
      upload: false,
    });
  });

  it('parses all-files mode', () => {
    expect(parseFilesSearch({ mode: 'all', q: 'report' })).toEqual({
      path: '',
      q: 'report',
      mode: 'all',
      upload: false,
    });
  });

  it('parses upload trigger', () => {
    expect(parseFilesSearch({ upload: '1' })).toEqual({
      path: '',
      q: '',
      mode: 'folder',
      upload: true,
    });
    expect(parseFilesSearch({ upload: 1 })).toMatchObject({ upload: true });
  });

  it('ignores invalid mode values', () => {
    expect(parseFilesSearch({ mode: 'global' }).mode).toBe('folder');
  });
});

describe('shouldUseGlobalSearch', () => {
  it('requires all mode and at least two characters', () => {
    expect(shouldUseGlobalSearch('all', 'a')).toBe(false);
    expect(shouldUseGlobalSearch('all', 'ab')).toBe(true);
    expect(shouldUseGlobalSearch('folder', 'abcd')).toBe(false);
  });

  it('trims whitespace before checking length', () => {
    expect(shouldUseGlobalSearch('all', '  x  ')).toBe(false);
    expect(shouldUseGlobalSearch('all', '  xy  ')).toBe(true);
  });
});
