import { queryOptions } from '@tanstack/react-query';
import { api } from './api';

export type StorageUsage = {
  usedBytes: number;
  fileCount: number;
  totalBytes: number | null;
  freeBytes: number | null;
};

export const storageUsageQuery = () =>
  queryOptions({
    queryKey: ['storage-usage'],
    queryFn: async () => {
      const { data, error } = await api.api.files.usage.get();
      if (error) throw error;
      if ('error' in data) throw new Error(data.error);
      return data as StorageUsage;
    },
    refetchInterval: 10_000,
  });

export function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB', 'PB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}
