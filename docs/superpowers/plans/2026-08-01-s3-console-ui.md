# S3 Console UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a session-authenticated top-level **S3** console (bucket list, object CRUD, relocated access keys) backed by a deep **Bucket Library** over the existing `DATA_DIR/s3/` tree, without IAM/policies.

**Architecture:** Bucket Library owns bucket/object mutations and listing. Thin JSON routes under `/api/s3-console/*` serve the SPA via cookie sessions. SigV4 `/api/s3` stays the external adapter and is refactored to call the same library for core ops so path rules cannot diverge. Empty “folders” are trailing-slash zero-byte marker objects (required for empty-prefix visibility under delimiter listing).

**Tech Stack:** Bun ≥ 1.3, Elysia + Eden, TanStack Router/Query, Drizzle `s3_object`, existing `writeUpload` / `openStream` / `createFileStream`, `bun:test`, Biome.

**Spec:** `docs/superpowers/specs/2026-08-01-s3-console-ui-design.md`

## Global Constraints

- No IAM / JSON policies / per-key bucket scopes / ACLs / fine-grained RBAC.
- Any signed-in user can use the console (shared workspace), same as Files.
- SPA never holds access-key secrets for browse/upload; session cookies only.
- Files browser must never list `s3/` objects.
- SigV4 wire behavior and `compat.test.ts` stay green.
- Access-key crypto + `/api/settings/s3-keys` wire path stay; only the UI moves to `/s3/keys`.
- Empty folders = zero-byte object whose key ends with `/` (marker). No silent mkdir-only folders.
- Route prefix for console JSON: `/api/s3-console` (do not collide with `/api/s3`).
- Lint/format: Biome. Verify with `bun test`, `bun run typecheck`, `bun run lint`.
- No new runtime dependencies.

## File map

| Path | Responsibility |
|---|---|
| `apps/server/src/s3/library.ts` | **Create** — Bucket Library (deep module) |
| `apps/server/src/s3/library.test.ts` | **Create** — module-seam tests |
| `apps/server/src/s3/console-routes.ts` | **Create** — session JSON adapter |
| `apps/server/src/s3/console-routes.test.ts` | **Create** — adapter smoke tests |
| `apps/server/src/s3/routes.ts` | **Modify** — call Bucket Library for bucket/object core ops; keep SigV4/XML/multipart |
| `apps/server/src/s3/access-keys.ts` | Unchanged wire (`/api/settings/s3-keys`) |
| `apps/server/src/index.ts` | **Modify** — `.use(s3ConsoleRoutes)` |
| `apps/web/src/components/layout/sidebar.tsx` | **Modify** — add S3 nav item |
| `apps/web/src/routes/_app.s3.tsx` | **Create** — bucket list + create/delete |
| `apps/web/src/routes/_app.s3.$bucket.tsx` | **Create** — object browser |
| `apps/web/src/routes/_app.s3.keys.tsx` | **Create** — access keys UI (moved from Settings) |
| `apps/web/src/routes/_app.settings.tsx` | **Modify** — remove keys block; link to `/s3/keys` |
| `apps/web/src/lib/s3-console.ts` | **Create** — query keys + helpers (optional thin client wrappers) |
| `docs/s3-compatibility.md` | **Modify** — console + global keys note |
| `README.md` / `PRODUCT.md` | **Modify** — mention S3 console capability |

---

### Task 1: Bucket Library — errors, validation, bucket CRUD

**Files:**
- Create: `apps/server/src/s3/library.ts`
- Create: `apps/server/src/s3/library.test.ts`

**Interfaces:**
- Consumes: `S3_ROOT` from `../files/store`, `mkdir` / `readdir` / `rm` / `stat` from `node:fs/promises`
- Produces:
  ```ts
  export class BucketError extends Error {
    constructor(
      public code:
        | 'invalid_bucket'
        | 'invalid_key'
        | 'not_found'
        | 'bucket_exists'
        | 'bucket_not_empty'
        | 'is_directory',
      message: string,
    ) {
      super(message);
    }
  }

  export function assertBucketName(name: string): void; // throws BucketError invalid_bucket
  export function assertObjectKey(key: string): void; // throws BucketError invalid_key

  export type BucketInfo = { name: string; createdAt: string };

  export function listBuckets(): Promise<BucketInfo[]>;
  export function createBucket(name: string): Promise<BucketInfo>;
  export function deleteBucket(name: string): Promise<void>;
  ```

- [ ] **Step 1: Write the failing tests**

```ts
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Test harness: set DATA_DIR before importing library (dynamic import after env).
describe('Bucket Library buckets', () => {
  let dataDir: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'bf-s3-lib-'));
    process.env.DATA_DIR = dataDir;
    // Re-import or call ensureDataLayout; prefer testing via exported functions
    // after a fresh import pattern used elsewhere in this repo's layout tests.
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  test('createBucket + listBuckets', async () => {
    const { createBucket, listBuckets } = await import('./library');
    await createBucket('photos');
    const all = await listBuckets();
    expect(all.map((b) => b.name)).toContain('photos');
  });

  test('rejects invalid bucket name', async () => {
    const { createBucket, BucketError } = await import('./library');
    expect(() => createBucket('../x')).toThrow(BucketError);
  });

  test('deleteBucket refuses non-empty', async () => {
    // create bucket, put a file via putObject once Task 2 exists —
    // for Task 1 only: create empty, delete succeeds; manually write a file under s3/b/ then expect bucket_not_empty
  });
});
```

Use the same `DATA_DIR` + dynamic import pattern as `apps/server/src/files/layout.test.ts` if module-level `S3_ROOT` is fixed at import time. If `store.ts` already bound `DATA_ROOT` before the test sets env, set `DATA_DIR` in the test file **before** any import of `library` / `store` (top of file), or extract path helpers that accept an optional root for tests. Prefer matching existing S3 route tests’ temp-dir approach in `routes.test.ts`.

- [ ] **Step 2: Run tests — expect FAIL**

Run: `cd apps/server && bun test src/s3/library.test.ts`  
Expected: fail (module missing or exports missing).

- [ ] **Step 3: Implement validation + bucket CRUD in `library.ts`**

Mirror current `validateBucket` rules from `routes.ts` (no `/`, `\`, `\0`, `.`, `..`, max 255). `createBucket` → `mkdir(S3_ROOT/name, { recursive: false })` after ensuring `S3_ROOT`; map `EEXIST` → `bucket_exists`. `deleteBucket` → `hasAnyFile` (any file under bucket dir, including markers) → `bucket_not_empty`; else `rm` recursive. `listBuckets` — directories under `S3_ROOT`, skip dot names, `createdAt` from birthtime/ctime ISO.

- [ ] **Step 4: Run tests — expect PASS**

Run: `cd apps/server && bun test src/s3/library.test.ts`

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/s3/library.ts apps/server/src/s3/library.test.ts
git commit -m "feat(s3): add Bucket Library bucket CRUD"
```

---

### Task 2: Bucket Library — put / get / head / delete object

**Files:**
- Modify: `apps/server/src/s3/library.ts`
- Modify: `apps/server/src/s3/library.test.ts`

**Interfaces:**
- Consumes: `writeUpload`, `openStream`, `createFileStream`, `hashOnDisk` (as needed), `absFromRelOrThrow` from `../files/store`; `db` + `s3Object`
- Produces:
  ```ts
  export function objectRel(bucket: string, key: string): string; // `s3/${bucket}/${key}`

  export type ObjectInfo = {
    key: string;
    size: number;
    mtimeMs: number;
    md5: string;
  };

  export function putObject(
    bucket: string,
    key: string,
    stream: ReadableStream<Uint8Array>,
  ): Promise<ObjectInfo>;

  export function headObject(bucket: string, key: string): Promise<ObjectInfo>;

  export function openObjectStream(
    bucket: string,
    key: string,
  ): Promise<{ info: ObjectInfo; stream: ReadableStream<Uint8Array> }>;

  export function deleteObject(bucket: string, key: string): Promise<void>; // idempotent OK
  ```

- [ ] **Step 1: Write failing tests**

```ts
test('putObject then openObjectStream is byte-exact', async () => {
  const { createBucket, putObject, openObjectStream } = await import('./library');
  await createBucket('b');
  const body = new TextEncoder().encode('hello-s3');
  await putObject('b', 'a/hi.txt', new Blob([body]).stream());
  const { stream, info } = await openObjectStream('b', 'a/hi.txt');
  expect(info.size).toBe(body.byteLength);
  const got = new Uint8Array(await new Response(stream).arrayBuffer());
  expect(got).toEqual(body);
});

test('rejects key with .. segment', async () => {
  const { createBucket, putObject, BucketError } = await import('./library');
  await createBucket('b');
  await expect(putObject('b', 'a/../b', new Blob(['x']).stream())).rejects.toBeInstanceOf(
    BucketError,
  );
});
```

- [ ] **Step 2: Run — expect FAIL**

- [ ] **Step 3: Implement**

`assertObjectKey`: reject empty, `\0`, `.` / `..` segments (same as routes). Ensure bucket exists (or `mkdir` recursive for put like current PutObject). `putObject`: `writeUpload(objectRel(...), stream)` then upsert `s3Object` (path, bucket, key, size, mtimeMs, inode, md5). `headObject` / `openObjectStream`: `openStream` + md5 from DB (fallback hash or size-mtime etag material as info.md5 empty string only if missing — prefer DB). `deleteObject`: unlink file, delete `s3Object` row, prune empty parent dirs under the bucket (port `pruneEmptyParents` into library).

- [ ] **Step 4: Run — expect PASS**

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/s3/library.ts apps/server/src/s3/library.test.ts
git commit -m "feat(s3): Bucket Library object put/get/delete"
```

---

### Task 3: Bucket Library — listObjects, createPrefix, copyObject, moveObject

**Files:**
- Modify: `apps/server/src/s3/library.ts`
- Modify: `apps/server/src/s3/library.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type ListObjectsInput = {
    bucket: string;
    prefix?: string;
    delimiter?: string; // typically '/'
    continuationToken?: string;
    maxKeys?: number; // default 1000, cap 1000
  };

  export type ListObjectsResult = {
    objects: ObjectInfo[];
    prefixes: string[]; // common prefixes when delimiter set
    isTruncated: boolean;
    nextContinuationToken?: string;
  };

  export function listObjects(input: ListObjectsInput): Promise<ListObjectsResult>;

  /** Creates empty folder marker: key must be normalized to end with '/'. */
  export function createPrefix(bucket: string, prefix: string): Promise<ObjectInfo>;

  export function copyObject(
    srcBucket: string,
    srcKey: string,
    dstBucket: string,
    dstKey: string,
  ): Promise<ObjectInfo>;

  /** copyObject then deleteObject(src). If delete fails after copy, throw with message noting orphan copy. */
  export function moveObject(
    srcBucket: string,
    srcKey: string,
    dstBucket: string,
    dstKey: string,
  ): Promise<ObjectInfo>;
  ```

- [ ] **Step 1: Write failing tests**

```ts
test('listObjects with delimiter returns prefixes', async () => {
  const { createBucket, putObject, listObjects } = await import('./library');
  await createBucket('b');
  await putObject('b', 'docs/a.txt', new Blob(['a']).stream());
  const listed = await listObjects({ bucket: 'b', prefix: '', delimiter: '/' });
  expect(listed.prefixes).toContain('docs/');
  expect(listed.objects.some((o) => o.key === 'docs/a.txt')).toBe(false);
});

test('createPrefix shows as empty folder via delimiter', async () => {
  const { createBucket, createPrefix, listObjects } = await import('./library');
  await createBucket('b');
  await createPrefix('b', 'empty');
  const listed = await listObjects({ bucket: 'b', delimiter: '/' });
  expect(listed.prefixes).toContain('empty/');
});

test('copyObject and moveObject', async () => {
  const { createBucket, putObject, copyObject, moveObject, headObject, openObjectStream } =
    await import('./library');
  await createBucket('b1');
  await createBucket('b2');
  await putObject('b1', 'x.txt', new Blob(['z']).stream());
  await copyObject('b1', 'x.txt', 'b2', 'y.txt');
  expect((await headObject('b2', 'y.txt')).size).toBe(1);
  await moveObject('b2', 'y.txt', 'b2', 'z.txt');
  await expect(headObject('b2', 'y.txt')).rejects.toBeInstanceOf(/* BucketError not_found */);
  const { stream } = await openObjectStream('b2', 'z.txt');
  expect(await new Response(stream).text()).toBe('z');
});
```

- [ ] **Step 2: Run — expect FAIL**

- [ ] **Step 3: Implement**

Port `walkObjects` + delimiter pagination from `routes.ts` into library. `createPrefix`: normalize so key ends with `/` (if user passes `empty`, store `empty/`); `putObject` empty body. `copyObject`: read source bytes (or `copyFile` + md5 from DB like routes), write dest via durable rename, upsert `s3Object`. `moveObject`: copy then delete source.

- [ ] **Step 4: Run full library tests — PASS**

Run: `cd apps/server && bun test src/s3/library.test.ts`

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/s3/library.ts apps/server/src/s3/library.test.ts
git commit -m "feat(s3): Bucket Library list, prefix, copy, move"
```

---

### Task 4: Session console HTTP adapter

**Files:**
- Create: `apps/server/src/s3/console-routes.ts`
- Create: `apps/server/src/s3/console-routes.test.ts`
- Modify: `apps/server/src/index.ts` — `.use(s3ConsoleRoutes)`

**Interfaces:**
- Consumes: Bucket Library; `auth.api.getSession`
- Produces HTTP (JSON unless download stream):

| Method | Path | Behavior |
|---|---|---|
| GET | `/api/s3-console/buckets` | `{ buckets: BucketInfo[] }` |
| POST | `/api/s3-console/buckets` | body `{ name }` → create |
| DELETE | `/api/s3-console/buckets/:bucket` | delete empty |
| GET | `/api/s3-console/buckets/:bucket/objects` | query `prefix`, `delimiter` (default `/`), `continuationToken`, `maxKeys` |
| POST | `/api/s3-console/buckets/:bucket/objects` | multipart or raw upload: query/header `key` + body stream → put |
| GET | `/api/s3-console/buckets/:bucket/object` | query `key` → download stream |
| DELETE | `/api/s3-console/buckets/:bucket/object` | query `key` |
| POST | `/api/s3-console/buckets/:bucket/prefixes` | body `{ prefix }` → createPrefix |
| POST | `/api/s3-console/buckets/:bucket/copy` | body `{ srcKey, dstBucket, dstKey, move?: boolean }` |

Map `BucketError` → 400/404/409. No session → 401.

Upload: follow Files pattern if helpful (`multipart` field + `key` query). Prefer single `Request` body stream with `?key=` for simpler progress XHR (like Files uses XHR to `/api/files/upload`).

- [ ] **Step 1: Write adapter tests** (session helper from `access-keys.test.ts` / `files/routes.test.ts`)

```ts
test('401 without session', async () => {
  const res = await app.handle(new Request('http://localhost/api/s3-console/buckets'));
  expect(res.status).toBe(401);
});

test('create list delete bucket', async () => {
  // withCookie session…
  // POST buckets { name: 't' } → 200
  // GET buckets includes t
  // DELETE → 204
});
```

- [ ] **Step 2: Run — expect FAIL**

- [ ] **Step 3: Implement `console-routes.ts` + register in `index.ts`**

- [ ] **Step 4: Run — PASS**

Run: `cd apps/server && bun test src/s3/console-routes.test.ts`

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/s3/console-routes.ts apps/server/src/s3/console-routes.test.ts apps/server/src/index.ts
git commit -m "feat(s3): session JSON console routes"
```

---

### Task 5: Refactor SigV4 routes to call Bucket Library

**Files:**
- Modify: `apps/server/src/s3/routes.ts`
- Keep: multipart handler as-is (may still use local paths; do not rewrite multipart in this task unless it breaks)

**Interfaces:**
- Consumes: `listBuckets`, `createBucket`, `deleteBucket`, `listObjects`, `putObject`, `openObjectStream` / `headObject`, `deleteObject`, `copyObject`, `assertBucketName` from `./library`
- Produces: same XML/HTTP status codes as today for external clients

- [ ] **Step 1: Run existing S3 tests as baseline**

Run: `cd apps/server && bun test src/s3/routes.test.ts src/s3/compat.test.ts src/s3/multipart.test.ts`  
Expected: PASS before edits (record any skip for missing rclone).

- [ ] **Step 2: Replace inline FS bucket/object logic with library calls**

Keep SigV4 verification, XML encoding, Range handling wrapper (Range may stay in routes using `createFileStream`/`readRange` on path from library — if library only returns streams, implement Range in routes via `openStream(objectRel)` still OK **or** extend library with `openObject` returning path+stat for Range only; prefer not exporting abs paths — implement Range inside library as `openObjectRange(bucket, key, start, end)` if needed for this task).

Minimum: CreateBucket / DeleteBucket / ListBuckets / ListObjects(V2) / PutObject / DeleteObject / CopyObject / HeadObject / GetObject (full object) go through library. Multipart may keep writing parts under MULTIPART_ROOT and completing via existing code that writes final object — if CompleteMultipartUpload duplicates put logic, call `putObject` or shared finalize.

- [ ] **Step 3: Re-run S3 tests — PASS**

- [ ] **Step 4: Commit**

```bash
git add apps/server/src/s3/routes.ts apps/server/src/s3/library.ts
git commit -m "refactor(s3): SigV4 core ops use Bucket Library"
```

---

### Task 6: SPA nav + bucket list page

**Files:**
- Modify: `apps/web/src/components/layout/sidebar.tsx` — add `{ label: 'S3', to: '/s3', icon: /* Box or Database from lucide */ }` in PRIMARY (after Shared or before People)
- Create: `apps/web/src/routes/_app.s3.tsx`
- Create: `apps/web/src/lib/s3-console.ts` — `s3BucketsQuery`, create/delete mutations helpers using Eden `api`

**Interfaces:**
- Consumes: `/api/s3-console/buckets`
- Produces: route `/s3` under `_app`

- [ ] **Step 1: Add sidebar link + empty route shell that lists buckets via React Query**

```tsx
// _app.s3.tsx sketch
export const Route = createFileRoute('/_app/s3')({ component: S3BucketsPage });

function S3BucketsPage() {
  // useQuery → GET buckets
  // Create bucket modal (Input + Button)
  // Row: Link to `/s3/$bucket`, delete ConfirmDialog
  // Empty state: explain Files vs S3; link to `/s3/keys`
}
```

Wire Eden paths once server types export the new routes (restart/typecheck). If Eden path typing lags, use `api.api['s3-console'].buckets.get()` style consistent with existing `api.api.settings['s3-keys']`.

- [ ] **Step 2: Manual smoke in dev** — navigate, create, open link target (object page may 404 until Task 7)

- [ ] **Step 3: `bun run --filter @bunnyfile/web typecheck` + lint

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/layout/sidebar.tsx apps/web/src/routes/_app.s3.tsx apps/web/src/lib/s3-console.ts
git commit -m "feat(web): S3 nav and bucket list"
```

---

### Task 7: SPA object browser — list, upload, download, delete

**Files:**
- Create: `apps/web/src/routes/_app.s3.$bucket.tsx`
- Modify: `apps/web/src/lib/s3-console.ts`

**Interfaces:**
- Search/params: `prefix` as search param `?prefix=` (simpler than splat for v1)
- Consumes: list/objects, upload POST, download GET, delete

- [ ] **Step 1: Build list UI**

Breadcrumb from prefix segments; rows for `prefixes` (navigate) and `objects` (skip displaying marker keys that equal current folder-only markers if noisy — show folders from `prefixes`, files from `objects` where key does not end with `/`).

- [ ] **Step 2: Upload via XHR** to `/api/s3-console/buckets/${bucket}/objects?key=...` with credentials + progress toast (copy pattern from `_app.files.tsx` upload XHR).

- [ ] **Step 3: Download** — `<a href={...}>` or `window.location` to GET object endpoint with `key` query (cookies send). Delete with ConfirmDialog; multi-select optional — if multi-select, delete sequentially and toast per failure.

- [ ] **Step 4: typecheck + lint**

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/routes/_app.s3.\$bucket.tsx apps/web/src/lib/s3-console.ts
git commit -m "feat(web): S3 object browser upload/download/delete"
```

---

### Task 8: SPA — create folder, copy, move

**Files:**
- Modify: `apps/web/src/routes/_app.s3.$bucket.tsx`

- [ ] **Step 1: “New folder” modal** → POST prefixes with `{ prefix: currentPrefix + name }`

- [ ] **Step 2: Copy/Move dialog** — destination bucket select (from buckets query) + dest key; POST copy with `move: true|false`

- [ ] **Step 3: Manual checklist** — create folder, upload into it, copy to other bucket, move, delete

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/routes/_app.s3.\$bucket.tsx
git commit -m "feat(web): S3 folder create and copy/move"
```

---

### Task 9: Move access keys UI to `/s3/keys`

**Files:**
- Create: `apps/web/src/routes/_app.s3.keys.tsx` — move UI from Settings (create / secret-once modal / revoke / endpoint snippet for `/api/s3`)
- Modify: `apps/web/src/routes/_app.settings.tsx` — remove S3 Access Keys section; add one-line link “Manage S3 access keys” → `/s3/keys`
- Modify: `apps/web/src/routes/_app.s3.tsx` — secondary nav or button to Keys

Keep calling `api.api.settings['s3-keys']` (no server route move).

Include UI copy: **Any access key can read and write every bucket on this instance.**

- [ ] **Step 1: Implement keys page + Settings cleanup**

- [ ] **Step 2: typecheck + lint**

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/routes/_app.s3.keys.tsx apps/web/src/routes/_app.settings.tsx apps/web/src/routes/_app.s3.tsx
git commit -m "feat(web): move S3 access keys under /s3/keys"
```

---

### Task 10: Docs + PRODUCT capability line

**Files:**
- Modify: `docs/s3-compatibility.md` — short “Web console” section: `/s3`, session auth, global keys
- Modify: `PRODUCT.md` — add S3 console to confirmed capabilities
- Modify: `README.md` — one mention under features / S3

- [ ] **Step 1: Edit docs**

- [ ] **Step 2: Run full verify**

Run: `bun test && bun run typecheck && bun run lint`  
Expected: PASS (rclone compat may skip).

- [ ] **Step 3: Commit**

```bash
git add docs/s3-compatibility.md PRODUCT.md README.md
git commit -m "docs: document S3 web console"
```

---

## Spec coverage check

| Spec item | Task |
|---|---|
| Top-level S3 nav | 6 |
| Bucket list/create/delete | 1, 4, 6 |
| Object browse prefix breadcrumbs | 3, 7 |
| Upload/download/delete | 2, 4, 7 |
| Copy/move | 3, 4, 8 |
| Empty folders via markers | 3, 8 |
| Keys under `/s3/keys`, global-key copy | 9 |
| Session REST, no browser SigV4 | 4, 6–8 |
| Bucket Library depth + tests | 1–3 |
| SigV4 unchanged externally | 5 |
| Files never lists s3 | unchanged Files routes; docs 10 |
| No IAM | Global Constraints |
| Docs / PRODUCT | 10 |

## Placeholder / consistency notes

- Locked empty-folder mechanism: trailing-slash zero-byte markers via `createPrefix`.
- Locked console API prefix: `/api/s3-console`.
- Locked keys wire path: `/api/settings/s3-keys`.
- Eden client paths must match Elysia route tree after Task 4.
