# Deepen File Library Mutations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move authenticated file mutations (upload / move / trash / restore / remove / create folder) out of the HTTP adapter into a deep **File Library** module that owns Storage bytes plus index, search, thumbnail, and files-changed broadcast side effects.

**Architecture:** `apps/server/src/files/library.ts` is the mutation seam. Callers pass already-validated relative paths (or trash ids) and an actor where ownership matters. Library calls Storage (`writeUpload`, `moveFile`, `movePathToTrash`, `restorePathFromTrash`, `removeTrashPath`, `createFolder`, `openStream`) and orchestrates `fileIndex` / `file_search` / `thumbnail` / `broadcastFilesChanged`. `files/routes.ts` becomes auth + `userRel` + PathError→HTTP mapping only for covered mutations. Scanner, watcher, and cron stay separate entry points. S3 is out of this change set.

**Tech Stack:** Bun ≥ 1.3, Elysia, Drizzle + `bun:sqlite`, `bun:test`, existing Storage / search / thumbnail / events helpers.

**Specs:**
- `docs/superpowers/specs/2026-08-01-deepen-file-library-mutations.md`
- Related (do not implement here): `docs/superpowers/specs/2026-08-01-seal-storage-path-seam.md`

## Global Constraints

- External `/api/files/*` and `/api/trash*` contracts stay stable (paths, status codes, response shapes).
- No new database tables or schema migrations.
- Storage remains the byte seam — File Library must not reimplement write-then-rename / checksums.
- Prefer not widening abs-path leakage; thumbnail internals may still resolve abs paths until the Storage seam lands (same as today: `absFromRelOrThrow` only inside Library / thumbnail, not in routes for covered mutations).
- Path validation (`userRel` / reserved / traversal) stays before mutation in the HTTP adapter.
- Thumbnail generation stays asynchronous on upload (`.catch(() => {})`), matching today.
- Share validity for moved/trashed paths is unchanged (no share rewrite in this deepen).
- Scanner / watcher / cron are not forced through File Library HTTP shapes.
- S3 PutObject migration is follow-on only — do not rewrite `apps/server/src/s3/` in this PR.
- Failure default: if bytes commit but metadata fails, compensate when safe (undo byte move / delete uploaded file) then fail the request; never leave a silent index lie when detectible.
- Lint/format: Biome. Verify with `bun test`, `bun run typecheck`, `bun run lint`.
- No new runtime dependencies.
- Domain name: **File Library** (`files/library.ts`). Do not confuse with `s3/library.ts`.

## File map

| Path | Responsibility |
|---|---|
| `apps/server/src/files/library.ts` | **Create** — File Library mutations: `upload`, `move`, `trashFile`, `trashFolder`, `restore`, `remove`, `emptyTrash`, `createLibraryFolder` |
| `apps/server/src/files/library.test.ts` | **Create** — module-seam tests (bytes + index + search + broadcast + trash rows) |
| `apps/server/src/files/routes.ts` | Thin adapter: session, `userRel`, ownership gate mapping, PathError→status; call Library for covered mutations |
| `apps/server/src/files/routes.test.ts` | Keep as adapter smoke (create → upload → list → move → trash → restore) |
| `apps/server/src/files/store.ts` | Unchanged Storage byte helpers |
| `apps/server/src/files/store.test.ts` | Unchanged byte integrity prior art |
| `apps/server/src/files/search.ts` | Unchanged helpers; called from Library |
| `apps/server/src/files/thumbnail.ts` | Unchanged; scheduled from Library upload |
| `apps/server/src/files/events.ts` | Unchanged `broadcastFilesChanged` |
| `apps/server/src/files/scanner.ts` | Unchanged; restore-of-dir may still call `scan()` from Library (same as routes today) |

---

### Task 1: File Library — types + `upload` + `createLibraryFolder`

**Files:**
- Create: `apps/server/src/files/library.ts`
- Create: `apps/server/src/files/library.test.ts`

**Interfaces:**
- Consumes: `writeUpload`, `createFolder`, `openStream`, `PathError`, `absFromRelOrThrow` from `./store`; `db` + `fileIndex` / `thumbnail`; `upsertFileSearch`; `broadcastFilesChanged`; `mimeFromName` / `basenameOf`; `generateAndStoreThumbnail` / `isThumbnailable`
- Produces:
  ```ts
  export type LibraryActor = {
    userId: string;
    role?: string | null;
  };

  export type UploadResult = {
    path: string;
    size: number;
    sha256: string;
    mime: string;
  };

  export async function upload(
    rel: string,
    stream: ReadableStream<Uint8Array>,
    opts: { mime?: string; uploadedByUserId: string },
  ): Promise<UploadResult>;

  export async function createLibraryFolder(rel: string): Promise<{ path: string }>;
  ```

**Failure semantics for `upload`:** After `writeUpload` succeeds, upsert index + search + broadcast. If metadata steps throw, compensate with `removeFile(rel)` when safe, then rethrow. Thumbnail schedule is fire-and-forget and must not fail the request.

- [ ] **Step 1: Write failing `upload` / `createLibraryFolder` tests**

Create `apps/server/src/files/library.test.ts` with the same env/bootstrap pattern as `routes.test.ts` (temp `DB_PATH` / `DATA_DIR`, `BETTER_AUTH_SECRET`, `runMigrations`, seed a user). Do **not** mock auth — call Library directly.

```ts
import { beforeAll, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';

const testRoot = await mkdtemp(join(tmpdir(), 'bunnyfile-file-library-'));
process.env.DB_PATH = join(testRoot, 'test.sqlite');
process.env.DATA_DIR = join(testRoot, 'data');
process.env.BETTER_AUTH_SECRET = 'test-secret';

const [{ runMigrations }, { db }, { fileIndex, user }, library, { openStream }, search] =
  await Promise.all([
    import('../db/migrate'),
    import('../db'),
    import('../db/schema'),
    import('./library'),
    import('./store'),
    import('./search'),
  ]);

function streamFromText(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(c) {
      c.enqueue(new TextEncoder().encode(text));
      c.close();
    },
  });
}

describe('File Library — upload / createLibraryFolder', () => {
  beforeAll(async () => {
    await mkdir(process.env.DATA_DIR!, { recursive: true });
    runMigrations();
    await db.insert(user).values({
      id: 'lib-user',
      name: 'Lib User',
      email: 'lib@example.com',
      emailVerified: true,
      role: 'admin',
    });
  });

  test('upload writes bytes, index row, and search hit', async () => {
    const path = `up-${crypto.randomUUID().slice(0, 8)}.txt`;
    const result = await library.upload(path, streamFromText('hello library'), {
      mime: 'text/plain',
      uploadedByUserId: 'lib-user',
    });
    expect(result.path).toBe(path);
    expect(result.size).toBe(13);
    expect(result.sha256).toHaveLength(64);

    const { stat } = await openStream(path);
    expect(stat.size).toBe(13);

    const row = db.select().from(fileIndex).where(eq(fileIndex.path, path)).get();
    expect(row?.size).toBe(13);
    expect(row?.uploadedByUserId).toBe('lib-user');

    const hits = await search.searchFiles(path.slice(0, 8), 20);
    expect(hits.some((h) => h.path === path)).toBe(true);
  });

  test('createLibraryFolder makes listing-visible empty dir', async () => {
    const path = `dir-${crypto.randomUUID().slice(0, 8)}`;
    const result = await library.createLibraryFolder(path);
    expect(result.path).toBe(path);
    const { listImmediateDirectories } = await import('./store');
    const dirs = await listImmediateDirectories('');
    expect(dirs).toContain(path);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test apps/server/src/files/library.test.ts`

Expected: FAIL — `./library` module missing / exports missing.

- [ ] **Step 3: Implement `upload` + `createLibraryFolder`**

Create `apps/server/src/files/library.ts`:

```ts
import { eq } from 'drizzle-orm';
import { db } from '../db';
import { fileIndex } from '../db/schema';
import { broadcastFilesChanged } from './events';
import { mimeFromName } from './mime';
import { basenameOf } from './paths';
import { upsertFileSearch } from './search';
import {
  absFromRelOrThrow,
  createFolder,
  removeFile,
  writeUpload,
} from './store';
import { generateAndStoreThumbnail, isThumbnailable } from './thumbnail';

export type LibraryActor = {
  userId: string;
  role?: string | null;
};

export type UploadResult = {
  path: string;
  size: number;
  sha256: string;
  mime: string;
};

export async function upload(
  rel: string,
  stream: ReadableStream<Uint8Array>,
  opts: { mime?: string; uploadedByUserId: string },
): Promise<UploadResult> {
  const info = await writeUpload(rel, stream);
  const mime = opts.mime || mimeFromName(basenameOf(rel));
  try {
    const existing = await db.select().from(fileIndex).where(eq(fileIndex.path, rel));
    if (existing.length > 0) {
      await db
        .update(fileIndex)
        .set({
          size: info.size,
          mtimeMs: info.mtimeMs,
          inode: info.inode,
          sha256: info.sha256,
          mime,
          uploadedByUserId: opts.uploadedByUserId,
          indexedAt: new Date(),
        })
        .where(eq(fileIndex.path, rel));
    } else {
      await db.insert(fileIndex).values({
        path: rel,
        size: info.size,
        mtimeMs: info.mtimeMs,
        inode: info.inode,
        sha256: info.sha256,
        mime,
        uploadedByUserId: opts.uploadedByUserId,
      });
    }
    await upsertFileSearch(rel);
    broadcastFilesChanged();
  } catch (err) {
    await removeFile(rel).catch(() => {});
    throw err;
  }
  if (isThumbnailable(mime)) {
    generateAndStoreThumbnail(absFromRelOrThrow(rel), rel, mime).catch(() => {});
  }
  return { path: rel, size: info.size, sha256: info.sha256, mime };
}

export async function createLibraryFolder(rel: string): Promise<{ path: string }> {
  await createFolder(rel);
  broadcastFilesChanged();
  return { path: rel };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test apps/server/src/files/library.test.ts`

Expected: PASS for Task 1 cases.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/files/library.ts apps/server/src/files/library.test.ts \
  docs/superpowers/specs/2026-08-01-deepen-file-library-mutations.md \
  docs/superpowers/plans/2026-08-01-deepen-file-library-mutations.md
git commit -m "$(cat <<'EOF'
feat(files): add File Library upload and folder create

EOF
)"
```

---

### Task 2: File Library — `move`

**Files:**
- Modify: `apps/server/src/files/library.ts`
- Modify: `apps/server/src/files/library.test.ts`

**Interfaces:**
- Consumes: Task 1 exports; `moveFile`, `openStream` from `./store`; `deleteFileSearch` / `upsertFileSearch`; `thumbnail` table
- Produces:
  ```ts
  export async function move(fromRel: string, toRel: string): Promise<{ path: string }>;
  ```

**Behavior (match routes today + thumbnail locality):**
1. Read existing `fileIndex` row for `fromRel` (may be null).
2. `await moveFile(fromRel, toRel)`.
3. Stat destination via `openStream(toRel)`.
4. Delete old index + search; insert new index; upsert search.
5. If a `thumbnail` row exists at `fromRel`, update its `path` to `toRel` (today orphans; Library owns thumbs).
6. `broadcastFilesChanged()`.
7. On metadata failure after rename: attempt `moveFile(toRel, fromRel)` compensation, then rethrow.

- [ ] **Step 1: Write failing `move` tests**

Append to `library.test.ts`:

```ts
describe('File Library — move', () => {
  test('move updates bytes, index path, and search', async () => {
    const from = `mv-from-${crypto.randomUUID().slice(0, 8)}.txt`;
    const to = `mv-to-${crypto.randomUUID().slice(0, 8)}.txt`;
    await library.upload(from, streamFromText('move me'), {
      mime: 'text/plain',
      uploadedByUserId: 'lib-user',
    });
    const result = await library.move(from, to);
    expect(result.path).toBe(to);

    await expect(openStream(from)).rejects.toBeInstanceOf(
      (await import('./store')).PathError,
    );
    const { stat } = await openStream(to);
    expect(stat.size).toBe(7);

    expect(db.select().from(fileIndex).where(eq(fileIndex.path, from)).get()).toBeUndefined();
    expect(db.select().from(fileIndex).where(eq(fileIndex.path, to)).get()?.size).toBe(7);

    const hits = await search.searchFiles(to.slice(0, 8), 20);
    expect(hits.some((h) => h.path === to)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test apps/server/src/files/library.test.ts`

Expected: FAIL — `move` is not a function.

- [ ] **Step 3: Implement `move`**

```ts
export async function move(fromRel: string, toRel: string): Promise<{ path: string }> {
  const existingRow = await db
    .select()
    .from(fileIndex)
    .where(eq(fileIndex.path, fromRel))
    .then((r) => r[0]);

  await moveFile(fromRel, toRel);

  try {
    const { stat: newStat } = await openStream(toRel);
    const mime = existingRow?.mime ?? mimeFromName(basenameOf(toRel));

    await db.delete(fileIndex).where(eq(fileIndex.path, fromRel));
    await deleteFileSearch(fromRel);
    await db.insert(fileIndex).values({
      path: toRel,
      size: newStat.size,
      mtimeMs: Math.round(newStat.mtimeMs),
      inode: Number(newStat.ino),
      sha256: existingRow?.sha256 ?? null,
      mime,
      uploadedByUserId: existingRow?.uploadedByUserId ?? null,
    });
    await upsertFileSearch(toRel);

    const thumb = db.select().from(thumbnail).where(eq(thumbnail.path, fromRel)).get();
    if (thumb) {
      await db.delete(thumbnail).where(eq(thumbnail.path, fromRel));
      await db.insert(thumbnail).values({ ...thumb, path: toRel });
    }

    broadcastFilesChanged();
  } catch (err) {
    await moveFile(toRel, fromRel).catch(() => {});
    throw err;
  }
  return { path: toRel };
}
```

Add imports: `moveFile`, `openStream`, `deleteFileSearch`, `thumbnail`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test apps/server/src/files/library.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/files/library.ts apps/server/src/files/library.test.ts
git commit -m "$(cat <<'EOF'
feat(files): File Library move owns index and search

EOF
)"
```

---

### Task 3: File Library — `trashFile` + `trashFolder`

**Files:**
- Modify: `apps/server/src/files/library.ts`
- Modify: `apps/server/src/files/library.test.ts`

**Interfaces:**
- Consumes: `movePathToTrash`; `trashItem`; `deleteFileSearch` / `deleteFileSearchPrefix`; `sql` for folder subtree deletes
- Produces:
  ```ts
  export async function trashFile(
    rel: string,
    deletedByUserId: string,
  ): Promise<{ ok: true }>;

  export async function trashFolder(
    rel: string,
    deletedByUserId: string,
  ): Promise<{ ok: true }>;
  ```

**Behavior (match routes):**
- **trashFile:** require file via `openStream`; generate id; `movePathToTrash`; insert `trashItem` kind `file`; delete index + search (+ thumbnail row if present); broadcast.
- **trashFolder:** `movePathToTrash`; insert `trashItem` kind `dir` with summed subtree size; delete index rows `path = rel OR path LIKE rel/%`; `deleteFileSearchPrefix(rel)`; delete thumbnail rows under that prefix; broadcast.
- On metadata failure after disk trash move: attempt `restorePathFromTrash(moved.trashPath, rel)`, then rethrow.

- [ ] **Step 1: Write failing trash tests**

```ts
describe('File Library — trash', () => {
  test('trashFile removes from index and search; restore path kept in trash_item', async () => {
    const { trashItem } = await import('../db/schema');
    const path = `tr-${crypto.randomUUID().slice(0, 8)}.txt`;
    await library.upload(path, streamFromText('bye'), {
      mime: 'text/plain',
      uploadedByUserId: 'lib-user',
    });
    await library.trashFile(path, 'lib-user');

    expect(db.select().from(fileIndex).where(eq(fileIndex.path, path)).get()).toBeUndefined();
    const row = db.select().from(trashItem).where(eq(trashItem.originalPath, path)).get();
    expect(row?.kind).toBe('file');
    expect(row?.deletedByUserId).toBe('lib-user');
    await expect(openStream(path)).rejects.toBeInstanceOf(
      (await import('./store')).PathError,
    );
  });

  test('trashFolder removes subtree index rows', async () => {
    const { trashItem } = await import('../db/schema');
    const folder = `tf-${crypto.randomUUID().slice(0, 8)}`;
    const child = `${folder}/child.txt`;
    await library.createLibraryFolder(folder);
    await library.upload(child, streamFromText('nested'), {
      mime: 'text/plain',
      uploadedByUserId: 'lib-user',
    });
    await library.trashFolder(folder, 'lib-user');

    expect(db.select().from(fileIndex).where(eq(fileIndex.path, child)).get()).toBeUndefined();
    const row = db.select().from(trashItem).where(eq(trashItem.originalPath, folder)).get();
    expect(row?.kind).toBe('dir');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test apps/server/src/files/library.test.ts`

Expected: FAIL — `trashFile` / `trashFolder` missing.

- [ ] **Step 3: Implement trash mutations**

Port the bodies from `routes.ts` DELETE `/api/files` and DELETE `/api/files/folder` into Library functions. Include thumbnail cleanup:

```ts
await db.delete(thumbnail).where(eq(thumbnail.path, rel)); // file
// folder:
await db.delete(thumbnail).where(
  sql`${thumbnail.path} = ${rel} OR ${thumbnail.path} LIKE ${`${rel}/%`}`,
);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test apps/server/src/files/library.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/files/library.ts apps/server/src/files/library.test.ts
git commit -m "$(cat <<'EOF'
feat(files): File Library trash owns index and search cleanup

EOF
)"
```

---

### Task 4: File Library — `restore` + `remove` + `emptyTrash`

**Files:**
- Modify: `apps/server/src/files/library.ts`
- Modify: `apps/server/src/files/library.test.ts`

**Interfaces:**
- Consumes: `restorePathFromTrash`, `removeTrashPath`, `openStream`; `scan` for dir restore; `LibraryActor`
- Produces:
  ```ts
  export class LibraryError extends Error {
    constructor(
      public code: 'not_found' | 'forbidden' | 'exists' | 'trashed_missing',
      message: string,
    ) {
      super(message);
    }
  }

  export async function restore(
    trashId: string,
    actor: LibraryActor,
  ): Promise<{ path: string }>;

  export async function remove(
    trashId: string,
    actor: LibraryActor,
  ): Promise<{ ok: true }>;

  export async function emptyTrash(
    actor: LibraryActor,
  ): Promise<{ removed: number }>;
  ```

**Ownership:** Admin may act on any trash row; non-admin only when `deletedByUserId === actor.userId`. Missing or unauthorized → `LibraryError('not_found')` (same 404 mapping routes use today — do not leak existence via `forbidden` for trash ids).

**restore behavior (match routes):**
- File: restore bytes; insert `fileIndex`; `upsertFileSearch`; delete trash row; broadcast.
- Dir: restore bytes; `await scan()`; delete trash row; broadcast.
- `PathError('exists')` → `LibraryError('exists')`; missing trash bytes → `LibraryError('trashed_missing')`.

**remove / emptyTrash:** delete bytes via `removeTrashPath`, delete rows; no broadcast required (matches today — permanent purge does not emit files-changed).

- [ ] **Step 1: Write failing restore/remove tests**

```ts
describe('File Library — restore / remove', () => {
  test('restore file brings bytes and index back', async () => {
    const { trashItem } = await import('../db/schema');
    const path = `rs-${crypto.randomUUID().slice(0, 8)}.txt`;
    await library.upload(path, streamFromText('back'), {
      mime: 'text/plain',
      uploadedByUserId: 'lib-user',
    });
    await library.trashFile(path, 'lib-user');
    const tid = db.select().from(trashItem).where(eq(trashItem.originalPath, path)).get()!.id;

    const result = await library.restore(tid, { userId: 'lib-user', role: 'admin' });
    expect(result.path).toBe(path);
    const { stat } = await openStream(path);
    expect(stat.size).toBe(4);
    expect(db.select().from(fileIndex).where(eq(fileIndex.path, path)).get()?.size).toBe(4);
  });

  test('remove permanently deletes trash bytes and row', async () => {
    const { trashItem } = await import('../db/schema');
    const path = `rm-${crypto.randomUUID().slice(0, 8)}.txt`;
    await library.upload(path, streamFromText('gone'), {
      mime: 'text/plain',
      uploadedByUserId: 'lib-user',
    });
    await library.trashFile(path, 'lib-user');
    const tid = db.select().from(trashItem).where(eq(trashItem.originalPath, path)).get()!.id;

    await library.remove(tid, { userId: 'lib-user', role: 'admin' });
    expect(db.select().from(trashItem).where(eq(trashItem.id, tid)).get()).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test apps/server/src/files/library.test.ts`

Expected: FAIL — restore/remove missing.

- [ ] **Step 3: Implement restore / remove / emptyTrash**

Port `/api/trash/:id/restore`, `/api/trash/:id` DELETE, and `/api/trash` DELETE bodies. Factor a private `ownsTrashItem(row, actor)` matching routes.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test apps/server/src/files/library.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/files/library.ts apps/server/src/files/library.test.ts
git commit -m "$(cat <<'EOF'
feat(files): File Library restore and permanent remove

EOF
)"
```

---

### Task 5: Thin HTTP adapter — wire routes to File Library

**Files:**
- Modify: `apps/server/src/files/routes.ts`
- Modify: `apps/server/src/files/routes.test.ts` (only if imports break; keep behavioral assertions)

**Interfaces:**
- Consumes: `upload`, `move`, `trashFile`, `trashFolder`, `restore`, `remove`, `emptyTrash`, `createLibraryFolder`, `LibraryError` from `./library`
- Consumes: `userRel`, `auth` session, `PathError` for leftover read paths
- Produces: unchanged HTTP shapes/status codes

Status mapping:

| Library / PathError | HTTP |
|---|---|
| unauthorized (no session) | 401 — adapter only |
| invalid `userRel` | 400 |
| `PathError('not_found')` / `LibraryError('not_found')` | 404 |
| `PathError('exists')` / `LibraryError('exists')` | 409 |
| `LibraryError('trashed_missing')` | 404 + `'trashed item missing'` |
| other `PathError` | 400 |
| unexpected | 500 / rethrow (match prior handler) |

- [ ] **Step 1: Replace mutation handlers**

Upload:

```ts
const target = userRel(body.path);
if (!target) { set.status = 400; return { error: 'invalid path' as const }; }
try {
  return await upload(target, body.file.stream(), {
    mime: body.file.type || undefined,
    uploadedByUserId: s.user.id,
  });
} catch (err) {
  // PathError → 400/500 mapping as today
}
```

Create folder → `createLibraryFolder(path)`.

PATCH move → `move(path, newPath)` with status mapping.

DELETE file → `trashFile(path, s.user.id)`.

DELETE folder → `trashFolder(path, s.user.id)`.

POST restore → `restore(params.id, { userId: s.user.id, role: s.user.role })`.

DELETE trash id → `remove(...)`.

DELETE trash all → `emptyTrash(...)`.

Remove from routes (for covered mutations): inline `fileIndex` upsert/delete, `upsertFileSearch` / `deleteFileSearch` / `deleteFileSearchPrefix`, `broadcastFilesChanged`, `generateAndStoreThumbnail`, `movePathToTrash` / `restorePathFromTrash` / `removeTrashPath` / `writeUpload` / `moveFile` / `createFolder` (keep Storage imports still needed for **read** paths: content, archive, thumbnail GET/POST regenerate, list, usage).

Keep `ownsTrashItem` only if still used; prefer deleting it once restore/remove live in Library.

- [ ] **Step 2: Run adapter + library tests**

```bash
bun test apps/server/src/files/library.test.ts apps/server/src/files/routes.test.ts apps/server/src/files/store.test.ts apps/server/src/files/search.test.ts
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/server/src/files/routes.ts apps/server/src/files/routes.test.ts apps/server/src/files/library.ts
git commit -m "$(cat <<'EOF'
refactor(files): thin routes; mutations go through File Library

EOF
)"
```

---

### Task 6: Full verification

**Files:** none new (verification only)

- [ ] **Step 1: Run full workspace checks**

```bash
bun test
bun run typecheck
bun run lint
```

Expected: all PASS / clean.

- [ ] **Step 2: Spec coverage self-check**

Confirm against the spec:
- Upload / move / trash / restore / remove / folder create owned by File Library ✓
- Routes do not upsert index/search inline for covered mutations ✓
- Storage still used for bytes ✓
- External contracts stable (routes tests green) ✓
- Scanner/watcher untouched ✓
- S3 not rewritten ✓
- Failure compensation documented in library upload/move/trash ✓

- [ ] **Step 3: Final commit only if verification fixed anything**

If lint/typecheck required fixes, commit those; otherwise done.

```bash
git status
```

---

## Self-review (plan author)

**1. Spec coverage**
- Mutation vocabulary → Tasks 1–4
- Routes thin adapter → Task 5
- Module-level tests at File Library seam → Tasks 1–4
- Storage remains byte seam → Global Constraints + all tasks call store helpers
- No S3 / share / UI / schema → Out of scope + constraints
- Failure semantics → Task 1 upload compensate; Task 2 move compensate; Task 3 trash compensate
- Thumbnail async on upload → Task 1; thumb path retarget on move → Task 2 (locality fix, no UX)
- Folder archive download unchanged → routes keep `/api/files/archive` streaming path

**2. Placeholder scan:** none intentional — code blocks are copy-ready.

**3. Type consistency:** `LibraryActor`, `UploadResult`, `LibraryError` codes used consistently across Tasks 1–5.
