import { Elysia, t } from 'elysia';
import { applySsoSettings } from './factory';
import { authOptions } from './options';
import {
  callbackUrlFor,
  loadSsoRow,
  publicAuthConfig,
  SsoSettingsError,
  viewOf,
} from './sso-settings';

type SessionLike = { user?: { id: string; role?: string | null | undefined } | null } | null;
type GetSession = (headers: Headers) => Promise<SessionLike>;

const callbackUrl = callbackUrlFor(authOptions.baseURL);

/**
 * Public login-mode endpoint plus the admin-only SSO settings API.
 * `getSession` is injected so tests don't need a full auth instance.
 */
export function ssoRoutes(getSession: GetSession) {
  return (
    new Elysia({ name: 'sso' })
      // Public: tells the login page which controls to render. Reveals no
      // provider details beyond the button label.
      .get('/api/auth-config', () => publicAuthConfig())
      .get('/api/settings/sso', async ({ request, set }) => {
        const s = await getSession(request.headers);
        if (!s?.user) {
          set.status = 401;
          return { error: 'unauthorized' as const };
        }
        if (s.user.role !== 'admin') {
          set.status = 403;
          return { error: 'forbidden' as const };
        }
        return viewOf(loadSsoRow(), callbackUrl);
      })
      .put(
        '/api/settings/sso',
        async ({ request, body, set }) => {
          const s = await getSession(request.headers);
          if (!s?.user) {
            set.status = 401;
            return { error: 'unauthorized' as const };
          }
          if (s.user.role !== 'admin') {
            set.status = 403;
            return { error: 'forbidden' as const };
          }
          try {
            await applySsoSettings(body, s.user.id);
          } catch (err) {
            if (err instanceof SsoSettingsError) {
              set.status = err.status;
              return { error: err.message };
            }
            console.error('[sso] saving settings failed', err instanceof Error ? err.message : err);
            set.status = 500;
            return { error: 'Could not save the SSO settings' };
          }
          return viewOf(loadSsoRow(), callbackUrl);
        },
        {
          body: t.Object({
            issuer: t.String({ maxLength: 2048 }),
            clientId: t.String({ maxLength: 512 }),
            clientSecret: t.Optional(t.String({ maxLength: 4096 })),
            label: t.Optional(t.String({ maxLength: 100 })),
            scopes: t.Optional(t.String({ maxLength: 1024 })),
            enabled: t.Boolean(),
            ssoOnly: t.Boolean(),
          }),
        },
      )
  );
}
