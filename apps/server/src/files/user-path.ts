import { safeRelPath } from './paths';

/**
 * Validate a user-supplied path for the files/shares APIs.
 * After the v2 layout split, isolation is by FILES_ROOT — no denylist needed.
 */
export function userRel(raw: string | null | undefined): string | null {
  return safeRelPath(raw);
}
