# Antigravity per-feature code review — 2026-06-30

Fresh-eyes review by `agy` across 17 feature units, then **verified against the
code by hand** (agy findings are a signal, not gospel — several P1 claims were
overstated and are downgraded below). 13/17 reviewed at time of writing; 4
pending (file-store-durability, password-reset, users-and-profile, ops).

## CONFIRMED P1 — verified real, fix recommended

1. **Stored XSS via raw file serving** — `files/routes.ts` (`GET /api/files/content`, ~L537) and the public share file endpoint serve uploaded bytes with `Content-Type` from the filename and **no `Content-Disposition`, no `X-Content-Type-Options: nosniff`, no CSP**. Upload `evil.html` → open its content URL → script runs in the app's **same origin**. Reachable **unauthenticated via share links**.
   *Fix:* on content + share-file responses set `X-Content-Type-Options: nosniff` and `Content-Security-Policy: sandbox` (neutralizes scripts but keeps img/video/pdf preview working, since those fetch bytes, not documents); force `Content-Disposition: attachment` for `text/html` / SVG.

2. **S3 multipart abort → arbitrary directory deletion** — `s3/multipart.ts:254-267`. `uploadId` from the request is passed unvalidated to `resolve(MULTIPART_DIR, uploadId)` then `rm(dir, {recursive, force})`. `uploadId=../../..` escapes `MULTIPART_DIR` and recursively deletes arbitrary dirs (as the server process). Authed S3 user only, but still arbitrary deletion.
   *Fix:* require `uploadId` to match a UUID and exist in `s3_multipart_upload`; assert the resolved dir stays under `MULTIPART_DIR` before `rm`.

3. **Internal-prefix access from the files API** — `files/paths.ts` `safeRelPath` blocks `..`/`\0`/absolute but **not reserved prefixes**. A web (non-S3) user can `DELETE /api/files/folder` with `path: "s3/bucket"` (or `.trash`, `.multipart`) → `movePathToTrash` moves S3 bucket data to trash → data loss + DB desync.
   *Fix:* reject `s3/`, `.trash`, `.multipart` (and the `.tmp-` artifacts) in `safeRelPath` / the files routes.

4. **Open public signup** — `index.ts` mounts `/api/auth/*` and `emailAndPassword` has no `disableSignUp`, so anyone can `POST /api/auth/sign-up/email` and self-register on a private instance (intended model is admin-invite via `/people`).
   *Fix:* allow sign-up only when zero users exist (first-admin), else require an admin invite; gate in a `databaseHooks.user.create.before` or disable the public endpoint and route invites server-side.

## Verified P2 — should-fix

- **Search `LIKE` wildcard over-match** — `files/search.ts:32` `deleteFileSearchPrefix` uses `path LIKE '<path>/%'`. (Params are bound — *no SQL injection*, agy overstated.) But `%`/`_` are legal filename chars, so a folder named `a_b` over-matches siblings → **FTS index desync** (derived, rebuildable; not disk data loss). *Fix:* escape `%`/`_` with `ESCAPE`.
- **Suffix byte-range broken** — `files/routes.ts:~517` regex `bytes=(\d*)-(\d*)` on `bytes=-500` yields start=0,end=500 instead of "last 500 bytes". Breaks suffix-range clients.
- **Unawaited search-index writes** — `files/search.ts` `upsert/delete*` run `db.run(...)` without `await`; callers proceed before the write and errors become unhandled rejections.
- **Thumbnail spawn** — `files/thumbnail.ts` `stderr: 'pipe'` not drained (can hang on large stderr); tmp file leaks on failure.
- **Auth secret fallback** — dev `BETTER_AUTH_SECRET` default still boots in prod (warns); S3 access-key encryption is tied to the same secret, so rotation silently invalidates all stored S3 keys (`s3/access-keys.ts`).
- **`ListObjectsV2` stat race** — `s3/routes.ts:~114` `stat()` after `readdir` throws `ENOENT` (→500) if a file is deleted concurrently; should skip.
- **Volume slider unmute bug** — `video-viewer.tsx`/`audio-player.tsx:55-62`.
- **Batch upload aborts on first failure** — `_app.files.tsx` upload loop.

## Downgraded — agy P1 claims that verification did NOT support

- **Scanner "deletes newly uploaded files"** → reconcile only deletes derived **DB rows** for paths absent on disk; never `rm`s disk. Self-heals next scan. → **P3**.
- **Share token "predictable" (UUIDv7)** → v7 still carries ~74 bits of randomness; infeasible to guess. Leaks creation time only. → **P3 hardening**.
- **Search `LIKE` "data loss / SQL injection"** → params are bound; impact is FTS-index desync only (see P2 above).

## Pending (retry in progress)

file-store-durability, password-reset, users-and-profile, ops-metrics-shutdown-migrations.
