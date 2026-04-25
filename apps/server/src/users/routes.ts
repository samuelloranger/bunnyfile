import { asc, count, eq } from 'drizzle-orm';
import { Elysia, t } from 'elysia';
import { auth } from '../auth/auth';
import { db } from '../db';
import { account, user } from '../db/schema';

type Role = 'admin' | 'user';

const publicUserShape = {
  id: user.id,
  name: user.name,
  email: user.email,
  emailVerified: user.emailVerified,
  image: user.image,
  role: user.role,
  createdAt: user.createdAt,
};

async function adminCount(): Promise<number> {
  const [row] = await db.select({ c: count() }).from(user).where(eq(user.role, 'admin'));
  return row?.c ?? 0;
}

async function callerFromRequest(request: Request) {
  return auth.api.getSession({ headers: request.headers });
}

export const usersRoutes = new Elysia({ name: 'users' })
  // Any authenticated user can see the people list. Roles are visible so
  // members know who has admin rights.
  .get('/api/users', async ({ request, set }) => {
    const s = await callerFromRequest(request);
    if (!s?.user) {
      set.status = 401;
      return { error: 'unauthorized' as const };
    }
    const rows = await db.select(publicUserShape).from(user).orderBy(asc(user.createdAt));
    return rows.map((r) => ({
      ...r,
      createdAt: r.createdAt.toISOString(),
    }));
  })

  // Admin creates a new user. Initial password is set by the admin — member
  // changes it later from /profile. No email flow yet.
  .post(
    '/api/users',
    async ({ request, body, set }) => {
      const s = await callerFromRequest(request);
      if (!s?.user) {
        set.status = 401;
        return { error: 'unauthorized' as const };
      }
      if (s.user.role !== 'admin') {
        set.status = 403;
        return { error: 'forbidden' as const };
      }
      try {
        const result = await auth.api.signUpEmail({
          body: {
            name: body.name,
            email: body.email,
            password: body.password,
          },
        });
        const createdId = result.user.id;
        if (body.role === 'admin') {
          await db.update(user).set({ role: 'admin' }).where(eq(user.id, createdId));
        }
        const [row] = await db.select(publicUserShape).from(user).where(eq(user.id, createdId));
        if (!row) {
          set.status = 500;
          return { error: 'user created but not found' as const };
        }
        return { ...row, createdAt: row.createdAt.toISOString() };
      } catch (err) {
        set.status = 400;
        const message = err instanceof Error ? err.message : String(err);
        return { error: message };
      }
    },
    {
      body: t.Object({
        name: t.String({ minLength: 1, maxLength: 120 }),
        email: t.String({ format: 'email' }),
        password: t.String({ minLength: 8, maxLength: 128 }),
        role: t.Union([t.Literal('admin'), t.Literal('user')]),
      }),
    },
  )

  // Admin changes another user's role. Blocks demotion of the last admin.
  .patch(
    '/api/users/:id',
    async ({ request, params, body, set }) => {
      const s = await callerFromRequest(request);
      if (!s?.user) {
        set.status = 401;
        return { error: 'unauthorized' as const };
      }
      if (s.user.role !== 'admin') {
        set.status = 403;
        return { error: 'forbidden' as const };
      }
      const [target] = await db.select().from(user).where(eq(user.id, params.id));
      if (!target) {
        set.status = 404;
        return { error: 'user not found' as const };
      }
      if (body.role && target.role === 'admin' && body.role !== 'admin') {
        if ((await adminCount()) <= 1) {
          set.status = 400;
          return { error: 'cannot demote the last admin' as const };
        }
      }
      const patch: { role?: Role; name?: string } = {};
      if (body.role) patch.role = body.role;
      if (body.name !== undefined) patch.name = body.name;
      if (Object.keys(patch).length === 0) {
        return { ok: true as const };
      }
      await db.update(user).set(patch).where(eq(user.id, params.id));
      return { ok: true as const };
    },
    {
      params: t.Object({ id: t.String() }),
      body: t.Object({
        role: t.Optional(t.Union([t.Literal('admin'), t.Literal('user')])),
        name: t.Optional(t.String({ minLength: 1, maxLength: 120 })),
      }),
    },
  )

  // Admin deletes a user. Blocks deleting yourself or the last admin.
  // Foreign keys cascade — sessions + accounts vanish with the user.
  .delete(
    '/api/users/:id',
    async ({ request, params, set }) => {
      const s = await callerFromRequest(request);
      if (!s?.user) {
        set.status = 401;
        return { error: 'unauthorized' as const };
      }
      if (s.user.role !== 'admin') {
        set.status = 403;
        return { error: 'forbidden' as const };
      }
      if (params.id === s.user.id) {
        set.status = 400;
        return { error: 'cannot delete your own account' as const };
      }
      const [target] = await db.select().from(user).where(eq(user.id, params.id));
      if (!target) {
        set.status = 404;
        return { error: 'user not found' as const };
      }
      if (target.role === 'admin' && (await adminCount()) <= 1) {
        set.status = 400;
        return { error: 'cannot delete the last admin' as const };
      }
      await db.delete(user).where(eq(user.id, params.id));
      return { ok: true as const };
    },
    {
      params: t.Object({ id: t.String() }),
    },
  )

  // Forgot password — generates a random password, updates the DB, and logs
  // it to stdout so the admin can read it from container logs.
  .post(
    '/api/users/forgot-password',
    async ({ body }) => {
      const [row] = await db.select({ id: user.id }).from(user).where(eq(user.email, body.email));
      if (!row) {
        // Don't reveal whether the email exists.
        return { ok: true as const };
      }

      const newPassword = crypto.randomUUID().replace(/-/g, '').slice(0, 16);
      const hash = await Bun.password.hash(newPassword, { algorithm: 'argon2id' });

      await db.update(account).set({ password: hash }).where(eq(account.userId, row.id));

      console.log(`[forgot-password] reset for ${body.email} — new password: ${newPassword}`);
      return { ok: true as const };
    },
    {
      body: t.Object({ email: t.String({ format: 'email' }) }),
    },
  )

  // Change own email — requires current password for confirmation.
  .put(
    '/api/users/me/email',
    async ({ request, body, set }) => {
      const s = await callerFromRequest(request);
      if (!s?.user) {
        set.status = 401;
        return { error: 'unauthorized' as const };
      }

      const cred = db
        .select({ password: account.password })
        .from(account)
        .where(eq(account.userId, s.user.id))
        .get();

      if (!cred?.password) {
        set.status = 400;
        return { error: 'no password credential found' as const };
      }

      const valid = await Bun.password.verify(body.currentPassword, cred.password);
      if (!valid) {
        set.status = 400;
        return { error: 'incorrect password' as const };
      }

      const conflict = db
        .select({ id: user.id })
        .from(user)
        .where(eq(user.email, body.newEmail))
        .get();
      if (conflict && conflict.id !== s.user.id) {
        set.status = 409;
        return { error: 'email already in use' as const };
      }

      await db.update(user).set({ email: body.newEmail }).where(eq(user.id, s.user.id));
      return { ok: true as const };
    },
    {
      body: t.Object({
        currentPassword: t.String({ minLength: 1 }),
        newEmail: t.String({ format: 'email' }),
      }),
    },
  );
