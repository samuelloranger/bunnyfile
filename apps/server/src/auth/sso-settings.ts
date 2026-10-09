import { and, eq } from 'drizzle-orm';
import { db } from '../db';
import { account, type SsoSettingsRow, ssoSettings } from '../db/schema';
import { decryptSsoSecret, encryptSsoSecret } from './secret-box';

export const SSO_PROVIDER_ID = 'oidc';
export const DEFAULT_LABEL = 'SSO';
export const DEFAULT_SCOPES = 'openid email profile';
const DISCOVERY_TIMEOUT_MS = 8000;

type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

/** Settings as the admin UI sees them. The client secret is never included. */
export type SsoSettingsView = {
  configured: boolean;
  issuer: string;
  clientId: string;
  clientSecretSet: boolean;
  label: string;
  scopes: string;
  enabled: boolean;
  ssoOnly: boolean;
  forcePasswordLogin: boolean;
  callbackUrl: string;
};

export type SsoSettingsInput = {
  issuer: string;
  clientId: string;
  /** Omitted or empty keeps the stored secret. */
  clientSecret?: string | undefined;
  label?: string;
  scopes?: string;
  enabled: boolean;
  ssoOnly: boolean;
};

/** Decrypted settings used to build the live better-auth provider. */
export type SsoRuntimeConfig = {
  issuer: string;
  clientId: string;
  clientSecret: string;
  label: string;
  scopes: string[];
};

export class SsoSettingsError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 403 = 400,
  ) {
    super(message);
  }
}

export function isPasswordLoginForced(): boolean {
  return Bun.env.BUNNYFILE_FORCE_PASSWORD_LOGIN === 'true';
}

export function callbackUrlFor(baseURL: string): string {
  return `${baseURL.replace(/\/+$/, '')}/api/auth/callback/${SSO_PROVIDER_ID}`;
}

export function loadSsoRow(): SsoSettingsRow | null {
  return db.select().from(ssoSettings).where(eq(ssoSettings.id, SSO_PROVIDER_ID)).get() ?? null;
}

/** SSO sign-in is offered when it is enabled and the stored secret is readable. */
export function loadSsoRuntime(row: SsoSettingsRow | null = loadSsoRow()): SsoRuntimeConfig | null {
  if (!row?.enabled) return null;
  try {
    return {
      issuer: row.issuer,
      clientId: row.clientId,
      clientSecret: decryptSsoSecret(row.clientSecretEncrypted),
      label: row.label,
      scopes: row.scopes.split(/\s+/).filter(Boolean),
    };
  } catch {
    console.error('[sso] stored client secret could not be decrypted; SSO is unavailable');
    return null;
  }
}

/** True when the password form must be refused (SSO-only, and not overridden). */
export function isPasswordLoginBlocked(): boolean {
  if (isPasswordLoginForced()) return false;
  const row = loadSsoRow();
  return Boolean(row?.enabled && row.ssoOnly && loadSsoRuntime(row));
}

export type PublicAuthConfig = { sso: boolean; ssoOnly: boolean; label: string };

export function publicAuthConfig(): PublicAuthConfig {
  const row = loadSsoRow();
  const sso = Boolean(row && loadSsoRuntime(row));
  return {
    sso,
    ssoOnly: sso && Boolean(row?.ssoOnly) && !isPasswordLoginForced(),
    label: row?.label || DEFAULT_LABEL,
  };
}

export function viewOf(row: SsoSettingsRow | null, callbackUrl: string): SsoSettingsView {
  return {
    configured: row !== null,
    issuer: row?.issuer ?? '',
    clientId: row?.clientId ?? '',
    clientSecretSet: row !== null,
    label: row?.label ?? DEFAULT_LABEL,
    scopes: row?.scopes ?? DEFAULT_SCOPES,
    enabled: row?.enabled ?? false,
    ssoOnly: row?.ssoOnly ?? false,
    forcePasswordLogin: isPasswordLoginForced(),
    callbackUrl,
  };
}

export function normalizeIssuer(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new SsoSettingsError('Issuer URL is not a valid URL');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new SsoSettingsError('Issuer URL must start with https:// (or http://)');
  }
  if (url.search || url.hash)
    throw new SsoSettingsError('Issuer URL must not have a query or hash');
  return url.toString().replace(/\/+$/, '');
}

export function normalizeScopes(raw: string | undefined): string {
  const scopes = [...new Set((raw ?? DEFAULT_SCOPES).split(/[\s,]+/).filter(Boolean))];
  if (!scopes.includes('openid')) throw new SsoSettingsError('Scopes must include "openid"');
  return scopes.join(' ');
}

/**
 * Fetch `${issuer}/.well-known/openid-configuration` and check it looks like
 * an OpenID Connect provider for this issuer. Throws SsoSettingsError.
 */
export async function validateDiscovery(issuer: string, fetchImpl: Fetcher = fetch): Promise<void> {
  const url = `${issuer}/.well-known/openid-configuration`;
  let res: Response;
  try {
    res = await fetchImpl(url, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
    });
  } catch {
    throw new SsoSettingsError(`Could not reach ${url}. Check the issuer URL and network access.`);
  }
  if (!res.ok) {
    throw new SsoSettingsError(`${url} returned HTTP ${res.status}. Check the issuer URL.`);
  }
  let doc: Record<string, unknown>;
  try {
    doc = (await res.json()) as Record<string, unknown>;
  } catch {
    throw new SsoSettingsError(`${url} did not return valid JSON.`);
  }
  if (typeof doc.issuer !== 'string' || doc.issuer.replace(/\/+$/, '') !== issuer) {
    throw new SsoSettingsError(
      'The discovery document reports a different issuer than the one entered.',
    );
  }
  if (typeof doc.authorization_endpoint !== 'string' || typeof doc.token_endpoint !== 'string') {
    throw new SsoSettingsError(
      'The discovery document is missing authorization_endpoint or token_endpoint.',
    );
  }
}

export function userHasSsoAccount(userId: string): boolean {
  const row = db
    .select({ id: account.id })
    .from(account)
    .where(and(eq(account.userId, userId), eq(account.providerId, SSO_PROVIDER_ID)))
    .get();
  return Boolean(row);
}

/**
 * Validate and persist SSO settings for `adminId`. Lockout protection: SSO-only
 * can be switched on only once this admin has signed in through SSO, and it
 * can't be combined with a change of provider (the linked account would no
 * longer match).
 */
export async function saveSsoSettings(
  input: SsoSettingsInput,
  adminId: string,
  fetchImpl: Fetcher = fetch,
): Promise<SsoSettingsRow> {
  const existing = loadSsoRow();
  const issuer = normalizeIssuer(input.issuer);
  const clientId = input.clientId.trim();
  if (!clientId) throw new SsoSettingsError('Client ID is required');
  const newSecret = input.clientSecret?.trim() ?? '';
  if (!newSecret && !existing) throw new SsoSettingsError('Client secret is required');
  const label = input.label?.trim() || DEFAULT_LABEL;
  if (label.length > 40) throw new SsoSettingsError('Button label must be 40 characters or fewer');
  const scopes = normalizeScopes(input.scopes);

  if (input.ssoOnly && !input.enabled) {
    throw new SsoSettingsError('"SSO only" requires "Enable SSO"');
  }
  if (input.ssoOnly) {
    if (!existing?.ssoOnly && !userHasSsoAccount(adminId)) {
      throw new SsoSettingsError(
        'Sign in once through SSO with your own account before turning on "SSO only", so you cannot lock yourself out.',
        403,
      );
    }
    if (existing?.ssoOnly && (existing.issuer !== issuer || existing.clientId !== clientId)) {
      throw new SsoSettingsError(
        'Turn off "SSO only" before changing the provider, then sign in through SSO again.',
        403,
      );
    }
  }

  if (input.enabled || !existing || existing.issuer !== issuer) {
    await validateDiscovery(issuer, fetchImpl);
  }

  const values = {
    id: SSO_PROVIDER_ID,
    issuer,
    clientId,
    clientSecretEncrypted: newSecret
      ? encryptSsoSecret(newSecret)
      : (existing?.clientSecretEncrypted as string),
    label,
    scopes,
    enabled: input.enabled,
    ssoOnly: input.ssoOnly,
    updatedAt: new Date(),
  };
  db.insert(ssoSettings)
    .values(values)
    .onConflictDoUpdate({ target: ssoSettings.id, set: values })
    .run();
  return loadSsoRow() as SsoSettingsRow;
}
