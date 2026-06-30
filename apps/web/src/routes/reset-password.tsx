import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { KeyRound } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { AuthCard, AuthShell } from '~/components/auth/auth-card';
import { Button } from '~/components/ui/button';
import { Input } from '~/components/ui/input';
import { Label } from '~/components/ui/label';
import { authClient } from '~/lib/auth-client';

export const Route = createFileRoute('/reset-password')({
  validateSearch: (search: Record<string, unknown>): { token?: string; error?: string } => {
    const out: { token?: string; error?: string } = {};
    if (typeof search.token === 'string') out.token = search.token;
    if (typeof search.error === 'string') out.error = search.error;
    return out;
  },
  component: ResetPasswordPage,
});

function ResetPasswordPage() {
  const { token, error: linkError } = Route.useSearch();
  const navigate = useNavigate();
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [done, setDone] = useState(false);

  // Hit without a token, or better-auth redirected with ?error=INVALID_TOKEN.
  if (linkError || !token) {
    return (
      <AuthShell>
        <AuthCard
          title="Reset link invalid"
          description="This password-reset link is invalid or has expired. Request a new one from the sign-in page."
        >
          <Button className="w-full" size="lg" onClick={() => navigate({ to: '/login' })}>
            Back to sign in
          </Button>
        </AuthCard>
      </AuthShell>
    );
  }

  if (done) {
    return (
      <AuthShell>
        <AuthCard
          title="Password updated"
          description="Your password has been changed and other sessions were signed out."
        >
          <Button className="w-full" size="lg" onClick={() => navigate({ to: '/login' })}>
            Go to sign in
          </Button>
        </AuthCard>
      </AuthShell>
    );
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setPending(true);
    const { error: resetError } = await authClient.resetPassword({ newPassword: password, token });
    setPending(false);
    if (resetError) {
      setError(resetError.message ?? 'Could not reset password. The link may have expired.');
      return;
    }
    setDone(true);
  }

  return (
    <AuthShell>
      <AuthCard title="Choose a new password" description="Enter a new password for your account.">
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="reset-password">New password</Label>
            <Input
              id="reset-password"
              type="password"
              autoComplete="new-password"
              required
              minLength={8}
              leftIcon={<KeyRound />}
              value={password}
              onChange={(e) => setPassword(e.currentTarget.value)}
              placeholder="At least 8 characters"
            />
          </div>

          {error && (
            <p className="rounded-md border border-[hsl(var(--destructive)/0.3)] bg-[hsl(var(--destructive)/0.08)] px-3 py-2 text-sm text-[hsl(var(--destructive))]">
              {error}
            </p>
          )}

          <Button type="submit" className="w-full" size="lg" loading={pending}>
            Update password
          </Button>
        </form>
      </AuthCard>
    </AuthShell>
  );
}
