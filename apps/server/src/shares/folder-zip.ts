import { readFile, stat, writeFile } from 'node:fs/promises';
import { sql } from 'drizzle-orm';
import { db } from '../db';
import { fileIndex } from '../db/schema';
import { basenameOf } from '../files/paths';
import { absFromRelOrThrow } from '../files/store';
import { zipFolderToFile } from '../files/zip';

// ponytail: in-process rebuild lock. The app is one Bun process (see CLAUDE.md
// architecture), so a Map is enough to coalesce concurrent rebuilds of one share.
const rebuilds = new Map<string, Promise<void>>();

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

export function zipRelForShare(id: string, folderRel: string): string {
  return `.shares/${id}/${basenameOf(folderRel)}.zip`;
}

function fpRelForShare(id: string): string {
  return `.shares/${id}/.fp`;
}

export async function folderFingerprint(folderRel: string): Promise<string> {
  const like = `${escapeLike(folderRel)}/%`;
  const [agg] = await db
    .select({
      count: sql<number>`count(*)`,
      maxM: sql<number>`coalesce(max(${fileIndex.mtimeMs}), 0)`,
      sumS: sql<number>`coalesce(sum(${fileIndex.size}), 0)`,
    })
    .from(fileIndex)
    .where(sql`${fileIndex.path} LIKE ${like} ESCAPE '\\'`);
  return `${agg?.count ?? 0}:${agg?.maxM ?? 0}:${agg?.sumS ?? 0}`;
}

export async function buildShareZip(id: string, folderRel: string): Promise<void> {
  const zipAbs = absFromRelOrThrow(zipRelForShare(id, folderRel));
  await zipFolderToFile(absFromRelOrThrow(folderRel), zipAbs);
  await writeFile(absFromRelOrThrow(fpRelForShare(id)), await folderFingerprint(folderRel), 'utf8');
}

export async function ensureShareZip(
  id: string,
  folderRel: string,
): Promise<{ abs: string; size: number }> {
  const zipAbs = absFromRelOrThrow(zipRelForShare(id, folderRel));
  const inflight = rebuilds.get(id);
  if (inflight) {
    await inflight;
  } else {
    const want = await folderFingerprint(folderRel);
    let have: string | null = null;
    try {
      have = await readFile(absFromRelOrThrow(fpRelForShare(id)), 'utf8');
    } catch {
      // no sidecar yet
    }
    let fresh = have === want;
    if (fresh) {
      try {
        await stat(zipAbs);
      } catch {
        fresh = false; // sidecar present but zip missing
      }
    }
    if (!fresh) {
      const p = buildShareZip(id, folderRel).finally(() => rebuilds.delete(id));
      rebuilds.set(id, p);
      await p;
    }
  }
  const st = await stat(zipAbs);
  return { abs: zipAbs, size: st.size };
}
