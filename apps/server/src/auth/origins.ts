/**
 * Trusted-origin policy, shared by better-auth (CSRF / origin check) and
 * Elysia's CORS middleware so they can't disagree.
 *
 * Default policy for a self-hosted app:
 *   - localhost / 127.0.0.1 on any port
 *   - Any RFC1918 private address (10/8, 172.16/12, 192.168/16) on any port
 *   - Anything explicitly listed in `TRUSTED_ORIGINS` (comma-separated) —
 *     use this for a real public hostname in production
 */

const LAN_PATTERN =
  /^https?:\/\/(localhost|127\.0\.0\.1|(10|192\.168|172\.(1[6-9]|2\d|3[0-1]))(\.\d{1,3}){1,3})(:\d+)?$/;

const explicit = (Bun.env.TRUSTED_ORIGINS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

export function isTrustedOrigin(origin: string | null | undefined): boolean {
  if (!origin) return false;
  if (explicit.includes(origin)) return true;
  return LAN_PATTERN.test(origin);
}

export const explicitTrustedOrigins = explicit;
