import type { BetterAuthOptions } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { count } from 'drizzle-orm';
import { db } from '../db';
import { account, session, user, verification } from '../db/schema';
import { sendMail } from '../email/mailer';
import { explicitTrustedOrigins, isTrustedOrigin } from './origins';

const DEV_SECRET = 'dev-only-insecure-secret-please-change-me';
const secret = Bun.env.BETTER_AUTH_SECRET ?? DEV_SECRET;
if (secret === DEV_SECRET) {
  console.warn('[auth] BETTER_AUTH_SECRET is not set — using an insecure dev default');
}

const baseURL = Bun.env.BETTER_AUTH_URL ?? 'http://localhost:3901';
const webOrigin = Bun.env.WEB_ORIGIN ?? 'http://localhost:3900';

// Config object lives apart from the constructed `auth` instance so tests can
// build a real instance from it. Unit tests mock '../auth/auth' globally
// (bun's mock.module is process-wide), which would otherwise hide the real api.
export const authOptions = {
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
    revokeSessionsOnPasswordReset: true,
    resetPasswordTokenExpiresIn: 60 * 60, // 1 hour
    // `url` resolves to <baseURL>/api/auth/reset-password/<token>?callbackURL=...
    // — better-auth validates the token then redirects to the SPA's
    // /reset-password page with ?token=... (or ?error=INVALID_TOKEN).
    sendResetPassword: async ({ user: u, url }) => {
      // Fire-and-forget: better-auth awaits this for existing accounts but skips
      // it for unknown ones. Awaiting SMTP delivery (or letting it throw) would
      // make existing-account requests measurably slower / error differently —
      // a timing/error enumeration side-channel. Return immediately, log failures.
      void sendMail({
        to: u.email,
        subject: 'Reset your BunnyFile password',
        text: `Reset your password (this link expires in 1 hour):\n\n${url}\n\nIf you didn't request this, you can ignore this email.`,
      }).catch((err) => console.error('[email] password-reset send failed', err));
    },
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
} satisfies BetterAuthOptions;
