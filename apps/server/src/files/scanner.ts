import { readdir, stat } from 'node:fs/promises';
import { sep } from 'node:path';
import { eq, inArray, notInArray } from 'drizzle-orm';
import { db } from '../db';
import { fileIndex } from '../db/schema';
import { mimeFromName } from './mime';
import { basenameOf } from './paths';
import { DATA_ROOT, hashOnDisk } from './store';

/**
 * Walk DATA_ROOT, reconcile against file_index.
 *  - Insert rows for new files
 *  - Update rows whose size/mtime/inode changed (invalidates cached sha256)
 *  - Delete rows whose file no longer exists
 * Hashing is lazy — we only compute sha256 when a row has no value yet and
 * its size is below a threshold, or on demand from the API. Big files get
 * hashed in the background.
 */

const HASH_ON_SCAN_MAX_SIZE = 64 * 1024 * 1024; // 64 MB

type DiskEntry = {
  path: string; // relative, POSIX
  size: number;
  mtimeMs: number;
  inode: number;
};

async function* walk(abs: string, rel: string): AsyncGenerator<DiskEntry> {
  const entries = await readdir(abs, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue; // skip dotfiles
    if (entry.name.endsWith('.tmp')) continue; // in-flight uploads
    const nextAbs = `${abs}${sep}${entry.name}`;
    const nextRel = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      yield* walk(nextAbs, nextRel);
    } else if (entry.isFile()) {
      const st = await stat(nextAbs);
      yield {
        path: nextRel,
        size: st.size,
        mtimeMs: Math.round(st.mtimeMs),
        inode: Number(st.ino),
      };
    }
  }
}

async function enumerateDisk(): Promise<Map<string, DiskEntry>> {
  const map = new Map<string, DiskEntry>();
  for await (const entry of walk(DATA_ROOT, '')) {
    map.set(entry.path, entry);
  }
  return map;
}

function stale(row: { size: number; mtimeMs: number; inode: number }, disk: DiskEntry) {
  return row.size !== disk.size || row.mtimeMs !== disk.mtimeMs || row.inode !== disk.inode;
}

export type ScanReport = {
  added: number;
  updated: number;
  removed: number;
  hashed: number;
  durationMs: number;
};

export async function runScan(): Promise<ScanReport> {
  const started = Date.now();
  let added = 0;
  let updated = 0;
  let hashed = 0;

  const onDisk = await enumerateDisk();
  const existing = await db.select().from(fileIndex);
  const byPath = new Map(existing.map((r) => [r.path, r]));

  // Insert + update
  for (const [path, disk] of onDisk) {
    const row = byPath.get(path);
    if (!row) {
      let hash: string | null = null;
      if (disk.size <= HASH_ON_SCAN_MAX_SIZE) {
        hash = await hashOnDisk(path);
        hashed++;
      }
      await db.insert(fileIndex).values({
        path,
        size: disk.size,
        mtimeMs: disk.mtimeMs,
        inode: disk.inode,
        sha256: hash,
        mime: mimeFromName(basenameOf(path)),
      });
      added++;
    } else if (stale(row, disk)) {
      let hash: string | null = null;
      if (disk.size <= HASH_ON_SCAN_MAX_SIZE) {
        hash = await hashOnDisk(path);
        hashed++;
      }
      await db
        .update(fileIndex)
        .set({
          size: disk.size,
          mtimeMs: disk.mtimeMs,
          inode: disk.inode,
          sha256: hash,
          indexedAt: new Date(),
        })
        .where(eq(fileIndex.path, path));
      updated++;
    }
  }

  // Delete rows whose files are gone. Do it in one query (batched in chunks
  // to avoid hitting SQLite's parameter limit on very large trees).
  const diskPaths = [...onDisk.keys()];
  const existingPaths = existing.map((r) => r.path);
  const missing = existingPaths.filter((p) => !onDisk.has(p));
  let removed = 0;
  if (missing.length > 0) {
    const CHUNK = 500;
    for (let i = 0; i < missing.length; i += CHUNK) {
      const chunk = missing.slice(i, i + CHUNK);
      await db.delete(fileIndex).where(inArray(fileIndex.path, chunk));
      removed += chunk.length;
    }
  }
  // Silence unused warnings — reserved for future "incremental" paths.
  void diskPaths;
  void notInArray;

  return { added, updated, removed, hashed, durationMs: Date.now() - started };
}

let running: Promise<ScanReport> | null = null;

/** Coalesces concurrent scan requests into one run. */
export function scan(): Promise<ScanReport> {
  if (running) return running;
  running = runScan().finally(() => {
    running = null;
  });
  return running;
}

export function logScanReport(label: string, r: ScanReport) {
  if (r.added || r.updated || r.removed || label === 'boot') {
    console.log(
      `[scanner] ${label}: +${r.added} ~${r.updated} -${r.removed} hashed=${r.hashed} in ${r.durationMs}ms`,
    );
  }
}
