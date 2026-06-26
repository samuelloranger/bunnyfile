import { useNavigate } from '@tanstack/react-router';
import { Bell, LogOut, Menu, Monitor, Moon, Search, Sun, User } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Avatar, AvatarFallback, AvatarImage } from '~/components/ui/avatar';
import { Button } from '~/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from '~/components/ui/dropdown-menu';
import { Input } from '~/components/ui/input';
import { Kbd } from '~/components/ui/kbd';
import { authClient } from '~/lib/auth-client';
import { buildFilesSearch } from '~/lib/files-search';
import {
  clearNotifications,
  listNotifications,
  markNotificationsRead,
  subscribeNotifications,
} from '~/lib/notifications';
import { useTheme } from '~/lib/theme';

export function Topbar({ onMenuClick }: { onMenuClick: () => void }) {
  const { theme, setTheme, resolved } = useTheme();
  const session = authClient.useSession();
  const navigate = useNavigate();
  const [searchQuery, setSearchQuery] = useState('');
  const [notifications, setNotifications] = useState(() => listNotifications());
  const user = session.data?.user;
  const unread = notifications.filter((item) => !item.read).length;
  const initials = user?.name
    ? user.name
        .split(' ')
        .map((s) => s[0])
        .slice(0, 2)
        .join('')
    : (user?.email?.[0]?.toUpperCase() ?? '?');

  async function handleSignOut() {
    await authClient.signOut();
    navigate({ to: '/login' });
  }

  useEffect(() => subscribeNotifications(() => setNotifications(listNotifications())), []);

  function submitSearch() {
    const q = searchQuery.trim();
    if (!q) return;
    navigate({ to: '/files', search: buildFilesSearch({ q, mode: 'all' }) });
    setSearchQuery('');
  }

  return (
    <header className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b border-[hsl(var(--border)/0.5)] bg-[hsl(var(--surface)/0.65)] px-4 backdrop-blur-md sm:px-6">
      <Button
        variant="ghost"
        size="icon"
        className="md:hidden"
        onClick={onMenuClick}
        aria-label="Open navigation"
      >
        <Menu />
      </Button>

      <div className="relative max-w-md flex-1">
        <Input
          type="search"
          placeholder="Search all files…"
          leftIcon={<Search />}
          rightIcon={<Kbd>⌘K</Kbd>}
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              submitSearch();
            }
          }}
        />
      </div>

      <div className="ml-auto flex items-center gap-1.5">
        <DropdownMenu
          onOpenChange={(open) => {
            if (open) {
              markNotificationsRead();
              setNotifications(listNotifications());
            }
          }}
        >
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" aria-label="Notifications" className="relative">
              <Bell />
              {unread > 0 && (
                <span
                  aria-hidden
                  className="absolute right-2 top-2 size-1.5 rounded-full bg-[hsl(var(--accent))]"
                />
              )}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-80">
            <div className="flex items-center justify-between gap-2 px-2 py-1.5">
              <DropdownMenuLabel className="p-0">Notifications</DropdownMenuLabel>
              {notifications.length > 0 && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    clearNotifications();
                    setNotifications([]);
                  }}
                >
                  Clear
                </Button>
              )}
            </div>
            <DropdownMenuSeparator />
            {notifications.length === 0 ? (
              <div className="px-2 py-6 text-center text-sm text-[hsl(var(--muted-foreground))]">
                No notifications.
              </div>
            ) : (
              <div className="max-h-80 overflow-y-auto">
                {notifications.slice(0, 10).map((item) => (
                  <div key={item.id} className="px-2 py-2">
                    <p className="text-sm font-medium">{item.title}</p>
                    {item.body && (
                      <p className="mt-0.5 line-clamp-2 text-xs text-[hsl(var(--muted-foreground))]">
                        {item.body}
                      </p>
                    )}
                    <p className="mt-1 text-[11px] text-[hsl(var(--muted-foreground))]">
                      {new Date(item.createdAt).toLocaleTimeString([], {
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </p>
                  </div>
                ))}
              </div>
            )}
          </DropdownMenuContent>
        </DropdownMenu>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" aria-label="Toggle theme">
              {resolved === 'dark' ? <Moon /> : <Sun />}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-40">
            <DropdownMenuLabel>Theme</DropdownMenuLabel>
            <DropdownMenuRadioGroup
              value={theme}
              onValueChange={(v) => setTheme(v as 'light' | 'dark' | 'system')}
            >
              <DropdownMenuRadioItem value="light">
                <Sun /> Light
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="dark">
                <Moon /> Dark
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="system">
                <Monitor /> System
              </DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="ml-1 rounded-full outline-none transition focus-visible:ring-2 focus-visible:ring-[hsl(var(--ring))] focus-visible:ring-offset-2 focus-visible:ring-offset-[hsl(var(--background))]"
              aria-label="Account menu"
            >
              <Avatar size="md">
                {user?.image && <AvatarImage src={user.image} alt="" />}
                <AvatarFallback>{initials}</AvatarFallback>
              </Avatar>
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            <div className="px-2 py-1.5">
              <p className="truncate text-sm font-medium">{user?.name ?? 'Guest'}</p>
              <p className="truncate text-xs text-[hsl(var(--muted-foreground))]">
                {user?.email ?? '—'}
              </p>
            </div>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => navigate({ to: '/profile' })}>
              <User /> Profile
              <DropdownMenuShortcut>⌘P</DropdownMenuShortcut>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem destructive onSelect={handleSignOut}>
              <LogOut /> Sign out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}
