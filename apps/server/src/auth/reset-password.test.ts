import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// In-memory DB + temp data dir + mail capture, set before any module loads.
process.env.DB_PATH = ':memory:';
process.env.MAIL_CAPTURE = '1';
const dataDir = await mkdtemp(join(tmpdir(), 'bf-reset-'));
process.env.DATA_DIR = dataDir;

// Build a real instance from the shared options. We can't import './auth'
// directly — other test files mock that module process-wide (bun mock.module),
// which would replace `auth` with a stub lacking the real api.
const { betterAuth } = await import('better-auth');
const { authOptions } = await import('./options');
const auth = betterAuth(authOptions);
const { runMigrations } = await import('../db/migrate');
const { outbox } = await import('../email/mailer');

const EMAIL = 'reset-user@example.com';
const OLD = 'old-password-123';
const NEW = 'new-password-456';

function tokenFromLastMail(): string {
  const url = outbox.at(-1)?.text.match(/https?:\/\/\S+/)?.[0] ?? '';
  // url shape: <baseURL>/api/auth/reset-password/<token>?callbackURL=...
  return url.split('/reset-password/')[1]?.split('?')[0] ?? '';
}

beforeAll(async () => {
  runMigrations();
  await auth.api.signUpEmail({ body: { email: EMAIL, password: OLD, name: 'Reset User' } });
});

afterAll(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

describe('password reset', () => {
  it('returns ok but sends no email for an unknown address (no enumeration)', async () => {
    const before = outbox.length;
    const res = await auth.api.requestPasswordReset({ body: { email: 'nobody@example.com' } });
    expect(res.status).toBe(true);
    expect(outbox.length).toBe(before);
  });

  it('emails a reset link for a known address', async () => {
    const before = outbox.length;
    const res = await auth.api.requestPasswordReset({ body: { email: EMAIL } });
    expect(res.status).toBe(true);
    expect(outbox.length).toBe(before + 1);
    expect(outbox.at(-1)?.to).toBe(EMAIL);
    expect(tokenFromLastMail().length).toBeGreaterThan(8);
  });

  it('resets the password with a valid token and invalidates the old one', async () => {
    await auth.api.requestPasswordReset({ body: { email: EMAIL } });
    const token = tokenFromLastMail();
    await auth.api.resetPassword({ body: { newPassword: NEW, token } });

    // Old password no longer works.
    expect(auth.api.signInEmail({ body: { email: EMAIL, password: OLD } })).rejects.toThrow();
    // New password works.
    const ok = await auth.api.signInEmail({ body: { email: EMAIL, password: NEW } });
    expect(ok.user.email).toBe(EMAIL);
  });

  it('rejects an invalid token', async () => {
    expect(
      auth.api.resetPassword({ body: { newPassword: 'irrelevant-789', token: 'garbage-token' } }),
    ).rejects.toThrow();
  });
});
