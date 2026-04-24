import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { resolveInRoot, safeRelPath } from './paths';

const DEFAULT_ROOT = resolve(import.meta.dir, '../../data/files');
export const DATA_ROOT = Bun.env.DATA_DIR ? resolve(Bun.env.DATA_DIR) : DEFAULT_ROOT;

// Make sure the data root exists at boot; creating it lazily would race with
// the first scan / upload.
await mkdir(DATA_ROOT, { recursive: true });

export class PathError extends Error {
  constructor(
    public code: 'traversal' | 'not_found' | 'is_directory' | 'exists',
    message: string,
  ) {
    super(message);
  }
}

function abs(rel: string): string {
  const p = resolveInRoot(DATA_ROOT, rel);
  if (p == null) throw new PathError('traversal', `unsafe path: ${rel}`);
  return p;
}

/** Resolve a relative path to absolute, after validating it. */
export function absFromRelOrThrow(raw: string): string {
  const rel = safeRelPath(raw);
  if (rel == null) throw new PathError('traversal', `invalid path: ${raw}`);
  return abs(rel);
}

export async function writeUpload(
  rel: string,
  stream: ReadableStream<Uint8Array>,
): Promise<{ size: number; sha256: string; md5: string; mtimeMs: number; inode: number }> {
  const destination = absFromRelOrThrow(rel);
  await mkdir(dirname(destination), { recursive: true });

  const tmp = `${destination}.tmp-${crypto.randomUUID().slice(0, 8)}`;
  const sha256Hash = createHash('sha256');
  const md5Hash = createHash('md5');
  let size = 0;

  const writer = Bun.file(tmp).writer();
  const reader = stream.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        sha256Hash.update(value);
        md5Hash.update(value);
        size += value.byteLength;
        writer.write(value);
      }
    }
    await writer.end();
  } catch (err) {
    try {
      await rm(tmp, { force: true });
    } catch {
      // best-effort cleanup
    }
    throw err;
  }

  await rename(tmp, destination);
  const st = await stat(destination);
  return {
    size,
    sha256: sha256Hash.digest('hex'),
    md5: md5Hash.digest('hex'),
    mtimeMs: Math.round(st.mtimeMs),
    inode: Number(st.ino),
  };
}

export async function openStream(rel: string) {
  const path = absFromRelOrThrow(rel);
  let st: Awaited<ReturnType<typeof stat>>;
  try {
    st = await stat(path);
  } catch {
    throw new PathError('not_found', `not found: ${rel}`);
  }
  if (st.isDirectory()) throw new PathError('is_directory', `is a directory: ${rel}`);
  return { path, stat: st };
}

export function readRange(path: string, start: number, end: number): ReadableStream<Uint8Array> {
  // Node's createReadStream without encoding yields Buffer, which extends
  // Uint8Array — safe to enqueue directly.
  const node = createReadStream(path, { start, end });
  return new ReadableStream<Uint8Array>({
    start(controller) {
      node.on('data', (chunk: Buffer | string) => {
        if (typeof chunk === 'string') {
          controller.enqueue(new TextEncoder().encode(chunk));
        } else {
          controller.enqueue(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
        }
      });
      node.on('end', () => controller.close());
      node.on('error', (err) => controller.error(err));
    },
    cancel() {
      node.destroy();
    },
  });
}

export async function removeFile(rel: string): Promise<void> {
  const path = absFromRelOrThrow(rel);
  let st: Awaited<ReturnType<typeof stat>>;
  try {
    st = await stat(path);
  } catch {
    throw new PathError('not_found', `not found: ${rel}`);
  }
  if (st.isDirectory()) throw new PathError('is_directory', `is a directory: ${rel}`);
  await rm(path);
}

export async function moveFile(fromRel: string, toRel: string): Promise<void> {
  const from = absFromRelOrThrow(fromRel);
  const to = absFromRelOrThrow(toRel);

  if (from === to) {
    return;
  }

  let fromStat: Awaited<ReturnType<typeof stat>>;
  try {
    fromStat = await stat(from);
  } catch {
    throw new PathError('not_found', `not found: ${fromRel}`);
  }
  if (fromStat.isDirectory()) {
    throw new PathError('is_directory', `is a directory: ${fromRel}`);
  }

  try {
    const toStat = await stat(to);
    if (toStat.isDirectory()) {
      throw new PathError('is_directory', `is a directory: ${toRel}`);
    }
    throw new PathError('exists', `already exists: ${toRel}`);
  } catch (err) {
    if (err instanceof PathError) throw err;
    if (!(err instanceof Error) || !('code' in err) || err.code !== 'ENOENT') {
      throw err;
    }
    // Destination doesn't exist; this is expected.
  }

  await mkdir(dirname(to), { recursive: true });
  await rename(from, to);
}

export async function createFolder(rel: string): Promise<void> {
  const target = absFromRelOrThrow(rel);
  await mkdir(target, { recursive: true });
}

export async function listImmediateDirectories(relPrefix: string): Promise<string[]> {
  const dir = relPrefix ? absFromRelOrThrow(relPrefix) : DATA_ROOT;
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b));
  } catch (err) {
    if (err instanceof Error && 'code' in err) {
      if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return [];
    }
    throw err;
  }
}

/** Hash an existing on-disk file (used by the scanner for lazy backfill). */
export async function hashOnDisk(
  rel: string,
  algorithm: 'sha256' | 'md5' = 'sha256',
): Promise<string> {
  const path = absFromRelOrThrow(rel);
  const node = createReadStream(path);
  const h = createHash(algorithm);
  for await (const chunk of node) {
    h.update(chunk);
  }
  return h.digest('hex');
}
