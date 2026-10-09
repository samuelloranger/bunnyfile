import { betterAuth } from 'better-auth';
import { genericOAuth } from 'better-auth/plugins';
import { authOptions } from './options';
import { loadSsoRuntime, SSO_PROVIDER_ID, type SsoRuntimeConfig } from './sso-settings';

/**
 * better-auth reads its provider list once, when the instance is created (the
 * generic OAuth plugin also fetches the discovery document there). To apply
 * SSO settings without a restart, the live instance is rebuilt from the saved
 * settings and swapped in; `auth` in ./auth.ts always forwards to the current
 * one. Sessions live in the database and are signed with the same secret, so
 * sessions created by an earlier instance stay valid.
 */
export function buildAuth(sso: SsoRuntimeConfig | null) {
  return betterAuth({
    ...authOptions,
    plugins: [
      genericOAuth({
        config: sso
          ? [
              {
                providerId: SSO_PROVIDER_ID,
                name: sso.label,
                clientId: sso.clientId,
                clientSecret: sso.clientSecret,
                discoveryUrl: `${sso.issuer}/.well-known/openid-configuration`,
                scopes: sso.scopes,
                pkce: true,
                // client_secret_basic at the token endpoint.
                authentication: 'basic',
                // Never create users from SSO. (Unlike disableImplicitSignUp,
                // a client can't override this with requestSignUp.)
                disableSignUp: true,
                // Require a verified email. Dropping the address makes the
                // callback stop with `email_not_found`; it can't be linked or
                // matched to a local user.
                mapProfileToUser: (profile) =>
                  profile.emailVerified === true || profile.email_verified === true
                    ? {}
                    : { email: null },
              },
            ]
          : [],
      }),
    ],
  });
}

export type Auth = ReturnType<typeof buildAuth>;

let current: Auth = buildAuth(null);
let ssoExpected = false;
let lastRetryAt = 0;
let chain: Promise<unknown> = Promise.resolve();

export function getAuth(): Auth {
  return current;
}

async function providerLoaded(instance: Auth): Promise<boolean> {
  const ctx = await instance.$context;
  return ctx.socialProviders.some((p) => p.id === SSO_PROVIDER_ID);
}

async function rebuild(): Promise<void> {
  const sso = loadSsoRuntime();
  const next = buildAuth(sso);
  // Awaiting the context runs plugin init, which fetches the discovery document.
  const loaded = sso ? await providerLoaded(next) : false;
  current = next;
  ssoExpected = sso !== null && !loaded;
  lastRetryAt = Date.now();
}

/** Rebuild the live auth instance from the saved SSO settings. Serialized. */
export function reloadAuth(): Promise<void> {
  const run = chain.then(rebuild, rebuild);
  chain = run.catch(() => {});
  return run;
}

/**
 * If SSO is enabled but the provider failed to load (the identity provider was
 * unreachable when the instance was built), retry at most every 15 seconds so
 * sign-in recovers on its own once the provider is back.
 */
export async function retryProviderIfMissing(): Promise<void> {
  if (!ssoExpected || Date.now() - lastRetryAt < 15_000) return;
  lastRetryAt = Date.now();
  await reloadAuth().catch((err) => console.error('[sso] reload failed', err));
}
