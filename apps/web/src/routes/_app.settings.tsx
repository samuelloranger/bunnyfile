import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createFileRoute, Link } from '@tanstack/react-router';
import { Copy, HardDrive, KeyRound, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Button } from '~/components/ui/button';
import { ConfirmDialog } from '~/components/ui/confirm-dialog';
import { Input } from '~/components/ui/input';
import { Label } from '~/components/ui/label';
import { Modal, ModalClose, ModalContent, ModalTitle } from '~/components/ui/modal';
import { api } from '~/lib/api';
import { FILES_HOME_SEARCH } from '~/lib/files-search';
import { pushNotification } from '~/lib/notifications';
import { formatBytes, storageUsageQuery } from '~/lib/storage';

export const Route = createFileRoute('/_app/settings')({
  component: SettingsPage,
});

type AccessKey = {
  id: string;
  accessKeyId: string;
  name: string;
  createdAt: string | number | Date;
};

type NewKey = {
  id: string;
  accessKeyId: string;
  secretAccessKey: string;
};

function SettingsPage() {
  const qc = useQueryClient();
  const usage = useQuery(storageUsageQuery());
  const [showCreate, setShowCreate] = useState(false);
  const [newKeyName, setNewKeyName] = useState('');
  const [generatedKey, setGeneratedKey] = useState<NewKey | null>(null);

  const keys = useQuery({
    queryKey: ['s3-keys'],
    queryFn: async () => {
      const { data, error } = await api.api.settings['s3-keys'].get();
      if (error) throw error;
      return (data ?? []) as AccessKey[];
    },
  });

  const createKey = useMutation({
    mutationFn: async (name: string) => {
      const { data, error } = await api.api.settings['s3-keys'].post({ name });
      if (error) throw error;
      return data as NewKey;
    },
    onSuccess: (data) => {
      setGeneratedKey(data);
      setShowCreate(false);
      setNewKeyName('');
      qc.invalidateQueries({ queryKey: ['s3-keys'] });
      pushNotification({ kind: 'success', title: 'S3 access key created' });
    },
    onError: (err: unknown) => {
      pushNotification({
        kind: 'error',
        title: 'Could not create S3 access key',
        body: err instanceof Error ? err.message : undefined,
      });
    },
  });

  const revokeKey = useMutation({
    mutationFn: async (id: string) => {
      await api.api.settings['s3-keys']({ id }).delete();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['s3-keys'] });
      pushNotification({ kind: 'success', title: 'S3 access key revoked' });
    },
    onError: (err: unknown) => {
      pushNotification({
        kind: 'error',
        title: 'Could not revoke S3 access key',
        body: err instanceof Error ? err.message : undefined,
      });
    },
  });

  return (
    <div className="mx-auto max-w-2xl px-6 py-8">
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
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-base font-medium">S3 Access Keys</h2>
            <p className="mt-0.5 text-sm text-[hsl(var(--muted-foreground))]">
              Use these credentials with rclone, kopia, restic, or any S3-compatible tool.
            </p>
          </div>
          <Button
            size="sm"
            leftIcon={<Plus className="size-4" />}
            onClick={() => setShowCreate(true)}
          >
            New key
          </Button>
        </div>

        <div className="mt-4 divide-y divide-[hsl(var(--border))] rounded-lg border border-[hsl(var(--border))]">
          {keys.data?.length === 0 && (
            <p className="px-4 py-6 text-center text-sm text-[hsl(var(--muted-foreground))]">
              No access keys yet.
            </p>
          )}
          {keys.data?.map((key) => (
            <div key={key.id} className="flex items-center gap-3 px-4 py-3">
              <KeyRound className="size-4 shrink-0 text-[hsl(var(--muted-foreground))]" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{key.name}</p>
                <p className="font-mono text-xs text-[hsl(var(--muted-foreground))]">
                  {key.accessKeyId}
                </p>
              </div>
              <span className="text-xs text-[hsl(var(--muted-foreground))]">
                {new Date(key.createdAt).toLocaleDateString()}
              </span>
              <ConfirmDialog
                trigger={
                  <Button variant="ghost" size="icon-sm" aria-label="Revoke key">
                    <Trash2 className="size-4" />
                  </Button>
                }
                title="Revoke access key?"
                description={`"${key.name}" will stop working immediately. This cannot be undone.`}
                confirmLabel="Revoke"
                tone="destructive"
                onConfirm={() => revokeKey.mutate(key.id)}
              />
            </div>
          ))}
        </div>
      </section>

      {/* Create key modal */}
      <Modal open={showCreate} onOpenChange={setShowCreate}>
        <ModalContent>
          <ModalTitle>New S3 Access Key</ModalTitle>
          <form
            className="mt-4 space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              if (newKeyName.trim()) createKey.mutate(newKeyName.trim());
            }}
          >
            <div className="space-y-1.5">
              <Label htmlFor="key-name">Key name</Label>
              <Input
                id="key-name"
                placeholder="e.g. rclone backup"
                value={newKeyName}
                onChange={(e) => setNewKeyName(e.target.value)}
                autoFocus
              />
            </div>
            <div className="flex justify-end gap-2">
              <ModalClose asChild>
                <Button variant="ghost" type="button">
                  Cancel
                </Button>
              </ModalClose>
              <Button type="submit" disabled={!newKeyName.trim() || createKey.isPending}>
                Generate
              </Button>
            </div>
          </form>
        </ModalContent>
      </Modal>

      {/* One-time secret display modal */}
      <Modal
        open={!!generatedKey}
        onOpenChange={(open) => {
          if (!open) setGeneratedKey(null);
        }}
      >
        <ModalContent>
          <ModalTitle>Save your secret access key</ModalTitle>
          <p className="mt-2 text-sm text-[hsl(var(--muted-foreground))]">
            This is the only time you'll see the secret. Copy it now.
          </p>
          <div className="mt-4 space-y-3">
            <SecretField label="Access Key ID" value={generatedKey?.accessKeyId ?? ''} />
            <SecretField label="Secret Access Key" value={generatedKey?.secretAccessKey ?? ''} />
          </div>
          <div className="mt-4 flex justify-end">
            <Button onClick={() => setGeneratedKey(null)}>I've saved my key</Button>
          </div>
        </ModalContent>
      </Modal>
    </div>
  );
}

function SecretField({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard.writeText(value);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  return (
    <div className="space-y-1">
      <Label>{label}</Label>
      <div className="flex items-center gap-2">
        <code className="flex-1 break-all rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--muted))] px-3 py-1.5 font-mono text-xs">
          {value}
        </code>
        <Button variant="ghost" size="icon-sm" onClick={copy} aria-label={`Copy ${label}`}>
          <Copy className="size-4" />
          {copied && <span className="sr-only">Copied</span>}
        </Button>
      </div>
    </div>
  );
}
