import { useQuery } from '@tanstack/react-query';
import logo from '~/assets/logo-platform-dark.svg';
import { createFileRoute, Navigate, Outlet } from '@tanstack/react-router';
import { AppShell } from '~/components/layout/app-shell';
import { authClient } from '~/lib/auth-client';
import { setupStatusQuery } from '~/lib/setup';

export const Route = createFileRoute('/_app')({
  component: AppLayout,
});

function AppLayout() {
  const setup = useQuery(setupStatusQuery);
  const session = authClient.useSession();

  if (setup.isLoading || session.isPending) return <SplashScreen />;
  if (setup.data?.needsSetup) return <Navigate to="/setup" />;
  if (!session.data?.user) return <Navigate to="/login" />;

  return (
    <AppShell>
      <Outlet />
    </AppShell>
  );
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
