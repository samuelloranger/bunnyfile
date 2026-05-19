import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import {
  CheckCircle2,
  Image as ImageIcon,
  KeyRound,
  Monitor,
  Smartphone,
  UserCog,
  XCircle,
} from 'lucide-react';
import type { FormEvent } from 'react';
import { useState } from 'react';
import { Avatar, AvatarFallback, AvatarImage } from '~/components/ui/avatar';
import { Badge } from '~/components/ui/badge';
import { Button } from '~/components/ui/button';
import { Input } from '~/components/ui/input';
import { Label } from '~/components/ui/label';
import { Separator } from '~/components/ui/separator';
import { authClient } from '~/lib/auth-client';
import { pushNotification } from '~/lib/notifications';

export const Route = createFileRoute('/_app/profile')({
  component: ProfilePage,
});

type FormStatus = { kind: 'idle' } | { kind: 'ok'; msg: string } | { kind: 'err'; msg: string };

function initialsOf(nameOrEmail: string | null | undefined) {
  if (!nameOrEmail) return '?';
  const parts = nameOrEmail.trim().split(/\s+/);
  if (parts.length >= 2 && parts[0] && parts[1]) {
    return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
  }
  return nameOrEmail.slice(0, 2).toUpperCase();
}

function ProfilePage() {
  const session = authClient.useSession();
  const user = session.data?.user;
  const isAdmin = user?.role === 'admin';

  if (!user) return null;

  return (
    <div className="mx-auto max-w-3xl space-y-8 px-4 py-8 sm:px-6 lg:px-8">
      <header className="flex items-center gap-5">
        <Avatar size="xl">
          {user.image && <AvatarImage src={user.image} alt="" />}
          <AvatarFallback>{initialsOf(user.name ?? user.email)}</AvatarFallback>
        </Avatar>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="truncate text-2xl font-semibold tracking-tight">{user.name}</h1>
            {isAdmin && (
              <Badge variant="primary">
                <UserCog className="size-3" /> Admin
              </Badge>
            )}
          </div>
          <p className="truncate text-sm text-[hsl(var(--muted-foreground))]">{user.email}</p>
        </div>
      </header>

      <ProfileCard />
      <EmailCard />
      <PasswordCard />
      <SessionsCard currentSessionId={session.data?.session?.id} />
    </div>
  );
}

function ProfileCard() {
  const session = authClient.useSession();
  const user = session.data?.user;
  const [name, setName] = useState(user?.name ?? '');
  const [image, setImage] = useState(user?.image ?? '');
  const [status, setStatus] = useState<FormStatus>({ kind: 'idle' });

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setStatus({ kind: 'idle' });
    const { error } = await authClient.updateUser({ name, image: image || null });
    if (error) {
      setStatus({ kind: 'err', msg: error.message ?? 'Could not update profile' });
      pushNotification({
        kind: 'error',
        title: 'Could not update profile',
        body: error.message ?? undefined,
      });
      return;
    }
    await session.refetch();
    setStatus({ kind: 'ok', msg: 'Profile updated' });
    pushNotification({ kind: 'success', title: 'Profile updated' });
  }

  return (
    <SectionCard title="Profile" description="What other people see on this instance.">
      <form onSubmit={handleSubmit} className="space-y-4">
        <Field label="Display name" htmlFor="name">
          <Input
            id="name"
            value={name}
            onChange={(e) => setName(e.currentTarget.value)}
            required
            maxLength={120}
          />
        </Field>
        <Field label="Email" htmlFor="email">
          <Input id="email" value={user?.email ?? ''} disabled readOnly />
        </Field>
        <Field
          label="Avatar URL"
          htmlFor="image"
          hint="Paste a link to an image. File upload will land with Phase 1."
        >
          <Input
            id="image"
            leftIcon={<ImageIcon />}
            value={image}
            onChange={(e) => setImage(e.currentTarget.value)}
            placeholder="https://…"
          />
        </Field>
        <StatusLine status={status} />
        <div className="flex justify-end">
          <Button type="submit">Save changes</Button>
        </div>
      </form>
    </SectionCard>
  );
}

function EmailCard() {
  const session = authClient.useSession();
  const [password, setPassword] = useState('');
  const [newEmail, setNewEmail] = useState('');
  const [status, setStatus] = useState<FormStatus>({ kind: 'idle' });
  const [pending, setPending] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setStatus({ kind: 'idle' });
    setPending(true);
    try {
      const res = await fetch('/api/users/me/email', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentPassword: password, newEmail }),
        credentials: 'include',
      });
      const json = await res.json();
      if (!res.ok) {
        const msg = (json as { error: string }).error ?? 'Could not update email';
        setStatus({ kind: 'err', msg });
        pushNotification({ kind: 'error', title: 'Could not update email', body: msg });
        return;
      }
      await session.refetch();
      setPassword('');
      setNewEmail('');
      setStatus({ kind: 'ok', msg: 'Email updated successfully' });
      pushNotification({ kind: 'success', title: 'Email updated' });
    } catch {
      setStatus({ kind: 'err', msg: 'Network error' });
      pushNotification({ kind: 'error', title: 'Could not update email', body: 'Network error' });
    } finally {
      setPending(false);
    }
  }

  return (
    <SectionCard
      title="Email address"
      description="Confirm your current password to change your email."
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        <Field label="New email" htmlFor="new-email">
          <Input
            id="new-email"
            type="email"
            value={newEmail}
            onChange={(e) => setNewEmail(e.currentTarget.value)}
            required
          />
        </Field>
        <Field label="Current password" htmlFor="email-password">
          <Input
            id="email-password"
            type="password"
            autoComplete="current-password"
            leftIcon={<KeyRound />}
            value={password}
            onChange={(e) => setPassword(e.currentTarget.value)}
            required
          />
        </Field>
        <StatusLine status={status} />
        <div className="flex justify-end">
          <Button type="submit" loading={pending}>
            Change email
          </Button>
        </div>
      </form>
    </SectionCard>
  );
}

function PasswordCard() {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [status, setStatus] = useState<FormStatus>({ kind: 'idle' });
  const [pending, setPending] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setStatus({ kind: 'idle' });
    if (next !== confirm) {
      setStatus({ kind: 'err', msg: 'New passwords do not match' });
      return;
    }
    if (next.length < 8) {
      setStatus({ kind: 'err', msg: 'New password must be at least 8 characters' });
      return;
    }
    setPending(true);
    const { error } = await authClient.changePassword({
      currentPassword: current,
      newPassword: next,
      revokeOtherSessions: true,
    });
    setPending(false);
    if (error) {
      setStatus({ kind: 'err', msg: error.message ?? 'Could not change password' });
      pushNotification({
        kind: 'error',
        title: 'Could not change password',
        body: error.message ?? undefined,
      });
      return;
    }
    setCurrent('');
    setNext('');
    setConfirm('');
    setStatus({ kind: 'ok', msg: 'Password changed. Other sessions were signed out.' });
    pushNotification({
      kind: 'success',
      title: 'Password changed',
      body: 'Other sessions were signed out.',
    });
  }

  return (
    <SectionCard
      title="Password"
      description="Changing your password signs out all other sessions."
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        <Field label="Current password" htmlFor="current-password">
          <Input
            id="current-password"
            type="password"
            autoComplete="current-password"
            leftIcon={<KeyRound />}
            value={current}
            onChange={(e) => setCurrent(e.currentTarget.value)}
            required
          />
        </Field>
        <Field label="New password" htmlFor="new-password" hint="At least 8 characters.">
          <Input
            id="new-password"
            type="password"
            autoComplete="new-password"
            leftIcon={<KeyRound />}
            value={next}
            onChange={(e) => setNext(e.currentTarget.value)}
            minLength={8}
            required
          />
        </Field>
        <Field label="Confirm new password" htmlFor="confirm-password">
          <Input
            id="confirm-password"
            type="password"
            autoComplete="new-password"
            leftIcon={<KeyRound />}
            value={confirm}
            onChange={(e) => setConfirm(e.currentTarget.value)}
            minLength={8}
            required
          />
        </Field>
        <StatusLine status={status} />
        <div className="flex justify-end">
          <Button type="submit" loading={pending}>
            Change password
          </Button>
        </div>
      </form>
    </SectionCard>
  );
}

function SessionsCard({ currentSessionId }: { currentSessionId: string | undefined }) {
  const qc = useQueryClient();
  const sessions = useQuery({
    queryKey: ['sessions', 'me'],
    queryFn: async () => {
      const { data, error } = await authClient.listSessions();
      if (error) throw error;
      return data;
    },
  });

  const revokeOne = useMutation({
    mutationFn: async (token: string) => {
      const { error } = await authClient.revokeSession({ token });
      if (error) throw new Error(error.message ?? 'Could not revoke session');
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['sessions', 'me'] });
      pushNotification({ kind: 'success', title: 'Session revoked' });
    },
    onError: (err: unknown) => {
      pushNotification({
        kind: 'error',
        title: 'Could not revoke session',
        body: err instanceof Error ? err.message : undefined,
      });
    },
  });
  const revokeOthers = useMutation({
    mutationFn: async () => {
      const { error } = await authClient.revokeOtherSessions();
      if (error) throw new Error(error.message ?? 'Could not sign out other sessions');
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['sessions', 'me'] });
      pushNotification({ kind: 'success', title: 'Other sessions signed out' });
    },
    onError: (err: unknown) => {
      pushNotification({
        kind: 'error',
        title: 'Could not sign out other sessions',
        body: err instanceof Error ? err.message : undefined,
      });
    },
  });

  return (
    <SectionCard
      title="Active sessions"
      description="Devices currently signed in as you."
      action={
        <Button
          variant="outline"
          size="sm"
          loading={revokeOthers.isPending}
          onClick={() => revokeOthers.mutate()}
        >
          Sign out other sessions
        </Button>
      }
    >
      {sessions.isLoading && (
        <p className="text-sm text-[hsl(var(--muted-foreground))]">Loading…</p>
      )}
      {sessions.data && sessions.data.length === 0 && (
        <p className="text-sm text-[hsl(var(--muted-foreground))]">No active sessions.</p>
      )}
      <ul className="space-y-2">
        {sessions.data?.map((s) => {
          const isCurrent = s.id === currentSessionId;
          const ua = s.userAgent ?? 'Unknown device';
          const isMobile = /mobi|android|iphone/i.test(ua);
          return (
            <li
              key={s.id}
              className="flex items-center gap-3 rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--surface-2))] p-3"
            >
              <div className="flex size-9 items-center justify-center rounded-lg bg-[hsl(var(--muted))] text-[hsl(var(--muted-foreground))]">
                {isMobile ? <Smartphone className="size-4" /> : <Monitor className="size-4" />}
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="truncate text-sm font-medium">{truncateUA(ua)}</p>
                  {isCurrent && <Badge variant="success">This device</Badge>}
                </div>
                <p className="truncate text-xs text-[hsl(var(--muted-foreground))]">
                  {s.ipAddress ?? 'unknown IP'} · expires {relative(s.expiresAt)}
                </p>
              </div>
              {!isCurrent && (
                <Button
                  variant="ghost"
                  size="sm"
                  loading={revokeOne.isPending && revokeOne.variables === s.token}
                  onClick={() => revokeOne.mutate(s.token)}
                >
                  Revoke
                </Button>
              )}
            </li>
          );
        })}
      </ul>
    </SectionCard>
  );
}

function truncateUA(ua: string) {
  // A friendlier label than the raw User-Agent string.
  const m = ua.match(/(Chrome|Firefox|Safari|Edge|Opera)[\s/]*([\d.]+)?/i);
  if (m?.[1]) return `${m[1]}${m[2] ? ` ${m[2].split('.')[0]}` : ''}`;
  return ua.length > 48 ? `${ua.slice(0, 48)}…` : ua;
}

function relative(date: string | Date) {
  const d = typeof date === 'string' ? new Date(date) : date;
  const delta = d.getTime() - Date.now();
  const days = Math.round(delta / 86_400_000);
  if (days >= 2) return `in ${days} days`;
  if (days === 1) return 'tomorrow';
  if (days === 0) return 'today';
  if (days === -1) return 'yesterday';
  return `${Math.abs(days)} days ago`;
}

function SectionCard({
  title,
  description,
  action,
  children,
}: {
  title: string;
  description?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--surface))] p-6">
      <div className="mb-4 flex items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold tracking-tight">{title}</h2>
          {description && (
            <p className="text-sm text-[hsl(var(--muted-foreground))]">{description}</p>
          )}
        </div>
        {action}
      </div>
      <Separator className="mb-4" />
      {children}
    </section>
  );
}

function Field({
  label,
  htmlFor,
  hint,
  children,
}: {
  label: string;
  htmlFor: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {hint && <p className="text-[11px] text-[hsl(var(--muted-foreground))]">{hint}</p>}
    </div>
  );
}

function StatusLine({ status }: { status: FormStatus }) {
  if (status.kind === 'idle') return null;
  const Icon = status.kind === 'ok' ? CheckCircle2 : XCircle;
  const tone =
    status.kind === 'ok'
      ? 'border-[hsl(var(--success)/0.3)] bg-[hsl(var(--success)/0.08)] text-[hsl(var(--success))]'
      : 'border-[hsl(var(--destructive)/0.3)] bg-[hsl(var(--destructive)/0.08)] text-[hsl(var(--destructive))]';
  return (
    <p
      className={`flex items-center gap-2 rounded-md border px-3 py-2 text-sm ${tone}`}
      role={status.kind === 'err' ? 'alert' : 'status'}
    >
      <Icon className="size-4 shrink-0" aria-hidden />
      {status.msg}
    </p>
  );
}
