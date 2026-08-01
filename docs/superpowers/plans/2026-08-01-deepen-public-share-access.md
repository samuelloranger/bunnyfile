# Deepen Public Share Access Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move public-share policy (inspect / verify / beginDownload, download leases, folder-zip cache) out of the HTTP adapter into a deep **Public Share Access** module, then thin `shares/routes.ts` to auth, rate-limit, and status-code mapping only.

**Architecture:** One module owns “may this token download?” and “here are the bytes.” Folder-share zip fingerprint/ensure/invalidate is absorbed behind that module (not deepened as its own public seam). Generic `zipFolderToFile` / `createFolderZipStream` stay byte-packing helpers. Rate limiting stays on the HTTP adapter. External URLs and response shapes stay stable.

**Tech Stack:** Bun ≥ 1.3, Elysia, Drizzle + `bun:sqlite`, `bun:test`, existing `attachDownloadLease`, Storage (`openStream` / `createFileStream` / `removeShareZip`).

**Specs:**
- `docs/superpowers/specs/2026-08-01-deepen-public-share-access.md`
- `docs/superpowers/specs/2026-08-01-absorb-folder-share-zip.md` (companion — implement in this plan, not a separate epic)

## Global Constraints

- No new share product features, no public-share UI redesign, no schema migrations.
- External contracts stay stable: `/api/shares`, `/api/shares/public/:token`, `/verify`, `/file` (GET+POST), `/s/:token`.
- Locked shares must not leak `path` / `name` / `size` / `mime` until password verified.
- Passwords only via POST body — never query params.
- Download-count lease semantics unchanged: maxed shares reserve a slot before stream; cancel releases; unlimited shares bump on complete only.
- Folder-zip cache policy is owned by Public Share Access; do **not** introduce a new public module named after folder-zip.
- Generic zipper (`apps/server/src/files/zip.ts`) stays free of share policy (no fingerprint, no share-id layout).
- Prefer not widening abs-path leakage from the Access interface (internals may still resolve abs paths until Storage seam lands).
- Authenticated “download folder as zip” for logged-in users stays on the streaming zipper path — do not force it through share cache.
- Lint/format: Biome. Verify with `bun test`, `bun run typecheck`, `bun run lint`.
- No new runtime dependencies.

## File map

| Path | Responsibility |
|---|---|
| `apps/server/src/shares/access.ts` | **Create** — Public Share Access: `inspect`, `verify`, `beginDownload`, `prepareFolderArtifact`, `invalidateFolderArtifact` |
| `apps/server/src/shares/access.test.ts` | **Create** — module-seam tests (policy + lease + folder artifact) |
| `apps/server/src/shares/folder-zip.ts` | **Privatize** — keep as Access-only implementation detail (or fold into `access.ts`); routes must not import it |
| `apps/server/src/shares/folder-zip.test.ts` | **Retarget / shrink** — pure pack leftovers only, or delete after coverage moves to `access.test.ts` |
| `apps/server/src/shares/download-lease.ts` | Unchanged helper; called from Access, not routes |
| `apps/server/src/shares/routes.ts` | Thin adapter: session, `userRel`, rate-limit, map Access results → HTTP |
| `apps/server/src/shares/routes.test.ts` | Keep as adapter smoke (locked meta, reserved path, GET password rejected) |
| `apps/server/src/shares/folder-share.test.ts` | Keep as HTTP smoke for create → zip meta → download → revoke |
| `apps/server/src/files/zip.ts` | Unchanged generic zipper |
| `apps/server/src/files/store.ts` | `removeShareZip` remains Storage helper; Access calls it |

---

### Task 1: Public Share Access — types + `inspect`

**Files:**
- Create: `apps/server/src/shares/access.ts`
- Create: `apps/server/src/shares/access.test.ts`

**Interfaces:**
- Consumes: `db`, `shareLink` from `../db` / `../db/schema`
- Produces:
  ```ts
  export type ShareUnavailableReason =
    | 'not_found'
    | 'expired'
    | 'revoked'
    | 'max_downloads';

  export type SharePublicMeta = {
    token: string;
    path: string;
    name: string;
    size: number | null;
    mime: string;
    requiresPassword: boolean;
    expiresAt: Date | null;
    maxDownloads: number | null;
    downloadCount: number;
  };

  export type InspectResult =
    | {
        status: 'unavailable';
        reason: ShareUnavailableReason;
        message: string;
      }
    | {
        status: 'locked';
        requiresPassword: true;
        expiresAt: Date | null;
        maxDownloads: number | null;
        downloadCount: number;
      }
    | ({ status: 'unlocked'; requiresPassword: false } & SharePublicMeta);

  export function statusMessage(reason: ShareUnavailableReason): string;
  export async function inspect(token: string): Promise<InspectResult>;
  ```
- For Task 1 only: unlocked `inspect` may return stub meta for open file shares (size/mime from index) **without** folder-zip yet — folder shares can return placeholder size `null` until Task 4, **or** call existing `ensureShareZip` temporarily. Prefer calling existing `ensureShareZip` so HTTP smoke stays green when routes switch later.

- [ ] **Step 1: Write failing `inspect` tests**

Create `apps/server/src/shares/access.test.ts` with the same env/bootstrap pattern as `routes.test.ts` (temp `DB_PATH` / `DATA_DIR`, `BETTER_AUTH_SECRET`, `runMigrations`, seed a user + file via `writeUpload` + `fileIndex`). Insert share rows directly with `db.insert(shareLink)` for unavailable cases.

```ts
import { beforeAll, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const testRoot = await mkdtemp(join(tmpdir(), 'bunnyfile-share-access-'));
process.env.DB_PATH = join(testRoot, 'test.sqlite');
process.env.DATA_DIR = join(testRoot, 'data');
process.env.BETTER_AUTH_SECRET = 'test-secret';

const [{ runMigrations }, { db }, { fileIndex, shareLink, user }, { writeUpload }, access] =
  await Promise.all([
    import('../db/migrate'),
    import('../db'),
    import('../db/schema'),
    import('../files/store'),
    import('./access'),
  ]);

function streamFromText(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(c) {
      c.enqueue(new TextEncoder().encode(text));
      c.close();
    },
  });
}

describe('Public Share Access — inspect', () => {
  beforeAll(async () => {
    await mkdir(process.env.DATA_DIR!, { recursive: true });
    runMigrations();
    await db.insert(user).values({
      id: 'access-user',
      name: 'Access User',
      email: 'access@example.com',
      emailVerified: true,
      role: 'admin',
    });
    const info = await writeUpload('hello.txt', streamFromText('hello world'));
    await db.insert(fileIndex).values({
      path: 'hello.txt',
      size: info.size,
      mtimeMs: info.mtimeMs,
      inode: info.inode,
      sha256: info.sha256,
      mime: 'text/plain',
      uploadedByUserId: 'access-user',
    });
  });

  test('not_found for unknown token', async () => {
    const r = await access.inspect('missing-token');
    expect(r.status).toBe('unavailable');
    if (r.status === 'unavailable') expect(r.reason).toBe('not_found');
  });

  test('locked omits path/name/size/mime', async () => {
    const token = crypto.randomUUID();
    await db.insert(shareLink).values({
      id: crypto.randomUUID(),
      token,
      path: 'hello.txt',
      passwordHash: await Bun.password.hash('secret'),
      createdByUserId: 'access-user',
    });
    const r = await access.inspect(token);
    expect(r.status).toBe('locked');
    if (r.status === 'locked') {
      expect(r.requiresPassword).toBe(true);
      expect('path' in r).toBe(false);
      expect('name' in r).toBe(false);
      expect('size' in r).toBe(false);
      expect('mime' in r).toBe(false);
    }
  });

  test('unlocked open share returns file meta', async () => {
    const token = crypto.randomUUID();
    await db.insert(shareLink).values({
      id: crypto.randomUUID(),
      token,
      path: 'hello.txt',
      createdByUserId: 'access-user',
    });
    const r = await access.inspect(token);
    expect(r.status).toBe('unlocked');
    if (r.status === 'unlocked') {
      expect(r.name).toBe('hello.txt');
      expect(r.size).toBeGreaterThan(0);
      expect(r.mime).toBe('text/plain');
      expect(r.requiresPassword).toBe(false);
    }
  });

  test('expired / revoked / max_downloads are unavailable', async () => {
    const expiredToken = crypto.randomUUID();
    await db.insert(shareLink).values({
      id: crypto.randomUUID(),
      token: expiredToken,
      path: 'hello.txt',
      expiresAt: new Date(Date.now() - 60_000),
      createdByUserId: 'access-user',
    });
    expect((await access.inspect(expiredToken)).status).toBe('unavailable');

    const revokedToken = crypto.randomUUID();
    await db.insert(shareLink).values({
      id: crypto.randomUUID(),
      token: revokedToken,
      path: 'hello.txt',
      revokedAt: new Date(),
      createdByUserId: 'access-user',
    });
    const revoked = await access.inspect(revokedToken);
    expect(revoked.status).toBe('unavailable');
    if (revoked.status === 'unavailable') expect(revoked.reason).toBe('revoked');

    const maxedToken = crypto.randomUUID();
    await db.insert(shareLink).values({
      id: crypto.randomUUID(),
      token: maxedToken,
      path: 'hello.txt',
      maxDownloads: 1,
      downloadCount: 1,
      createdByUserId: 'access-user',
    });
    const maxed = await access.inspect(maxedToken);
    expect(maxed.status).toBe('unavailable');
    if (maxed.status === 'unavailable') expect(maxed.reason).toBe('max_downloads');
  });
});
```

- [ ] **Step 2: Run tests — expect fail (module missing)**

```bash
bun test apps/server/src/shares/access.test.ts
```

Expected: fail resolving `./access`.

- [ ] **Step 3: Implement `inspect` + helpers in `access.ts`**

Move `getShareState` / `statusToMessage` / unlocked-meta building for **files** out of `routes.ts` into `access.ts`. Reuse existing messages verbatim:

- expired → `This share link has expired.`
- revoked → `This share link has been revoked.`
- max_downloads → `This share link reached its download limit.`
- not_found → `This share link does not exist.`

For unlocked file meta, mirror `buildUnlockedPublicMeta` file branch (index row + `mimeFromName` fallback). For directories, temporarily import `ensureShareZip` from `./folder-zip` so unlocked folder inspect returns zip name/size/mime — full absorb in Task 4.

Do **not** change `routes.ts` yet.

- [ ] **Step 4: Run tests — expect pass**

```bash
bun test apps/server/src/shares/access.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/shares/access.ts apps/server/src/shares/access.test.ts
git commit -m "$(cat <<'EOF'
feat(shares): add Public Share Access inspect

EOF
)"
```

---

### Task 2: `verify` — password gate + unlocked meta

**Files:**
- Modify: `apps/server/src/shares/access.ts`
- Modify: `apps/server/src/shares/access.test.ts`

**Interfaces:**
- Consumes: `inspect` helpers / share row lookup from Task 1; `Bun.password.verify`
- Produces:
  ```ts
  export type VerifyResult =
    | ({ ok: true } & SharePublicMeta)
    | { ok: false; error: 'unavailable'; reason: ShareUnavailableReason; message: string }
    | { ok: false; error: 'unauthorized'; message: string };

  export async function verify(
    token: string,
    password?: string | null,
  ): Promise<VerifyResult>;
  ```

- [ ] **Step 1: Write failing `verify` tests**

Append to `access.test.ts`:

```ts
describe('Public Share Access — verify', () => {
  test('wrong password → unauthorized', async () => {
    const token = crypto.randomUUID();
    await db.insert(shareLink).values({
      id: crypto.randomUUID(),
      token,
      path: 'hello.txt',
      passwordHash: await Bun.password.hash('secret'),
      createdByUserId: 'access-user',
    });
    const r = await access.verify(token, 'nope');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('unauthorized');
  });

  test('correct password → unlocked meta', async () => {
    const token = crypto.randomUUID();
    await db.insert(shareLink).values({
      id: crypto.randomUUID(),
      token,
      path: 'hello.txt',
      passwordHash: await Bun.password.hash('secret'),
      createdByUserId: 'access-user',
    });
    const r = await access.verify(token, 'secret');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.name).toBe('hello.txt');
      expect(r.requiresPassword).toBe(true);
      expect(r.size).toBeGreaterThan(0);
    }
  });

  test('open share verify without password still unlocks', async () => {
    const token = crypto.randomUUID();
    await db.insert(shareLink).values({
      id: crypto.randomUUID(),
      token,
      path: 'hello.txt',
      createdByUserId: 'access-user',
    });
    const r = await access.verify(token);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.requiresPassword).toBe(false);
  });

  test('revoked share verify → unavailable', async () => {
    const token = crypto.randomUUID();
    await db.insert(shareLink).values({
      id: crypto.randomUUID(),
      token,
      path: 'hello.txt',
      revokedAt: new Date(),
      createdByUserId: 'access-user',
    });
    const r = await access.verify(token, 'secret');
    expect(r.ok).toBe(false);
    if (!r.ok && r.error === 'unavailable') expect(r.reason).toBe('revoked');
  });
});
```

- [ ] **Step 2: Run tests — expect fail**

```bash
bun test apps/server/src/shares/access.test.ts
```

Expected: fail on missing `verify` export.

- [ ] **Step 3: Implement `verify`**

```ts
export async function verify(
  token: string,
  password?: string | null,
): Promise<VerifyResult> {
  const state = await getShareState(token);
  if (state.status !== 'ok') {
    return {
      ok: false,
      error: 'unavailable',
      reason: state.status,
      message: statusMessage(state.status),
    };
  }
  const row = state.row;
  if (row.passwordHash) {
    if (!password || !(await Bun.password.verify(password, row.passwordHash))) {
      return {
        ok: false,
        error: 'unauthorized',
        message: 'Password required or invalid.',
      };
    }
  }
  const meta = await buildUnlockedPublicMeta(row);
  return { ok: true, ...meta };
}
```

Keep `buildUnlockedPublicMeta` private inside `access.ts` (same behavior as today’s routes helper).

- [ ] **Step 4: Run tests — expect pass**

```bash
bun test apps/server/src/shares/access.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/shares/access.ts apps/server/src/shares/access.test.ts
git commit -m "$(cat <<'EOF'
feat(shares): add Public Share Access verify

EOF
)"
```

---

### Task 3: `beginDownload` for file shares + lease semantics

**Files:**
- Modify: `apps/server/src/shares/access.ts`
- Modify: `apps/server/src/shares/access.test.ts`

**Interfaces:**
- Consumes: `openStream`, `createFileStream`, `PathError` from `../files/store`; `attachDownloadLease` from `./download-lease`; `SAFE_CONTENT_HEADERS` from `../files/routes` (or duplicate the two header constants locally to avoid coupling — prefer import if already used by shares)
- Produces:
  ```ts
  export type BeginDownloadResult =
    | {
        ok: true;
        stream: ReadableStream<Uint8Array>;
        headers: Record<string, string>;
      }
    | { ok: false; error: 'unavailable'; reason: ShareUnavailableReason; message: string }
    | { ok: false; error: 'unauthorized'; message: string }
    | { ok: false; error: 'missing'; message: string };

  export async function beginDownload(
    token: string,
    password?: string | null,
  ): Promise<BeginDownloadResult>;
  ```

Lease rules (copy from current `downloadHandler`):
1. Authorize (same as verify).
2. Resolve file bytes via `openStream(row.path)` (file-only in this task; folders → Task 4).
3. If `maxDownloads != null`: optimistic `downloadCount + 1` with `downloadCount < maxDownloads`; if zero rows → unavailable `max_downloads`.
4. Wrap stream with `attachDownloadLease`:
   - unlimited (`maxDownloads == null`): `onComplete` increments count; `onCancel` no-op for count.
   - limited: slot already taken; `onCancel` decrements with `max(count - 1, 0)`; `onComplete` no-op for count.
5. Return headers including `SAFE_CONTENT_HEADERS`, `Content-Type`, `Content-Length`, `Content-Disposition` (same quoting/encoding as routes today).

- [ ] **Step 1: Write failing download + lease tests**

```ts
describe('Public Share Access — beginDownload (file)', () => {
  test('downloads open file bytes', async () => {
    const token = crypto.randomUUID();
    await db.insert(shareLink).values({
      id: crypto.randomUUID(),
      token,
      path: 'hello.txt',
      createdByUserId: 'access-user',
    });
    const r = await access.beginDownload(token);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.headers['Content-Type']).toBe('text/plain');
    const text = await new Response(r.stream).text();
    expect(text).toBe('hello world');
  });

  test('wrong password → unauthorized', async () => {
    const token = crypto.randomUUID();
    await db.insert(shareLink).values({
      id: crypto.randomUUID(),
      token,
      path: 'hello.txt',
      passwordHash: await Bun.password.hash('secret'),
      createdByUserId: 'access-user',
    });
    const r = await access.beginDownload(token, 'wrong');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('unauthorized');
  });

  test('max downloads: cancel releases lease', async () => {
    const token = crypto.randomUUID();
    const id = crypto.randomUUID();
    await db.insert(shareLink).values({
      id,
      token,
      path: 'hello.txt',
      maxDownloads: 1,
      downloadCount: 0,
      createdByUserId: 'access-user',
    });

    const first = await access.beginDownload(token);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    await first.stream.cancel();

    // After cancel, slot should be free again.
    await Bun.sleep(20);
    const row = await db
      .select()
      .from(shareLink)
      .where(eq(shareLink.id, id))
      .then((r) => r[0]!);
    expect(row.downloadCount).toBe(0);

    const second = await access.beginDownload(token);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    await new Response(second.stream).arrayBuffer(); // complete
    await Bun.sleep(20);
    const after = await db
      .select()
      .from(shareLink)
      .where(eq(shareLink.id, id))
      .then((r) => r[0]!);
    expect(after.downloadCount).toBe(1);

    const third = await access.beginDownload(token);
    expect(third.ok).toBe(false);
    if (!third.ok && third.error === 'unavailable') {
      expect(third.reason).toBe('max_downloads');
    }
  });
});
```

Import `eq` from `drizzle-orm` in the test file.

- [ ] **Step 2: Run tests — expect fail**

```bash
bun test apps/server/src/shares/access.test.ts
```

- [ ] **Step 3: Implement `beginDownload` for files**

Port the file branch of `downloadHandler` into `access.ts`. On `PathError`, return `{ ok: false, error: 'missing', message: 'file missing' }`.

For directories in this task: if path is a directory, either throw/`missing` temporarily **or** call `ensureShareZip` early — prefer calling `ensureShareZip` so Task 4 is absorb/cleanup rather than greenfield. If you call `ensureShareZip` here, Task 4 still must move ownership and stop routes from importing folder-zip.

- [ ] **Step 4: Run tests — expect pass**

```bash
bun test apps/server/src/shares/access.test.ts
```

Also keep lease unit tests green:

```bash
bun test apps/server/src/shares/download-lease.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/shares/access.ts apps/server/src/shares/access.test.ts
git commit -m "$(cat <<'EOF'
feat(shares): add Public Share Access beginDownload for files

EOF
)"
```

---

### Task 4: Absorb folder-zip policy into Access

**Files:**
- Modify: `apps/server/src/shares/access.ts` (own fingerprint / ensure / build / prepare / invalidate)
- Modify: `apps/server/src/shares/folder-zip.ts` (privatize — only imported by `access.ts`, or delete after inlining)
- Modify: `apps/server/src/shares/access.test.ts`
- Modify or delete: `apps/server/src/shares/folder-zip.test.ts` (move assertions into `access.test.ts`)

**Interfaces:**
- Consumes: `zipFolderToFile` from `../files/zip`; `absFromRelOrThrow`, `removeShareZip`, `SHARES_ROOT` (internal only) from `../files/store`; `fileIndex` for fingerprint
- Produces (public on Access — **not** a separate folder-zip facade):
  ```ts
  /** Materialize/refresh cached zip for a folder share (used on create). */
  export async function prepareFolderArtifact(
    shareId: string,
    folderRel: string,
  ): Promise<void>;

  /** Delete cached zip dir for a share id (used on revoke). */
  export async function invalidateFolderArtifact(shareId: string): Promise<void>;
  ```
- Internal (not exported): `folderFingerprint`, `ensureShareZip`-equivalent returning `{ abs, size }` or relative path + size, rebuild Map coalescing.
- `beginDownload` / unlocked meta for directories must use the absorbed ensure path; zip download name = `${basenameOf(folderRel)}.zip`, mime `application/zip`.

- [ ] **Step 1: Write failing Access-level folder artifact tests**

Move the important cases from `folder-zip.test.ts` / `folder-share.test.ts` up to the Access seam:

```ts
describe('Public Share Access — folder artifact', () => {
  test('prepare → beginDownload returns zip with entries; mutate → rebuild; invalidate removes', async () => {
    const folder = `fa-${crypto.randomUUID()}`;
    const info = await writeUpload(`${folder}/a.txt`, streamFromText('hi'));
    await db.insert(fileIndex).values({
      path: `${folder}/a.txt`,
      size: info.size,
      mtimeMs: info.mtimeMs,
      inode: info.inode,
      sha256: info.sha256,
      mime: 'text/plain',
      uploadedByUserId: 'access-user',
    });

    const id = crypto.randomUUID();
    const token = crypto.randomUUID();
    await access.prepareFolderArtifact(id, folder);
    await db.insert(shareLink).values({
      id,
      token,
      path: folder,
      createdByUserId: 'access-user',
    });

    const meta = await access.inspect(token);
    expect(meta.status).toBe('unlocked');
    if (meta.status === 'unlocked') {
      expect(meta.mime).toBe('application/zip');
      expect(meta.name).toBe(`${folder}.zip`);
      expect(meta.size).toBeGreaterThan(0);
    }

    const dl = await access.beginDownload(token);
    expect(dl.ok).toBe(true);
    if (!dl.ok) return;
    const { unzipSync } = await import('fflate');
    const files = unzipSync(new Uint8Array(await new Response(dl.stream).arrayBuffer()));
    expect(new TextDecoder().decode(files['a.txt'])).toBe('hi');

    // Stale: add file + index row, next download reflects change
    const info2 = await writeUpload(`${folder}/b.txt`, streamFromText('bye'));
    await db.insert(fileIndex).values({
      path: `${folder}/b.txt`,
      size: info2.size,
      mtimeMs: info2.mtimeMs,
      inode: info2.inode,
      sha256: info2.sha256,
      mime: 'text/plain',
      uploadedByUserId: 'access-user',
    });
    const dl2 = await access.beginDownload(token);
    expect(dl2.ok).toBe(true);
    if (!dl2.ok) return;
    const files2 = unzipSync(new Uint8Array(await new Response(dl2.stream).arrayBuffer()));
    expect(Object.keys(files2).sort()).toEqual(['a.txt', 'b.txt']);

    await access.invalidateFolderArtifact(id);
    const { SHARES_ROOT } = await import('../files/store');
    const { stat } = await import('node:fs/promises');
    await expect(stat(join(SHARES_ROOT, id))).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run tests — expect fail on missing exports**

```bash
bun test apps/server/src/shares/access.test.ts
```

- [ ] **Step 3: Absorb implementation**

1. Move (or re-export privately) fingerprint / build / ensure / rebuild Map into Access ownership.
2. Implement `prepareFolderArtifact` = today’s `buildShareZip`.
3. Implement `invalidateFolderArtifact` = `removeShareZip(shareId)`.
4. Ensure unlocked meta + `beginDownload` call the internal ensure — never leave routes calling `ensureShareZip` / `buildShareZip`.
5. Stop exporting share-policy functions from `folder-zip.ts` to the rest of the app:
   - Either delete `folder-zip.ts` and keep logic in `access.ts` / `access-folder-artifact.ts` imported only by `access.ts`,
   - Or leave `folder-zip.ts` but add a file-top comment `/** @internal Access only */` and ensure **zero** imports from `routes.ts` / tests outside Access.
6. Keep `files/zip.ts` as pure pack/stream — no fingerprint.

- [ ] **Step 4: Migrate old folder-zip tests**

- Port fingerprint + reuse/rebuild assertions into `access.test.ts` (via prepare/beginDownload/invalidate).
- Delete `folder-zip.test.ts` **or** reduce it to nothing that imports a public folder-zip API.
- Keep `files/zip.test.ts` for pure zipper behavior.

- [ ] **Step 5: Run tests**

```bash
bun test apps/server/src/shares/access.test.ts apps/server/src/files/zip.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/shares/access.ts apps/server/src/shares/access.test.ts \
  apps/server/src/shares/folder-zip.ts apps/server/src/shares/folder-zip.test.ts
git commit -m "$(cat <<'EOF'
refactor(shares): absorb folder-zip cache into Public Share Access

EOF
)"
```

---

### Task 5: Thin HTTP adapter — wire routes to Access

**Files:**
- Modify: `apps/server/src/shares/routes.ts`
- Modify: `apps/server/src/shares/routes.test.ts` (only if imports break; keep behavioral assertions)
- Modify: `apps/server/src/shares/folder-share.test.ts` (should stay green without logic changes)

**Interfaces:**
- Consumes: `inspect`, `verify`, `beginDownload`, `prepareFolderArtifact`, `invalidateFolderArtifact` from `./access`
- Consumes: `allowShareRequest`, `requestIp` from `./rate-limit` (stay in routes)
- Consumes: `userRel`, `auth` session for owner routes
- Produces: unchanged HTTP shapes/status codes

Status mapping:

| Access result | HTTP |
|---|---|
| inspect `unavailable` | 410 + `{ status, message }` |
| inspect `locked` | 200 + locked payload (no path/name/size/mime) |
| inspect `unlocked` | 200 + full meta + `requiresPassword: false` |
| verify unauthorized | 401 |
| verify unavailable | 410 |
| verify ok | 200 + `{ ok: true, ...meta }` |
| beginDownload unauthorized | 401 |
| beginDownload unavailable | 410 |
| beginDownload missing | 404 |
| beginDownload ok | `new Response(stream, { headers })` |
| rate limit trip | 429 (adapter only, before Access) |

- [ ] **Step 1: Refactor public GET inspect handler**

Replace inline `getShareState` / locked branching with:

```ts
.get('/api/shares/public/:token', async ({ request, params, set, server }) => {
  const ip = requestIp(request, server?.requestIP(request)?.address);
  if (!allowShareRequest(ip, params.token)) {
    set.status = 429;
    return { error: 'Too many requests. Try again shortly.' };
  }
  const result = await inspect(params.token);
  if (result.status === 'unavailable') {
    set.status = 410;
    return { status: result.reason, message: result.message };
  }
  if (result.status === 'locked') {
    return {
      status: 'ok' as const,
      requiresPassword: true as const,
      expiresAt: result.expiresAt,
      maxDownloads: result.maxDownloads,
      downloadCount: result.downloadCount,
    };
  }
  return {
    status: 'ok' as const,
    ...result,
    requiresPassword: false as const,
  };
})
```

- [ ] **Step 2: Refactor verify + downloadHandler**

Verify: call `verify`; map errors to 401/410; success spreads meta with `ok: true`.

Download: keep one shared `downloadHandler` for GET+POST; rate-limit first; then `beginDownload(params.token, body?.password)`; map errors; on ok return `new Response(result.stream, { headers: result.headers })`.

Remove from routes: `getShareState`, `buildUnlockedPublicMeta`, `statusToMessage`, `attachDownloadLease` usage, `ensureShareZip` / `buildShareZip` / `openStream` / `createFileStream` for public download path.

- [ ] **Step 3: Wire create + revoke**

Create folder branch: `await prepareFolderArtifact(id, path)` instead of `buildShareZip`.

Revoke: `await invalidateFolderArtifact(params.id)` instead of direct `removeShareZip` (Access may call `removeShareZip` internally — routes should not import Storage zip helpers for this).

Owner list/create auth + `userRel` stay in routes.

- [ ] **Step 4: Run adapter + Access + folder HTTP tests**

```bash
bun test apps/server/src/shares/
```

Expected: all PASS. Especially:
- locked metadata redaction
- GET query password rejected
- verify enriched meta
- max downloads / lease behavior (routes.test)
- folder create → zip → download → revoke (folder-share.test)

- [ ] **Step 5: Confirm routes no longer import folder-zip**

```bash
rg "from '\\./folder-zip'|from \\\"./folder-zip\\\"" apps/server/src/shares/routes.ts
```

Expected: no matches.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/shares/routes.ts apps/server/src/shares/routes.test.ts \
  apps/server/src/shares/folder-share.test.ts apps/server/src/shares/access.ts
git commit -m "$(cat <<'EOF'
refactor(shares): thin public share routes behind Access module

EOF
)"
```

---

### Task 6: Full regression + deletion check

**Files:**
- Touch only if something broke: leftover exports, cron share-sweep still using `removeShareZip` (that is fine — Storage helper), docs if domain vocab is already documented (optional; out of scope unless a comment lies)

**Interfaces:** none new

- [ ] **Step 1: Run full test suite**

```bash
bun test
```

Expected: PASS.

- [ ] **Step 2: Typecheck + lint**

```bash
bun run typecheck
bun run lint
```

Expected: clean.

- [ ] **Step 3: Deletion / shallowness check (manual)**

Confirm:
1. `routes.ts` does not own password/lease/zip policy — only maps Access + rate-limit.
2. No public folder-zip facade imported outside Access (and maybe tests).
3. `files/zip.ts` has no share fingerprint/share-id knowledge.
4. Cron/sweep orphan zip cleanup still works (`share-sweep` / `removeShareZip` path).

```bash
bun test apps/server/src/files/share-sweep.test.ts
rg "ensureShareZip|buildShareZip|folderFingerprint" apps/server/src --glob '!**/access*.ts' --glob '!**/folder-zip.ts'
```

Expected: no route/other callers of zip policy outside Access / internal folder-zip file.

- [ ] **Step 4: Final commit if cleanup needed**

```bash
git add -A
git status
# only commit if there are cleanup diffs
git commit -m "$(cat <<'EOF'
chore(shares): finish Public Share Access deepen cleanup

EOF
)"
```

---

## Spec coverage (self-review)

| Spec requirement | Task |
|---|---|
| `inspect` / `verify` / `beginDownload` interface | 1–3 |
| Locked metadata redaction | 1, 5 |
| Password only via POST / verify then download | 2, 3, 5 |
| Expired / revoked / max downloads | 1–3 |
| Lease release on cancel / commit on complete | 3 |
| Folder zip download + honest size/name | 4 |
| Create prepares zip; revoke deletes artifact | 4–5 |
| Concurrent rebuild coalescing stays internal | 4 (existing Map) |
| Rate limit remains HTTP adapter | 5 |
| External URLs/shapes stable | 5 |
| No new folder-zip public module | 4 |
| Generic zipper stays policy-free | 4 |
| Module tests at Access seam | 1–4 |
| Adapter smoke retained | 5–6 |
| No schema / no new UX / no S3 / no File Library | all (out of scope) |

## Placeholder scan

No TBD / “add appropriate error handling” / “similar to Task N” without repeating code.

## Type consistency

- `ShareUnavailableReason`, `SharePublicMeta`, `InspectResult`, `VerifyResult`, `BeginDownloadResult` defined in Task 1–3 and reused thereafter.
- Owner helpers: `prepareFolderArtifact` / `invalidateFolderArtifact` (Task 4) — routes must use these exact names in Task 5.
