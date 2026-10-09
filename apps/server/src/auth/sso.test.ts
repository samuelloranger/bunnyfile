import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DB_PATH = ':memory:';
process.env.BETTER_AUTH_SECRET = 'test-secret-for-sso';
process.env.BETTER_AUTH_URL = 'http://localhost:3901';
process.env.MAIL_CAPTURE = '1';
const dataDir = await mkdtemp(join(tmpdir(), 'bf-sso-'));
process.env.DATA_DIR = dataDir;

// Real modules only: other test files mock '../auth/auth' process-wide.
const { db } = await import('../db');
const { runMigrations } = await import('../db/migrate');
const { account, ssoSettings, user } = await import('../db/schema');
const { app } = await import('../index');
const { auth } = await import('./auth');
const { getAuth, reloadAuth } = await import('./factory');
const { decryptSsoSecret, encryptSsoSecret } = await import('./secret-box');
const { ssoRoutes } = await import('./sso-routes');
const {
  isPasswordLoginBlocked,
  loadSsoRow,
  normalizeIssuer,
  normalizeScopes,
  publicAuthConfig,
  saveSsoSettings,
  SsoSettingsError,
  validateDiscovery,
} = await import('./sso-settings');
const { eq } = await import('drizzle-orm');

const ORIGIN = 'http://localhost:3900';
const ADMIN_EMAIL = 'admin@example.com';
const MEMBER_EMAIL = 'member@example.com';
const PASSWORD = 'correct-horse-battery';
const CLIENT_SECRET = 'idp-client-secret-value';

// --- a minimal fake OpenID provider -----------------------------------------

type Claims = Record<string, unknown>;
let claims: Claims = {};
const tokenRequests: { authorization: string | null; body: URLSearchParams }[] = [];
let discoveryHits = 0;

function jwt(payload: Claims): string {
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${enc({ alg: 'none', typ: 'JWT' })}.${enc(payload)}.sig`;
}

const idp = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    const origin = url.origin;
    if (url.pathname === '/.well-known/openid-configuration') {
      discoveryHits++;
      return Response.json({
        issuer: origin,
        authorization_endpoint: `${origin}/authorize`,
        token_endpoint: `${origin}/token`,
        userinfo_endpoint: `${origin}/userinfo`,
      });
    }
    if (url.pathname === '/token') {
      tokenRequests.push({
        authorization: req.headers.get('authorization'),
        body: new URLSearchParams(await req.text()),
      });
      return Response.json({
        access_token: 'at',
        token_type: 'Bearer',
        expires_in: 300,
        id_token: jwt({ iss: origin, aud: 'bf-client', ...claims }),
      });
    }
    return new Response('not found', { status: 404 });
  },
});
const ISSUER = `http://localhost:${idp.port}`;

// --- helpers -----------------------------------------------------------------

let adminId = '';
let memberId = '';

const asAdmin = () => ssoRoutes(async () => ({ user: { id: adminId, role: 'admin' } }));
const asMember = () => ssoRoutes(async () => ({ user: { id: memberId, role: 'user' } }));
const anonymous = () => ssoRoutes(async () => null);

function put(routes: ReturnType<typeof ssoRoutes>, body: Record<string, unknown>) {
  return routes.handle(
    new Request('http://localhost/api/settings/sso', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

const baseInput = {
  issuer: ISSUER,
  clientId: 'bf-client',
  clientSecret: CLIENT_SECRET,
  label: 'Corp login',
  scopes: 'openid email profile',
  enabled: true,
  ssoOnly: false,
};

async function loadedProviderIds(): Promise<string[]> {
  const ctx = await getAuth().$context;
  return ctx.socialProviders.map((p) => p.id);
}

function cookiesFrom(res: Response): string {
  return res.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ');
}

/** Run the browser leg: start sign-in, then hit the callback as the IdP would. */
async function ssoSignIn(): Promise<Response> {
  const start = await auth.handler(
    new Request('http://localhost:3901/api/auth/sign-in/social', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: ORIGIN },
      body: JSON.stringify({
        provider: 'oidc',
        callbackURL: `${ORIGIN}/`,
        errorCallbackURL: `${ORIGIN}/login`,
        disableRedirect: true,
      }),
    }),
  );
  expect(start.status).toBe(200);
  const { url } = (await start.json()) as { url: string };
  const authorize = new URL(url);
  expect(authorize.origin).toBe(ISSUER);
  expect(authorize.searchParams.get('code_challenge_method')).toBe('S256');
  const state = authorize.searchParams.get('state') as string;
  return auth.handler(
    new Request(`http://localhost:3901/api/auth/callback/oidc?code=abc&state=${state}`, {
      headers: { cookie: cookiesFrom(start), origin: ORIGIN },
    }),
  );
}

beforeAll(async () => {
  runMigrations();
  const a = await auth.api.signUpEmail({
    body: { email: ADMIN_EMAIL, password: PASSWORD, name: 'Admin' },
  });
  adminId = a.user.id;
  const m = await auth.api.signUpEmail({
    body: { email: MEMBER_EMAIL, password: PASSWORD, name: 'Member' },
  });
  memberId = m.user.id;
});

afterEach(async () => {
  delete process.env.BUNNYFILE_FORCE_PASSWORD_LOGIN;
  db.delete(ssoSettings).run();
  db.delete(account).where(eq(account.providerId, 'oidc')).run();
  await reloadAuth();
});

afterAll(async () => {
  idp.stop(true);
  await rm(dataDir, { recursive: true, force: true });
});

// --- tests -------------------------------------------------------------------

describe('secret encryption', () => {
  it('round-trips and never stores plaintext', () => {
    const stored = encryptSsoSecret(CLIENT_SECRET);
    expect(stored).not.toContain(CLIENT_SECRET);
    expect(decryptSsoSecret(stored)).toBe(CLIENT_SECRET);
    expect(encryptSsoSecret(CLIENT_SECRET)).not.toBe(stored); // fresh IV
  });

  it('rejects tampered or malformed values', () => {
    const stored = encryptSsoSecret(CLIENT_SECRET);
    const flipped = `${stored.slice(0, -2)}${stored.endsWith('00') ? '11' : '00'}`;
    expect(() => decryptSsoSecret(flipped)).toThrow();
    expect(() => decryptSsoSecret('nonsense')).toThrow();
  });

  it('is stored encrypted in the database', async () => {
    await saveSsoSettings(baseInput, adminId);
    expect(loadSsoRow()?.clientSecretEncrypted).not.toContain(CLIENT_SECRET);
  });
});

describe('settings validation', () => {
  it('normalizes the issuer and scopes', () => {
    expect(normalizeIssuer(' https://id.example.com/realm/ ')).toBe('https://id.example.com/realm');
    expect(() => normalizeIssuer('not a url')).toThrow(SsoSettingsError);
    expect(() => normalizeIssuer('ftp://id.example.com')).toThrow(SsoSettingsError);
    expect(normalizeScopes('openid, email  email')).toBe('openid email');
    expect(normalizeScopes(undefined)).toBe('openid email profile');
    expect(() => normalizeScopes('email profile')).toThrow(/openid/);
  });

  it('requires a client id and, the first time, a client secret', async () => {
    await expect(saveSsoSettings({ ...baseInput, clientId: ' ' }, adminId)).rejects.toThrow(
      /Client ID/,
    );
    await expect(saveSsoSettings({ ...baseInput, clientSecret: '' }, adminId)).rejects.toThrow(
      /Client secret/,
    );
  });

  it('reports an unreachable or malformed discovery document', async () => {
    await expect(validateDiscovery('http://localhost:1', fetch)).rejects.toThrow(/Could not reach/);
    await expect(
      validateDiscovery(ISSUER, async () => new Response('nope', { status: 404 })),
    ).rejects.toThrow(/HTTP 404/);
    await expect(
      validateDiscovery(ISSUER, async () => new Response('<html>', { status: 200 })),
    ).rejects.toThrow(/valid JSON/);
    await expect(
      validateDiscovery(ISSUER, async () => Response.json({ issuer: 'https://other.example.com' })),
    ).rejects.toThrow(/different issuer/);
    await expect(
      validateDiscovery(ISSUER, async () => Response.json({ issuer: ISSUER })),
    ).rejects.toThrow(/authorization_endpoint/);
    await validateDiscovery(ISSUER);
  });

  it('refuses to save when discovery fails, and keeps the old settings', async () => {
    await saveSsoSettings(baseInput, adminId);
    const res = await put(asAdmin(), { ...baseInput, issuer: 'http://localhost:1' });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/Could not reach/);
    expect(loadSsoRow()?.issuer).toBe(ISSUER);
  });

  it('keeps the stored secret when none is sent', async () => {
    await saveSsoSettings(baseInput, adminId);
    const before = loadSsoRow()?.clientSecretEncrypted;
    await saveSsoSettings({ ...baseInput, clientSecret: undefined, label: 'Other' }, adminId);
    expect(loadSsoRow()?.clientSecretEncrypted).toBe(before);
    expect(loadSsoRow()?.label).toBe('Other');
  });
});

describe('settings API', () => {
  it('is admin-only', async () => {
    expect(
      (await anonymous().handle(new Request('http://localhost/api/settings/sso'))).status,
    ).toBe(401);
    expect((await asMember().handle(new Request('http://localhost/api/settings/sso'))).status).toBe(
      403,
    );
    expect((await put(asMember(), baseInput)).status).toBe(403);
    expect(loadSsoRow()).toBeNull();
  });

  it('never returns the client secret', async () => {
    const saved = await put(asAdmin(), baseInput);
    expect(saved.status).toBe(200);
    const savedText = await saved.text();
    expect(savedText).not.toContain(CLIENT_SECRET);
    expect(JSON.parse(savedText)).toMatchObject({
      configured: true,
      clientSecretSet: true,
      issuer: ISSUER,
      callbackUrl: 'http://localhost:3901/api/auth/callback/oidc',
    });

    const read = await asAdmin().handle(new Request('http://localhost/api/settings/sso'));
    const readText = await read.text();
    expect(readText).not.toContain(CLIENT_SECRET);
    expect(readText).not.toContain(loadSsoRow()?.clientSecretEncrypted as string);
    expect(Object.keys(JSON.parse(readText))).not.toContain('clientSecret');
  });
});

describe('lockout guard', () => {
  it('rejects "SSO only" until the admin has signed in through SSO', async () => {
    const res = await put(asAdmin(), { ...baseInput, ssoOnly: true });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toMatch(/Sign in once through SSO/);
    expect(loadSsoRow()).toBeNull();
  });

  it('allows "SSO only" once the admin has a linked SSO account', async () => {
    db.insert(account)
      .values({
        id: 'acc-admin-oidc',
        accountId: 'idp-subject-1',
        providerId: 'oidc',
        userId: adminId,
        updatedAt: new Date(),
      })
      .run();
    const res = await put(asAdmin(), { ...baseInput, ssoOnly: true });
    expect(res.status).toBe(200);
    expect(loadSsoRow()?.ssoOnly).toBe(true);
  });

  it("does not count another user's linked account", async () => {
    db.insert(account)
      .values({
        id: 'acc-member-oidc',
        accountId: 'idp-subject-2',
        providerId: 'oidc',
        userId: memberId,
        updatedAt: new Date(),
      })
      .run();
    expect((await put(asAdmin(), { ...baseInput, ssoOnly: true })).status).toBe(403);
  });

  it('requires SSO to be enabled, and blocks a provider change while SSO-only', async () => {
    db.insert(account)
      .values({
        id: 'acc-admin-oidc',
        accountId: 'idp-subject-1',
        providerId: 'oidc',
        userId: adminId,
        updatedAt: new Date(),
      })
      .run();
    expect((await put(asAdmin(), { ...baseInput, enabled: false, ssoOnly: true })).status).toBe(
      400,
    );
    expect((await put(asAdmin(), { ...baseInput, ssoOnly: true })).status).toBe(200);
    const moved = await put(asAdmin(), { ...baseInput, clientId: 'another-client', ssoOnly: true });
    expect(moved.status).toBe(403);
    expect(loadSsoRow()?.clientId).toBe('bf-client');
  });
});

describe('GET /api/auth-config', () => {
  async function config() {
    const res = await app.handle(new Request('http://localhost/api/auth-config'));
    expect(res.status).toBe(200);
    return (await res.json()) as { sso: boolean; ssoOnly: boolean; label: string };
  }

  it('reports password-only when SSO is not configured', async () => {
    expect(await config()).toEqual({ sso: false, ssoOnly: false, label: 'SSO' });
  });

  it('reports the label and flags, without provider details', async () => {
    await saveSsoSettings(baseInput, adminId);
    const body = await config();
    expect(body).toEqual({ sso: true, ssoOnly: false, label: 'Corp login' });
    expect(JSON.stringify(body)).not.toContain(ISSUER);
  });

  it('reports sso: false while saved but disabled', async () => {
    await saveSsoSettings({ ...baseInput, enabled: false }, adminId);
    expect((await config()).sso).toBe(false);
  });
});

describe('password endpoints in SSO-only mode', () => {
  const endpoints: [string, string][] = [
    ['POST', '/api/auth/sign-in/email'],
    ['POST', '/api/auth/sign-up/email'],
    ['POST', '/api/auth/request-password-reset'],
    ['POST', '/api/auth/reset-password'],
    ['GET', '/api/auth/reset-password/some-token'],
  ];

  function hit(method: string, path: string) {
    return app.handle(
      new Request(`http://localhost${path}`, {
        method,
        headers: { 'content-type': 'application/json', origin: ORIGIN },
        body:
          method === 'POST'
            ? JSON.stringify({ email: ADMIN_EMAIL, password: PASSWORD })
            : undefined,
      }),
    );
  }

  function enableSsoOnly() {
    db.insert(ssoSettings)
      .values({
        id: 'oidc',
        issuer: ISSUER,
        clientId: 'bf-client',
        clientSecretEncrypted: encryptSsoSecret(CLIENT_SECRET),
        enabled: true,
        ssoOnly: true,
      })
      .run();
  }

  it('does not block password sign-in when SSO-only is off', async () => {
    const res = await hit('POST', '/api/auth/sign-in/email');
    expect(res.status).toBe(200);
  });

  it('answers 403 for every password endpoint when SSO-only is on', async () => {
    enableSsoOnly();
    expect(isPasswordLoginBlocked()).toBe(true);
    for (const [method, path] of endpoints) {
      const res = await hit(method, path);
      expect([method, path, res.status]).toEqual([method, path, 403]);
    }
  });

  it('keeps non-password auth endpoints reachable', async () => {
    enableSsoOnly();
    const res = await app.handle(new Request('http://localhost/api/auth/get-session'));
    expect(res.status).not.toBe(403);
  });

  it('lets BUNNYFILE_FORCE_PASSWORD_LOGIN=true override', async () => {
    enableSsoOnly();
    process.env.BUNNYFILE_FORCE_PASSWORD_LOGIN = 'true';
    expect(isPasswordLoginBlocked()).toBe(false);
    expect((await hit('POST', '/api/auth/sign-in/email')).status).toBe(200);
    expect(publicAuthConfig().ssoOnly).toBe(false);
    const view = await asAdmin()
      .handle(new Request('http://localhost/api/settings/sso'))
      .then((r) => r.json() as Promise<{ forcePasswordLogin: boolean }>);
    expect(view.forcePasswordLogin).toBe(true);
  });

  it('does not block when SSO-only is saved but SSO is disabled', async () => {
    db.insert(ssoSettings)
      .values({
        id: 'oidc',
        issuer: ISSUER,
        clientId: 'bf-client',
        clientSecretEncrypted: encryptSsoSecret(CLIENT_SECRET),
        enabled: false,
        ssoOnly: true,
      })
      .run();
    expect(isPasswordLoginBlocked()).toBe(false);
  });
});

describe('applying settings without a restart', () => {
  it('registers and removes the provider on the running instance', async () => {
    expect(await loadedProviderIds()).not.toContain('oidc');
    const before = getAuth();

    const res = await put(asAdmin(), baseInput);
    expect(res.status).toBe(200);
    expect(getAuth()).not.toBe(before);
    expect(await loadedProviderIds()).toContain('oidc');
    expect(discoveryHits).toBeGreaterThan(0);

    const off = await put(asAdmin(), { ...baseInput, enabled: false });
    expect(off.status).toBe(200);
    expect(await loadedProviderIds()).not.toContain('oidc');
  });

  it('keeps existing sessions valid across a reload', async () => {
    const signedIn = await auth.handler(
      new Request('http://localhost:3901/api/auth/sign-in/email', {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: ORIGIN },
        body: JSON.stringify({ email: ADMIN_EMAIL, password: PASSWORD }),
      }),
    );
    expect(signedIn.status).toBe(200);
    const cookie = cookiesFrom(signedIn);
    await put(asAdmin(), baseInput);
    const session = await auth.api.getSession({ headers: new Headers({ cookie }) });
    expect(session?.user.email).toBe(ADMIN_EMAIL);
  });
});

describe('SSO sign-in', () => {
  async function enable() {
    await saveSsoSettings(baseInput, adminId);
    await reloadAuth();
  }

  it('links an existing user by verified email and signs them in', async () => {
    await enable();
    claims = { sub: 'idp-subject-1', email: ADMIN_EMAIL, email_verified: true, name: 'Admin' };
    tokenRequests.length = 0;
    const res = await ssoSignIn();
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(`${ORIGIN}/`);
    expect(cookiesFrom(res)).toContain('bunnyfile');

    const linked = db.select().from(account).where(eq(account.providerId, 'oidc')).all();
    expect(linked).toHaveLength(1);
    expect(linked[0]?.userId).toBe(adminId);

    // client_secret_basic + PKCE at the token endpoint
    const req = tokenRequests[0];
    const expected = `Basic ${Buffer.from(`bf-client:${CLIENT_SECRET}`).toString('base64')}`;
    expect(req?.authorization).toBe(expected);
    expect(req?.body.get('code_verifier')).toBeTruthy();
    expect(req?.body.has('client_secret')).toBe(false);
  });

  it('refuses an unverified provider email', async () => {
    await enable();
    claims = { sub: 'idp-subject-1', email: ADMIN_EMAIL, email_verified: false };
    const res = await ssoSignIn();
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain(`${ORIGIN}/login?error=email_not_found`);
    expect(db.select().from(account).where(eq(account.providerId, 'oidc')).all()).toHaveLength(0);
  });

  it('does not create users: an unknown email goes back to the login page', async () => {
    await enable();
    claims = { sub: 'idp-subject-9', email: 'stranger@example.com', email_verified: true };
    const before = db.select().from(user).all().length;
    const res = await ssoSignIn();
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toMatch(new RegExp(`^${ORIGIN}/login\\?error=`));
    expect(db.select().from(user).all()).toHaveLength(before);
  });

  it('cannot be asked to sign people up with requestSignUp', async () => {
    await enable();
    claims = { sub: 'idp-subject-9', email: 'stranger@example.com', email_verified: true };
    const start = await auth.handler(
      new Request('http://localhost:3901/api/auth/sign-in/social', {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: ORIGIN },
        body: JSON.stringify({
          provider: 'oidc',
          callbackURL: `${ORIGIN}/`,
          errorCallbackURL: `${ORIGIN}/login`,
          disableRedirect: true,
          requestSignUp: true,
        }),
      }),
    );
    const { url } = (await start.json()) as { url: string };
    const state = new URL(url).searchParams.get('state');
    const before = db.select().from(user).all().length;
    const res = await auth.handler(
      new Request(`http://localhost:3901/api/auth/callback/oidc?code=abc&state=${state}`, {
        headers: { cookie: cookiesFrom(start), origin: ORIGIN },
      }),
    );
    expect(res.headers.get('location')).toContain('/login?error=');
    expect(db.select().from(user).all()).toHaveLength(before);
  });
});
