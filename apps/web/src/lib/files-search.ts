export type FilesSearchMode = 'folder' | 'all';

export type FilesSearchParams = {
  path?: string;
  q?: string;
  mode?: FilesSearchMode;
  upload?: boolean;
};

export type ResolvedFilesSearch = {
  path: string;
  q: string;
  mode: FilesSearchMode;
  upload: boolean;
};

export function parseFilesSearch(search: Record<string, unknown>): FilesSearchParams {
  const out: FilesSearchParams = {};
  if (typeof search.path === 'string' && search.path) out.path = search.path;
  if (typeof search.q === 'string' && search.q) out.q = search.q;
  if (search.mode === 'all') out.mode = 'all';
  if (
    search.upload === '1' ||
    search.upload === 1 ||
    search.upload === true ||
    search.upload === 'true'
  ) {
    out.upload = true;
  }
  return out;
}

export function resolveFilesSearch(search: FilesSearchParams): ResolvedFilesSearch {
  return {
    path: search.path ?? '',
    q: search.q ?? '',
    mode: search.mode ?? 'folder',
    upload: search.upload ?? false,
  };
}

export function buildFilesSearch(params: FilesSearchParams = {}): FilesSearchParams {
  const out: FilesSearchParams = {};
  if (params.path) out.path = params.path;
  if (params.q) out.q = params.q;
  if (params.mode && params.mode !== 'folder') out.mode = params.mode;
  if (params.upload) out.upload = true;
  return out;
}

export function shouldUseGlobalSearch(mode: FilesSearchMode, q: string): boolean {
  return mode === 'all' && q.trim().length >= 2;
}

export const FILES_HOME_SEARCH: FilesSearchParams = {};
