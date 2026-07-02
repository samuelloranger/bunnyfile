import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { type FileHandle, mkdir, open, readdir, rename, rm, stat } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { trackUpload } from '../inflight';
import { resolveInRoot, safeRelPath } from './paths';

const DEFAULT_ROOT = resolve(import.meta.dir, '../../data/files');
export const DATA_ROOT = Bun.env.DATA_DIR ? resolve(Bun.env.DATA_DIR) : DEFAULT_ROOT;

// Make sure the data root exists at boot; creating it lazily would race with
// the first scan / upload.
await mkdir(DATA_ROOT, { recursive: true });

export class PathError extends Error {
  constructor(
    public code: 'traversal' | 'not_found' | 'is_directory' | 'not_directory' | 'exists',
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

// Inputs like "" / "." / "/" normalize to the empty rel, which resolves to the
// data root itself. Destructive ops must refuse it, or a request with path="."
// would delete/move/trash the entire storage tree.
function assertNotRoot(rel: string): void {
  if (safeRelPath(rel) === '') {
    throw new PathError('traversal', 'refusing to operate on the storage root');
  }
}

export function writeUpload(
  rel: string,
  stream: ReadableStream<Uint8Array>,
): Promise<{ size: number; sha256: string; md5: string; mtimeMs: number; inode: number }> {
  return trackUpload(doWriteUpload(rel, stream));
}

async function doWriteUpload(
  rel: string,
  stream: ReadableStream<Uint8Array>,
): Promise<{ size: number; sha256: string; md5: string; mtimeMs: number; inode: number }> {
  const destination = absFromRelOrThrow(rel);
  await mkdir(dirname(destination), { recursive: true });

  // Dot-prefixed temp in the same directory: the scanner already skips all
  // dotfiles, so an in-flight/orphaned temp is never indexed — and the marker
  // can't collide with a *visible* user path (a user file like
  // `report.tmp-1a2b3c4d` stays listed). Same dir keeps the rename atomic.
  const tmp = join(
    dirname(destination),
    `.${basename(destination)}.tmp-${crypto.randomUUID().slice(0, 8)}`,
  );
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

    // Durability: writer.end() only flushes to the OS page cache. fsync the
    // file so a crash/power-loss after the rename below can't surface a
    // zero-length or partial file at the destination (data-loss risk).
    const fh = await open(tmp, 'r+');
    try {
      // Detect a short write (e.g. disk full mid-stream) before we commit:
      // the bytes on disk must match what we streamed and hashed.
      const tmpStat = await fh.stat();
      if (tmpStat.size !== size) {
        throw new Error(`short write for ${rel}: ${tmpStat.size} on disk, expected ${size}`);
      }
      await fh.sync();
    } finally {
      await fh.close();
    }
  } catch (err) {
    // Close the sink's file descriptor (e.g. on a client-aborted stream) before
    // removing the partial temp, so neither the fd nor the bytes leak.
    try {
      await writer.end();
    } catch {
      // already errored — ignore
    }
    try {
      await rm(tmp, { force: true });
    } catch {
      // best-effort cleanup
    }
    throw err;
  }

  try {
    await rename(tmp, destination);
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => {});
    throw err;
  }

  // fsync the directory so the rename (the commit point) is itself durable.
  // Best-effort: not supported on every platform; failure here doesn't mean
  // the file is bad. Linux/macOS (the deploy targets) support it.
  try {
    const dh = await open(dirname(destination), 'r');
    try {
      await dh.sync();
    } finally {
      await dh.close();
    }
  } catch {
    // directory fsync unsupported — leave as-is
  }

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
  // `end` is inclusive (HTTP Range semantics); Blob.slice end is exclusive.
  // Bun's Blob stream applies backpressure, so a slow client can't make the
  // server buffer the whole range in memory (unlike a raw 'data'-event pump).
  return Bun.file(path)
    .slice(start, end + 1)
    .stream();
}

export async function removeFile(rel: string): Promise<void> {
  assertNotRoot(rel);
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

export async function removeFolder(rel: string): Promise<void> {
  assertNotRoot(rel);
  const path = absFromRelOrThrow(rel);
  let st: Awaited<ReturnType<typeof stat>>;
  try {
    st = await stat(path);
  } catch {
    throw new PathError('not_found', `not found: ${rel}`);
  }
  if (!st.isDirectory()) throw new PathError('not_directory', `not a directory: ${rel}`);
  await rm(path, { recursive: true });
}

export async function movePathToTrash(
  rel: string,
  id: string,
): Promise<{
  trashPath: string;
  kind: 'file' | 'dir';
  size: number | null;
  mtimeMs: number;
  inode: number;
}> {
  if (rel === '.trash' || rel.startsWith('.trash/')) {
    throw new PathError('traversal', 'trash paths cannot be trashed');
  }
  assertNotRoot(rel);

  const from = absFromRelOrThrow(rel);
  let st: Awaited<ReturnType<typeof stat>>;
  try {
    st = await stat(from);
  } catch {
    throw new PathError('not_found', `not found: ${rel}`);
  }

  const name = rel.split('/').at(-1) ?? id;
  const trashPath = `.trash/${id}/${name}`;
  const to = absFromRelOrThrow(trashPath);
  await mkdir(dirname(to), { recursive: true });
  await rename(from, to);

  return {
    trashPath,
    kind: st.isDirectory() ? 'dir' : 'file',
    size: st.isFile() ? st.size : null,
    mtimeMs: Math.round(st.mtimeMs),
    inode: Number(st.ino),
  };
}

export async function restorePathFromTrash(trashRel: string, originalRel: string): Promise<void> {
  const from = absFromRelOrThrow(trashRel);
  const to = absFromRelOrThrow(originalRel);

  try {
    await stat(from);
  } catch {
    throw new PathError('not_found', `not found: ${trashRel}`);
  }

  try {
    await stat(to);
    throw new PathError('exists', `already exists: ${originalRel}`);
  } catch (err) {
    if (err instanceof PathError) throw err;
    if (!(err instanceof Error) || !('code' in err) || err.code !== 'ENOENT') {
      throw err;
    }
  }

  await mkdir(dirname(to), { recursive: true });
  await rename(from, to);
}

export async function removeTrashPath(trashRel: string): Promise<void> {
  const path = absFromRelOrThrow(trashRel);
  await rm(path, { recursive: true, force: true });
}

/** Delete a folder-share's cached zip directory. No-op if it doesn't exist. */
export async function removeShareZip(id: string): Promise<void> {
  await rm(absFromRelOrThrow(`.shares/${id}`), { recursive: true, force: true });
}

export async function moveFile(fromRel: string, toRel: string): Promise<void> {
  assertNotRoot(fromRel);
  assertNotRoot(toRel);
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

/** Create a memory-safe pull-based ReadableStream for streaming files of any size without buffering. */
export function createFileStream(path: string, chunkSize = 256 * 1024): ReadableStream<Uint8Array> {
  let fd: FileHandle | null = null;
  return new ReadableStream({
    async start() {
      fd = await open(path, 'r');
    },
    async pull(controller) {
      const buffer = new Uint8Array(chunkSize);
      const { bytesRead } = await fd.read(buffer, 0, chunkSize, null);
      if (bytesRead === 0) {
        await fd.close();
        controller.close();
      } else {
        controller.enqueue(buffer.subarray(0, bytesRead));
      }
    },
    async cancel() {
      if (fd) {
        await fd.close();
      }
    },
  });
}
