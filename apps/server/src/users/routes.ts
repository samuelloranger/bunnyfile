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
      const patch: { role?: Role; name?: string } = {};
      if (body.role) patch.role = body.role;
      if (body.name !== undefined) patch.name = body.name;
      if (Object.keys(patch).length === 0) {
        return { ok: true as const };
      }
      const demoting = Boolean(body.role && target.role === 'admin' && body.role !== 'admin');
      // Re-check the admin count and apply the patch in one synchronous
      // transaction so two concurrent demotions can't both pass the check and
      // leave zero admins.
      const applied = db.transaction((tx) => {
        if (demoting) {
          const [row] = tx.select({ c: count() }).from(user).where(eq(user.role, 'admin')).all();
          if ((row?.c ?? 0) <= 1) return false;
        }
        tx.update(user).set(patch).where(eq(user.id, params.id)).run();
        return true;
      });
      if (!applied) {
        set.status = 400;
        return { error: 'cannot demote the last admin' as const };
      }
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
      // Re-check admin count and delete atomically so concurrent deletes can't
      // both pass the check and remove the last admin.
      const deleted = db.transaction((tx) => {
        if (target.role === 'admin') {
          const [row] = tx.select({ c: count() }).from(user).where(eq(user.role, 'admin')).all();
          if ((row?.c ?? 0) <= 1) return false;
        }
        tx.delete(user).where(eq(user.id, params.id)).run();
        return true;
      });
      if (!deleted) {
        set.status = 400;
        return { error: 'cannot delete the last admin' as const };
      }
      return { ok: true as const };
    },
    {
      params: t.Object({ id: t.String() }),
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
