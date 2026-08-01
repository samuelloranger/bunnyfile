# Launch security hardening — design

**Status:** approved design, pre-implementation  
**Date:** 2026-08-01  
**Board:** #567–#571 (execution order below); brainstorm #572  
**Approach:** A — security-first vertical slices; storage migration last

## Goal

Close the full audit package before the public launch post: fix the share
reserved-path leak, harden public share links, document the shared-workspace
model, refuse insecure auth secrets, fix download streaming, split internal
storage out of the user files tree (with boot auto-migrate), and refresh
screenshot seed data so README shots look credible.

**Done when:** board tasks #567–#571 are closable; `bun test`, typecheck, and
lint are green; release notes cover the layout migrate and new env vars.

## Decisions (from brainstorm)

| Topic | Choice |
|---|---|
| Scope | Full audit #567–#571 |
| Workspace model | Keep shared workspace; document only (no per-user ACL) |
| Storage split | Do in this cycle |
| Migration | Auto-migrate on boot when `files/` is missing |
| Locked share metadata | Status + `requiresPassword` + expiry / maxDownloads / downloadCount; no path/name/size/mime |
| Passworded download | POST body only; GET allowed only when share has no password |
| Download count | Lease at start → commit on complete → release on cancel/error |
| Missing `BETTER_AUTH_SECRET` | Refuse to start always (tests set env) |
| X-Forwarded-For | Trust only when `TRUST_PROXY` / `TRUSTED_PROXIES` configured |
| Screenshots | In scope |
| Ship bar | All listed audit items closed |
| Uncommitted `store.ts` | Discard Bun.file rewrite; ship correct `createFileStream` with cancel |
| Spec shape | One design doc |

## Non-goals

- Per-user file or S3 ACLs / admin override (document convention only)
- PLAN.md §1 non-goals (sync, WebDAV, SFTP, plugins, LDAP, fine-grained RBAC, …)
- Splitting `apps/web/src/routes/_app.files.tsx`
- Re-scoping or deleting `packages/shared`
- Automatic downgrade of the DATA_DIR layout

## Execution order (fixed)

1. **#568** — reserved-path guard on share create  
2. **#569** — share link hardening  
3. **#570** — workspace docs, auth secret, `createFileStream`, small leftovers  
4. **#571** — storage layout split + boot migrate + S3/storage docs  
5. **#567** — screenshot seed + dark-mode recapture  

---

## 1. Share reserved-path guard (#568)

### Problem

`POST /api/shares` validates with `safeRelPath()` only. The files API uses
`userRel()`, which also rejects `RESERVED_TOP_SEGMENTS` (`s3`, `.trash`,
`.multipart`, `.shares`). An authenticated user can share `s3` and get a
public zip of the object tree.

### Design

- Share create uses the **same** reserved-aware validator as the files API.
- Until the layout split lands, extract/share one helper (e.g. export
  `userRel` / `assertUserRel` from a shared module) so files and shares cannot
  drift.
- After #571, validation is “safe relative path under `FILES_ROOT`” only; the
  denylist is deleted.

### Tests

- Creating a share for each reserved top segment → `400` / invalid path.
- Normal file and folder share create still succeeds.

---

## 2. Share link hardening (#569)

### 2.1 Password never in query / logs

- Passworded shares: download via **POST body only** (existing native form
  POST).
- Passwordless shares: `GET .../file` remains allowed.
- Remove `query.password` from the GET schema and from `downloadHandler`.
- Frontend (`s.$token.tsx`): remove the `?password=` `window.location.href`
  path; passworded flow = optional `/verify` + form POST only.

### 2.2 Locked public metadata

`GET /api/shares/public/:token` when the share requires a password returns
only:

- `status`, `requiresPassword: true`
- `expiresAt`, `maxDownloads`, `downloadCount`

Omit `path`, `name`, `size`, `mime` until unlocked (no password, or after a
successful verify used by the SPA to fetch enriched metadata — if the SPA
needs name/size after verify, add a password-gated metadata fetch or return
full fields from verify; do not leak them on the anonymous GET).

Frontend must not assume name/size while locked.

### 2.3 No zip work before auth

- Do **not** call `ensureShareZip` on public metadata GET when
  `requiresPassword` is true (no CPU/disk DoS, no size leak).
- Passwordless folder shares may still ensure/cache the zip for size display.
- Download handler already verifies password before building/serving the zip;
  keep that order.

### 2.4 Proxy-aware rate limit

- Env: `TRUST_PROXY=1` and/or `TRUSTED_PROXIES` (IP/CIDR list).
- `requestIp`: honor `X-Forwarded-For` / `X-Real-IP` only when trust is
  enabled (and peer matches allowlist when `TRUSTED_PROXIES` is set);
  otherwise use the socket peer address.
- README operator checklist: behind Caddy, set trust appropriately.

### 2.5 Download-count lease

When `maxDownloads` is set:

1. **Lease** at transfer start with the existing race-safe conditional
   `UPDATE ... WHERE downloadCount < maxDownloads` (`+1`).
2. **Commit** on successful stream completion (leave the `+1`).
3. **Release** on stream cancel/error (`-1`), so aborted downloads do not
   consume a slot.

When `maxDownloads` is null: prefer increment on successful completion for
consistency (counting aborted unlimited downloads is unimportant).

Do not regress the conditional max-download race.

Wire release through stream `cancel` / response teardown (see §3 stream).

### Tests (shares)

- Password rejected when supplied only as query on GET.
- Locked metadata shape; no zip artifact created for passworded metadata GET.
- XFF ignored without trust; honored with trust config.
- Aborted download releases lease; concurrent max-download still enforced.
- Frontend passworded download works via POST without query password.

---

## 3. Auth, stream, docs, leftovers (#570)

### 3.1 Shared workspace documentation

README Security (+ short note in `docs/migrating-from-nextcloud.md`):

- BunnyFile is a **shared workspace**: every authenticated user can
  list/download/delete the whole files tree.
- Any valid S3 access key reaches every bucket.
- `uploadedByUserId` is attribution, not an ACL.
- Per-user folders are an operator convention, not enforcement.

### 3.2 `BETTER_AUTH_SECRET`

- If unset or equal to the known insecure default → **refuse to start**.
- Tests/CI set a test secret via env.
- `.env.example` and README show generating a secret; no silent fallback.
- Code that encrypts S3 access-key secrets must not run under the insecure
  default (boot fails first).

### 3.3 `createFileStream`

- Discard the uncommitted Bun.file rewrite on `store.ts` — do **not** ship it.
  Implement a correct stream:
  - No whole-file buffering (any size).
  - **`cancel` closes** the underlying handle / aborts reads.
  - Do not snapshot size in a way that lies across truncate/replace mid-read;
    prefer an open handle + read loop (prior `FileHandle` approach is fine if
    cancel is restored).
- Share lease release hooks into cancel/teardown.

### 3.4 Path helper tests

Dedicated tests for `safeRelPath` / `resolveInRoot` (traversal, NUL,
absolute, `..`, root escape). After #571: assert S3/trash/shares/multipart
unreachable from every user-path entry point.

### 3.5 Symlink escape

API cannot create symlinks. Document operator risk (do not plant symlinks
under `DATA_DIR`). Optional `realpath` hardening only if it stays a small
patch; otherwise explicit deferral note in the implementation plan — not a
blocker vs the share leak.

### 3.6 SigV4 `UNSIGNED-PAYLOAD` on mutating ops

Tight fix: reject or require payload-hash binding on mutating authenticated
requests where the body is available. If rclone/aws-cli compat breaks, stop
and document the chosen behavior + client matrix in the plan task (go/no-go)
rather than shipping a silent regression.

### 3.7 Deferred from this package

- Split `_app.files.tsx`
- `packages/shared` boundary cleanup  

---

## 4. Storage layout split + migration (#571)

### 4.1 Target layout

```
DATA_DIR/
  files/       ← FILES_ROOT (browser, scanner, user shares)
  s3/          ← S3_ROOT
  trash/       ← was .trash/
  shares/      ← was .shares/ (cached folder-share zips)
  multipart/   ← was .multipart/
```

Dot prefixes drop once these dirs live outside the files tree. Isolation is
by construction: user path resolution only ever targets `FILES_ROOT`.

### 4.2 Code roots

- `FILES_ROOT = DATA_DIR/files` — store, scanner, file routes, share paths for
  user content.
- `S3_ROOT = DATA_DIR/s3` — sibling of `files/`.
- Trash / share-zip / multipart roots from `DATA_DIR`, not from `FILES_ROOT`.
- After migrate + tests: delete `RESERVED_TOP_SEGMENTS` and call sites.

### 4.3 DB path identity

- `fileIndex.path` and `shareLink.path` remain relative to the **files** root
  (no rewrite of stored user paths).
- Verify `s3Object` paths are relative to `S3_ROOT`; rewrite only if they
  incorrectly assume the old combined root.

### 4.4 Boot auto-migrate

Before serving traffic:

1. If `DATA_DIR/files` already exists → treat as migrated; ensure marker
   `DATA_DIR/.bunnyfile-layout-v2` exists (stamp if missing), then continue
   boot. Do **not** move entries again.
2. If `files/` is missing → migrate:
   - Create `files/`.
   - Move every top-level entry that is **not** `s3`, `.trash`/`trash`,
     `.shares`/`shares`, `.multipart`/`multipart`, or `files` into `files/`.
   - Rename dotted internal dirs to undotted names when present.
   - Leave `s3/` in place.
   - Write the layout marker only after the move+rename completes successfully.
3. Fail loudly on partial failure (e.g. move throws mid-way): do not stamp the
   marker; refuse to serve until an operator repairs `DATA_DIR` or re-runs a
   clean migrate.
4. Idempotent on reboot (marker + `files/` → no-op).

Fresh installs create the sibling dirs at boot; never reintroduce a denylist.

### 4.5 Docs

`docs/s3-compatibility.md` + README:

- Physical layout under `DATA_DIR`.
- Files browser and S3 are **separate namespaces** (rclone objects do not
  appear in the browser and vice versa).
- Buckets are global (cross-link shared-workspace security note).
- Internal directories operators must not hand-edit.
- What a backup of `DATA_DIR` includes.

### 4.6 Rollback

Document reverse move for operators. No automatic downgrade in code.

---

## 5. Screenshots (#567)

Keep `.github/workflows/screenshots.yml`; fix seed data and capture settings.

1. Realistic sizes (hundreds of MB / multi-GB class) so the storage meter is
   credible — prefer sparse/`truncate` files or equivalent so CI stays light.
2. Sidebar “My files N” matches list “N total”.
3. Hero shot shows **one** search/filter control (not two).
4. Capture **dark mode**.
5. Keep stable filenames under `docs/screenshots/`.

---

## Verification

- `bun test`, `bun run typecheck`, `bun run lint` green.
- New tests from §§1–4 and migration/layout tests.
- Manual/scripted checks: share `s3` rejected; locked metadata shape;
  passworded POST download; abort releases lease; legacy fixture boot →
  `files/` + marker; fresh boot creates siblings.
- Screenshot workflow (or local equivalent) refreshes PNGs; README renders.

## Rollout

1. Security slices (#568→#570) can ship before the layout migrate; #571 runs
   on next boot of existing volumes.
2. Release notes: back up `DATA_DIR` before upgrade; set
   `BETTER_AUTH_SECRET` (required); set `TRUST_PROXY` behind Caddy.
3. Password-in-query clients break by design; SPA ships in the same release.
4. Launch post waits until PNGs + all five tasks are closed.

## Open implementation details (plan may pin)

- Exact shape of post-verify metadata fetch for the SPA (verify returns
  enriched fields vs second authenticated-by-password GET).
- Whether unlimited-download counters bump on complete only (preferred) or
  keep start-bump.
- `realpath` symlink hardening: include iff small; else defer explicitly.
- SigV4 UNSIGNED-PAYLOAD: go/no-go after one rclone/aws-cli smoke.
