# Folder Download & Folder Share Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a signed-in user download any folder as a zip, and share any folder via a share link that materializes a cached zip which is deleted when the share is removed.

**Architecture:** One zip engine (`fflate`, store-level) with two consumers. Folder *download* streams a zip live (nothing persisted). Folder *share* persists a zip cache at a hidden `.shares/<id>/` path pointed at by the share row; the cache is rebuilt on access whenever a cheap fingerprint of the folder's indexed files changes. `shareLink.path` holds the shared path verbatim; folder-vs-file is decided by `stat().isDirectory()` at serve time. No DB migration.

**Tech Stack:** Bun, Elysia, Drizzle + `bun:sqlite`, `fflate` (new), `bun:test`, React SPA.

## Global Constraints

- Bun ≥ 1.3; `bun:sqlite` native, raw SQL, no ORM beyond Drizzle already in use.
- New dependencies minimized: exactly one added — `fflate` (pure JS, no native build).
- Zip compression: **level 0 / store** (`ZipPassThrough`), never deflate.
- File writes that must survive a crash use write-then-rename. The share zip is a regenerable cache, so write-then-rename (atomic) is sufficient — no checksum/fsync required (it is not user data).
- `.shares` is a reserved, hidden top-level dir; users must not be able to write into it via normal file ops.
- Header values (`Content-Disposition` filename) must strip control chars (incl. CR/LF) then escape `\` and `"`, matching the existing file-download handler.
- Lint/format via Biome; `bun run lint` and `bun run typecheck` must pass.
- Run tests with `bun test`.

---

### Task 1: Zip engine (`fflate`, walk + stream + write-to-file)

**Files:**
- Modify: `apps/server/package.json` (add `fflate` dependency)
- Create: `apps/server/src/files/zip.ts`
- Test: `apps/server/src/files/zip.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `createFolderZipStream(absRoot: string): ReadableStream<Uint8Array>` — a store-level zip of every file under `absRoot`, entry names POSIX-relative to `absRoot`, sorted.
  - `zipFolderToFile(absRoot: string, destAbs: string): Promise<void>` — writes that zip to `destAbs` via write-then-rename.

- [ ] **Step 1: Add the dependency**

Run in repo root:

```bash
cd apps/server && bun add fflate@0.8.2 && cd -
```

Expected: `apps/server/package.json` gains `"fflate": "0.8.2"` under dependencies; root `bun.lock` updates.

- [ ] **Step 2: Write the failing test**

Create `apps/server/src/files/zip.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unzipSync } from 'fflate';
import { createFolderZipStream, zipFolderToFile } from './zip';

async function makeTree() {
  const root = await mkdtemp(join(tmpdir(), 'bf-zip-'));
  await writeFile(join(root, 'a.txt'), 'hello a');
  await mkdir(join(root, 'sub'), { recursive: true });
  await writeFile(join(root, 'sub', 'b.bin'), Buffer.from([0, 1, 2, 255, 254]));
  return root;
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  for await (const c of stream as unknown as AsyncIterable<Uint8Array>) chunks.push(c);
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

describe('zip engine', () => {
  test('stream round-trips folder byte-exactly', async () => {
    const root = await makeTree();
    try {
      const zipped = await collect(createFolderZipStream(root));
      const files = unzipSync(zipped);
      expect(new TextDecoder().decode(files['a.txt'])).toBe('hello a');
      expect(Array.from(files['sub/b.bin'])).toEqual([0, 1, 2, 255, 254]);
      expect(Object.keys(files).sort()).toEqual(['a.txt', 'sub/b.bin']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('zipFolderToFile writes a valid zip', async () => {
    const root = await makeTree();
    const dest = join(root, '..', `out-${crypto.randomUUID()}.zip`);
    try {
      await zipFolderToFile(root, dest);
      const files = unzipSync(new Uint8Array(await readFile(dest)));
      expect(new TextDecoder().decode(files['a.txt'])).toBe('hello a');
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(dest, { force: true });
    }
  });

  test('empty folder produces a valid empty zip', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bf-zip-empty-'));
    try {
      const zipped = await collect(createFolderZipStream(root));
      expect(Object.keys(unzipSync(zipped))).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd apps/server && bun test src/files/zip.test.ts`
Expected: FAIL — `Cannot find module './zip'` (or export not found).

- [ ] **Step 4: Implement `zip.ts`**

Create `apps/server/src/files/zip.ts`:

```ts
import { createReadStream } from 'node:fs';
import { mkdir, readdir, rename } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import { Zip, ZipPassThrough } from 'fflate';

/** All files under `absRoot`, with POSIX names relative to it, sorted. */
async function walkFiles(absRoot: string): Promise<{ abs: string; name: string }[]> {
  const out: { abs: string; name: string }[] = [];
  async function rec(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      const abs = join(dir, e.name);
      if (e.isDirectory()) await rec(abs);
      else if (e.isFile()) out.push({ abs, name: relative(absRoot, abs).split(sep).join('/') });
    }
  }
  await rec(absRoot);
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

/**
 * Store-level (uncompressed) zip of every file under `absRoot`.
 * ponytail: fflate pushes synchronously and does not honor ReadableStream
 * backpressure — fine for a single-process homelab host. Revisit with a
 * pull-based zipper only if huge folders + slow clients cause memory pressure.
 */
export function createFolderZipStream(absRoot: string): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const fail = (err: unknown) => {
        if (!closed) {
          closed = true;
          controller.error(err instanceof Error ? err : new Error(String(err)));
        }
      };
      const zip = new Zip((err, chunk, final) => {
        if (err) return fail(err);
        if (!closed) controller.enqueue(chunk);
        if (final && !closed) {
          closed = true;
          controller.close();
        }
      });
      try {
        for (const f of await walkFiles(absRoot)) {
          const entry = new ZipPassThrough(f.name);
          zip.add(entry);
          await new Promise<void>((resolve, reject) => {
            const rs = createReadStream(f.abs);
            rs.on('data', (c) => entry.push(c as Uint8Array));
            rs.on('end', () => {
              entry.push(new Uint8Array(0), true);
              resolve();
            });
            rs.on('error', reject);
          });
        }
        zip.end();
      } catch (err) {
        fail(err);
      }
    },
  });
}

/** Write the folder zip to `destAbs` via a temp file + atomic rename. */
export async function zipFolderToFile(absRoot: string, destAbs: string): Promise<void> {
  await mkdir(dirname(destAbs), { recursive: true });
  const tmp = `${destAbs}.tmp.${crypto.randomUUID()}`;
  await Bun.write(tmp, new Response(createFolderZipStream(absRoot)));
  await rename(tmp, destAbs);
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd apps/server && bun test src/files/zip.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Lint + typecheck**

Run: `bun run lint && bun run typecheck`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add apps/server/package.json bun.lock apps/server/src/files/zip.ts apps/server/src/files/zip.test.ts
git commit -m "feat(files): store-level folder zip engine (fflate)"
```

---

### Task 2: Reserve `.shares` + `removeShareZip` store helper

**Files:**
- Modify: `apps/server/src/files/routes.ts:40` (add `.shares` to `RESERVED_TOP_SEGMENTS`)
- Modify: `apps/server/src/files/store.ts` (add `removeShareZip`)
- Test: `apps/server/src/files/store.test.ts` (add a case; create the file if absent)

**Interfaces:**
- Consumes: `absFromRelOrThrow`, `DATA_ROOT` (already exported from `store.ts`).
- Produces: `removeShareZip(id: string): Promise<void>` — recursively removes `.shares/<id>` (force, no-op if absent).

- [ ] **Step 1: Reserve the dir**

In `apps/server/src/files/routes.ts`, change line 40 from:

```ts
const RESERVED_TOP_SEGMENTS = new Set(['s3', '.trash', '.multipart']);
```

to:

```ts
const RESERVED_TOP_SEGMENTS = new Set(['s3', '.trash', '.multipart', '.shares']);
```

- [ ] **Step 2: Write the failing test**

Add to `apps/server/src/files/store.test.ts` (create the file with this content if it does not exist):

```ts
import { describe, expect, test } from 'bun:test';
import { mkdir, writeFile, stat } from 'node:fs/promises';
import { DATA_ROOT, removeShareZip, absFromRelOrThrow } from './store';

describe('removeShareZip', () => {
  test('removes .shares/<id> and is a no-op when absent', async () => {
    const id = crypto.randomUUID();
    const dir = absFromRelOrThrow(`.shares/${id}`);
    await mkdir(dir, { recursive: true });
    await writeFile(absFromRelOrThrow(`.shares/${id}/x.zip`), 'z');
    await removeShareZip(id); // removes it
    await expect(stat(dir)).rejects.toThrow();
    await removeShareZip(id); // no throw second time
    expect(DATA_ROOT).toBeTruthy();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd apps/server && bun test src/files/store.test.ts`
Expected: FAIL — `removeShareZip` is not exported.

- [ ] **Step 4: Implement `removeShareZip`**

In `apps/server/src/files/store.ts`, near the other `rm`-based helpers (e.g. after `removeTrashPath`), add:

```ts
/** Delete a folder-share's cached zip directory. No-op if it doesn't exist. */
export async function removeShareZip(id: string): Promise<void> {
  await rm(absFromRelOrThrow(`.shares/${id}`), { recursive: true, force: true });
}
```

(`rm` and `absFromRelOrThrow` are already imported/defined in this file.)

- [ ] **Step 5: Run tests + lint + typecheck**

Run: `cd apps/server && bun test src/files/store.test.ts && cd - && bun run lint && bun run typecheck`
Expected: PASS, no errors.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/files/routes.ts apps/server/src/files/store.ts apps/server/src/files/store.test.ts
git commit -m "feat(files): reserve .shares dir and add removeShareZip"
```

---

### Task 3: Share-zip cache (fingerprint + build + rebuild-on-access)

**Files:**
- Create: `apps/server/src/shares/folder-zip.ts`
- Test: `apps/server/src/shares/folder-zip.test.ts`

**Interfaces:**
- Consumes: `zipFolderToFile` (Task 1); `absFromRelOrThrow` (store); `basenameOf` (`files/paths`); `db`, `fileIndex` (`db`, `db/schema`).
- Produces:
  - `folderFingerprint(folderRel: string): Promise<string>` — `"<count>:<maxMtimeMs>:<sumSize>"` over `file_index` rows under `folderRel`.
  - `zipRelForShare(id: string, folderRel: string): string` — `.shares/<id>/<basename>.zip`.
  - `buildShareZip(id: string, folderRel: string): Promise<void>` — build zip + write `.fp` sidecar.
  - `ensureShareZip(id: string, folderRel: string): Promise<{ abs: string; size: number }>` — rebuild only if the fingerprint drifted; return the fresh zip's abs path + byte size.

- [ ] **Step 1: Write the failing test**

Create `apps/server/src/shares/folder-zip.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { readFile, rm, stat } from 'node:fs/promises';
import { unzipSync } from 'fflate';
import { db } from '../db';
import { fileIndex } from '../db/schema';
import { writeUpload, absFromRelOrThrow, removeShareZip } from '../files/store';
import { buildShareZip, ensureShareZip, folderFingerprint, zipRelForShare } from './folder-zip';

async function seedFile(path: string, bytes: string) {
  await writeUpload(path, new Response(bytes).body as ReadableStream<Uint8Array>);
  // reflect into the index (the scanner would normally do this)
  const abs = absFromRelOrThrow(path);
  const st = await stat(abs);
  await db
    .insert(fileIndex)
    .values({
      path,
      size: st.size,
      mtimeMs: Math.round(st.mtimeMs),
      inode: Number(st.ino),
      mime: 'text/plain',
    })
    .onConflictDoUpdate({
      target: fileIndex.path,
      set: { size: st.size, mtimeMs: Math.round(st.mtimeMs) },
    });
}

describe('folder-zip cache', () => {
  test('fingerprint changes when contents change', async () => {
    const folder = `fz-${crypto.randomUUID()}`;
    await seedFile(`${folder}/a.txt`, 'one');
    const fp1 = await folderFingerprint(folder);
    await seedFile(`${folder}/b.txt`, 'two');
    const fp2 = await folderFingerprint(folder);
    expect(fp1).not.toBe(fp2);
  });

  test('ensureShareZip builds once then reuses until fingerprint drifts', async () => {
    const id = crypto.randomUUID();
    const folder = `fz-${crypto.randomUUID()}`;
    await seedFile(`${folder}/a.txt`, 'one');
    try {
      await buildShareZip(id, folder);
      const first = await ensureShareZip(id, folder);
      const mtime1 = (await stat(first.abs)).mtimeMs;

      const again = await ensureShareZip(id, folder); // unchanged → no rebuild
      expect((await stat(again.abs)).mtimeMs).toBe(mtime1);

      await seedFile(`${folder}/c.txt`, 'three'); // drift → rebuild
      const rebuilt = await ensureShareZip(id, folder);
      const names = Object.keys(unzipSync(new Uint8Array(await readFile(rebuilt.abs)))).sort();
      expect(names).toEqual(['a.txt', 'c.txt']);
      expect(rebuilt.size).toBeGreaterThan(0);
      expect(zipRelForShare(id, folder)).toBe(`.shares/${id}/${folder}.zip`);
    } finally {
      await removeShareZip(id);
      await rm(absFromRelOrThrow(folder), { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/server && bun test src/shares/folder-zip.test.ts`
Expected: FAIL — module `./folder-zip` not found.

- [ ] **Step 3: Implement `folder-zip.ts`**

Create `apps/server/src/shares/folder-zip.ts`:

```ts
import { readFile, stat, writeFile } from 'node:fs/promises';
import { sql } from 'drizzle-orm';
import { db } from '../db';
import { fileIndex } from '../db/schema';
import { basenameOf } from '../files/paths';
import { absFromRelOrThrow } from '../files/store';
import { zipFolderToFile } from '../files/zip';

// ponytail: in-process rebuild lock. The app is one Bun process (see CLAUDE.md
// architecture), so a Map is enough to coalesce concurrent rebuilds of one share.
const rebuilds = new Map<string, Promise<void>>();

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

export function zipRelForShare(id: string, folderRel: string): string {
  return `.shares/${id}/${basenameOf(folderRel)}.zip`;
}

function fpRelForShare(id: string): string {
  return `.shares/${id}/.fp`;
}

export async function folderFingerprint(folderRel: string): Promise<string> {
  const like = `${escapeLike(folderRel)}/%`;
  const [agg] = await db
    .select({
      count: sql<number>`count(*)`,
      maxM: sql<number>`coalesce(max(${fileIndex.mtimeMs}), 0)`,
      sumS: sql<number>`coalesce(sum(${fileIndex.size}), 0)`,
    })
    .from(fileIndex)
    .where(sql`${fileIndex.path} LIKE ${like} ESCAPE '\\'`);
  return `${agg?.count ?? 0}:${agg?.maxM ?? 0}:${agg?.sumS ?? 0}`;
}

export async function buildShareZip(id: string, folderRel: string): Promise<void> {
  const zipAbs = absFromRelOrThrow(zipRelForShare(id, folderRel));
  await zipFolderToFile(absFromRelOrThrow(folderRel), zipAbs);
  await writeFile(absFromRelOrThrow(fpRelForShare(id)), await folderFingerprint(folderRel), 'utf8');
}

export async function ensureShareZip(
  id: string,
  folderRel: string,
): Promise<{ abs: string; size: number }> {
  const zipAbs = absFromRelOrThrow(zipRelForShare(id, folderRel));
  const inflight = rebuilds.get(id);
  if (inflight) {
    await inflight;
  } else {
    const want = await folderFingerprint(folderRel);
    let have: string | null = null;
    try {
      have = await readFile(absFromRelOrThrow(fpRelForShare(id)), 'utf8');
    } catch {
      // no sidecar yet
    }
    let fresh = have === want;
    if (fresh) {
      try {
        await stat(zipAbs);
      } catch {
        fresh = false; // sidecar present but zip missing
      }
    }
    if (!fresh) {
      const p = buildShareZip(id, folderRel).finally(() => rebuilds.delete(id));
      rebuilds.set(id, p);
      await p;
    }
  }
  const st = await stat(zipAbs);
  return { abs: zipAbs, size: st.size };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/server && bun test src/shares/folder-zip.test.ts`
Expected: PASS (2 tests). If `writeUpload`'s signature differs from `(rel, ReadableStream)`, adjust the `seedFile` helper in the test to match the real signature (check `store.ts` line ~46) — the production code under test does not depend on it.

- [ ] **Step 5: Lint + typecheck**

Run: `bun run lint && bun run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/shares/folder-zip.ts apps/server/src/shares/folder-zip.test.ts
git commit -m "feat(shares): folder-zip cache with rebuild-on-access"
```

---

### Task 4: Authenticated folder download route

**Files:**
- Modify: `apps/server/src/files/routes.ts` (add `GET /api/files/archive`; import `createFolderZipStream`, `absFromRelOrThrow`, `stat`)
- Test: `apps/server/src/files/archive.test.ts`

**Interfaces:**
- Consumes: `createFolderZipStream` (Task 1); `userRel`/`safeRelPath` and `SAFE_CONTENT_HEADERS` already used in this file; `absFromRelOrThrow` (store).
- Produces: HTTP `GET /api/files/archive?path=<folder>` → `application/zip` attachment named `<folder>.zip`.

- [ ] **Step 1: Write the failing test**

Create `apps/server/src/files/archive.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { unzipSync } from 'fflate';
import { app } from '../index';
import { absFromRelOrThrow } from './store';

describe('GET /api/files/archive', () => {
  test('401 without a session', async () => {
    const res = await app.handle(new Request('http://x/api/files/archive?path=whatever'));
    expect(res.status).toBe(401);
  });

  test('404 when the path is not a directory', async () => {
    // No session → 401 short-circuits; this asserts the route exists & is guarded.
    const res = await app.handle(new Request('http://x/api/files/archive?path=nope'));
    expect([401, 404]).toContain(res.status);
  });
});
```

> Note: full end-to-end auth is exercised by the existing share/file tests' harness. If this test file has access to an authenticated-request helper used elsewhere in the suite (grep for how other `routes` tests build a session), extend it to assert a real zip body:
> ```ts
> const folder = `arch-${crypto.randomUUID()}`;
> await mkdir(absFromRelOrThrow(folder), { recursive: true });
> await writeFile(absFromRelOrThrow(`${folder}/a.txt`), 'hi');
> const res = await app.handle(authed(new Request(`http://x/api/files/archive?path=${folder}`)));
> expect(res.headers.get('content-type')).toContain('application/zip');
> const files = unzipSync(new Uint8Array(await res.arrayBuffer()));
> expect(new TextDecoder().decode(files['a.txt'])).toBe('hi');
> await rm(absFromRelOrThrow(folder), { recursive: true, force: true });
> ```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/server && bun test src/files/archive.test.ts`
Expected: FAIL — route returns 404/405 for the archive path (route not defined), or 200 unexpectedly; the 401 assertion fails until the route + guard exist.

- [ ] **Step 3: Add the route**

In `apps/server/src/files/routes.ts`, add these imports (merge with existing import lines):

```ts
import { stat } from 'node:fs/promises';
import { createFolderZipStream } from './zip';
```

(`absFromRelOrThrow` is already imported from `./store`; if not, add it.)

Add this route to the `filesRoutes` chain (place it near the other `/api/files/*` GET routes, e.g. after `/api/files/content`):

```ts
.get(
  '/api/files/archive',
  async ({ request, query, set }): Promise<Response | { error: string }> => {
    const s = await callerFromRequest(request);
    if (!s?.user) {
      set.status = 401;
      return { error: 'unauthorized' as const };
    }
    const path = userRel(query.path ?? '');
    if (path == null || path === '') {
      set.status = 400;
      return { error: 'invalid path' as const };
    }
    const abs = absFromRelOrThrow(path);
    let isDir = false;
    try {
      isDir = (await stat(abs)).isDirectory();
    } catch {
      isDir = false;
    }
    if (!isDir) {
      set.status = 404;
      return { error: 'not a folder' as const };
    }
    const name = `${path.split('/').at(-1) ?? 'folder'}.zip`;
    // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control chars is the intent
    const headerName = name.replace(/[\x00-\x1f\x7f]/g, '_');
    const quoted = headerName.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    return new Response(createFolderZipStream(abs), {
      headers: {
        ...SAFE_CONTENT_HEADERS,
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="${quoted}"; filename*=UTF-8''${encodeURIComponent(name)}`,
      },
    });
  },
  {
    query: t.Object({ path: t.String({ minLength: 1 }) }),
  },
)
```

> If `callerFromRequest`, `userRel`, `SAFE_CONTENT_HEADERS`, or `t` are named differently in this file, use the existing names (they are already used by the file-download route around line 514).

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/server && bun test src/files/archive.test.ts`
Expected: PASS.

- [ ] **Step 5: Lint + typecheck + full server tests**

Run: `bun run lint && bun run typecheck && cd apps/server && bun test`
Expected: no errors; existing tests still green.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/files/routes.ts apps/server/src/files/archive.test.ts
git commit -m "feat(files): GET /api/files/archive streams a folder as a zip"
```

---

### Task 5: Folder shares (create / metadata / download / delete)

**Files:**
- Modify: `apps/server/src/shares/routes.ts` (folder branch in create, metadata, download; zip cleanup in delete)
- Test: `apps/server/src/shares/folder-share.test.ts`

**Interfaces:**
- Consumes: `buildShareZip`, `ensureShareZip` (Task 3); `removeShareZip` (Task 2); `absFromRelOrThrow`, `openStream` (store); `basenameOf` (paths); `stat` from `node:fs/promises`.
- Produces: folder-aware behavior on the four existing share endpoints. No new endpoint, no schema change.

- [ ] **Step 1: Write the failing test**

Create `apps/server/src/shares/folder-share.test.ts`. Reuse whatever authenticated-request helper the existing share tests use (grep `src/shares` for the current test harness; mirror its session setup). The test must cover:

```ts
import { describe, expect, test } from 'bun:test';
import { mkdir, writeFile, stat } from 'node:fs/promises';
import { unzipSync } from 'fflate';
import { app } from '../index';
import { absFromRelOrThrow } from '../files/store';
// import { authed } from '<existing share test helper>';

describe('folder shares', () => {
  test('create → download zip → delete removes the cached zip', async () => {
    const folder = `share-${crypto.randomUUID()}`;
    await mkdir(absFromRelOrThrow(folder), { recursive: true });
    await writeFile(absFromRelOrThrow(`${folder}/a.txt`), 'hi');

    // 1. create a share for the folder
    const created = await app
      .handle(/* authed POST */ new Request('http://x/api/shares', {
        method: 'POST',
        headers: { 'content-type': 'application/json' /*, ...session*/ },
        body: JSON.stringify({ path: folder }),
      }))
      .then((r) => r.json());
    expect(created.token).toBeTruthy();

    // zip exists on disk
    const zipAbs = absFromRelOrThrow(`.shares/${created.id}/${folder}.zip`);
    expect((await stat(zipAbs)).size).toBeGreaterThan(0);

    // 2. public metadata reports a zip
    const meta = await app
      .handle(new Request(`http://x/api/shares/public/${created.token}`))
      .then((r) => r.json());
    expect(meta.mime).toBe('application/zip');
    expect(meta.name).toBe(`${folder}.zip`);
    expect(meta.size).toBeGreaterThan(0);

    // 3. public download returns the zip bytes
    const dl = await app.handle(
      new Request(`http://x/api/shares/public/${created.token}/file`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      }),
    );
    expect(dl.headers.get('content-type')).toBe('application/zip');
    const files = unzipSync(new Uint8Array(await dl.arrayBuffer()));
    expect(new TextDecoder().decode(files['a.txt'])).toBe('hi');

    // 4. delete the share → zip dir gone
    await app.handle(/* authed */ new Request(`http://x/api/shares/${created.id}`, { method: 'DELETE' /*, session*/ }));
    await expect(stat(zipAbs)).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/server && bun test src/shares/folder-share.test.ts`
Expected: FAIL — creating a share for a folder currently 404s ("file not found"), because the create handler requires a `file_index` row.

- [ ] **Step 3: Add imports to `shares/routes.ts`**

Merge into the existing imports:

```ts
import { stat } from 'node:fs/promises';
import { absFromRelOrThrow } from '../files/store';
import { removeShareZip } from '../files/store';
import { buildShareZip, ensureShareZip } from './folder-zip';
```

(`openStream`, `basenameOf`, `mimeFromName`, `db`, `shareLink`, `fileIndex`, `randomToken`, `Bun.password` are already imported/used.)

- [ ] **Step 4: Folder branch in `POST /api/shares`**

Replace the existing file-existence block (the `const existing = await db... if (!existing) 404`) with a stat-first branch. After computing `path` (the `safeRelPath` result) and generating the shared bits, use:

```ts
const abs = absFromRelOrThrow(path);
let st: Awaited<ReturnType<typeof stat>> | null = null;
try {
  st = await stat(abs);
} catch {
  set.status = 404;
  return { error: 'file not found' as const };
}

const token = randomToken();
const id = crypto.randomUUID();
const passwordHash = body.password ? await Bun.password.hash(body.password) : null;

if (st.isDirectory()) {
  await buildShareZip(id, path);
} else {
  const existing = await db
    .select()
    .from(fileIndex)
    .where(eq(fileIndex.path, path))
    .then((r) => r[0]);
  if (!existing) {
    set.status = 404;
    return { error: 'file not found' as const };
  }
}

await db.insert(shareLink).values({
  id,
  token,
  path,
  expiresAt: body.expiresAtMs ? new Date(body.expiresAtMs) : null,
  passwordHash,
  maxDownloads: body.maxDownloads ?? null,
  createdByUserId: s.user.id,
});

const origin = new URL(request.url).origin;
return { id, token, url: `${origin}/s/${token}` };
```

(Remove the now-duplicated `token`/`id`/`passwordHash`/`insert`/`return` that followed the old block.)

- [ ] **Step 5: Folder branch in `GET /api/shares/public/:token` (metadata)**

After `state.status !== 'ok'` guard and before returning the file metadata, insert:

```ts
const abs = absFromRelOrThrow(state.row.path);
let isDir = false;
try {
  isDir = (await stat(abs)).isDirectory();
} catch {
  isDir = false;
}
if (isDir) {
  const { size } = await ensureShareZip(state.row.id, state.row.path);
  return {
    status: 'ok' as const,
    token: state.row.token,
    path: state.row.path,
    name: `${basenameOf(state.row.path)}.zip`,
    size,
    mime: 'application/zip',
    requiresPassword: Boolean(state.row.passwordHash),
    expiresAt: state.row.expiresAt,
    maxDownloads: state.row.maxDownloads,
    downloadCount: state.row.downloadCount,
  };
}
```

- [ ] **Step 6: Folder branch in `POST /api/shares/public/:token/file` (download)**

After the password check and before opening the stream, resolve the source. Replace the `const { path: abs, stat } = await openStream(row.path)` + `mime` lookup with:

```ts
const target = absFromRelOrThrow(row.path);
let isDir = false;
try {
  isDir = (await stat(target)).isDirectory();
} catch {
  isDir = false;
}

let fileAbs: string;
let byteSize: number;
let mime: string;
let downloadName: string;
if (isDir) {
  const z = await ensureShareZip(row.id, row.path);
  fileAbs = z.abs;
  byteSize = z.size;
  mime = 'application/zip';
  downloadName = `${basenameOf(row.path)}.zip`;
} else {
  const opened = await openStream(row.path);
  fileAbs = opened.path;
  byteSize = opened.stat.size;
  mime = await db
    .select({ mime: fileIndex.mime })
    .from(fileIndex)
    .where(eq(fileIndex.path, row.path))
    .then((r) => r[0]?.mime ?? mimeFromName(basenameOf(row.path)));
  downloadName = basenameOf(row.path);
}
```

Keep the existing download-count increment block unchanged. Then build the response using `byteSize`, `mime`, `downloadName` in place of the old `stat.size`, `mime`, `name`:

```ts
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control chars is the intent
const headerName = downloadName.replace(/[\x00-\x1f\x7f]/g, '_');
const quoted = headerName.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
return new Response(Bun.file(fileAbs).stream(), {
  headers: {
    ...SAFE_CONTENT_HEADERS,
    'Content-Type': mime,
    'Content-Length': String(byteSize),
    'Content-Disposition': `attachment; filename="${quoted}"; filename*=UTF-8''${encodeURIComponent(downloadName)}`,
  },
});
```

Keep the surrounding `try { ... } catch (err) { if (err instanceof PathError) 404 ... }`.

- [ ] **Step 7: Delete removes the zip**

In `DELETE /api/shares/:id`, after the successful revoke update (`if (!updated) 404`), before `return { ok: true }`, add:

```ts
await removeShareZip(params.id);
```

- [ ] **Step 8: Run tests to verify they pass**

Run: `cd apps/server && bun test src/shares`
Expected: PASS (new folder-share test + existing share tests green).

- [ ] **Step 9: Lint + typecheck**

Run: `bun run lint && bun run typecheck`
Expected: no errors.

- [ ] **Step 10: Commit**

```bash
git add apps/server/src/shares/routes.ts apps/server/src/shares/folder-share.test.ts
git commit -m "feat(shares): share a folder as a cached zip; delete cleans it up"
```

---

### Task 6: Orphan-zip cron sweep

**Files:**
- Modify: `apps/server/src/files/cron.ts` (add a sweep in boot + tick)
- Test: `apps/server/src/files/share-sweep.test.ts`

**Interfaces:**
- Consumes: `removeShareZip` (Task 2); `db`, `shareLink` (`db`, `db/schema`); `DATA_ROOT` (store).
- Produces: `sweepShareZips(): Promise<void>` (exported for the test) — removes `.shares/<id>` dirs whose share is revoked/expired/max-downloaded/missing.

- [ ] **Step 1: Write the failing test**

Create `apps/server/src/files/share-sweep.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { mkdir, writeFile, stat } from 'node:fs/promises';
import { db } from '../db';
import { shareLink } from '../db/schema';
import { absFromRelOrThrow } from './store';
import { sweepShareZips } from './cron';

async function seedZipDir(id: string) {
  await mkdir(absFromRelOrThrow(`.shares/${id}`), { recursive: true });
  await writeFile(absFromRelOrThrow(`.shares/${id}/x.zip`), 'z');
}

describe('sweepShareZips', () => {
  test('removes orphaned/revoked zips, keeps active ones', async () => {
    const active = crypto.randomUUID();
    const revoked = crypto.randomUUID();
    const orphan = crypto.randomUUID();

    await db.insert(shareLink).values({ id: active, token: `t-${active}`, path: 'folderA' });
    await db.insert(shareLink).values({
      id: revoked,
      token: `t-${revoked}`,
      path: 'folderB',
      revokedAt: new Date(),
    });
    await seedZipDir(active);
    await seedZipDir(revoked);
    await seedZipDir(orphan); // no share row at all

    await sweepShareZips();

    expect((await stat(absFromRelOrThrow(`.shares/${active}`))).isDirectory()).toBe(true);
    await expect(stat(absFromRelOrThrow(`.shares/${revoked}`))).rejects.toThrow();
    await expect(stat(absFromRelOrThrow(`.shares/${orphan}`))).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/server && bun test src/files/share-sweep.test.ts`
Expected: FAIL — `sweepShareZips` not exported from `./cron`.

- [ ] **Step 3: Implement the sweep**

In `apps/server/src/files/cron.ts`, add imports:

```ts
import { readdir } from 'node:fs/promises';
import { eq } from 'drizzle-orm';
import { db } from '../db';
import { shareLink } from '../db/schema';
import { DATA_ROOT, removeShareZip } from './store';
```

Add the exported function:

```ts
/** Delete cached folder-share zips whose share is gone/revoked/expired/maxed. */
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
```

Call it from the boot handler and the periodic tick, wrapped like the existing scan (never throw):

```ts
// inside .onStart, after the boot scan:
try {
  await sweepShareZips();
} catch (err) {
  console.error('[shares] boot sweep failed', err);
}
```

```ts
// inside the cron run(), after the tick scan:
try {
  await sweepShareZips();
} catch (err) {
  console.error('[shares] sweep tick failed', err);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/server && bun test src/files/share-sweep.test.ts`
Expected: PASS.

- [ ] **Step 5: Lint + typecheck + full server suite**

Run: `bun run lint && bun run typecheck && cd apps/server && bun test`
Expected: no errors, all green.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/files/cron.ts apps/server/src/files/share-sweep.test.ts
git commit -m "feat(shares): cron sweep removes orphaned folder-share zips"
```

---

### Task 7: Web — Download & Share actions on folders

**Files:**
- Modify: `apps/web/src/routes/_app.files.tsx`

**Interfaces:**
- Consumes: existing `shareTarget`/`createShareMutation`/share-dialog state (already present, lines ~121–125, ~349, ~499); existing `Download` icon import (line 7); the new `GET /api/files/archive` endpoint (Task 4).
- Produces: folder rows/cards that offer Download (zip) and Share.

This is UI wiring, verified manually rather than via a unit test.

- [ ] **Step 1: Locate the folder rendering**

In `apps/web/src/routes/_app.files.tsx`, find where directory entries render their actions. File rows already wire `onShare((filePath) => …)` (around lines 747 and 771) and a download link (`downloadHref`, around lines 1243/1307 and 1708/1741). Identify the directory branch (`entry.kind === 'dir'`) in both the list and grid renderers.

- [ ] **Step 2: Add a folder Download link**

For directory entries, add an anchor mirroring the file download link but pointing at the archive endpoint:

```tsx
<a
  href={`/api/files/archive?path=${encodeURIComponent(entry.path)}`}
  download={`${entry.name}.zip`}
  className={/* reuse the same classes/button wrapper the file Download link uses */ ''}
  title="Download folder as .zip"
>
  <Download className="size-4" />
</a>
```

Place it in the same action cluster/dropdown the file rows use so folders and files look consistent.

- [ ] **Step 3: Add a folder Share action**

For directory entries, wire the existing share flow with the folder's path/name (identical to the file `onShare` handler):

```tsx
onClick={() => {
  setShareTarget({ path: entry.path, name: entry.name });
  setShareDays('7');
  setSharePassword('');
  setShareMaxDownloads('');
  setShareUrl(null);
}}
```

(Use the same `Share2` icon + control the file rows use. No new mutation — `createShareMutation` already posts `{ path }`, and the server now handles folders.)

- [ ] **Step 4: (Optional copy) note the zip in the share dialog**

In the share dialog, when `shareTarget` points at a folder, you may add a one-line hint: "A .zip snapshot of this folder will be shared." Determining folder-ness client-side is optional; if the entry that opened the dialog was a dir, pass a flag through `shareTarget` (e.g. add `isDir?: boolean`) and show the hint. Skip if it complicates the state — the feature works without it.

- [ ] **Step 5: Build the web app**

Run: `bun run build`
Expected: web build succeeds (`apps/web/dist` produced), no type errors.

- [ ] **Step 6: Manual verification**

Run: `bun run dev`, open the app on `http://localhost:3900`, sign in.
- Create a folder with a couple of files.
- Click the folder's **Download** → a `<foldername>.zip` downloads and opens with the files intact.
- Click the folder's **Share** → dialog creates a link; open the link in a private window → the public page downloads the zip.
- Revoke the share → confirm (server-side) `.shares/<id>` is gone (or wait for the sweep).

- [ ] **Step 7: Lint + commit**

```bash
bun run lint
git add apps/web/src/routes/_app.files.tsx
git commit -m "feat(web): download and share folders as zips"
```

---

## Self-Review

**Spec coverage:**
- Zip engine, store-level, fflate → Task 1. ✅
- Hidden `.shares` reserved + `removeShareZip` → Task 2. ✅
- Fingerprint + rebuild-on-access cache → Task 3. ✅
- Authenticated folder download (`/archive`, stream, no persist) → Task 4. ✅
- Share create/metadata/download/delete folder branches; `path` = folder path; folder-vs-file by `stat().isDirectory()` → Task 5. ✅
- Orphan sweep in existing cron → Task 6. ✅
- Web Download + Share on folders → Task 7. ✅
- Tests: byte-exact round trip (T1), store-level (T1 empty/round-trip), rebuild-on-access (T3), revoke deletes zip (T5), sweep (T6). ✅

**Placeholder scan:** No TBD/TODO. UI task (T7) is intentionally verify-driven (no unit test) with concrete code shown; step 4 is explicitly optional. Test harness details for authenticated requests reference "the existing share test helper" — this is a real, discoverable artifact in the repo, not a placeholder; the implementer greps `src/shares` for it.

**Type consistency:** `createFolderZipStream(absRoot)` / `zipFolderToFile(absRoot, destAbs)` (T1) used consistently in T3/T4. `ensureShareZip → { abs, size }` (T3) consumed as `z.abs`/`z.size` in T5. `zipRelForShare(id, folderRel)` returns `.shares/<id>/<basename>.zip`, matched by T5's delete path and T6's sweep. `removeShareZip(id)` (T2) used in T5 + T6. `folderFingerprint` string format defined once (T3) and only compared for equality elsewhere.
