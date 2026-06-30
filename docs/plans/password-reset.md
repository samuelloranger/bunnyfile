# Plan — Password reset flow

**Status:** planned, not implemented.
**Why:** PLAN.md open question #6 + adoption blocker — today a forgotten password needs admin
intervention (manual DB edit / delete+reinvite). First locked-out user churns. Last real *feature*
gap before public launch.

## Scope

In scope: self-service "forgot password → email link → set new password" for the native
email/password auth mode. Out of scope: email-change flow (separate), forward-auth mode (Tinyauth
owns its own reset), 2FA.

## Design decisions

| Decision | Choice | Rationale |
|---|---|---|
| Reset mechanism | better-auth built-in `forgetPassword` / `resetPassword` | Already the auth lib. `emailAndPassword.sendResetPassword` is the only missing wire-up — no custom token table. |
| Email transport | `nodemailer` + SMTP env vars | SMTP is the self-hoster default; works in Bun. One dep, no provider lock-in. |
| No-SMTP fallback | Log the reset URL to server stdout | Reset still works before SMTP is configured (admin relays link). No hard SMTP dependency to boot. |
| Token TTL | 1 hour (better-auth default, env-overridable) | Standard; short enough to limit exposure. |
| Enumeration | `forgetPassword` always returns 200 | better-auth default — never reveal whether an email exists. |
| Session handling | `revokeSessionsOnPasswordReset: true` | A reset implies "I lost control" — kill all existing sessions. |
| Rate limiting | Reuse the existing in-memory token-bucket on `/forgot-password` | Stops reset-email spam / enumeration timing. Same limiter as public shares. |

## Implementation steps

1. **`apps/server/src/email/mailer.ts`** — singleton transport.
   - Env: `SMTP_HOST`, `SMTP_PORT` (default 587), `SMTP_USER`, `SMTP_PASS`, `SMTP_SECURE`
     (bool, default false), `EMAIL_FROM` (default `BunnyFile <no-reply@localhost>`).
   - If `SMTP_HOST` unset → `console` transport: `sendMail` logs `to` + link instead of sending.
   - Export `sendMail({ to, subject, text, html })`.
   - Add dep: `nodemailer` (+ `@types/nodemailer` dev).

2. **`apps/server/src/auth/auth.ts`** — extend `emailAndPassword`:
   ```ts
   emailAndPassword: {
     enabled: true,
     autoSignIn: true,
     minPasswordLength: 8,
     maxPasswordLength: 128,
     revokeSessionsOnPasswordReset: true,
     resetPasswordTokenExpiresIn: 60 * 60, // 1h
     sendResetPassword: async ({ user, url }) => {
       // url already points at webOrigin/reset-password?token=...&callbackURL=...
       await sendMail({
         to: user.email,
         subject: 'Reset your BunnyFile password',
         text: `Reset your password: ${url}\nLink expires in 1 hour. Ignore if you didn't request this.`,
       });
     },
   }
   ```
   - Set better-auth `resetPasswordRedirectTo` / pass `redirectTo` from the client so `url` lands on
     the SPA `/reset-password` route (not the API origin). Confirm `url` host = `webOrigin` in dev,
     same-origin in prod (single process).

3. **Frontend routes** (top-level, NOT under `_app` guard — like `login.tsx` / `setup.tsx`):
   - `apps/web/src/routes/forgot-password.tsx` — email field → `authClient.forgetPassword({ email, redirectTo: '/reset-password' })`. Always show "If that email exists, a link is on its way." Link to it from `login.tsx`.
   - `apps/web/src/routes/reset-password.tsx` — read `token` from search params → new-password field → `authClient.resetPassword({ newPassword, token })` → on success redirect `/login` with a toast; on `INVALID_TOKEN` / expired show a friendly "link expired, request a new one" with a link back to `/forgot-password`.

4. **Rate limit** — apply the existing token-bucket limiter to the better-auth `/api/auth/forget-password` path (per-IP, e.g. 5/hour). Wire in the Elysia layer that already fronts better-auth.

5. **Tests** (`apps/server/src/auth/*.test.ts`, `bun:test`):
   - Mock `sendMail` to capture the reset `url`/token.
   - `forgetPassword` for existing AND non-existent email → both 200, sender called only for existing.
   - `resetPassword` with captured token → password changed (old fails, new works) + prior sessions revoked.
   - Expired/garbage token → rejected, password unchanged.
   - Rate limit: 6th forgot request within window → 429.

6. **Docs / config:**
   - README env table: SMTP vars + the no-SMTP fallback note.
   - `deploy/compose/` standalone example: commented SMTP block.
   - One line in `docs/migrating-from-nextcloud.md` if relevant.

## Risks

- **better-auth reset URL origin** — must land on the SPA route, not the API. Verify `baseURL` vs
  `webOrigin` behavior; in prod both are same-origin so trivial, dev needs the `redirectTo`. Pin this
  in the first test.
- **SMTP misconfig is silent** — surface send failures in server logs clearly; the console fallback
  prevents a hard failure but admins must know whether real mail went out.

## Done when

A user clicks "Forgot password?" on `/login`, receives (or finds in logs) a working link, sets a new
password, all old sessions are revoked, and the flow is covered by passing `bun:test` cases.
