import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import {
  KeyRound,
  Mail,
  MoreHorizontal,
  ShieldCheck,
  ShieldMinus,
  Trash2,
  UserCog,
  UserPlus,
} from 'lucide-react';
import type { FormEvent } from 'react';
import { useState } from 'react';
import { Avatar, AvatarFallback, AvatarImage } from '~/components/ui/avatar';
import { Badge } from '~/components/ui/badge';
import { Button } from '~/components/ui/button';
import { ConfirmDialog } from '~/components/ui/confirm-dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '~/components/ui/dropdown-menu';
import { Input } from '~/components/ui/input';
import { Label } from '~/components/ui/label';
import {
  Modal,
  ModalClose,
  ModalContent,
  ModalDescription,
  ModalFooter,
  ModalHeader,
  ModalTitle,
} from '~/components/ui/modal';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '~/components/ui/select';
import { api } from '~/lib/api';
import { authClient } from '~/lib/auth-client';
import { type UserRow, usersQuery } from '~/lib/users';

export const Route = createFileRoute('/_app/people')({
  component: PeoplePage,
});

function PeoplePage() {
  const session = authClient.useSession();
  const me = session.data?.user;
  const isAdmin = me?.role === 'admin';
  const users = useQuery(usersQuery);

  return (
    <div className="mx-auto max-w-6xl space-y-6 px-4 py-8 sm:px-6 lg:px-8">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-xs font-medium uppercase tracking-wider text-[hsl(var(--muted-foreground))]">
            Workspace
          </p>
          <h1 className="text-2xl font-semibold tracking-tight">People</h1>
          <p className="text-sm text-[hsl(var(--muted-foreground))]">
            Everyone with an account on this BunnyFile instance.
          </p>
        </div>
        {isAdmin && <InviteUserDialog />}
      </header>

      <section className="overflow-hidden rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--surface))]">
        {users.isLoading && (
          <p className="p-6 text-sm text-[hsl(var(--muted-foreground))]">Loading users…</p>
        )}
        {users.isError && (
          <p className="p-6 text-sm text-[hsl(var(--destructive))]">
            Could not load users: {String((users.error as Error)?.message ?? users.error)}
          </p>
        )}
        {users.data && users.data.length === 0 && (
          <p className="p-6 text-sm text-[hsl(var(--muted-foreground))]">No users yet.</p>
        )}
        {users.data && users.data.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[hsl(var(--border))] bg-[hsl(var(--surface-2))] text-left text-[11px] font-semibold uppercase tracking-wider text-[hsl(var(--muted-foreground))]">
                  <Th className="w-full">Name</Th>
                  <Th>Email</Th>
                  <Th>Role</Th>
                  <Th>Joined</Th>
                  <Th className="text-right">{isAdmin ? 'Actions' : ''}</Th>
                </tr>
              </thead>
              <tbody>
                {users.data.map((u) => (
                  <UserRowView key={u.id} user={u} isMe={me?.id === u.id} isAdminViewer={isAdmin} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

function Th({ children, className }: { children: React.ReactNode; className?: string }) {
  return <th className={`px-4 py-2.5 font-semibold ${className ?? ''}`}>{children}</th>;
}

function Td({ children, className }: { children: React.ReactNode; className?: string }) {
  return <td className={`px-4 py-3 align-middle ${className ?? ''}`}>{children}</td>;
}

function UserRowView({
  user,
  isMe,
  isAdminViewer,
}: {
  user: UserRow;
  isMe: boolean;
  isAdminViewer: boolean;
}) {
  const initials = (user.name || user.email)
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0] ?? '')
    .join('')
    .toUpperCase();

  const joined = new Date(user.createdAt).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });

  return (
    <tr className="border-b border-[hsl(var(--border))] last:border-b-0 transition-colors hover:bg-[hsl(var(--muted)/0.3)]">
      <Td>
        <div className="flex items-center gap-3">
          <Avatar size="sm">
            {user.image && <AvatarImage src={user.image} alt="" />}
            <AvatarFallback>{initials}</AvatarFallback>
          </Avatar>
          <div className="min-w-0">
            <p className="flex items-center gap-2 truncate font-medium">
              {user.name}
              {isMe && (
                <span className="text-[11px] font-normal text-[hsl(var(--muted-foreground))]">
                  (you)
                </span>
              )}
            </p>
          </div>
        </div>
      </Td>
      <Td className="text-[hsl(var(--muted-foreground))]">{user.email}</Td>
      <Td>
        {user.role === 'admin' ? (
          <Badge variant="primary">
            <UserCog className="size-3" /> Admin
          </Badge>
        ) : (
          <Badge>Member</Badge>
        )}
      </Td>
      <Td className="whitespace-nowrap text-[hsl(var(--muted-foreground))]">{joined}</Td>
      <Td className="text-right">{isAdminViewer && !isMe && <UserActions user={user} />}</Td>
    </tr>
  );
}

function UserActions({ user }: { user: UserRow }) {
  const qc = useQueryClient();
  const promoteOrDemote = useMutation({
    mutationFn: async (role: 'admin' | 'user') => {
      const { error } = await api.api.users({ id: user.id }).patch({ role });
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['users'] }),
  });
  const deleteUser = useMutation({
    mutationFn: async () => {
      const { error } = await api.api.users({ id: user.id }).delete();
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['users'] }),
  });

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${user.name}`}>
          <MoreHorizontal />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
        {user.role === 'admin' ? (
          <DropdownMenuItem
            onSelect={() => promoteOrDemote.mutate('user')}
            disabled={promoteOrDemote.isPending}
          >
            <ShieldMinus /> Demote to member
          </DropdownMenuItem>
        ) : (
          <DropdownMenuItem
            onSelect={() => promoteOrDemote.mutate('admin')}
            disabled={promoteOrDemote.isPending}
          >
            <ShieldCheck /> Promote to admin
          </DropdownMenuItem>
        )}
        <DropdownMenuSeparator />
        <ConfirmDialog
          trigger={
            <DropdownMenuItem
              destructive
              onSelect={(e) => {
                // Keep the menu item from closing the ConfirmDialog trigger
                e.preventDefault();
              }}
            >
              <Trash2 /> Delete user
            </DropdownMenuItem>
          }
          title={`Delete ${user.name}?`}
          description="This removes the account, all sessions, and linked credentials. Files uploaded by this user are not deleted."
          confirmLabel="Delete user"
          tone="destructive"
          onConfirm={() => deleteUser.mutateAsync()}
        />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function InviteUserDialog() {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<'admin' | 'user'>('user');
  const [error, setError] = useState<string | null>(null);
  const qc = useQueryClient();

  const createUser = useMutation({
    mutationFn: async () => {
      const { data, error } = await api.api.users.post({ name, email, password, role });
      if (error) throw error;
      if (data && 'error' in data) throw new Error(data.error);
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['users'] });
      setOpen(false);
      setName('');
      setEmail('');
      setPassword('');
      setRole('user');
      setError(null);
    },
    onError: (err: unknown) => {
      setError(err instanceof Error ? err.message : String(err));
    },
  });

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    createUser.mutate();
  }

  return (
    <Modal open={open} onOpenChange={setOpen}>
      <Button leftIcon={<UserPlus />} onClick={() => setOpen(true)}>
        Invite user
      </Button>
      <ModalContent size="md">
        <ModalHeader>
          <ModalTitle>Invite a new user</ModalTitle>
          <ModalDescription>
            Create the account with an initial password. Share it with them — they can change it
            from their profile.
          </ModalDescription>
        </ModalHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="invite-name">Full name</Label>
            <Input
              id="invite-name"
              required
              value={name}
              onChange={(e) => setName(e.currentTarget.value)}
              placeholder="Grace Hopper"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="invite-email">Email</Label>
            <Input
              id="invite-email"
              type="email"
              required
              leftIcon={<Mail />}
              value={email}
              onChange={(e) => setEmail(e.currentTarget.value)}
              placeholder="grace@example.com"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="invite-password">Initial password</Label>
            <Input
              id="invite-password"
              type="text"
              required
              minLength={8}
              leftIcon={<KeyRound />}
              value={password}
              onChange={(e) => setPassword(e.currentTarget.value)}
              placeholder="At least 8 characters"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="invite-role">Role</Label>
            <Select value={role} onValueChange={(v) => setRole(v as 'admin' | 'user')}>
              <SelectTrigger id="invite-role">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="user">Member — regular access</SelectItem>
                <SelectItem value="admin">Admin — full control</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {error && (
            <p className="rounded-md border border-[hsl(var(--destructive)/0.3)] bg-[hsl(var(--destructive)/0.08)] px-3 py-2 text-sm text-[hsl(var(--destructive))]">
              {error}
            </p>
          )}

          <ModalFooter>
            <ModalClose asChild>
              <Button variant="outline" type="button" disabled={createUser.isPending}>
                Cancel
              </Button>
            </ModalClose>
            <Button type="submit" loading={createUser.isPending}>
              Create user
            </Button>
          </ModalFooter>
        </form>
      </ModalContent>
    </Modal>
  );
}
