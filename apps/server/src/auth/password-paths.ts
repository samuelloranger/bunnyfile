// better-auth endpoints that authenticate with, create, or recover a password.
// Matched on the path below /api/auth.
const PASSWORD_PATH =
  /^\/api\/auth\/(sign-in\/email|sign-up\/email|request-password-reset|forget-password|reset-password(\/.*)?)\/?$/;

export function isPasswordAuthPath(pathname: string): boolean {
  return PASSWORD_PATH.test(pathname);
}
