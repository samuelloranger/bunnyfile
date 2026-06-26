import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useRouterState } from '@tanstack/react-router';
import {
  FolderOpen,
  type LucideIcon,
  Settings,
  Share2,
  Trash2,
  UploadCloud,
  Users,
} from 'lucide-react';
import type { ReactNode } from 'react';
import logo from '~/assets/logo-platform-dark.svg';
import { Badge } from '~/components/ui/badge';
import { Button } from '~/components/ui/button';
import { cn } from '~/lib/cn';
import { buildFilesSearch } from '~/lib/files-search';
import { formatBytes, storageUsageQuery } from '~/lib/storage';
import { useUploadTrigger } from '~/lib/upload-trigger';

type NavItem = {
  label: string;
  to: string;
  icon: LucideIcon;
  badge?: ReactNode;
};

const PRIMARY: NavItem[] = [
  { label: 'My files', to: '/files', icon: FolderOpen },
  { label: 'Shared', to: '/shared', icon: Share2 },
  { label: 'People', to: '/people', icon: Users },
];

const SECONDARY: NavItem[] = [
  { label: 'Trash', to: '/trash', icon: Trash2 },
  { label: 'Settings', to: '/settings', icon: Settings },
];

function NavLink({ item }: { item: NavItem }) {
  const { location } = useRouterState();
  const active =
    item.to === '/'
      ? location.pathname === '/'
      : location.pathname === item.to || location.pathname.startsWith(`${item.to}/`);
  const Icon = item.icon;

  return (
    <Link
      to={item.to}
      className={cn(
        'group relative flex h-9 items-center gap-3 rounded-md px-2.5 text-sm font-medium',
        'transition-colors duration-150',
        active
          ? 'bg-[hsl(var(--primary)/0.12)] text-[hsl(var(--primary))]'
          : 'text-[hsl(var(--muted-foreground))] hover:bg-[hsl(var(--muted))] hover:text-[hsl(var(--foreground))]',
      )}
    >
      {active && (
        <span
          aria-hidden
          className="absolute left-0 top-1/2 h-5 w-0.5 -translate-y-1/2 rounded-r-full bg-[hsl(var(--primary))]"
        />
      )}
      <Icon className="size-4 shrink-0" />
      <span className="flex-1 truncate">{item.label}</span>
      {item.badge && (
        <Badge variant={active ? 'primary' : 'neutral'} className="ml-auto">
          {item.badge}
        </Badge>
      )}
    </Link>
  );
}

export function Sidebar({ className }: { className?: string }) {
  const navigate = useNavigate();
  const { trigger: triggerUpload } = useUploadTrigger();
  const usage = useQuery(storageUsageQuery());
  const usedBytes = usage.data?.usedBytes ?? 0;
  const totalBytes = usage.data?.totalBytes ?? null;
  const pct = totalBytes && totalBytes > 0 ? Math.min((usedBytes / totalBytes) * 100, 100) : 0;
  const fileCount = usage.data?.fileCount;
  const primaryItems: NavItem[] = PRIMARY.map((item) =>
    item.to === '/files' ? { ...item, badge: fileCount != null ? String(fileCount) : '...' } : item,
  );

  return (
    <aside
      className={cn(
        'flex h-full w-full flex-col bg-[hsl(var(--surface)/0.65)] backdrop-blur-md',
        'border-r border-[hsl(var(--border)/0.5)]',
        className,
      )}
    >
      <div className="flex h-14 items-center gap-2 px-4 border-b border-[hsl(var(--border)/0.5)]">
        <img src={logo} alt="BunnyFile" className="size-8 rounded-lg shadow-sm" />
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold leading-tight">BunnyFile</p>
          <p className="truncate text-[11px] text-[hsl(var(--muted-foreground))]">Files, shared.</p>
        </div>
      </div>

      <div className="px-3 py-3">
        <Button
          className="w-full justify-start"
          size="md"
          leftIcon={<UploadCloud />}
          onClick={() => {
            // Try opening the picker synchronously from this click (preserves
            // the user-activation gesture that Safari/Firefox require). Fall
            // back to navigating with ?upload=1 when FilesPage isn't mounted.
            if (triggerUpload()) return;
            navigate({ to: '/files', search: buildFilesSearch({ upload: true }) });
          }}
        >
          Upload files
        </Button>
      </div>

      <nav className="flex-1 overflow-y-auto px-2">
        <ul className="space-y-0.5">
          {primaryItems.map((item) => (
            <li key={item.to}>
              <NavLink item={item} />
            </li>
          ))}
        </ul>

        <p className="mt-5 mb-1 px-2.5 text-[10px] font-semibold uppercase tracking-wider text-[hsl(var(--muted-foreground))]">
          Workspace
        </p>
        <ul className="space-y-0.5">
          {SECONDARY.map((item) => (
            <li key={item.to}>
              <NavLink item={item} />
            </li>
          ))}
        </ul>
      </nav>

      <div className="border-t border-[hsl(var(--border)/0.5)] p-3">
        <div className="rounded-xl border border-[hsl(var(--border)/0.5)] bg-[hsl(var(--surface-2)/0.4)] backdrop-blur-sm p-3">
          <p className="text-xs font-medium">Storage</p>
          <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-[hsl(var(--muted)/0.5)]">
            <div
              className="h-full rounded-full bg-gradient-to-r from-[hsl(var(--primary))] to-[hsl(var(--accent))]"
              style={{ width: `${pct}%` }}
            />
          </div>
          <p className="mt-1.5 text-[11px] text-[hsl(var(--muted-foreground))]">
            {formatBytes(usedBytes)}
            {totalBytes ? ` of ${formatBytes(totalBytes)}` : ''} used
          </p>
        </div>
      </div>
    </aside>
  );
}
