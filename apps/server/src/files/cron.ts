import { cron, Patterns } from '@elysiajs/cron';
import { Elysia } from 'elysia';
import { logScanReport, scan } from './scanner';

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
      },
    }),
  );
