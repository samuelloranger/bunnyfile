import { useQuery } from '@tanstack/react-query';
import { createFileRoute, Link } from '@tanstack/react-router';
import { Clock, Download, LockKeyhole, ShieldAlert } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import logo from '~/assets/logo-platform-dark.svg';
import { Badge } from '~/components/ui/badge';
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
  const [passwordError, setPasswordError] = useState<string | null>(null);

  const share = useQuery({
    queryKey: ['public-share', token],
    queryFn: async () => {
      const { data, error } = await api.api.shares.public({ token }).get();
      if (error) throw error;
      return data;
    },
    retry: false,
  });

  const status =
    share.data && 'status' in share.data && share.data.status !== 'ok' ? share.data.status : null;

  function handleSubmit(e: FormEvent<HTMLFormElement>) {
    if (
      share.data &&
      'status' in share.data &&
      share.data.status === 'ok' &&
      share.data.requiresPassword &&
      !password.trim()
    ) {
      e.preventDefault();
      setPasswordError('Enter the password before downloading.');
    }
  }

  const okShare =
    share.data && 'status' in share.data && share.data.status === 'ok' ? share.data : null;

  return (
    <div className="flex min-h-dvh flex-col bg-[hsl(var(--background))]">
      <header className="border-b border-[hsl(var(--border))] bg-[hsl(var(--surface))] px-4 py-4 sm:px-6">
        <div className="mx-auto flex max-w-xl items-center gap-3">
          <img src={logo} alt="BunnyFile" className="size-9 rounded-lg shadow-sm" />
          <div>
            <p className="text-sm font-semibold leading-tight">BunnyFile</p>
            <p className="text-xs text-[hsl(var(--muted-foreground))]">Shared file</p>
          </div>
        </div>
      </header>

      <main className="flex flex-1 items-center justify-center px-4 py-8">
        <div className="w-full max-w-xl rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--surface))] p-6 shadow-sm">
          {share.isLoading && (
            <p className="text-sm text-[hsl(var(--muted-foreground))]">Loading share…</p>
          )}

          {share.isError && (
            <p className="rounded-md border border-[hsl(var(--destructive)/0.3)] bg-[hsl(var(--destructive)/0.08)] p-3 text-sm text-[hsl(var(--destructive))]">
              Failed to load this share. The link may be invalid.
            </p>
          )}

          {status && share.data && 'message' in share.data && (
            <div className="space-y-3">
              <h1 className="text-xl font-semibold tracking-tight">Share unavailable</h1>
              <p className="rounded-md border border-[hsl(var(--destructive)/0.3)] bg-[hsl(var(--destructive)/0.08)] p-3 text-sm text-[hsl(var(--destructive))]">
                {share.data.message}
              </p>
            </div>
          )}

          {okShare && (
            <div className="space-y-5">
              <div className="space-y-2">
                <h1 className="truncate text-2xl font-semibold tracking-tight">{okShare.name}</h1>
                <p className="text-sm text-[hsl(var(--muted-foreground))]">
                  {okShare.size != null ? humanSize(okShare.size) : 'Size unknown'} ·{' '}
                  {displayMimeLabel(okShare.mime, okShare.name)}
                </p>
                <div className="flex flex-wrap gap-2">
                  {okShare.requiresPassword && (
                    <Badge variant="outline">
                      <LockKeyhole className="size-3" /> Password protected
                    </Badge>
                  )}
                  {okShare.expiresAt && (
                    <Badge variant="outline">
                      <Clock className="size-3" />
                      Expires {formatExpiry(okShare.expiresAt)}
                    </Badge>
                  )}
                  {okShare.maxDownloads != null && (
                    <Badge variant="outline">
                      <ShieldAlert className="size-3" />
                      {okShare.downloadCount} / {okShare.maxDownloads} downloads used
                    </Badge>
                  )}
                </div>
              </div>

              <form
                method="POST"
                action={`/api/shares/public/${encodeURIComponent(token)}/file`}
                onSubmit={handleSubmit}
                className="space-y-4"
              >
                {okShare.requiresPassword && (
                  <div className="space-y-1">
                    <p className="text-xs text-[hsl(var(--muted-foreground))]">
                      Password required to download
                    </p>
                    <Input
                      type="password"
                      name="password"
                      value={password}
                      onChange={(e) => {
                        setPassword(e.target.value);
                        setPasswordError(null);
                      }}
                      placeholder="Enter password"
                      leftIcon={<LockKeyhole />}
                      invalid={Boolean(passwordError)}
                    />
                    {passwordError && (
                      <p className="text-xs text-[hsl(var(--destructive))]">{passwordError}</p>
                    )}
                  </div>
                )}

                <Button type="submit" className="w-full" leftIcon={<Download />}>
                  Download file
                </Button>
              </form>
            </div>
          )}
        </div>
      </main>

      <footer className="border-t border-[hsl(var(--border))] px-4 py-4 text-center sm:px-6">
        <Link to="/login" className="text-sm text-[hsl(var(--primary))] hover:underline">
          Open BunnyFile
        </Link>
      </footer>
    </div>
  );
}

function formatExpiry(expiresAt: string | number | Date) {
  return new Date(expiresAt).toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
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
