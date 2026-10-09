// better-auth endpoints that authenticate with, create, or recover a password.
export const PASSWORD_AUTH_PATHS = [
  '/sign-in/email',
  '/sign-up/email',
  '/request-password-reset',
  '/forget-password',
  '/reset-password',
] as const;

// Matched on the full request path (the reset link also carries a token segment).
const PASSWORD_PATH =
  /^\/api\/auth\/(sign-in\/email|sign-up\/email|request-password-reset|forget-password|reset-password(\/.*)?)\/?$/;

export function isPasswordAuthPath(pathname: string): boolean {
  return PASSWORD_PATH.test(pathname);
}
