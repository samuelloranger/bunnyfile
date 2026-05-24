import { useQuery } from '@tanstack/react-query';
import { createFileRoute, Navigate, useNavigate } from '@tanstack/react-router';
import { KeyRound, Mail, ShieldCheck, User } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { AuthCard, AuthShell } from '~/components/auth/auth-card';
import { Button } from '~/components/ui/button';
import { Input } from '~/components/ui/input';
import { Label } from '~/components/ui/label';
import { authClient } from '~/lib/auth-client';
import { FILES_HOME_SEARCH } from '~/lib/files-search';
import { setupStatusQuery } from '~/lib/setup';

export const Route = createFileRoute('/setup')({
  component: SetupPage,
});

function SetupPage() {
  const setup = useQuery(setupStatusQuery);
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  if (setup.isLoading) return null;
  if (setup.data && !setup.data.needsSetup) return <Navigate to="/login" />;

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setPending(true);
    const { error } = await authClient.signUp.email({
      name,
      email,
      password,
      callbackURL: '/files',
    });
    setPending(false);
    if (error) {
      setError(error.message ?? 'Sign-up failed');
      return;
    }
    await setup.refetch();
    navigate({ to: '/files', search: FILES_HOME_SEARCH });
  }

  return (
    <AuthShell>
      <AuthCard
        title="Create your admin account"
        description="You're the first user of this BunnyFile instance, so your account will have full admin access."
        footer="Additional users can be invited later."
      >
        <div className="mb-5 inline-flex items-center gap-2 rounded-full border border-[hsl(var(--primary)/0.25)] bg-[hsl(var(--primary)/0.08)] px-3 py-1 text-xs font-medium text-[hsl(var(--primary))]">
          <ShieldCheck className="size-3.5" aria-hidden />
          One-time setup
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="setup-name">Full name</Label>
            <Input
              id="setup-name"
              autoComplete="name"
              required
              leftIcon={<User />}
              value={name}
              onChange={(e) => setName(e.currentTarget.value)}
              placeholder="Ada Lovelace"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="setup-email">Email</Label>
            <Input
              id="setup-email"
              type="email"
              autoComplete="email"
              required
              leftIcon={<Mail />}
              value={email}
              onChange={(e) => setEmail(e.currentTarget.value)}
              placeholder="admin@example.com"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="setup-password">Password</Label>
            <Input
              id="setup-password"
              type="password"
              autoComplete="new-password"
              required
              minLength={8}
              leftIcon={<KeyRound />}
              value={password}
              onChange={(e) => setPassword(e.currentTarget.value)}
              placeholder="At least 8 characters"
            />
            <p className="text-[11px] text-[hsl(var(--muted-foreground))]">
              Use 8+ characters. No composition rules — length beats complexity.
            </p>
          </div>

          {error && (
            <p className="rounded-md border border-[hsl(var(--destructive)/0.3)] bg-[hsl(var(--destructive)/0.08)] px-3 py-2 text-sm text-[hsl(var(--destructive))]">
              {error}
            </p>
          )}

          <Button type="submit" className="w-full" size="lg" loading={pending}>
            Create admin account
          </Button>
        </form>
      </AuthCard>
    </AuthShell>
  );
}
