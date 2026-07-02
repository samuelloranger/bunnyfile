# Folder download & folder share — design

**Status:** approved design, pre-implementation
**Date:** 2026-07-01

## Goal

Let a signed-in user **download** a whole folder as a zip, and **share** a
whole folder via the existing share-link mechanism. Sharing a folder
materializes a zip in a hidden location; removing the share deletes it.

Two capabilities, one zip engine:

- **Download folder** (authenticated, no share): stream a zip on the fly.
  Nothing persisted — there's no share to attach a stored zip to.
- **Share folder**: persist a zip as a **cache** at a hidden path, pointed at
  by the share link. The zip stays current via rebuild-on-access (below).
  Removing the share deletes the zip.

## Non-goals check (PLAN.md §1)

Not sync, not WebDAV, not a plugin. This is core file-serving — downloading
and sharing files the user already has. In scope.

## Zip engine

Bun has no native zip; the `zip` CLI is not guaranteed in the production
image. Add one dependency: **`fflate`** (pure JS, streaming, no native build,
bundles cleanly into the Docker image).

New file `apps/server/src/files/zip.ts`:

- A core async generator walks a folder recursively (`node:fs` `readdir`),
  feeds each file through fflate at **compression level 0 (store, no
  deflate)** — a file host mostly holds already-compressed media, so
  deflate would burn CPU for little gain — and yields zip chunks.
- `zipFolderToStream(rel): ReadableStream<Uint8Array>` — wraps the generator
  for live download.
- `zipFolderToFile(rel, destRel): Promise<void>` — writes the generator to
  `destRel` via **write-then-rename** (`.zip.tmp.<rand>` → `.zip`), honoring
  the storage invariant (PLAN.md §6 / CLAUDE.md).

Entry paths inside the zip are relative to the shared folder (e.g. sharing
`Documents` yields `report.pdf`, `sub/notes.md`).

## Storage layout

Zips live at a reserved, hidden path:

```
.shares/<shareId>/<foldername>.zip     # the cached zip
.shares/<shareId>/.fp                  # folder fingerprint at build time
```

- `.shares` is dot-prefixed, so the scanner, watcher, and
  `listImmediateDirectories` already skip it — it never reaches `file_index`
  or the browser.
- Add `.shares` to `RESERVED_TOP_SEGMENTS` (`apps/server/src/files/routes.ts`)
  so users can't write into it via normal file ops.
- `shareLink.path` = the **shared path verbatim** (the folder path for a
  folder share, the file path for a file share — unchanged for files).
  Storing the folder path is required so rebuild-on-change can re-zip the
  source. **"Is this a folder share?"** = `stat(path).isDirectory()` at serve
  time. The zip path is derived: `.shares/<id>/<basename(path)>.zip`.
  **No DB migration.**

## Rebuild-on-access (the "rebuild on change" behavior)

The persisted zip is a **cache**, not a frozen snapshot. Rather than a live
per-share filesystem watcher, staleness is checked cheaply at access time:

- **Fingerprint** of a folder = one SQL aggregate over its indexed
  descendants: `SELECT COUNT(*), MAX(mtime_ms), SUM(size) FROM file_index
  WHERE path LIKE '<folder>/%'`. Serialized as `count:maxMtime:sumSize` and
  written to the `.fp` sidecar when the zip is built.
- On **share create**: build the zip + write `.fp` immediately (so size is
  known right away, matching "creating a share creates a zip").
- On **share download** and on the **public metadata** fetch: recompute the
  current fingerprint, compare to `.fp`. If missing or different → rebuild the
  zip (write-then-rename) and rewrite `.fp`, then serve. If equal → serve the
  cached zip untouched (no re-zip).
- **Concurrency:** an in-process `Map<shareId, Promise>` coalesces concurrent
  rebuilds of the same share (single Bun process per the architecture, so an
  in-process lock is sufficient — `// ponytail:` documented).

Consistency note: the fingerprint reads `file_index`, which lags disk by up to
the watcher/cron window (≤5 min). This matches the rest of the app's
disk↔index consistency model; the zip self-heals on the next tick + download.

## API changes

`apps/server/src/files/routes.ts`

- **`GET /api/files/archive?path=<folder>`** (auth required): validate path via
  `userRel`, confirm it's a directory, stream `zipFolderToStream(path)` with
  `Content-Type: application/zip` and
  `Content-Disposition: attachment; filename="<folder>.zip"` (same header
  sanitization already used for file downloads). No persistence.

`apps/server/src/shares/routes.ts`

- **`POST /api/shares`**: `stat` the path first.
  - Directory → generate id + token, build zip to
    `.shares/<id>/<basename>.zip` + `.fp`, insert `shareLink` with
    `path = <folder path>`. Password / expiry / maxDownloads unchanged.
  - Regular file → existing behavior (requires a `file_index` row), unchanged.
  - Neither (missing) → 404.
- **`GET /api/shares/public/:token`** (metadata): if `stat(path)` is a
  directory, ensure the zip fresh, take `size` from its on-disk `stat`, set
  `mime = application/zip`, `name = <foldername>.zip`. Else existing file
  metadata.
- **`POST /api/shares/public/:token/file`** (download): if the path is a
  directory, ensure-fresh (rebuild-on-access) then stream the zip
  (`Content-Length` from the zip's `stat.size`, filename `<foldername>.zip`).
  Else existing file streaming. Download-count increment unchanged.
- **`DELETE /api/shares/:id`**: after revoking, `rm('.shares/<id>',
  {recursive, force})`. No-op for file shares (nothing at that path).

`apps/server/src/files/store.ts`

- `removeShareZip(shareId)` → `rm` of `.shares/<id>` (recursive, force).
- Helpers to build the zip path and read/write the `.fp` sidecar.

## Orphan sweep

Manual removal deletes the zip immediately, but expiry / max-downloads leave
orphans. Extend the existing `filesCron` 5-minute tick
(`apps/server/src/files/cron.ts`):

- List `.shares/*` dirs. For each `<id>`, look up its `shareLink` row. Delete
  the dir if the share is revoked, expired, download-maxed, or has no row.
- Best-effort; errors logged, never throw (matches scanner tick behavior).

## Web

`apps/web/src/routes/_app.files.tsx` (all file-browser UI lives here):

- **Folder download**: folder rows/cards get a Download action —
  `<a href="/api/files/archive?path=<path>" download="<name>.zip">` (browser
  sends the session cookie; no JS fetch needed, mirrors the existing file
  download link at lines ~1243/1708).
- **Folder share**: the existing share flow (`shareTarget`,
  `createShareMutation`, share dialog) already takes a `{ path, name }` and
  posts to `api.api.shares`. Wire the same "Share" action onto folder rows.
  Server handles the folder branch; the dialog copy can note "a zip of this
  folder will be shared."

## Tests (`bun:test`)

- **Byte-exact round trip**: create a folder tree with known bytes → zip via
  `zipFolderToFile` → unzip (fflate) → assert every file's bytes match.
- **Store-level**: assert entries are stored (not deflated) — sanity on level 0.
- **Rebuild-on-access**: build zip, mutate folder + reindex, assert next
  access rebuilds (fingerprint change → new zip contents / size).
- **Revoke deletes zip**: create folder share → `.shares/<id>` exists →
  DELETE → dir gone.
- **Sweep**: an orphaned `.shares/<id>` (revoked/expired share) is removed on
  cron sweep; an active share's zip is kept.

## Files touched

- `apps/server/src/files/zip.ts` — **new**
- `apps/server/src/files/store.ts` — `removeShareZip`, zip-path/fp helpers
- `apps/server/src/files/routes.ts` — `/archive` route, `.shares` reserved
- `apps/server/src/shares/routes.ts` — folder branch, rebuild-on-access, delete
- `apps/server/src/files/cron.ts` — orphan sweep
- `apps/server/package.json` — add `fflate`
- `apps/web/src/routes/_app.files.tsx` — folder Download + Share actions
- tests alongside the above
