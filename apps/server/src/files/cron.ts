import { readdir } from 'node:fs/promises';
import { cron, Patterns } from '@elysiajs/cron';
import { eq } from 'drizzle-orm';
import { Elysia } from 'elysia';
import { db } from '../db';
import { shareLink } from '../db/schema';
import { logScanReport, scan } from './scanner';
import { DATA_ROOT, removeShareZip } from './store';

/**
 * Delete cached folder-share zips whose share is gone, revoked, expired, or
 * has hit its download limit. Manual share removal already deletes the zip;
 * this catches the leaks (expiry, max-downloads) that removal doesn't cover.
 */
export async function sweepShareZips(): Promise<void> {
  let ids: string[];
  try {
    const entries = await readdir(`${DATA_ROOT}/.shares`, { withFileTypes: true });
    ids = entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return; // no .shares dir yet
  }
  const now = Date.now();
  for (const id of ids) {
    const row = await db
      .select()
      .from(shareLink)
      .where(eq(shareLink.id, id))
      .then((r) => r[0]);
    const active =
      row &&
      !row.revokedAt &&
      !(row.expiresAt && row.expiresAt.getTime() <= now) &&
      !(row.maxDownloads != null && row.downloadCount >= row.maxDownloads);
    if (!active) await removeShareZip(id);
  }
}

/**
 * Scheduled filesystem scan.
 * - Boot: fires once as soon as the app is ready (catches changes made while
 *   the server was down).
 * - Periodic: every 5 minutes, reconcile disk ↔ index.
 *
 * `scan()` internally coalesces — a user-triggered rescan + a cron tick won't
 * run twice concurrently.
 */
export const filesCron = new Elysia({ name: 'files/cron' })
  .onStart(async () => {
    try {
      logScanReport('boot', await scan());
    } catch (err) {
      console.error('[scanner] boot scan failed', err);
    }
    try {
      await sweepShareZips();
    } catch (err) {
      console.error('[shares] boot sweep failed', err);
    }
  })
  .use(
    cron({
      name: 'file-index-rescan',
      pattern: Patterns.everyMinutes(5),
      async run() {
        try {
          logScanReport('tick', await scan());
        } catch (err) {
          console.error('[scanner] tick failed', err);
        }
        try {
          await sweepShareZips();
        } catch (err) {
          console.error('[shares] sweep tick failed', err);
        }
      },
    }),
  );
