import { Elysia } from 'elysia';
import { auth } from './auth';

/**
 * Session guard for authenticated API routes. A route opts in with
 * `{ auth: true }` and receives the signed-in `user`; requests without a
 * session get `401 { error: 'unauthorized' }` before the handler runs.
 */
export const authGuard = new Elysia({ name: 'auth-guard' }).macro({
  auth: {
    async resolve({ request, status }) {
      const session = await auth.api.getSession({ headers: request.headers });
      if (!session?.user) return status(401, { error: 'unauthorized' as const });
      return { user: session.user };
    },
  },
});
