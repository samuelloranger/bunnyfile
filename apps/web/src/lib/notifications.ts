import { toast } from 'sonner';

export type AppNotification = {
  id: string;
  kind: 'success' | 'error' | 'info';
  title: string;
  body?: string | undefined;
  createdAt: number;
  read: boolean;
};

const KEY = 'bunnyfile.notifications';
const EVENT = 'bunnyfile-notifications-changed';
const MAX = 30;

function read(): AppNotification[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as AppNotification[]) : [];
  } catch {
    return [];
  }
}

function write(items: AppNotification[]) {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(KEY, JSON.stringify(items.slice(0, MAX)));
  window.dispatchEvent(new Event(EVENT));
}

export function listNotifications(): AppNotification[] {
  return read();
}

export function pushNotification(input: Omit<AppNotification, 'id' | 'createdAt' | 'read'>) {
  const item: AppNotification = {
    ...input,
    id: crypto.randomUUID(),
    createdAt: Date.now(),
    read: false,
  };
  write([item, ...read()]);
  if (input.kind === 'success') toast.success(input.title);
  else if (input.kind === 'error') toast.error(input.title);
  else toast(input.title);
}

export function markNotificationsRead() {
  write(read().map((item) => ({ ...item, read: true })));
}

export function clearNotifications() {
  write([]);
}

export function subscribeNotifications(fn: () => void) {
  window.addEventListener(EVENT, fn);
  return () => window.removeEventListener(EVENT, fn);
}
