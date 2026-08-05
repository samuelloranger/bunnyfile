import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createFileRoute, Link } from '@tanstack/react-router';
import { ArrowLeft, FolderPlus, Trash2, Upload } from 'lucide-react';
import { useRef, useState } from 'react';
import { Button } from '~/components/ui/button';
import { ConfirmDialog } from '~/components/ui/confirm-dialog';
import { Input } from '~/components/ui/input';
import { Label } from '~/components/ui/label';
import { Modal, ModalClose, ModalContent, ModalTitle } from '~/components/ui/modal';
import { humanSize } from '~/lib/files';
import { pushNotification } from '~/lib/notifications';
import {
  copyOrMoveObject,
  createPrefix,
  deleteObject,
  deletePrefix,
  fetchBuckets,
  fetchObjects,
  isFolderMarkerKey,
  objectDownloadUrl,
  s3BucketsQueryKey,
  s3ObjectsQueryKey,
  uploadObject,
} from '~/lib/s3-console';

export const Route = createFileRoute('/_app/s3/$bucket')({
  validateSearch: (search: Record<string, unknown>) => ({
    prefix: typeof search.prefix === 'string' ? search.prefix : '',
  }),
  component: S3ObjectBrowserPage,
});

function S3ObjectBrowserPage() {
  const { bucket } = Route.useParams();
  const { prefix } = Route.useSearch();
  const navigate = Route.useNavigate();
  const qc = useQueryClient();
  const fileInput = useRef<HTMLInputElement>(null);
  const [folderOpen, setFolderOpen] = useState(false);
  const [folderName, setFolderName] = useState('');
  const [copyOpen, setCopyOpen] = useState(false);
  const [copyKey, setCopyKey] = useState('');
  const [dstBucket, setDstBucket] = useState(bucket);
  const [dstKey, setDstKey] = useState('');
  const [move, setMove] = useState(false);

  const listing = useQuery({
    queryKey: s3ObjectsQueryKey(bucket, prefix),
    queryFn: () => fetchObjects(bucket, prefix),
  });

  const buckets = useQuery({
    queryKey: s3BucketsQueryKey,
    queryFn: fetchBuckets,
  });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: s3ObjectsQueryKey(bucket, prefix) });
  };

  const remove = useMutation({
    mutationFn: (key: string) => deleteObject(bucket, key),
    onSuccess: () => {
      invalidate();
      pushNotification({ kind: 'success', title: 'Object deleted' });
    },
    onError: (err: unknown) => {
      pushNotification({
        kind: 'error',
        title: 'Could not delete object',
        body: err instanceof Error ? err.message : undefined,
      });
    },
  });

  const removeFolder = useMutation({
    mutationFn: (folderPrefix: string) => deletePrefix(bucket, folderPrefix),
    onSuccess: () => {
      invalidate();
      pushNotification({ kind: 'success', title: 'Folder deleted' });
    },
    onError: (err: unknown) => {
      pushNotification({
        kind: 'error',
        title: 'Could not delete folder',
        body: err instanceof Error ? err.message : undefined,
      });
    },
  });

  const makeFolder = useMutation({
    mutationFn: async () => {
      const name = folderName.trim().replace(/\/+$/, '');
      if (!name) throw new Error('Folder name required');
      const full = prefix ? `${prefix}${name}` : name;
      return createPrefix(bucket, full);
    },
    onSuccess: () => {
      setFolderOpen(false);
      setFolderName('');
      invalidate();
      pushNotification({ kind: 'success', title: 'Folder created' });
    },
    onError: (err: unknown) => {
      pushNotification({
        kind: 'error',
        title: 'Could not create folder',
        body: err instanceof Error ? err.message : undefined,
      });
    },
  });

  const transfer = useMutation({
    mutationFn: () =>
      copyOrMoveObject({
        srcBucket: bucket,
        srcKey: copyKey,
        dstBucket,
        dstKey: dstKey.trim(),
        move,
      }),
    onSuccess: () => {
      setCopyOpen(false);
      invalidate();
      qc.invalidateQueries({ queryKey: ['s3-console', 'objects'] });
      pushNotification({ kind: 'success', title: move ? 'Object moved' : 'Object copied' });
    },
    onError: (err: unknown) => {
      pushNotification({
        kind: 'error',
        title: move ? 'Could not move object' : 'Could not copy object',
        body: err instanceof Error ? err.message : undefined,
      });
    },
  });

  const crumbs = prefix
    ? prefix
        .replace(/\/$/, '')
        .split('/')
        .filter(Boolean)
        .map((seg: string, i: number, arr: string[]) => ({
          label: seg,
          prefix: `${arr.slice(0, i + 1).join('/')}/`,
        }))
    : [];

  const objects = (listing.data?.objects ?? []).filter((o) => !isFolderMarkerKey(o.key));
  const prefixes = listing.data?.prefixes ?? [];

  async function onFilesSelected(files: FileList | null) {
    if (!files?.length) return;
    for (const file of files) {
      const key = prefix ? `${prefix}${file.name}` : file.name;
      try {
        await uploadObject(bucket, key, file);
        pushNotification({ kind: 'success', title: `Uploaded ${file.name}` });
      } catch (err) {
        pushNotification({
          kind: 'error',
          title: `Upload failed: ${file.name}`,
          body: err instanceof Error ? err.message : undefined,
        });
      }
    }
    invalidate();
    if (fileInput.current) fileInput.current.value = '';
  }

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <Link
          to="/s3"
          className="inline-flex items-center gap-1 text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))]"
        >
          <ArrowLeft className="size-4" />
          Buckets
        </Link>
        <span className="text-[hsl(var(--muted-foreground))]">/</span>
        <button
          type="button"
          className="font-medium hover:underline"
          onClick={() => navigate({ search: { prefix: '' } })}
        >
          {bucket}
        </button>
        {crumbs.map((c) => (
          <span key={c.prefix} className="contents">
            <span className="text-[hsl(var(--muted-foreground))]">/</span>
            <button
              type="button"
              className="hover:underline"
              onClick={() => navigate({ search: { prefix: c.prefix } })}
            >
              {c.label}
            </button>
          </span>
        ))}
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        <input
          ref={fileInput}
          type="file"
          className="hidden"
          multiple
          onChange={(e) => onFilesSelected(e.target.files)}
        />
        <Button size="md" leftIcon={<Upload />} onClick={() => fileInput.current?.click()}>
          Upload
        </Button>
        <Button
          size="md"
          variant="secondary"
          leftIcon={<FolderPlus />}
          onClick={() => setFolderOpen(true)}
        >
          New folder
        </Button>
      </div>

      {listing.isLoading && (
        <p className="mt-8 text-sm text-[hsl(var(--muted-foreground))]">Loading…</p>
      )}
      {listing.isError && (
        <p className="mt-8 text-sm text-[hsl(var(--destructive))]">
          {listing.error instanceof Error ? listing.error.message : 'Failed to load objects'}
        </p>
      )}

      {listing.data && prefixes.length === 0 && objects.length === 0 && (
        <p className="mt-8 text-sm text-[hsl(var(--muted-foreground))]">This prefix is empty.</p>
      )}

      {(prefixes.length > 0 || objects.length > 0) && (
        <ul className="mt-6 divide-y divide-[hsl(var(--border))] rounded-lg border border-[hsl(var(--border))]">
          {prefixes.map((p) => {
            const label = p.slice(prefix.length).replace(/\/$/, '');
            return (
              <li
                key={p}
                className="flex min-h-11 flex-wrap items-center gap-2 px-4 py-2.5 text-sm"
              >
                <button
                  type="button"
                  className="min-w-0 flex-1 truncate text-left font-medium hover:underline"
                  onClick={() => navigate({ search: { prefix: p } })}
                >
                  {label}/
                </button>
                <ConfirmDialog
                  trigger={
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-[hsl(var(--destructive))]"
                      aria-label={`Delete folder ${label}`}
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  }
                  title="Delete folder?"
                  description={`Delete empty folder “${label}/”? Folders with objects cannot be deleted.`}
                  confirmLabel="Delete"
                  tone="destructive"
                  onConfirm={() => removeFolder.mutateAsync(p)}
                />
              </li>
            );
          })}
          {objects.map((o) => {
            const label = o.key.slice(prefix.length);
            return (
              <li
                key={o.key}
                className="flex min-h-11 flex-wrap items-center gap-2 px-4 py-2.5 text-sm"
              >
                <a
                  className="min-w-0 flex-1 truncate font-medium text-[hsl(var(--primary))] hover:underline"
                  href={objectDownloadUrl(bucket, o.key)}
                >
                  {label}
                </a>
                <span className="text-xs text-[hsl(var(--muted-foreground))]">
                  {humanSize(o.size)}
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setCopyKey(o.key);
                    setDstBucket(bucket);
                    setDstKey(o.key);
                    setMove(false);
                    setCopyOpen(true);
                  }}
                >
                  Copy/Move
                </Button>
                <ConfirmDialog
                  trigger={
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-[hsl(var(--destructive))]"
                      aria-label={`Delete ${label}`}
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  }
                  title="Delete object?"
                  description={`Delete “${o.key}”?`}
                  confirmLabel="Delete"
                  tone="destructive"
                  onConfirm={() => remove.mutateAsync(o.key)}
                />
              </li>
            );
          })}
        </ul>
      )}

      <Modal open={folderOpen} onOpenChange={setFolderOpen}>
        <ModalContent>
          <ModalTitle>New folder</ModalTitle>
          <form
            className="mt-4 space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              makeFolder.mutate();
            }}
          >
            <div>
              <Label htmlFor="folder-name">Name</Label>
              <Input
                id="folder-name"
                className="mt-1"
                value={folderName}
                onChange={(e) => setFolderName(e.target.value)}
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
              <Button type="submit" disabled={makeFolder.isPending || !folderName.trim()}>
                Create
              </Button>
            </div>
          </form>
        </ModalContent>
      </Modal>

      <Modal open={copyOpen} onOpenChange={setCopyOpen}>
        <ModalContent>
          <ModalTitle>{move ? 'Move object' : 'Copy object'}</ModalTitle>
          <form
            className="mt-4 space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              transfer.mutate();
            }}
          >
            <p className="text-sm text-[hsl(var(--muted-foreground))]">Source: {copyKey}</p>
            <div>
              <Label htmlFor="dst-bucket">Destination bucket</Label>
              <select
                id="dst-bucket"
                className="mt-1 flex h-11 w-full rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--surface))] px-3 text-sm"
                value={dstBucket}
                onChange={(e) => setDstBucket(e.target.value)}
              >
                {(buckets.data ?? [{ name: bucket }]).map((b) => (
                  <option key={b.name} value={b.name}>
                    {b.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <Label htmlFor="dst-key">Destination key</Label>
              <Input
                id="dst-key"
                className="mt-1"
                value={dstKey}
                onChange={(e) => setDstKey(e.target.value)}
                required
              />
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={move} onChange={(e) => setMove(e.target.checked)} />
              Move (delete source after copy)
            </label>
            <div className="flex justify-end gap-2">
              <ModalClose asChild>
                <Button type="button" variant="secondary">
                  Cancel
                </Button>
              </ModalClose>
              <Button type="submit" disabled={transfer.isPending || !dstKey.trim()}>
                {move ? 'Move' : 'Copy'}
              </Button>
            </div>
          </form>
        </ModalContent>
      </Modal>
    </div>
  );
}
