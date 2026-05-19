import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createFileRoute, Link } from '@tanstack/react-router';
import { File, Folder, RotateCcw, Trash2 } from 'lucide-react';
import { Badge } from '~/components/ui/badge';
import { Button } from '~/components/ui/button';
import { ConfirmDialog } from '~/components/ui/confirm-dialog';
import { api } from '~/lib/api';
import { humanSize } from '~/lib/files';
import { pushNotification } from '~/lib/notifications';

export const Route = createFileRoute('/_app/trash')({
  component: TrashPage,
});

type TrashEntry = {
  id: string;
  originalPath: string;
  kind: 'file' | 'dir';
  size: number | null;
  mime: string | null;
  deletedAt: string | number | Date;
};

function TrashPage() {
  const qc = useQueryClient();
  const trash = useQuery({
    queryKey: ['trash'],
    queryFn: async () => {
      const { data, error } = await api.api.trash.get();
      if (error) throw error;
      if ('error' in data) throw new Error(data.error);
      return data.entries as TrashEntry[];
    },
  });

  const restore = useMutation({
    mutationFn: async (id: string) => {
      const { data, error } = await api.api.trash({ id }).restore.post();
      if (error) throw error;
      if (data && 'error' in data) throw new Error(data.error);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['trash'] });
      qc.invalidateQueries({ queryKey: ['files'] });
      qc.invalidateQueries({ queryKey: ['storage-usage'] });
      pushNotification({ kind: 'success', title: 'Restored from trash' });
    },
    onError: (err: unknown) => {
      const body = err instanceof Error ? err.message : undefined;
      pushNotification({
        kind: 'error',
        title: 'Could not restore item',
        ...(body ? { body } : {}),
      });
    },
  });

  const remove = useMutation({
    mutationFn: async (id: string) => {
      const { data, error } = await api.api.trash({ id }).delete();
      if (error) throw error;
      if (data && 'error' in data) throw new Error(data.error);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['trash'] });
      pushNotification({ kind: 'success', title: 'Deleted permanently' });
    },
  });

  const empty = useMutation({
    mutationFn: async () => {
      const { data, error } = await api.api.trash.delete();
      if (error) throw error;
      if (data && 'error' in data) throw new Error(data.error);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['trash'] });
      pushNotification({ kind: 'success', title: 'Trash emptied' });
    },
  });

  return (
    <div className="mx-auto max-w-5xl px-6 py-8">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold">Trash</h1>
          <p className="mt-1 text-sm text-[hsl(var(--muted-foreground))]">
            Deleted files stay here until you restore or permanently remove them.
          </p>
        </div>
        {(trash.data?.length ?? 0) > 0 && (
          <ConfirmDialog
            trigger={
              <Button variant="outline" leftIcon={<Trash2 />}>
                Empty trash
              </Button>
            }
            title="Empty trash?"
            description="Every item in trash will be permanently deleted. This cannot be undone."
            confirmLabel="Empty trash"
            tone="destructive"
            onConfirm={() => empty.mutateAsync()}
          />
        )}
      </div>

      <div className="mt-6 overflow-hidden rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--surface))]">
        {trash.isLoading && (
          <p className="px-4 py-8 text-center text-sm text-[hsl(var(--muted-foreground))]">
            Loading trash...
          </p>
        )}
        {trash.isError && (
          <p className="px-4 py-8 text-center text-sm text-[hsl(var(--destructive))]">
            Could not load trash.
          </p>
        )}
        {!trash.isLoading && !trash.isError && trash.data?.length === 0 && (
          <div className="px-4 py-8 text-center">
            <p className="text-sm text-[hsl(var(--muted-foreground))]">Trash is empty.</p>
            <Button className="mt-4" variant="outline" asChild>
              <Link to="/files" search={{ path: '' }}>
                Browse files
              </Link>
            </Button>
          </div>
        )}
        {(trash.data?.length ?? 0) > 0 && (
          <div className="divide-y divide-[hsl(var(--border))]">
            {trash.data?.map((item) => (
              <div key={item.id} className="flex items-center gap-3 px-4 py-3">
                <div className="flex size-9 items-center justify-center rounded-lg bg-[hsl(var(--muted))] text-[hsl(var(--muted-foreground))]">
                  {item.kind === 'dir' ? (
                    <Folder className="size-4" />
                  ) : (
                    <File className="size-4" />
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{item.originalPath}</p>
                  <div className="mt-1 flex items-center gap-2 text-xs text-[hsl(var(--muted-foreground))]">
                    <Badge variant="outline">
                      {item.kind === 'dir' ? 'Folder' : (item.mime ?? 'File')}
                    </Badge>
                    {item.size != null && <span>{humanSize(item.size)}</span>}
                    <span>Deleted {relativeDate(item.deletedAt)}</span>
                  </div>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  leftIcon={<RotateCcw />}
                  onClick={() => restore.mutate(item.id)}
                >
                  Restore
                </Button>
                <ConfirmDialog
                  trigger={
                    <Button variant="ghost" size="icon-sm" aria-label="Delete permanently">
                      <Trash2 />
                    </Button>
                  }
                  title="Delete permanently?"
                  description="This item will be removed from disk. This cannot be undone."
                  confirmLabel="Delete"
                  tone="destructive"
                  onConfirm={() => remove.mutateAsync(item.id)}
                />
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function relativeDate(value: string | number | Date): string {
  const date = new Date(value);
  const delta = Date.now() - date.getTime();
  if (delta < 60_000) return 'just now';
  if (delta < 3_600_000) return `${Math.round(delta / 60_000)}m ago`;
  if (delta < 86_400_000) return `${Math.round(delta / 3_600_000)}h ago`;
  return date.toLocaleDateString();
}
