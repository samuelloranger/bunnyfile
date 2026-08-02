import { useQuery } from '@tanstack/react-query';
import { createFileRoute, Navigate, Outlet } from '@tanstack/react-router';
import { AppShell } from '~/components/layout/app-shell';
import { SplashScreen } from '~/components/layout/splash-screen';
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
