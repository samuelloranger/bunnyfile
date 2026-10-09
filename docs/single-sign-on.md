# Single sign-on (OpenID Connect)

BunnyFile can let people sign in through any OpenID Connect (OIDC) identity
provider, for example Authelia, Authentik or Keycloak. It is configured by an
admin in the web UI and applies immediately, with no restart and no
environment variables.

SSO only signs in **existing** users. It never creates accounts: new people are
still invited by an admin, and are matched to the provider by email address.

## Set up

1. In your identity provider, create a **confidential** OIDC client for BunnyFile.
   - Redirect URI: the **Callback URL** shown in **Settings → Single sign-on**
     (`<BETTER_AUTH_URL>/api/auth/callback/oidc`). Set `BETTER_AUTH_URL` to your
     public URL so this is correct.
   - Token endpoint authentication: **client secret basic**
     (`client_secret_basic`).
   - PKCE (S256) is used; allow the `authorization_code` grant.
   - Scopes: `openid`, `email` and `profile`. The provider must release the
     user's email and mark it verified (`email_verified: true`).
2. As an admin, open **Settings → Single sign-on** and fill in:
   - **Issuer URL**: the provider's issuer, whose
     `/.well-known/openid-configuration` document must be reachable from the
     BunnyFile server.
   - **Client ID** and **Client secret**.
   - **Button label** (default `SSO`) and **Scopes** (default
     `openid email profile`, must include `openid`).
3. Tick **Enable SSO** and save. BunnyFile fetches the discovery document and
   reports a clear error if it cannot be read. The SSO button then appears next
   to the password form on the login page.

The client secret is write-only. It is stored encrypted (AES-256-GCM, key
derived from `BETTER_AUTH_SECRET`) and is never sent back to the browser; the
form only shows that a secret is **set**. Leave the field blank to keep it, or
type a new value to replace it. If you change `BETTER_AUTH_SECRET`, re-enter the
client secret.

## How sign-in works

- A person whose BunnyFile email matches the provider's verified email is
  linked on first SSO sign-in and signed in from then on.
- If no BunnyFile user has that email, or the provider does not return a
  verified email, sign-in returns to the login page with an error.
- Existing password users keep their password unless "SSO only" is on.

## SSO only

Turning on **SSO only** hides the password form and makes the server answer
`403` to password sign-in, sign-up and password-reset requests.

To prevent locking yourself out it can only be switched on after **your own**
admin account has signed in through SSO at least once (so it is linked). While
SSO only is on, the provider (issuer or client ID) cannot be changed; turn it
off first.

## Locked out? Force password login

If the provider is down or misconfigured while SSO only is on, start BunnyFile
with:

```
BUNNYFILE_FORCE_PASSWORD_LOGIN=true
```

Password login is then available again, regardless of the saved settings. Fix
the settings, then remove the variable and restart.

## Notes

- If the provider is unreachable when settings are applied or at startup,
  BunnyFile keeps running and retries when someone attempts to sign in.
- Settings are held by one server process. Run a single BunnyFile instance
  (as the default container does).
