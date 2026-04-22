import { queryOptions } from '@tanstack/react-query';
import { api } from './api';

export const setupStatusQuery = queryOptions({
  queryKey: ['setup-status'],
  queryFn: async () => {
    const { data, error } = await api.api.setup.status.get();
    if (error) throw error;
    return data;
  },
  staleTime: 60_000,
});
