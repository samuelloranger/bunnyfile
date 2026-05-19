import { eq, sql } from 'drizzle-orm';
import { db, sqlite } from '../db';
import { fileIndex } from '../db/schema';
import { basenameOf } from './paths';

function escapeFtsToken(raw: string): string {
  return raw.replace(/"/g, '""');
}

/** Build a prefix-match FTS5 query from user input. */
export function toFtsQuery(raw: string): string | null {
  const terms = raw
    .trim()
    .split(/\s+/)
    .map((t) => t.trim())
    .filter(Boolean);
  if (terms.length === 0) return null;
  return terms.map((term) => `"${escapeFtsToken(term)}"*`).join(' AND ');
}

export async function upsertFileSearch(path: string): Promise<void> {
  const name = basenameOf(path);
  db.run(sql`DELETE FROM file_search WHERE path = ${path}`);
  db.run(sql`INSERT INTO file_search(path, name) VALUES (${path}, ${name})`);
}

export async function deleteFileSearch(path: string): Promise<void> {
  db.run(sql`DELETE FROM file_search WHERE path = ${path}`);
}

export async function deleteFileSearchPrefix(path: string): Promise<void> {
  db.run(sql`DELETE FROM file_search WHERE path = ${path} OR path LIKE ${`${path}/%`}`);
}

export async function rebuildFileSearchIndex(): Promise<number> {
  db.run(sql`DELETE FROM file_search`);
  const rows = await db.select({ path: fileIndex.path }).from(fileIndex);
  for (const row of rows) {
    await upsertFileSearch(row.path);
  }
  return rows.length;
}

export type SearchHit = {
  path: string;
  name: string;
  size: number;
  mime: string;
  mtimeMs: number;
};

export async function searchFiles(query: string, limit = 50): Promise<SearchHit[]> {
  const fts = toFtsQuery(query);
  if (!fts) return [];

  const capped = Math.min(Math.max(limit, 1), 200);
  const rows = sqlite
    .query('SELECT path, name FROM file_search WHERE name MATCH ? ORDER BY rank LIMIT ?')
    .all(fts, capped) as Array<{ path: string; name: string }>;

  const hits: SearchHit[] = [];
  for (const row of rows) {
    const meta = db.select().from(fileIndex).where(eq(fileIndex.path, row.path)).get();
    if (!meta) continue;
    hits.push({
      path: row.path,
      name: row.name,
      size: meta.size,
      mime: meta.mime,
      mtimeMs: meta.mtimeMs,
    });
  }
  return hits;
}
