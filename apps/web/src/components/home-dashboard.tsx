import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { ArrowUpRight, CheckCircle2, Clock, HardDrive, Sparkles } from 'lucide-react';
import type { ReactNode } from 'react';
import { Badge } from '~/components/ui/badge';
import { Button } from '~/components/ui/button';
import { api } from '~/lib/api';
import { FILES_HOME_SEARCH } from '~/lib/files-search';
import { displayName, entryMeta, recentFilesQuery } from '~/lib/recent';
import { formatBytes, storageUsageQuery } from '~/lib/storage';

export function HomeDashboard() {
  const usage = useQuery(storageUsageQuery());
  const recent = useQuery(recentFilesQuery(8));
  const health = useQuery({
    queryKey: ['health'],
    queryFn: async () => {
      const { data, error } = await api.api.health.get();
      if (error) throw error;
      return data;
    },
    refetchInterval: 5_000,
  });

  return (
    <div className="mx-auto max-w-6xl space-y-8 px-4 py-8 sm:px-6 lg:px-8">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="space-y-1">
          <p className="text-xs font-medium uppercase tracking-wider text-[hsl(var(--muted-foreground))]">
            Welcome back
          </p>
          <h1 className="text-3xl font-semibold tracking-tight">Your files, in one place.</h1>
          <p className="max-w-xl text-sm text-[hsl(var(--muted-foreground))]">
            BunnyFile is a lightweight self-hosted file host. Upload, share, and manage — without
            the bloat.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" asChild>
            <Link to="/files" search={FILES_HOME_SEARCH}>
              <Sparkles /> Browse files
            </Link>
          </Button>
          <Button rightIcon={<ArrowUpRight />} asChild>
            <Link to="/files" search={FILES_HOME_SEARCH}>
              Upload
            </Link>
          </Button>
        </div>
      </header>

      <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <StatCard
          icon={<HardDrive />}
          label="Storage used"
          value={usage.data ? formatBytes(usage.data.usedBytes) : '—'}
          hint={usage.data?.totalBytes ? `of ${formatBytes(usage.data.totalBytes)}` : undefined}
          tone="primary"
        />
        <StatCard
          icon={<CheckCircle2 />}
          label="Server status"
          value={
            health.isLoading
              ? 'Checking…'
              : health.data?.status === 'ok'
                ? 'Healthy'
                : 'Unreachable'
          }
          hint={health.data ? `v${health.data.version}` : undefined}
          tone={health.data?.status === 'ok' ? 'success' : 'warning'}
        />
        <StatCard
          icon={<Clock />}
          label="Uptime"
          value={health.data ? `${health.data.uptimeSeconds}s` : '—'}
          hint="since last boot"
          tone="accent"
        />
      </section>

      <section className="rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--surface))] p-6">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold">Recent activity</h2>
            <p className="text-sm text-[hsl(var(--muted-foreground))]">
              Recently uploaded or modified files.
            </p>
          </div>
          <Button variant="ghost" size="sm" rightIcon={<ArrowUpRight />} asChild>
            <Link to="/files" search={FILES_HOME_SEARCH}>
              View all
            </Link>
          </Button>
        </div>
        {recent.isLoading && (
          <div className="mt-4 rounded-lg border border-dashed border-[hsl(var(--border))] bg-[hsl(var(--surface-2))] p-10 text-center">
            <p className="text-sm text-[hsl(var(--muted-foreground))]">Loading activity…</p>
          </div>
        )}
        {recent.isError && (
          <div className="mt-4 rounded-lg border border-dashed border-[hsl(var(--border))] bg-[hsl(var(--surface-2))] p-10 text-center">
            <p className="text-sm text-[hsl(var(--destructive))]">Failed to load activity.</p>
          </div>
        )}
        {!recent.isLoading && !recent.isError && (recent.data?.length ?? 0) === 0 && (
          <div className="mt-4 rounded-lg border border-dashed border-[hsl(var(--border))] bg-[hsl(var(--surface-2))] p-10 text-center">
            <p className="text-sm text-[hsl(var(--muted-foreground))]">
              No activity yet. Upload a file to get started.
            </p>
          </div>
        )}
        {!recent.isLoading && !recent.isError && (recent.data?.length ?? 0) > 0 && (
          <ul className="mt-4 divide-y divide-[hsl(var(--border))] rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--surface-2))]">
            {recent.data?.map((entry) => (
              <li key={entry.path} className="flex items-center justify-between gap-3 px-4 py-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{displayName(entry.path)}</p>
                  <p className="truncate text-xs text-[hsl(var(--muted-foreground))]">
                    {entry.path}
                  </p>
                </div>
                <p className="shrink-0 text-xs text-[hsl(var(--muted-foreground))]">
                  {entryMeta(entry)}
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

type Tone = 'primary' | 'accent' | 'success' | 'warning';

function StatCard({
  icon,
  label,
  value,
  hint,
  tone,
}: {
  icon: ReactNode;
  label: string;
  value: string;
  hint?: string | undefined;
  tone: Tone;
}) {
  const toneBg: Record<Tone, string> = {
    primary: 'bg-[hsl(var(--primary)/0.12)] text-[hsl(var(--primary))]',
    accent: 'bg-[hsl(var(--accent)/0.15)] text-[hsl(var(--accent))]',
    success: 'bg-[hsl(var(--success)/0.15)] text-[hsl(var(--success))]',
    warning: 'bg-[hsl(var(--warning)/0.2)] text-[hsl(var(--warning-foreground))]',
  };
  return (
    <div className="rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--surface))] p-5 transition-shadow hover:shadow-sm">
      <div className="flex items-center justify-between">
        <div
          className={`inline-flex size-10 items-center justify-center rounded-lg [&_svg]:size-5 ${toneBg[tone]}`}
          aria-hidden
        >
          {icon}
        </div>
        <Badge variant="outline">live</Badge>
      </div>
      <p className="mt-4 text-xs font-medium uppercase tracking-wider text-[hsl(var(--muted-foreground))]">
        {label}
      </p>
      <p className="mt-1 text-2xl font-semibold tracking-tight">{value}</p>
      {hint && <p className="text-xs text-[hsl(var(--muted-foreground))]">{hint}</p>}
    </div>
  );
}
