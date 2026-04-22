import { useQuery } from '@tanstack/react-query';
import { createFileRoute, Link } from '@tanstack/react-router';
import { Download, LockKeyhole } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '~/components/ui/button';
import { Input } from '~/components/ui/input';
import { api } from '~/lib/api';
import { humanSize } from '~/lib/files';

export const Route = createFileRoute('/s/$token')({
  component: PublicSharePage,
});

function PublicSharePage() {
  const { token } = Route.useParams();
  const [password, setPassword] = useState('');
  const [downloading, setDownloading] = useState(false);

  const share = useQuery({
    queryKey: ['public-share', token],
    queryFn: async () => {
      const { data, error } = await api.api.shares.public({ token }).get();
      if (error) throw error;
      return data;
    },
    retry: false,
  });

  async function download() {
    if (!share.data || !('status' in share.data) || share.data.status !== 'ok') return;
    setDownloading(true);
    try {
      const url = new URL(
        `/api/shares/public/${encodeURIComponent(token)}/file`,
        window.location.origin,
      );
      if (password.trim()) url.searchParams.set('password', password);
      const res = await fetch(url);
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? 'Download failed');
      }
      const blob = await res.blob();
      const href = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = href;
      a.download = share.data.name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(href);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Download failed');
    } finally {
      setDownloading(false);
    }
  }

  const status =
    share.data && 'status' in share.data && share.data.status !== 'ok' ? share.data.status : null;

  return (
    <div className="flex min-h-dvh items-center justify-center bg-[hsl(var(--background))] px-4 py-8">
      <main className="w-full max-w-xl rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--surface))] p-6">
        <p className="text-xs font-medium uppercase tracking-wider text-[hsl(var(--muted-foreground))]">
          BunnyFile Share
        </p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">Shared file</h1>
        <p className="mt-1 text-sm text-[hsl(var(--muted-foreground))]">
          {status
            ? "This share isn't available."
            : 'A file has been shared with you. You can download it below.'}
        </p>

        {share.isLoading && (
          <p className="mt-6 text-sm text-[hsl(var(--muted-foreground))]">Loading…</p>
        )}

        {share.isError && (
          <p className="mt-6 rounded-md border border-[hsl(var(--destructive)/0.3)] bg-[hsl(var(--destructive)/0.08)] p-3 text-sm text-[hsl(var(--destructive))]">
            Failed to load share.
          </p>
        )}

        {share.data && 'status' in share.data && share.data.status !== 'ok' && (
          <p className="mt-6 rounded-md border border-[hsl(var(--destructive)/0.3)] bg-[hsl(var(--destructive)/0.08)] p-3 text-sm text-[hsl(var(--destructive))]">
            {share.data.message}
          </p>
        )}

        {share.data && 'status' in share.data && share.data.status === 'ok' && (
          <div className="mt-6 space-y-4">
            <div className="rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--surface-2))] p-3">
              <p className="truncate text-sm font-medium">{share.data.name}</p>
              <p className="text-xs text-[hsl(var(--muted-foreground))]">
                {share.data.size != null ? humanSize(share.data.size) : 'Size unknown'} ·{' '}
                {displayMimeLabel(share.data.mime, share.data.name)}
              </p>
            </div>

            {share.data.requiresPassword && (
              <div className="space-y-1">
                <p className="text-xs text-[hsl(var(--muted-foreground))]">Password required</p>
                <Input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Enter password"
                  leftIcon={<LockKeyhole />}
                />
              </div>
            )}

            <Button
              className="w-full"
              leftIcon={<Download />}
              loading={downloading}
              onClick={download}
            >
              Download
            </Button>
          </div>
        )}

        <div className="mt-6 border-t border-[hsl(var(--border))] pt-4">
          <Link to="/login" className="text-sm text-[hsl(var(--primary))] hover:underline">
            Open BunnyFile
          </Link>
        </div>
      </main>
    </div>
  );
}

const KNOWN_MIME_TYPES = new Set([
  'text/plain',
  'text/markdown',
  'text/csv',
  'application/json',
  'application/xml',
  'application/yaml',
  'application/toml',
  'text/html',
  'text/css',
  'text/javascript',
  'text/typescript',
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/svg+xml',
  'image/avif',
  'image/heic',
  'audio/mpeg',
  'audio/wav',
  'audio/flac',
  'audio/mp4',
  'audio/ogg',
  'video/mp4',
  'video/quicktime',
  'video/webm',
  'video/x-matroska',
  'application/zip',
  'application/x-tar',
  'application/gzip',
  'application/x-bzip2',
  'application/x-7z-compressed',
  'application/vnd.rar',
  'application/octet-stream',
]);

function displayMimeLabel(mime: string, name: string) {
  if (preferExtensionLabel(mime)) {
    const ext = name.includes('.') ? name.split('.').pop()?.toUpperCase() : '';
    if (ext) return ext;
  }
  if (KNOWN_MIME_TYPES.has(mime)) return mime;
  const ext = name.includes('.') ? name.split('.').pop()?.toUpperCase() : '';
  return ext || mime;
}

function preferExtensionLabel(mime: string) {
  return mime.startsWith('application/vnd.') || mime.startsWith('application/x-');
}
