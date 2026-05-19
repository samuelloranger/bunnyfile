import { queryOptions } from '@tanstack/react-query';
import { api } from './api';

export type FileEntry = {
  kind: 'file';
  name: string;
  path: string;
  size: number;
  mime: string;
  mtimeMs: number;
  sha256: string | null;
};

export type DirEntry = {
  kind: 'dir';
  name: string;
  path: string;
  itemCount: number;
};

export type Entry = FileEntry | DirEntry;

export type FilesPage = {
  prefix: string;
  entries: Entry[];
  total: number;
  offset: number;
  limit: number;
  hasMore: boolean;
};

async function fetchList(prefix: string, offset: number, limit: number): Promise<FilesPage> {
  // Always pass a string — Eden's generated type is `{ prefix?: string }` and
  // under `exactOptionalPropertyTypes` we can't pass `undefined`.
  const query = prefix ? { prefix, offset, limit } : { offset, limit };
  const { data, error } = await api.api.files.get({ query });
  if (error) throw error;
  if ('error' in data) throw new Error(data.error);
  return data as FilesPage;
}

export const filesQuery = (prefix: string, offset = 0, limit = 200) =>
  queryOptions({
    queryKey: ['files', prefix, offset, limit],
    queryFn: () => fetchList(prefix, offset, limit),
    staleTime: 5_000,
  });

export type SearchResult = {
  path: string;
  name: string;
  size: number;
  mime: string;
  mtimeMs: number;
};

export const filesSearchQuery = (q: string, limit = 50) =>
  queryOptions({
    queryKey: ['files-search', q, limit],
    queryFn: async () => {
      const { data, error } = await api.api.files.search.get({ query: { q, limit } });
      if (error) throw error;
      if ('error' in data) throw new Error(data.error);
      return data as { query: string; entries: SearchResult[] };
    },
    enabled: q.trim().length >= 2,
    staleTime: 3_000,
  });

export function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let n = bytes / 1024;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n < 10 ? n.toFixed(1) : Math.round(n)} ${units[i]}`;
}

export function humanTime(mtimeMs: number): string {
  const d = new Date(mtimeMs);
  const now = Date.now();
  const delta = Math.round((now - mtimeMs) / 1000);
  if (delta < 60) return 'just now';
  if (delta < 3600) return `${Math.round(delta / 60)}m ago`;
  if (delta < 86_400) return `${Math.round(delta / 3600)}h ago`;
  if (delta < 86_400 * 30) return `${Math.round(delta / 86_400)}d ago`;
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}
