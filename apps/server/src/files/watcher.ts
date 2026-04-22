import { type FSWatcher, watch } from 'node:fs';
import { Elysia } from 'elysia';
import { broadcastFilesChanged } from './events';
import { logScanReport, scan } from './scanner';
import { DATA_ROOT } from './store';

const DEBOUNCE_MS = 500;

/**
 * Live filesystem watcher. Treated as a *hint*, not the source of truth:
 * any event triggers a debounced `scan()`, which is also run on a 5-min
 * cron. If the watcher fails to start (NFS, inotify-watch-limit exhausted,
 * or any runtime error) we log a warning and rely on the cron alone.
 *
 * Debounced 500ms trailing — editors that do atomic-rename saves, rsync
 * bursts, git operations, etc. all collapse to a single scan.
 */
export const filesWatcher = new Elysia({ name: 'files/watcher' })
  .state('watcher', null as FSWatcher | null)
  .state('debounceTimer', null as ReturnType<typeof setTimeout> | null)
  .onStart(({ store }) => {
    try {
      const watcher = watch(
        DATA_ROOT,
        { recursive: true, persistent: false },
        (_event, filename) => {
          // Ignore our own in-flight uploads and hidden files.
          const name = filename?.toString() ?? '';
          if (name.endsWith('.tmp') || name.startsWith('.')) return;

          if (store.debounceTimer) clearTimeout(store.debounceTimer);
          store.debounceTimer = setTimeout(() => {
            store.debounceTimer = null;
            scan().then(
              (report) => {
                logScanReport('watcher', report);
                if (report.added || report.updated || report.removed) {
                  broadcastFilesChanged();
                }
              },
              (err) => console.error('[watcher] scan failed', err),
            );
          }, DEBOUNCE_MS);
        },
      );
      watcher.on('error', (err) => {
        console.warn('[watcher] disabled after error — falling back to cron only:', err.message);
      });
      store.watcher = watcher;
      console.log(`[watcher] live watch on ${DATA_ROOT}`);
    } catch (err) {
      console.warn(
        '[watcher] not supported on this filesystem — using cron only:',
        err instanceof Error ? err.message : err,
      );
    }
  })
  .onStop(({ store }) => {
    if (store.debounceTimer) {
      clearTimeout(store.debounceTimer);
      store.debounceTimer = null;
    }
    store.watcher?.close();
    store.watcher = null;
  });
