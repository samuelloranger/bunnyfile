import { queryOptions } from '@tanstack/react-query';
import { api } from './api';

async function fetchUsers() {
  const { data, error } = await api.api.users.get();
  if (error) throw error;
  if (!Array.isArray(data)) throw new Error('Unexpected users response');
  return data;
}

export const usersQuery = queryOptions({
  queryKey: ['users'],
  queryFn: fetchUsers,
  staleTime: 30_000,
});

export type UserRow = Awaited<ReturnType<typeof fetchUsers>>[number];
