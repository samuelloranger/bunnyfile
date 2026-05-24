export type FilesSearchMode = 'folder' | 'all';

export type FilesSearchParams = {
  path: string;
  q: string;
  mode: FilesSearchMode;
  upload: boolean;
};

export function parseFilesSearch(search: Record<string, unknown>): FilesSearchParams {
  const path = typeof search.path === 'string' ? search.path : '';
  const q = typeof search.q === 'string' ? search.q : '';
  const mode: FilesSearchMode = search.mode === 'all' ? 'all' : 'folder';
  const upload = search.upload === '1' || search.upload === 1 || search.upload === true;
  return { path, q, mode, upload };
}

export function buildFilesSearch(params: Partial<FilesSearchParams> = {}): FilesSearchParams {
  return parseFilesSearch({
    path: params.path ?? '',
    q: params.q ?? '',
    mode: params.mode ?? 'folder',
    upload: params.upload ? '1' : undefined,
  });
}

export function shouldUseGlobalSearch(mode: FilesSearchMode, q: string): boolean {
  return mode === 'all' && q.trim().length >= 2;
}

export const FILES_HOME_SEARCH = buildFilesSearch();
