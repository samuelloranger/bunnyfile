import { isAbsolute, resolve, sep } from 'node:path';

/**
 * Canonicalize a user-supplied path into a safe POSIX relative path rooted at
 * DATA_DIR. Returns `null` if the path tries to escape the root (traversal)
 * or is obviously malformed (NUL byte, absolute path).
 */
export function safeRelPath(raw: string | null | undefined): string | null {
  if (raw == null) return '';
  if (raw.includes('\0')) return null;
  // Normalize: strip leading slashes, collapse backslashes, collapse repeats.
  let p = raw.replaceAll('\\', '/').replace(/^\/+/, '').replace(/\/+/g, '/');
  if (p === '' || p === '.') return '';
  if (p.endsWith('/')) p = p.slice(0, -1);
  // Reject `..` anywhere in the path. We don't try to be clever.
  if (p.split('/').some((seg) => seg === '..' || seg === '.')) return null;
  return p;
}

/**
 * Resolve a safe relative path to an absolute path under `root`. Returns
 * `null` if the resolved path escapes `root`.
 */
export function resolveInRoot(root: string, rel: string): string | null {
  if (isAbsolute(rel)) return null;
  const abs = resolve(root, rel);
  const rootWithSep = root.endsWith(sep) ? root : root + sep;
  if (abs !== root && !abs.startsWith(rootWithSep)) return null;
  return abs;
}

/** Parent directory of a POSIX relative path. '' for top-level items. */
export function parentOf(rel: string): string {
  const i = rel.lastIndexOf('/');
  return i < 0 ? '' : rel.slice(0, i);
}

export function basenameOf(rel: string): string {
  const i = rel.lastIndexOf('/');
  return i < 0 ? rel : rel.slice(i + 1);
}

export function joinRel(a: string, b: string): string {
  if (!a) return b;
  if (!b) return a;
  return `${a}/${b}`;
}
