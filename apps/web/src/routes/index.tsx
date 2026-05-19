import { useQuery } from '@tanstack/react-query';
import { createFileRoute, Link, Navigate } from '@tanstack/react-router';
import { Cloud, HardDrive, Share2, Shield, Zap } from 'lucide-react';
import logo from '~/assets/logo-platform-dark.svg';
import { HomeDashboard } from '~/components/home-dashboard';
import { AppShell } from '~/components/layout/app-shell';
import { Button } from '~/components/ui/button';
import { authClient } from '~/lib/auth-client';
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
    return (
      <AppShell>
        <HomeDashboard />
      </AppShell>
    );
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
          <Button variant="ghost" asChild>
            <Link to="/login">Sign in</Link>
          </Button>
          <Button asChild>
            <Link to={needsSetup ? '/setup' : '/login'}>
              {needsSetup ? 'Set up' : 'Get started'}
            </Link>
          </Button>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 pb-20 pt-10 sm:px-6 sm:pt-16">
        <section className="mx-auto max-w-3xl text-center">
          <p className="text-xs font-semibold uppercase tracking-wider text-[hsl(var(--primary))]">
            Self-hosted file hosting
          </p>
          <h1 className="mt-3 text-4xl font-semibold tracking-tight sm:text-5xl">
            Your files. Your server. Zero bloat.
          </h1>
          <p className="mt-4 text-base text-[hsl(var(--muted-foreground))] sm:text-lg">
            BunnyFile replaces the files half of Nextcloud — browse, upload, share, and back up with
            an S3-compatible API. Built on Bun, SQLite, and a filesystem you can actually trust.
          </p>
          <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
            <Button size="lg" asChild>
              <Link to={needsSetup ? '/setup' : '/login'}>
                {needsSetup ? 'Create admin account' : 'Sign in to your instance'}
              </Link>
            </Button>
            <Button size="lg" variant="outline" asChild>
              <Link to="/login">Learn more in the app</Link>
            </Button>
          </div>
        </section>

        <section className="mt-16 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <FeatureCard
            icon={<Zap />}
            title="Fast & lean"
            body="Cold start under half a second. Idle RAM measured in megabytes, not gigabytes."
          />
          <FeatureCard
            icon={<Cloud />}
            title="S3-compatible"
            body="Point rclone, restic, or kopia at BunnyFile. Multipart uploads, presigned URLs, access keys."
          />
          <FeatureCard
            icon={<Share2 />}
            title="Share links"
            body="Password-protected, expiring links with QR codes — no WeTransfer required."
          />
          <FeatureCard
            icon={<Shield />}
            title="You own the data"
            body="Files stay on disk. Metadata in SQLite. Write-then-rename for every upload."
          />
        </section>

        <section className="mt-16 rounded-2xl border border-[hsl(var(--border))] bg-[hsl(var(--surface))] p-8 sm:p-10">
          <div className="flex flex-col gap-6 sm:flex-row sm:items-center sm:justify-between">
            <div className="space-y-2">
              <div className="inline-flex items-center gap-2 text-[hsl(var(--primary))]">
                <HardDrive className="size-5" />
                <span className="text-sm font-medium">Homelab ready</span>
              </div>
              <h2 className="text-2xl font-semibold tracking-tight">One container. One process.</h2>
              <p className="max-w-xl text-sm text-[hsl(var(--muted-foreground))]">
                Elysia serves the React SPA and REST API together. Docker image on GHCR. Example
                Compose stacks for standalone, Caddy, and Tinyauth.
              </p>
            </div>
            <Button size="lg" variant="outline" asChild>
              <Link to="/login">Open your instance</Link>
            </Button>
          </div>
        </section>
      </main>

      <footer className="border-t border-[hsl(var(--border))] py-8 text-center text-xs text-[hsl(var(--muted-foreground))]">
        Not a Nextcloud clone. Not a sync engine. Just files, shared.
      </footer>
    </div>
  );
}

function FeatureCard({
  icon,
  title,
  body,
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
}) {
  return (
    <div className="rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--surface))] p-5">
      <div className="inline-flex size-10 items-center justify-center rounded-lg bg-[hsl(var(--primary)/0.12)] text-[hsl(var(--primary))] [&_svg]:size-5">
        {icon}
      </div>
      <h3 className="mt-4 text-sm font-semibold">{title}</h3>
      <p className="mt-1.5 text-sm text-[hsl(var(--muted-foreground))]">{body}</p>
    </div>
  );
}
