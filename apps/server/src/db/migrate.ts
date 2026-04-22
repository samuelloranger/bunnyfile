import { join } from 'node:path';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import { db } from './index';

const MIGRATIONS_FOLDER = join(import.meta.dir, 'migrations');

export function runMigrations() {
  migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
}

if (import.meta.main) {
  runMigrations();
  console.log('migrations applied');
}
