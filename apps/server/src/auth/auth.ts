import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { count } from 'drizzle-orm';
import { db } from '../db';
import { account, session, user, verification } from '../db/schema';
import { explicitTrustedOrigins, isTrustedOrigin } from './origins';

const DEV_SECRET = 'dev-only-insecure-secret-please-change-me';
const secret = Bun.env.BETTER_AUTH_SECRET ?? DEV_SECRET;
if (secret === DEV_SECRET) {
  console.warn('[auth] BETTER_AUTH_SECRET is not set — using an insecure dev default');
}

const baseURL = Bun.env.BETTER_AUTH_URL ?? 'http://localhost:3901';
const webOrigin = Bun.env.WEB_ORIGIN ?? 'http://localhost:3900';

export const auth = betterAuth({
  baseURL,
  secret,
  database: drizzleAdapter(db, {
    provider: 'sqlite',
    schema: { user, session, account, verification },
  }),
  emailAndPassword: {
    enabled: true,
    autoSignIn: true,
    minPasswordLength: 8,
    maxPasswordLength: 128,
  },
  user: {
    additionalFields: {
      role: {
        type: 'string',
        required: false,
        defaultValue: 'user',
        input: false, // not settable by clients
      },
    },
  },
  databaseHooks: {
    user: {
      create: {
        before: async (newUser) => {
          const [row] = await db.select({ c: count() }).from(user);
          const isFirstUser = (row?.c ?? 0) === 0;
          return {
            data: { ...newUser, role: isFirstUser ? 'admin' : 'user' },
          };
        },
      },
    },
  },
  session: {
    expiresIn: 60 * 60 * 24 * 30, // 30 days
    updateAge: 60 * 60 * 24, // refresh daily
    cookieCache: { enabled: true, maxAge: 60 * 5 },
  },
  trustedOrigins: (request) => {
    const base = [webOrigin, baseURL, ...explicitTrustedOrigins];
    const origin = request?.headers.get('origin');
    if (isTrustedOrigin(origin)) return [...base, origin as string];
    return base;
  },
  advanced: {
    cookiePrefix: 'bunnyfile',
  },
});

export type Auth = typeof auth;
