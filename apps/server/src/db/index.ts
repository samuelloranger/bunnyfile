import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import * as schema from './schema';

const SERVER_ROOT = resolve(import.meta.dir, '../..');
const raw = Bun.env.DB_PATH ?? './data/bunnyfile.sqlite';
const DB_PATH = raw === ':memory:' || isAbsolute(raw) ? raw : resolve(SERVER_ROOT, raw);

if (DB_PATH !== ':memory:') {
  mkdirSync(dirname(DB_PATH), { recursive: true });
}

const sqlite = new Database(DB_PATH, { create: true, strict: true });

for (const pragma of [
  'journal_mode = WAL',
  'synchronous = NORMAL',
  'foreign_keys = ON',
  'busy_timeout = 5000',
  'temp_store = MEMORY',
]) {
  sqlite.run(`PRAGMA ${pragma}`);
}

export const db = drizzle(sqlite, { schema, casing: 'snake_case' });
export * as tables from './schema';
export { sqlite };
