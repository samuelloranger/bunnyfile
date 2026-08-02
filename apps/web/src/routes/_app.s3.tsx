import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createFileRoute, Link } from '@tanstack/react-router';
import { KeyRound, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Button } from '~/components/ui/button';
import { ConfirmDialog } from '~/components/ui/confirm-dialog';
import { Input } from '~/components/ui/input';
import { Label } from '~/components/ui/label';
import { Modal, ModalClose, ModalContent, ModalTitle } from '~/components/ui/modal';
import { pushNotification } from '~/lib/notifications';
import { createBucket, deleteBucket, fetchBuckets, s3BucketsQueryKey } from '~/lib/s3-console';

export const Route = createFileRoute('/_app/s3')({
  component: S3BucketsPage,
});

function S3BucketsPage() {
  const qc = useQueryClient();
  const [showCreate, setShowCreate] = useState(false);
  const [name, setName] = useState('');

  const buckets = useQuery({
    queryKey: s3BucketsQueryKey,
    queryFn: fetchBuckets,
  });

  const create = useMutation({
    mutationFn: createBucket,
    onSuccess: () => {
      setShowCreate(false);
      setName('');
      qc.invalidateQueries({ queryKey: s3BucketsQueryKey });
      pushNotification({ kind: 'success', title: 'Bucket created' });
    },
    onError: (err: unknown) => {
      pushNotification({
        kind: 'error',
        title: 'Could not create bucket',
        body: err instanceof Error ? err.message : undefined,
      });
    },
  });

  const remove = useMutation({
    mutationFn: deleteBucket,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: s3BucketsQueryKey });
      pushNotification({ kind: 'success', title: 'Bucket deleted' });
    },
    onError: (err: unknown) => {
      pushNotification({
        kind: 'error',
        title: 'Could not delete bucket',
        body: err instanceof Error ? err.message : undefined,
      });
    },
  });

  return (
    <div className="mx-auto max-w-3xl px-4 py-8 sm:px-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">S3</h1>
          <p className="mt-0.5 text-sm text-[hsl(var(--muted-foreground))]">
            Buckets are separate from My files. Any access key can reach every bucket.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" size="md" leftIcon={<KeyRound />} asChild>
            <Link to="/s3/keys">Access keys</Link>
          </Button>
          <Button size="md" leftIcon={<Plus />} onClick={() => setShowCreate(true)}>
            Create bucket
          </Button>
        </div>
      </div>

      {buckets.isLoading && (
        <p className="mt-8 text-sm text-[hsl(var(--muted-foreground))]">Loading buckets…</p>
      )}

      {buckets.isError && (
        <p className="mt-8 text-sm text-[hsl(var(--destructive))]">
          {buckets.error instanceof Error ? buckets.error.message : 'Failed to load buckets'}
        </p>
      )}

      {buckets.data && buckets.data.length === 0 && (
        <div className="mt-8 rounded-lg border border-dashed border-[hsl(var(--border))] p-8 text-center">
          <p className="text-sm font-medium">No buckets yet</p>
          <p className="mt-1 text-sm text-[hsl(var(--muted-foreground))]">
            Create a bucket to store objects for rclone, restic, or the API — they will not appear
            under My files.
          </p>
          <Button className="mt-4" size="md" onClick={() => setShowCreate(true)}>
            Create bucket
          </Button>
        </div>
      )}

      {buckets.data && buckets.data.length > 0 && (
        <ul className="mt-8 divide-y divide-[hsl(var(--border))] rounded-lg border border-[hsl(var(--border))]">
          {buckets.data.map((b) => (
            <li
              key={b.name}
              className="flex min-h-11 items-center justify-between gap-3 px-4 py-2.5"
            >
              <Link
                to="/s3/$bucket"
                params={{ bucket: b.name }}
                search={{ prefix: '' }}
                className="min-w-0 flex-1 truncate text-sm font-medium text-[hsl(var(--primary))] hover:underline"
              >
                {b.name}
              </Link>
              <span className="shrink-0 text-xs text-[hsl(var(--muted-foreground))]">
                {new Date(b.createdAt).toLocaleString()}
              </span>
              <ConfirmDialog
                trigger={
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-[hsl(var(--destructive))]"
                    aria-label={`Delete bucket ${b.name}`}
                  >
                    <Trash2 className="size-4" />
                  </Button>
                }
                title="Delete bucket?"
                description={`Delete empty bucket “${b.name}”? Non-empty buckets cannot be deleted.`}
                confirmLabel="Delete"
                tone="destructive"
                onConfirm={() => remove.mutateAsync(b.name)}
              />
            </li>
          ))}
        </ul>
      )}

      <Modal open={showCreate} onOpenChange={setShowCreate}>
        <ModalContent>
          <ModalTitle>Create bucket</ModalTitle>
          <form
            className="mt-4 space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              if (!name.trim()) return;
              create.mutate(name.trim());
            }}
          >
            <div>
              <Label htmlFor="bucket-name">Name</Label>
              <Input
                id="bucket-name"
                className="mt-1"
                value={name}
                onChange={(e) => setName(e.target.value)}
                autoFocus
                required
              />
            </div>
            <div className="flex justify-end gap-2">
              <ModalClose asChild>
                <Button type="button" variant="secondary">
                  Cancel
                </Button>
              </ModalClose>
              <Button type="submit" disabled={create.isPending || !name.trim()}>
                Create
              </Button>
            </div>
          </form>
        </ModalContent>
      </Modal>
    </div>
  );
}
