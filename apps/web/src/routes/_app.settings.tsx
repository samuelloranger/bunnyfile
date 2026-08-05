import { useQuery } from '@tanstack/react-query';
import { createFileRoute, Link } from '@tanstack/react-router';
import { HardDrive, KeyRound } from 'lucide-react';
import { Button } from '~/components/ui/button';
import { FILES_HOME_SEARCH } from '~/lib/files-search';
import { formatBytes, storageUsageQuery } from '~/lib/storage';

export const Route = createFileRoute('/_app/settings')({
  component: SettingsPage,
});

function SettingsPage() {
  const usage = useQuery(storageUsageQuery());

  return (
    <div>
      <h1 className="text-xl font-semibold">Settings</h1>

      <section className="mt-8">
        <h2 className="text-base font-medium">Storage</h2>
        <p className="mt-0.5 text-sm text-[hsl(var(--muted-foreground))]">
          Files indexed on this instance. S3 bucket data is stored separately under{' '}
          <code className="rounded bg-[hsl(var(--muted))] px-1 py-0.5 text-xs">data/s3/</code>.
        </p>
        <div className="mt-4 rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--surface-2))] p-4">
          <div className="flex items-center gap-2 text-sm font-medium">
            <HardDrive className="size-4 text-[hsl(var(--muted-foreground))]" />
            {usage.data ? formatBytes(usage.data.usedBytes) : '—'} used
            {usage.data?.fileCount != null ? ` · ${usage.data.fileCount} files` : ''}
          </div>
          {usage.data?.totalBytes ? (
            <>
              <div className="mt-3 h-2 overflow-hidden rounded-full bg-[hsl(var(--muted))]">
                <div
                  className="h-full rounded-full bg-gradient-to-r from-[hsl(var(--primary))] to-[hsl(var(--accent))]"
                  style={{
                    width: `${Math.min((usage.data.usedBytes / usage.data.totalBytes) * 100, 100)}%`,
                  }}
                />
              </div>
              <p className="mt-2 text-xs text-[hsl(var(--muted-foreground))]">
                {formatBytes(usage.data.freeBytes ?? 0)} free of{' '}
                {formatBytes(usage.data.totalBytes)} on disk
              </p>
            </>
          ) : null}
          <div className="mt-3">
            <Button variant="outline" size="sm" asChild>
              <Link to="/files" search={FILES_HOME_SEARCH}>
                Browse files
              </Link>
            </Button>
          </div>
        </div>
      </section>

      <section className="mt-8">
        <h2 className="text-base font-medium">S3</h2>
        <p className="mt-0.5 text-sm text-[hsl(var(--muted-foreground))]">
          Manage buckets and access keys in the S3 console. Any access key can reach every bucket.
        </p>
        <div className="mt-4 flex flex-wrap gap-2">
          <Button variant="outline" size="sm" asChild>
            <Link to="/s3">Open S3</Link>
          </Button>
          <Button variant="outline" size="sm" leftIcon={<KeyRound />} asChild>
            <Link to="/s3/keys">Access keys</Link>
          </Button>
        </div>
      </section>
    </div>
  );
}
