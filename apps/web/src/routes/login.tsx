import { useQuery } from '@tanstack/react-query';
import { createFileRoute, Navigate, useNavigate } from '@tanstack/react-router';
import { KeyRound, Mail } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { AuthCard, AuthShell } from '~/components/auth/auth-card';
import { SplashScreen } from '~/components/layout/splash-screen';
import { Button } from '~/components/ui/button';
import { Input } from '~/components/ui/input';
import { Label } from '~/components/ui/label';
import { authClient } from '~/lib/auth-client';
import { FILES_HOME_SEARCH } from '~/lib/files-search';
import { setupStatusQuery } from '~/lib/setup';

export const Route = createFileRoute('/login')({
  component: LoginPage,
});

function LoginPage() {
  const setup = useQuery(setupStatusQuery);
  const session = authClient.useSession();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [showForgot, setShowForgot] = useState(false);

  if (setup.isLoading || session.isPending)
    return <SplashScreen message="Checking your session…" />;
  if (setup.data?.needsSetup) return <Navigate to="/setup" />;
  if (session.data?.user) return <Navigate to="/files" search={FILES_HOME_SEARCH} />;

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setPending(true);
    const { error } = await authClient.signIn.email({ email, password });
    setPending(false);
    if (error) {
      setError(error.message ?? 'Invalid email or password');
      return;
    }
    navigate({ to: '/files', search: FILES_HOME_SEARCH });
  }

  return (
    <AuthShell>
      <AuthCard title="Welcome back" description="Sign in to your BunnyFile account.">
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="login-email">Email</Label>
            <Input
              id="login-email"
              type="email"
              autoComplete="email"
              required
              leftIcon={<Mail />}
              value={email}
              onChange={(e) => setEmail(e.currentTarget.value)}
              placeholder="you@example.com"
              aria-describedby={error ? 'login-error' : undefined}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="login-password">Password</Label>
            <Input
              id="login-password"
              type="password"
              autoComplete="current-password"
              required
              leftIcon={<KeyRound />}
              value={password}
              onChange={(e) => setPassword(e.currentTarget.value)}
              placeholder="••••••••"
              aria-describedby={error ? 'login-error' : undefined}
            />
          </div>

          {error && (
            <p
              id="login-error"
              role="alert"
              className="rounded-md border border-[hsl(var(--destructive)/0.3)] bg-[hsl(var(--destructive)/0.08)] px-3 py-2 text-sm text-[hsl(var(--destructive))]"
            >
              {error}
            </p>
          )}

          <Button type="submit" className="w-full" size="lg" loading={pending}>
            Sign in
          </Button>
        </form>

        <div className="mt-4 space-y-2">
          <button
            type="button"
            className="w-full text-center text-sm text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))] transition-colors"
            onClick={() => setShowForgot((v) => !v)}
            aria-expanded={showForgot}
          >
            Forgot password?
          </button>

          {showForgot && <ForgotPasswordForm prefillEmail={email} />}
        </div>
      </AuthCard>
    </AuthShell>
  );
}

function ForgotPasswordForm({ prefillEmail }: { prefillEmail: string }) {
  const [resetEmail, setResetEmail] = useState(prefillEmail);
  const [status, setStatus] = useState<'idle' | 'pending' | 'done' | 'err'>('idle');

  async function handleReset(e: FormEvent) {
    e.preventDefault();
    setStatus('pending');
    const { error } = await authClient.requestPasswordReset({
      email: resetEmail,
      redirectTo: `${window.location.origin}/reset-password`,
    });
    setStatus(error ? 'err' : 'done');
  }

  if (status === 'done') {
    return (
      <p
        role="status"
        className="rounded-md border border-[hsl(var(--success)/0.3)] bg-[hsl(var(--success)/0.08)] px-3 py-2 text-sm text-[hsl(var(--success))]"
      >
        If that account exists, a password-reset link is on its way. Check your email.
      </p>
    );
  }

  return (
    <div className="space-y-2 rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--surface-2))] p-3">
      <p id="forgot-hint" className="text-xs text-[hsl(var(--muted-foreground))]">
        Enter your email and we'll send a link to reset your password.
      </p>
      <form onSubmit={handleReset} className="flex flex-col gap-2 sm:flex-row sm:items-end">
        <div className="min-w-0 flex-1 space-y-1.5">
          <Label htmlFor="forgot-email">Email for reset link</Label>
          <Input
            id="forgot-email"
            type="email"
            required
            value={resetEmail}
            onChange={(e) => setResetEmail(e.currentTarget.value)}
            placeholder="your@email.com"
            aria-describedby="forgot-hint"
          />
        </div>
        <Button type="submit" size="sm" loading={status === 'pending'} variant="outline">
          Send reset link
        </Button>
      </form>
      {status === 'err' && (
        <p role="alert" className="text-xs text-[hsl(var(--destructive))]">
          Couldn't send the reset email. Check the address and try again.
        </p>
      )}
    </div>
  );
}
