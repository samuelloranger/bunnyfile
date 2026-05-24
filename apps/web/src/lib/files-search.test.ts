import { describe, expect, it } from 'bun:test';
import {
  buildFilesSearch,
  parseFilesSearch,
  resolveFilesSearch,
  shouldUseGlobalSearch,
} from './files-search';

describe('parseFilesSearch', () => {
  it('returns an empty object for empty search so URLs stay clean', () => {
    expect(parseFilesSearch({})).toEqual({});
  });

  it('parses only the fields that are present and non-default', () => {
    expect(parseFilesSearch({ path: 'docs/reports', q: 'invoice' })).toEqual({
      path: 'docs/reports',
      q: 'invoice',
    });
  });

  it('parses all-files mode', () => {
    expect(parseFilesSearch({ mode: 'all', q: 'report' })).toEqual({
      q: 'report',
      mode: 'all',
    });
  });

  it('parses upload trigger from any truthy representation', () => {
    expect(parseFilesSearch({ upload: '1' })).toEqual({ upload: true });
    expect(parseFilesSearch({ upload: 1 })).toEqual({ upload: true });
    expect(parseFilesSearch({ upload: true })).toEqual({ upload: true });
    expect(parseFilesSearch({ upload: 'true' })).toEqual({ upload: true });
  });

  it('drops invalid mode values', () => {
    expect(parseFilesSearch({ mode: 'global' }).mode).toBeUndefined();
    expect(parseFilesSearch({ mode: 'folder' }).mode).toBeUndefined();
  });
});

describe('resolveFilesSearch', () => {
  it('fills in defaults for missing fields', () => {
    expect(resolveFilesSearch({})).toEqual({
      path: '',
      q: '',
      mode: 'folder',
      upload: false,
    });
  });

  it('preserves provided fields', () => {
    expect(resolveFilesSearch({ path: 'docs', mode: 'all' })).toEqual({
      path: 'docs',
      q: '',
      mode: 'all',
      upload: false,
    });
  });
});

describe('buildFilesSearch', () => {
  it('returns an empty object for defaults so URLs stay clean', () => {
    expect(buildFilesSearch()).toEqual({});
    expect(buildFilesSearch({ path: '', q: '', mode: 'folder', upload: false })).toEqual({});
  });

  it('omits each field that is at its default', () => {
    expect(buildFilesSearch({ path: 'docs' })).toEqual({ path: 'docs' });
    expect(buildFilesSearch({ q: 'foo' })).toEqual({ q: 'foo' });
    expect(buildFilesSearch({ mode: 'all' })).toEqual({ mode: 'all' });
    expect(buildFilesSearch({ upload: true })).toEqual({ upload: true });
  });

  it('combines non-default fields', () => {
    expect(buildFilesSearch({ path: 'docs', q: 'foo', mode: 'all' })).toEqual({
      path: 'docs',
      q: 'foo',
      mode: 'all',
    });
  });

  it('round-trips through parseFilesSearch and resolveFilesSearch', () => {
    const fromBuild = buildFilesSearch({ path: 'a', q: 'b', mode: 'all', upload: true });
    expect(resolveFilesSearch(parseFilesSearch(fromBuild))).toEqual({
      path: 'a',
      q: 'b',
      mode: 'all',
      upload: true,
    });
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
