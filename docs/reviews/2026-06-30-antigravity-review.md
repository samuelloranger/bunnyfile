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

---

# Resolution (2026-06-30)

Branch `harden/review-fixes`. Every finding was re-verified against the code
before acting; agy's severities were corrected where overstated.

## Fixed (with regression tests where testable)

**Security / data-integrity P1s**
- Stored XSS on `/api/files/content` + share file endpoint → `CSP: sandbox` + `nosniff`.
- S3 multipart abort path traversal → UUID-format validation.
- Open public signup → gated to first-admin; invites bypass via in-process api.
- Files API reaching `s3/` / `.trash` / `.multipart` → `userRel()` reserved-prefix guard.
- Empty/`.`/`/` path → operations on the data root → `assertNotRoot()` on all destructive store ops.
- Thumbnail pdftoppm stderr-pipe deadlock + temp leak → `stderr:'ignore'` + `finally` cleanup.
- S3 DeleteObject orphaned metadata (unawaited drizzle delete) → awaited.
- S3 chunked-decode: mid-chunk truncation committed as complete + negative chunk size OOB → both error out.

**P2s**
- search `deleteFileSearchPrefix` LIKE-wildcard over-match → escaped + `ESCAPE`.
- static SPA fallback path traversal (defense-in-depth) → WEB_DIST containment check.
- no sign-in rate limit (brute-force) → `/sign-in/email` throttled, keyed per path.
- upload fd leak on abort + temp leak on rename failure → sink closed / temp removed.
- range-read backpressure → `Bun.file().slice().stream()`.
- suffix byte range `bytes=-N` → returns last N bytes.
- S3 ListObjects `stat` race → skip files removed mid-walk.
- scanner indexed the `s3/` object tree → skipped.
- share filename header injection → control chars stripped.
- web: nested-path-at-root on create/rename (P1) → relative to current folder.
- web: grid keynav fired inside modals → dialog guard.
- web: volume slider didn't unmute → muted synced.
- web: clipboard copy crashed on plain-HTTP → guarded.
- Codex follow-up on #15: upload temps dot-prefixed (no collision with real files).

## Downgraded after verification (no fix needed)
- scanner "deletes uploaded files" → only derived DB rows, self-heals (P3).
- share token "predictable" (UUIDv7) → ~74 bits random, infeasible to guess (P3).
- rate-limit "virtual lockout" → bucket accrues correctly; not a bug.
- search LIKE "SQL injection / data loss" → drizzle binds params; FTS-index desync only.

## Deferred — lower value or needs a deeper change (recommend follow-ups)
- **Email change** desync: low-confidence (credential provider keys on userId, so login likely works); switching to `auth.api.changeEmail` requires wiring the email-verification flow. Needs investigation, not a blind change.
- **Last-admin demote/delete race**: existing check is non-atomic; needs a transaction/lock. Low real-world likelihood.
- **OAuth account-lookup**: genericOAuth isn't configured (N/A unless OAuth is enabled).
- **S3 GetObject suffix range** / **completeMultipartUpload omitted-parts** / **chunked unbounded per-chunk buffer**: S3 edge cases; capping chunk size risks valid large chunks — needs care.
- **IP spoofing / shared `unknown` rate-limit bucket**: deploy behind a proxy that sets `X-Forwarded-For`; better fix is reading the socket peer IP.
- **S3 access-key encryption tied to `BETTER_AUTH_SECRET`**: rotating the secret invalidates stored keys — operational note, document.
- **Web UX P2/P3**: folder filter only sees the loaded page, batch upload aborts on first failure, un-debounced search, stale search after delete/rename, negative share expiry, thumbnail cache-bust, share error-message loss, invalid-password tab redirect, huge-file viewer OOM, missing fetch aborts on close, iOS fullscreen.
- **Misc P3**: move TOCTOU, metrics full-table scan, graceful-shutdown completeness, access-key modulo bias.
