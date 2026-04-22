import { queryOptions } from '@tanstack/react-query';
import { api } from './api';
import { formatBytes } from './storage';

export type RecentEntry = {
  path: string;
  size: number;
  mime: string;
  mtimeMs: number;
};

export const recentFilesQuery = (limit = 8) =>
  queryOptions({
    queryKey: ['recent-files', limit],
    queryFn: async () => {
      const { data, error } = await api.api.files.recent.get({ query: { limit } });
      if (error) throw error;
      if ('error' in data) throw new Error(data.error);
      return data.entries as RecentEntry[];
    },
    refetchInterval: 10_000,
  });

export function relativeTime(mtimeMs: number): string {
  const delta = Math.round((Date.now() - mtimeMs) / 1000);
  if (delta < 60) return 'just now';
  if (delta < 3600) return `${Math.round(delta / 60)}m ago`;
  if (delta < 86_400) return `${Math.round(delta / 3600)}h ago`;
  if (delta < 86_400 * 30) return `${Math.round(delta / 86_400)}d ago`;
  return new Date(mtimeMs).toLocaleDateString();
}

export function displayName(path: string): string {
  return path.split('/').at(-1) ?? path;
}

export function entryMeta(entry: RecentEntry): string {
  return `${formatBytes(entry.size)} · ${relativeTime(entry.mtimeMs)}`;
}
