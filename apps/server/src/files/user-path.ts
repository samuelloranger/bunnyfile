import { safeRelPath } from './paths';

/** Internal storage areas the user-facing files/shares APIs must never touch. */
export const RESERVED_TOP_SEGMENTS = new Set(['s3', '.trash', '.multipart', '.shares']);

/** Validate a user-supplied path AND reject reserved internal prefixes. */
export function userRel(raw: string | null | undefined): string | null {
  const rel = safeRelPath(raw);
  if (rel == null) return null;
  const top = rel.split('/')[0];
  if (top && RESERVED_TOP_SEGMENTS.has(top)) return null;
  return rel;
}
