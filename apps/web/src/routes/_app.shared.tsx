import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createFileRoute, Link } from '@tanstack/react-router';
import { Copy, ExternalLink, Lock, ShieldOff } from 'lucide-react';
import { Badge } from '~/components/ui/badge';
import { Button } from '~/components/ui/button';
import { ConfirmDialog } from '~/components/ui/confirm-dialog';
import { api } from '~/lib/api';
import { FILES_HOME_SEARCH } from '~/lib/files-search';
import { pushNotification } from '~/lib/notifications';

export const Route = createFileRoute('/_app/shared')({
  component: SharedPage,
});

type ShareEntry = {
  id: string;
  token: string;
  path: string;
  expiresAt: string | number | Date | null;
  maxDownloads: number | null;
  downloadCount: number;
  createdAt: string | number | Date;
  hasPassword: boolean;
};

function SharedPage() {
  const qc = useQueryClient();
  const shares = useQuery({
    queryKey: ['shares'],
    queryFn: async () => {
      const { data, error } = await api.api.shares.get();
      if (error) throw error;
      if ('error' in data) throw new Error(data.error);
      return data.entries as ShareEntry[];
    },
  });

  const revoke = useMutation({
    mutationFn: async (id: string) => {
      const { data, error } = await api.api.shares({ id }).delete();
      if (error) throw error;
      if (data && 'error' in data) throw new Error(data.error);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['shares'] });
      pushNotification({ kind: 'success', title: 'Share revoked' });
    },
    onError: (err: unknown) => {
      const body = err instanceof Error ? err.message : undefined;
      pushNotification({
        kind: 'error',
        title: 'Could not revoke share',
        ...(body ? { body } : {}),
      });
    },
  });

  return (
    <div className="mx-auto max-w-5xl px-6 py-8">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold">Shared links</h1>
          <p className="mt-1 text-sm text-[hsl(var(--muted-foreground))]">
            Active public links created from your files.
          </p>
        </div>
        <Button asChild>
          <Link to="/files" search={FILES_HOME_SEARCH}>
            Share a file
          </Link>
        </Button>
      </div>

      <div className="mt-6 overflow-hidden rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--surface))]">
        {shares.isLoading && (
          <p className="px-4 py-8 text-center text-sm text-[hsl(var(--muted-foreground))]">
            Loading shared links...
          </p>
        )}
        {shares.isError && (
          <p className="px-4 py-8 text-center text-sm text-[hsl(var(--destructive))]">
            Could not load shared links.
          </p>
        )}
        {!shares.isLoading && !shares.isError && shares.data?.length === 0 && (
          <p className="px-4 py-8 text-center text-sm text-[hsl(var(--muted-foreground))]">
            No active shared links.
          </p>
        )}
        {(shares.data?.length ?? 0) > 0 && (
          <div className="divide-y divide-[hsl(var(--border))]">
            {shares.data?.map((share) => {
              const url = `${window.location.origin}/s/${share.token}`;
              return (
                <div key={share.id} className="flex items-center gap-3 px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{share.path}</p>
                    <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-[hsl(var(--muted-foreground))]">
                      <span>{relativeDate(share.createdAt)}</span>
                      {share.expiresAt && (
                        <Badge variant="outline">Expires {relativeDate(share.expiresAt)}</Badge>
                      )}
                      {share.hasPassword && (
                        <Badge variant="outline">
                          <Lock className="size-3" /> Password
                        </Badge>
                      )}
                      {share.maxDownloads != null && (
                        <Badge variant="outline">
                          {share.downloadCount}/{share.maxDownloads} downloads
                        </Badge>
                      )}
                    </div>
                  </div>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Copy share link"
                    onClick={async () => {
                      await navigator.clipboard.writeText(url);
                      pushNotification({ kind: 'success', title: 'Share link copied' });
                    }}
                  >
                    <Copy />
                  </Button>
                  <Button variant="ghost" size="icon-sm" asChild aria-label="Open share link">
                    <a href={url} target="_blank" rel="noreferrer">
                      <ExternalLink />
                    </a>
                  </Button>
                  <ConfirmDialog
                    trigger={
                      <Button variant="ghost" size="icon-sm" aria-label="Revoke share">
                        <ShieldOff />
                      </Button>
                    }
                    title="Revoke this share?"
                    description="The public link will stop working immediately."
                    confirmLabel="Revoke"
                    tone="destructive"
                    onConfirm={() => revoke.mutateAsync(share.id)}
                  />
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function relativeDate(value: string | number | Date): string {
  const date = new Date(value);
  const delta = date.getTime() - Date.now();
  const abs = Math.abs(delta);
  if (abs < 60_000) return delta < 0 ? 'just now' : 'soon';
  if (abs < 3_600_000) return `${Math.round(abs / 60_000)}m ${delta < 0 ? 'ago' : 'from now'}`;
  if (abs < 86_400_000) return `${Math.round(abs / 3_600_000)}h ${delta < 0 ? 'ago' : 'from now'}`;
  return date.toLocaleDateString();
}
