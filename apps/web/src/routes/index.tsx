import { useQuery } from '@tanstack/react-query';
import { createFileRoute, Link, Navigate } from '@tanstack/react-router';
import {
  ChevronRight,
  FileText,
  Folder,
  HardDrive,
  Home,
  Image as ImageIcon,
  Share2,
} from 'lucide-react';
import logo from '~/assets/logo-platform-dark.svg';
import { Button } from '~/components/ui/button';
import { authClient } from '~/lib/auth-client';
import { FILES_HOME_SEARCH } from '~/lib/files-search';
import { setupStatusQuery } from '~/lib/setup';

export const Route = createFileRoute('/')({
  component: IndexPage,
});

function IndexPage() {
  const setup = useQuery(setupStatusQuery);
  const session = authClient.useSession();

  if (setup.isLoading || session.isPending) return <SplashScreen />;
  if (setup.data?.needsSetup) return <Navigate to="/setup" />;
  if (session.data?.user) {
    return <Navigate to="/files" search={FILES_HOME_SEARCH} />;
  }

  return <LandingPage needsSetup={false} />;
}

function SplashScreen() {
  return (
    <div className="flex h-dvh w-full items-center justify-center bg-[hsl(var(--background))]">
      <div className="flex flex-col items-center gap-3 text-[hsl(var(--muted-foreground))]">
        <img src={logo} alt="BunnyFile" className="size-10 rounded-xl shadow-sm" />
        <p className="text-xs">Loading…</p>
      </div>
    </div>
  );
}

function LandingPage({ needsSetup }: { needsSetup: boolean }) {
  return (
    <div className="min-h-dvh bg-[hsl(var(--background))] text-[hsl(var(--foreground))]">
      <div
        aria-hidden
        className="pointer-events-none fixed inset-0 -z-10 bg-[radial-gradient(ellipse_at_top,hsl(var(--primary)/0.16),transparent_55%),radial-gradient(ellipse_at_bottom_right,hsl(var(--accent)/0.12),transparent_50%)]"
      />

      <header className="mx-auto flex max-w-6xl items-center justify-between px-4 py-6 sm:px-6">
        <div className="flex items-center gap-3">
          <img src={logo} alt="BunnyFile" className="size-10 rounded-xl shadow-sm" />
          <div>
            <p className="text-sm font-semibold leading-tight">BunnyFile</p>
            <p className="text-xs text-[hsl(var(--muted-foreground))]">Files, shared. That's it.</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button asChild>
            <Link to={needsSetup ? '/setup' : '/login'}>
              {needsSetup ? 'Create admin account' : 'Sign in'}
            </Link>
          </Button>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 pb-20 pt-6 sm:px-6 sm:pt-10">
        <section className="grid items-center gap-10 lg:grid-cols-2 lg:gap-12">
          <div className="space-y-6">
            <div className="space-y-3">
              <p className="text-xs font-semibold uppercase tracking-wider text-[hsl(var(--primary))]">
                Self-hosted file hosting
              </p>
              <h1 className="text-4xl font-semibold tracking-tight sm:text-5xl">
                Your files. Your server. Zero bloat.
              </h1>
              <p className="max-w-lg text-base text-[hsl(var(--muted-foreground))] sm:text-lg">
                Browse and upload files, share password-protected links, and back up with
                S3-compatible clients — without the weight of a full collaboration suite.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <Button size="lg" asChild>
                <Link to={needsSetup ? '/setup' : '/login'}>
                  {needsSetup ? 'Create admin account' : 'Sign in'}
                </Link>
              </Button>
            </div>
            <ul className="flex flex-wrap gap-x-5 gap-y-2 text-sm text-[hsl(var(--muted-foreground))]">
              <li className="inline-flex items-center gap-1.5">
                <Folder className="size-4 text-[hsl(var(--primary))]" />
                File browser
              </li>
              <li className="inline-flex items-center gap-1.5">
                <Share2 className="size-4 text-[hsl(var(--primary))]" />
                Share links
              </li>
              <li className="inline-flex items-center gap-1.5">
                <HardDrive className="size-4 text-[hsl(var(--primary))]" />
                S3-compatible backup
              </li>
            </ul>
          </div>

          <FileManagerPreview />
        </section>

        <section className="mt-20 rounded-2xl border border-[hsl(var(--border))] bg-[hsl(var(--surface))] p-8 sm:p-10">
          <div className="max-w-2xl space-y-2">
            <div className="inline-flex items-center gap-2 text-[hsl(var(--primary))]">
              <HardDrive className="size-5" />
              <span className="text-sm font-medium">Homelab ready</span>
            </div>
            <h2 className="text-2xl font-semibold tracking-tight">One container. One process.</h2>
            <p className="text-sm text-[hsl(var(--muted-foreground))]">
              A single Bun process serves the web app and API. Files stay on disk, metadata in
              SQLite, and every upload uses write-then-rename for safety.
            </p>
          </div>
        </section>
      </main>

      <footer className="border-t border-[hsl(var(--border))] py-8 text-center text-xs text-[hsl(var(--muted-foreground))]">
        Not a Nextcloud clone. Not a sync engine. Just files, shared.
      </footer>
    </div>
  );
}

function FileManagerPreview() {
  const rows = [
    { name: 'Documents', kind: 'dir' as const, meta: '12 items' },
    { name: 'quarterly-report.pdf', kind: 'file' as const, meta: '2.4 MB' },
    { name: 'team-photo.jpg', kind: 'image' as const, meta: '840 KB' },
    { name: 'backup-notes.md', kind: 'doc' as const, meta: '4 KB' },
  ];

  return (
    <div
      aria-hidden
      className="overflow-hidden rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--surface))] shadow-lg"
    >
      <div className="flex items-center justify-between border-b border-[hsl(var(--border))] bg-[hsl(var(--surface-2))] px-4 py-3">
        <div>
          <p className="text-xs font-medium uppercase tracking-wider text-[hsl(var(--muted-foreground))]">
            Files
          </p>
          <nav className="mt-1 flex items-center gap-1 text-xs text-[hsl(var(--muted-foreground))]">
            <Home className="size-3" />
            <span>Root</span>
            <ChevronRight className="size-3" />
            <span className="text-[hsl(var(--foreground))]">Documents</span>
          </nav>
        </div>
        <span className="rounded-md bg-[hsl(var(--primary)/0.12)] px-2 py-1 text-[10px] font-medium text-[hsl(var(--primary))]">
          Preview
        </span>
      </div>
      <div className="divide-y divide-[hsl(var(--border))]">
        {rows.map((row) => (
          <div key={row.name} className="flex items-center gap-3 px-4 py-3">
            <PreviewIcon kind={row.kind} />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{row.name}</p>
            </div>
            <p className="shrink-0 text-xs text-[hsl(var(--muted-foreground))]">{row.meta}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

function PreviewIcon({ kind }: { kind: 'dir' | 'file' | 'image' | 'doc' }) {
  const className = 'size-4 shrink-0 text-[hsl(var(--muted-foreground))]';
  if (kind === 'dir') return <Folder className={className} />;
  if (kind === 'image') return <ImageIcon className={className} />;
  if (kind === 'doc') return <FileText className={className} />;
  return <FileText className={className} />;
}
