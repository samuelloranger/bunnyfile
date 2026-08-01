# Launch Security Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close audit follow-ups #567–#571 so BunnyFile is safe and credible for a public launch post: share reserved-path guard, public share hardening, shared-workspace docs, required auth secret, correct file streaming + download leases, DATA_DIR sibling layout with boot migrate, and screenshot seed fixes.

**Architecture:** Security-first vertical slices. Until the layout split, one shared `userRel()` rejects reserved top segments for both files and shares. Public shares never put passwords in URLs, never leak locked metadata, never zip before auth, trust XFF only behind configured proxies, and lease max-download slots until the stream finishes or cancels. Then `DATA_DIR` becomes a container (`files/`, `s3/`, `trash/`, `shares/`, `multipart/`) with idempotent boot migrate; denylist deleted. Screenshots last.

**Tech Stack:** Bun ≥ 1.3, Elysia, Drizzle + `bun:sqlite`, `bun:test`, React SPA (TanStack Query/Router), Playwright screenshot scripts, Biome.

**Spec:** `docs/superpowers/specs/2026-08-01-launch-security-hardening-design.md`

## Global Constraints

- Execution order is fixed: #568 → #569 → #570 → #571 → #567. Do not start Task 8+ until earlier tasks are green.
- No new runtime dependencies unless a task explicitly adds one (expect none).
- Storage writes that persist user bytes stay write-then-rename + checksum (existing invariant). Share zip caches and layout migrate use atomic renames where practical.
- `BETTER_AUTH_SECRET` must be set in every test that boots auth/options (many already set `test-secret`).
- Lint/format: Biome. Verify with `bun test`, `bun run typecheck`, `bun run lint`.
- Do not implement per-user ACLs, split `_app.files.tsx`, or auto-downgrade layout.
- Discard the uncommitted Bun.file `createFileStream` rewrite — do not ship it.
- Pin from spec: `/verify` returns enriched metadata after a correct password; unlimited download counts bump on successful completion; `realpath` symlink hardening is deferred (document only); SigV4 UNSIGNED-PAYLOAD is a go/no-go after smoke (Task 7).

## File map

| Path | Responsibility |
|---|---|
| `apps/server/src/files/user-path.ts` | **Create** — `RESERVED_TOP_SEGMENTS` + `userRel()` (shared) |
| `apps/server/src/files/paths.ts` | `safeRelPath` / `resolveInRoot` (add tests) |
| `apps/server/src/files/paths.test.ts` | **Create** — path helper tests |
| `apps/server/src/files/routes.ts` | Import shared `userRel`; later drop denylist filter once layout lands |
| `apps/server/src/files/store.ts` | `FILES_ROOT` / roots; trash/shares paths; `createFileStream` with cancel |
| `apps/server/src/files/store.test.ts` | Stream cancel + layout-aware fixtures |
| `apps/server/src/files/layout.ts` | **Create** — ensure layout + boot migrate |
| `apps/server/src/files/layout.test.ts` | **Create** — migrate idempotency |
| `apps/server/src/files/scanner.ts` | Scan `FILES_ROOT` only; remove `s3` special-case |
| `apps/server/src/shares/routes.ts` | Create via `userRel`; locked metadata; no query password; lease |
| `apps/server/src/shares/routes.test.ts` | Reserved create, locked meta, lease, GET password rejected |
| `apps/server/src/shares/folder-zip.ts` | Zip paths under `shares/` (post-layout) |
| `apps/server/src/shares/rate-limit.ts` | Proxy-aware `requestIp` |
| `apps/server/src/shares/rate-limit.test.ts` | **Create** — XFF trust tests |
| `apps/server/src/auth/options.ts` | Refuse missing/default secret |
| `apps/server/src/s3/routes.ts` / `multipart.ts` | Roots under `DATA_DIR/s3`, `multipart/` |
| `apps/server/src/index.ts` | Call layout ensure before listen |
| `apps/web/src/routes/s.$token.tsx` | No query password; locked UI; native POST after verify |
| `README.md`, `docs/migrating-from-nextcloud.md`, `docs/s3-compatibility.md`, `.env.example` | Workspace + storage + env docs |
| `scripts/screenshot/seed.ts`, `shots.ts` | Realistic sizes, dark mode, single search chrome |

---

### Task 1: Shared `userRel` + reject reserved share creates (#568)

**Files:**
- Create: `apps/server/src/files/user-path.ts`
- Create: `apps/server/src/files/user-path.test.ts`
- Modify: `apps/server/src/files/routes.ts` (delete local `RESERVED_TOP_SEGMENTS` / `userRel`; import from `user-path.ts`)
- Modify: `apps/server/src/shares/routes.ts` (use `userRel` instead of `safeRelPath` on create)
- Modify: `apps/server/src/shares/routes.test.ts`

**Interfaces:**
- Consumes: `safeRelPath` from `./paths`
- Produces:
  - `export const RESERVED_TOP_SEGMENTS: ReadonlySet<string>` — currently `s3`, `.trash`, `.multipart`, `.shares`
  - `export function userRel(raw: string | null | undefined): string | null`

- [ ] **Step 1: Write failing tests for `userRel`**

Create `apps/server/src/files/user-path.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { userRel } from './user-path';

describe('userRel', () => {
  test('allows normal paths', () => {
    expect(userRel('docs/a.txt')).toBe('docs/a.txt');
    expect(userRel('')).toBe('');
  });

  test('rejects reserved top segments', () => {
    for (const top of ['s3', '.trash', '.multipart', '.shares']) {
      expect(userRel(top)).toBeNull();
      expect(userRel(`${top}/x`)).toBeNull();
    }
  });

  test('rejects traversal via safeRelPath', () => {
    expect(userRel('../x')).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests — expect fail (module missing)**

```bash
bun test apps/server/src/files/user-path.test.ts
```

Expected: fail resolving `./user-path`.

- [ ] **Step 3: Implement `user-path.ts` and wire routes**

```ts
// apps/server/src/files/user-path.ts
import { safeRelPath } from './paths';

export const RESERVED_TOP_SEGMENTS = new Set(['s3', '.trash', '.multipart', '.shares']);

/** Validate a user-supplied path AND reject reserved internal prefixes. */
export function userRel(raw: string | null | undefined): string | null {
  const rel = safeRelPath(raw);
  if (rel == null) return null;
  const top = rel.split('/')[0];
  if (top && RESERVED_TOP_SEGMENTS.has(top)) return null;
  return rel;
}
```

In `files/routes.ts`: remove the local set/function; `import { userRel } from './user-path'`.  
In `shares/routes.ts` create handler: `const path = userRel(body.path);` (keep `if (!path)` → 400 invalid path).

- [ ] **Step 4: Add share-create reserved-path tests**

In `apps/server/src/shares/routes.test.ts`, add:

```ts
it('rejects share create on reserved top segments', async () => {
  for (const path of ['s3', 's3/bucket/key', '.trash', '.multipart', '.shares']) {
    const res = await request('/api/shares', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('invalid path');
  }
});
```

- [ ] **Step 5: Run tests**

```bash
bun test apps/server/src/files/user-path.test.ts apps/server/src/shares/routes.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/files/user-path.ts apps/server/src/files/user-path.test.ts \
  apps/server/src/files/routes.ts apps/server/src/shares/routes.ts \
  apps/server/src/shares/routes.test.ts
git commit -m "$(cat <<'EOF'
fix(shares): reject reserved paths on share create

Use the same userRel() guard as the files API so authenticated users cannot
publish s3/.trash/.multipart/.shares via POST /api/shares.
EOF
)"
```

---

### Task 2: Locked metadata, no zip-before-auth, drop query password (#569 server)

**Files:**
- Modify: `apps/server/src/shares/routes.ts`
- Modify: `apps/server/src/shares/routes.test.ts`
- Modify: `apps/server/src/shares/folder-share.test.ts` (if it asserts full locked metadata)

**Interfaces:**
- Consumes: `ensureShareZip`, `getShareState`, `requestIp`
- Produces: locked public metadata shape; password from `body` only in `downloadHandler`

- [ ] **Step 1: Write failing tests**

Extend `routes.test.ts`:

```ts
it('omits path/name/size/mime on locked public metadata and does not build zip', async () => {
  // create a folder + passworded folder share (reuse folder-share helpers or mkdir + writeUpload)
  // GET /api/shares/public/:token
  // expect requiresPassword true
  // expect body.path / body.name / body.size / body.mime to be undefined
  // expect expiresAt/maxDownloads/downloadCount present when set
  // expect no .shares/<id> zip dir yet (readdir DATA_DIR/.shares)
});

it('rejects password supplied only as GET query on /file', async () => {
  const createRes = await request('/api/shares', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: 'hello.txt', password: 'secret123' }),
  });
  const { token } = (await createRes.json()) as { token: string };
  const res = await request(
    `/api/shares/public/${token}/file?password=${encodeURIComponent('secret123')}`,
  );
  expect(res.status).toBe(401);
});
```

Also update the existing test that only checks `requiresPassword` so it asserts omitted fields.

- [ ] **Step 2: Run tests — expect fail**

```bash
bun test apps/server/src/shares/routes.test.ts
```

- [ ] **Step 3: Implement**

In `downloadHandler`:
- Remove `query` from password resolution: `const password = body?.password;`
- Remove GET route `query: t.Object({ password: ... })` (empty query schema or omit).

In `GET /api/shares/public/:token`:
- After `state.status === 'ok'`, if `state.row.passwordHash`:
  - return only `{ status: 'ok', requiresPassword: true, expiresAt, maxDownloads, downloadCount, token }` (token optional; keep if SPA needs it — SPA already has token from URL; prefer omit path/name/size/mime).
  - **do not** `stat` for zip / **do not** call `ensureShareZip`.
- If no password: existing full metadata path (may `ensureShareZip` for folder size).

- [ ] **Step 4: Run tests — expect pass**

```bash
bun test apps/server/src/shares/
```

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/shares/routes.ts apps/server/src/shares/routes.test.ts \
  apps/server/src/shares/folder-share.test.ts
git commit -m "$(cat <<'EOF'
fix(shares): lock public metadata and drop query passwords

Passworded shares no longer leak path/size or build zips on anonymous GET,
and download passwords are accepted from the POST body only.
EOF
)"
```

---

### Task 3: Public share SPA — verify unlock + POST-only download (#569 web)

**Files:**
- Modify: `apps/server/src/shares/routes.ts` (`POST .../verify` response)
- Modify: `apps/web/src/routes/s.$token.tsx`

**Interfaces:**
- Consumes: locked GET metadata; verify endpoint
- Produces: `POST /verify` success body includes full public fields (`name`, `size`, `mime`, `path`, flags) after password check so the SPA can render details without a leaking GET

- [ ] **Step 1: Extend verify to return enriched metadata (server test first)**

```ts
it('verify returns full metadata after correct password', async () => {
  // create passworded file share
  const res = await request(`/api/shares/public/${token}/verify`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: 'secret123' }),
  });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.ok).toBe(true);
  expect(body.name).toBe('hello.txt');
  expect(body.size).toBeGreaterThan(0);
  expect(body.requiresPassword).toBe(true);
});
```

Implement verify to return `{ ok: true, ...fullMeta }` (same fields as unlocked GET). Wrong password stays 401.

- [ ] **Step 2: Update `s.$token.tsx`**

- Track `unlocked` meta from verify (`useState`).
- While `requiresPassword && !unlocked`: show password UI; title like “Password protected share”; do **not** read `okShare.name` / size (they are absent).
- On submit: `preventDefault` → `fetch` verify → on success set unlocked meta from JSON → then native form POST for download:
  - Prefer `HTMLFormElement.prototype.submit.call(form)` so the React `onSubmit` does not re-fire, posting `password` in the form body to `/file`.
- Remove the `window.location.href = ...?password=` branch entirely.
- Passwordless: unlocked GET already has name/size; download via native form POST (no password field) or GET `/file` without query — prefer POST for one code path, or GET only when `!requiresPassword`.

- [ ] **Step 3: Typecheck web**

```bash
bun run --filter @bunnyfile/web typecheck
```

Expected: PASS (adjust optional fields on public share type if inferred from Eden — may need narrow unions for locked vs unlocked).

- [ ] **Step 4: Commit**

```bash
git add apps/server/src/shares/routes.ts apps/server/src/shares/routes.test.ts \
  apps/web/src/routes/s.\$token.tsx
git commit -m "$(cat <<'EOF'
fix(web): unlock share details via verify, POST downloads only

Stop putting share passwords in download URLs; show locked UI until verify
returns enriched metadata, then native form POST the file.
EOF
)"
```

---

### Task 4: Proxy-aware share rate limit (#569)

**Files:**
- Modify: `apps/server/src/shares/rate-limit.ts`
- Create: `apps/server/src/shares/rate-limit.test.ts`
- Modify: `README.md` (operator checklist — fold into this commit)
- Modify: `.env.example` and `deploy/compose/.env.example`

**Interfaces:**
- Consumes: `Request`, optional peer address
- Produces: `requestIp(request, peerAddress?, opts?)` honors XFF only when trusted

- [ ] **Step 1: Failing tests**

```ts
import { describe, expect, test } from 'bun:test';
import { requestIp } from './rate-limit';

describe('requestIp', () => {
  test('ignores XFF when trust disabled', () => {
    const req = new Request('http://x', { headers: { 'x-forwarded-for': '1.2.3.4' } });
    expect(requestIp(req, '10.0.0.5', { trustProxy: false })).toBe('10.0.0.5');
  });

  test('uses first XFF hop when trustProxy true', () => {
    const req = new Request('http://x', {
      headers: { 'x-forwarded-for': '1.2.3.4, 10.0.0.1' },
    });
    expect(requestIp(req, '10.0.0.5', { trustProxy: true })).toBe('1.2.3.4');
  });

  test('TRUSTED_PROXIES: ignore XFF unless peer is trusted', () => {
    const req = new Request('http://x', { headers: { 'x-forwarded-for': '1.2.3.4' } });
    expect(
      requestIp(req, '8.8.8.8', { trustProxy: true, trustedProxies: ['10.0.0.0/8'] }),
    ).toBe('8.8.8.8');
    expect(
      requestIp(req, '10.0.0.5', { trustProxy: true, trustedProxies: ['10.0.0.0/8'] }),
    ).toBe('1.2.3.4');
  });
});
```

Use a tiny CIDR match helper in `rate-limit.ts` (IPv4 only is enough for Caddy-on-LAN; document IPv6 limitation if skipped).

- [ ] **Step 2: Implement**

Read env once at module load:

```ts
const trustProxy =
  Bun.env.TRUST_PROXY === '1' || Bun.env.TRUST_PROXY === 'true';
const trustedProxies = (Bun.env.TRUSTED_PROXIES ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
```

`requestIp` uses those defaults when `opts` omitted. Call sites in `routes.ts` stay `requestIp(request, server?.requestIP(request)?.address)`.

- [ ] **Step 3: Docs / env examples**

README Security operator checklist: set `TRUST_PROXY=1` (and optionally `TRUSTED_PROXIES`) when behind Caddy.  
`.env.example`: comment the new vars.

- [ ] **Step 4: Test + commit**

```bash
bun test apps/server/src/shares/rate-limit.test.ts
git add apps/server/src/shares/rate-limit.ts apps/server/src/shares/rate-limit.test.ts \
  README.md .env.example deploy/compose/.env.example
git commit -m "$(cat <<'EOF'
fix(shares): trust X-Forwarded-For only behind configured proxies

Share rate limits were spoofable via XFF; honor forwarded headers only when
TRUST_PROXY / TRUSTED_PROXIES say the peer is a reverse proxy.
EOF
)"
```

---

### Task 5: Restore correct `createFileStream` with cancel (#570)

**Files:**
- Modify: `apps/server/src/files/store.ts` (replace current Bun.file stream)
- Modify: `apps/server/src/files/store.test.ts`

**Interfaces:**
- Produces: `createFileStream(path: string, chunkSize?: number): ReadableStream<Uint8Array>` with `cancel` closing the fd

- [ ] **Step 1: Failing test**

```ts
it('createFileStream cancel closes the file handle', async () => {
  const rel = 'stream.bin';
  const bytes = new Uint8Array(1024 * 512).fill(7);
  await writeUpload(rel, streamFromBytes(bytes));
  const { absFromRelOrThrow, createFileStream } = await import('./store');
  const abs = absFromRelOrThrow(rel);
  const stream = createFileStream(abs, 64 * 1024);
  const reader = stream.getReader();
  await reader.read(); // first chunk
  await reader.cancel();
  // Re-open for write should succeed quickly (fd not leaked). Soft assert:
  // subsequent createFileStream + full read equals bytes.
  const again = createFileStream(abs, 64 * 1024);
  const chunks: Uint8Array[] = [];
  for await (const c of again as unknown as AsyncIterable<Uint8Array>) chunks.push(c);
  const total = chunks.reduce((n, c) => n + c.length, 0);
  expect(total).toBe(bytes.length);
});
```

(If `for await` on `ReadableStream` is awkward under Bun, use `getReader` loop.)

- [ ] **Step 2: Implement FileHandle-based stream**

```ts
import { open, type FileHandle } from 'node:fs/promises';

export function createFileStream(path: string, chunkSize = 256 * 1024): ReadableStream<Uint8Array> {
  let fd: FileHandle | null = null;
  return new ReadableStream({
    async start() {
      fd = await open(path, 'r');
    },
    async pull(controller) {
      if (!fd) throw new Error('stream not started');
      const buffer = new Uint8Array(chunkSize);
      const { bytesRead } = await fd.read(buffer, 0, chunkSize, null);
      if (bytesRead === 0) {
        await fd.close();
        fd = null;
        controller.close();
      } else {
        controller.enqueue(buffer.subarray(0, bytesRead));
      }
    },
    async cancel() {
      if (fd) {
        await fd.close();
        fd = null;
      }
    },
  });
}
```

Discard any Bun.file / size-snapshot working tree version.

- [ ] **Step 3: Test + commit**

```bash
bun test apps/server/src/files/store.test.ts
git add apps/server/src/files/store.ts apps/server/src/files/store.test.ts
git commit -m "$(cat <<'EOF'
fix(store): restore cancel-safe createFileStream

Replace the Bun.file size-snapshot stream with a FileHandle pull stream so
client aborts release the fd (needed for share download leases).
EOF
)"
```

---

### Task 6: Download-count lease on cancel/complete (#569)

**Files:**
- Modify: `apps/server/src/shares/routes.ts`
- Modify: `apps/server/src/shares/routes.test.ts`
- Modify: `apps/server/src/files/store.ts` (optional: `createFileStream` accepts `onCancel` / wrap Response)

**Interfaces:**
- Produces: maxDownloads conditional `+1` at start; `-1` on stream cancel/error; leave `+1` on complete. Unlimited: `+1` only on complete.

- [ ] **Step 1: Failing test**

```ts
it('releases maxDownload lease when the client cancels', async () => {
  const createRes = await request('/api/shares', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: 'hello.txt', maxDownloads: 1 }),
  });
  const { token } = (await createRes.json()) as { token: string };

  const res = await request(`/api/shares/public/${token}/file`, { method: 'POST', body: '{}' , headers: { 'content-type': 'application/json' }});
  expect(res.status).toBe(200);
  await res.body?.cancel(); // abort before full consume if needed

  // Allow microtask for cancel handler
  await Bun.sleep(50);

  const retry = await request(`/api/shares/public/${token}/file`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  expect(retry.status).toBe(200);
  expect(await retry.text()).toBe('hello world');
});
```

Tune to whatever cancel signal Bun's `app.handle` actually invokes on `body.cancel()`. If cancel is hard to simulate under `app.handle`, unit-test a small `attachDownloadLease(stream, { commit, release })` helper instead and integration-test commit path.

- [ ] **Step 2: Implement**

Pattern:

```ts
let settled = false;
const release = async () => {
  if (settled) return;
  settled = true;
  if (row.maxDownloads != null) {
    await db.update(shareLink)
      .set({ downloadCount: sql`max(${shareLink.downloadCount} - 1, 0)` })
      .where(eq(shareLink.id, row.id));
  }
};
const commit = async () => {
  if (settled) return;
  settled = true;
  if (row.maxDownloads == null) {
    await db.update(shareLink)
      .set({ downloadCount: sql`${shareLink.downloadCount} + 1` })
      .where(eq(shareLink.id, row.id));
  }
  // maxDownloads already +1 at lease time
};

// Lease maxDownloads with existing conditional UPDATE before creating the Response.
const base = createFileStream(fileAbs);
const stream = new ReadableStream({
  start(c) { /* pipe or use tee — simpler: wrap pull from base reader */ },
  async pull(controller) {
    const r = await reader.read();
    if (r.done) {
      await commit();
      controller.close();
      return;
    }
    controller.enqueue(r.value);
  },
  async cancel(reason) {
    await reader.cancel(reason);
    await release();
  },
});
```

Keep the race-safe `WHERE downloadCount < maxDownloads` on lease.

- [ ] **Step 3: Test + commit**

```bash
bun test apps/server/src/shares/routes.test.ts
git add apps/server/src/shares/routes.ts apps/server/src/shares/routes.test.ts apps/server/src/files/store.ts
git commit -m "$(cat <<'EOF'
fix(shares): lease max-download slots until stream settles

Increment under the existing conditional UPDATE at start, commit on complete,
and release on cancel so aborted transfers do not burn maxDownloads.
EOF
)"
```

---

### Task 7: Auth secret refuse + workspace docs + path tests + SigV4 go/no-go (#570)

**Files:**
- Modify: `apps/server/src/auth/options.ts`
- Modify: tests that import auth without `BETTER_AUTH_SECRET` (set env before import)
- Create: `apps/server/src/files/paths.test.ts`
- Modify: `README.md`, `docs/migrating-from-nextcloud.md`
- Modify: `apps/server/src/s3/sigv4.ts` **only if go**
- Modify: `apps/server/src/s3/*.test.ts` / helpers **only if go**

**Pinned decisions:**
- Symlink `realpath`: **defer** — add one README sentence under Security / operator checklist.
- SigV4: run investigation first (below). If rclone/aws-cli/our compat suite require `UNSIGNED-PAYLOAD` on PutObject, **document deferral** in README Security and close the audit item as “accepted risk / tracked” without breaking clients. If clients already send payload hashes, reject `UNSIGNED-PAYLOAD` on mutating methods (`PUT`/`POST`) with a clear S3 error.

- [ ] **Step 1: Auth secret failing boot test**

```ts
// apps/server/src/auth/options-secret.test.ts
import { describe, expect, test } from 'bun:test';

describe('BETTER_AUTH_SECRET', () => {
  test('refuses insecure default', async () => {
    const prev = process.env.BETTER_AUTH_SECRET;
    delete process.env.BETTER_AUTH_SECRET;
    try {
      // dynamic import of a fresh module is hard under bun mock cache —
      // instead export assertAuthSecret() and unit-test that.
      const { assertAuthSecret } = await import('./options');
      expect(() => assertAuthSecret(undefined)).toThrow(/BETTER_AUTH_SECRET/);
      expect(() => assertAuthSecret('dev-only-insecure-secret-please-change-me')).toThrow();
      expect(() => assertAuthSecret('a-real-secret-at-least-32-chars!!')).not.toThrow();
    } finally {
      if (prev !== undefined) process.env.BETTER_AUTH_SECRET = prev;
    }
  });
});
```

Refactor `options.ts` to call `assertAuthSecret(Bun.env.BETTER_AUTH_SECRET)` and throw (no `DEV_SECRET` fallback).

- [ ] **Step 2: `paths.test.ts`**

Cover: empty/`./` → `''`; strip slashes; reject `..`, `.`, NUL, absolute; `resolveInRoot` stays inside root.

- [ ] **Step 3: README + migrating doc**

State shared workspace clearly (every authed user sees whole tree; S3 keys reach all buckets; `uploadedByUserId` is attribution). Operator checklist: required `BETTER_AUTH_SECRET`; no symlink plant under `DATA_DIR`.

- [ ] **Step 4: SigV4 go/no-go**

```bash
bun test apps/server/src/s3/compat.test.ts
```

Inspect whether production clients can send `x-amz-content-sha256` hex. If UNSIGNED-PAYLOAD is required for streaming PutObject in rclone, add README note and **skip code change**. If safe to require hash on mutating non-chunked uploads, implement minimal reject and update test helpers to sign real SHA256 of known bodies; keep chunked streaming auth as-is.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/auth/options.ts apps/server/src/auth/options-secret.test.ts \
  apps/server/src/files/paths.test.ts README.md docs/migrating-from-nextcloud.md \
  .env.example apps/server/src/s3/sigv4.ts apps/server/src/s3/test-helpers.ts
git commit -m "$(cat <<'EOF'
fix(auth): require BETTER_AUTH_SECRET and document shared workspace

Refuse boot on missing/insecure secrets, document the shared-workspace model,
add path helper tests, and resolve the UNSIGNED-PAYLOAD audit item (fix or
documented deferral).
EOF
)"
```

---

### Task 8: DATA_DIR sibling layout + boot migrate (#571)

**Files:**
- Create: `apps/server/src/files/layout.ts`
- Create: `apps/server/src/files/layout.test.ts`
- Modify: `apps/server/src/files/store.ts` (`DATA_ROOT` container, `FILES_ROOT`, trash/shares abs paths)
- Modify: `apps/server/src/files/scanner.ts`
- Modify: `apps/server/src/files/user-path.ts` (remove denylist after layout; `userRel` → `safeRelPath` only **or** keep denying the old names during one release — prefer delete denylist and rely on `FILES_ROOT`)
- Modify: `apps/server/src/files/routes.ts` (remove reserved listing filters)
- Modify: `apps/server/src/shares/folder-zip.ts` (`shares/<id>/...` under `DATA_DIR`, not under files)
- Modify: `apps/server/src/s3/routes.ts`, `multipart.ts` roots
- Modify: `apps/server/src/index.ts` (ensure layout before listen)
- Modify: all tests that assume files live at `DATA_DIR/<file>` — they should still pass if migrate runs on store import
- Modify: `docs/s3-compatibility.md`, `README.md`
- Modify: `scripts/screenshot/seed.ts` to write into `files/` for fresh v2 trees (or write legacy layout and let migrate run — prefer seed **v2 directly**)

**Interfaces:**
- Produces:
  - `export const DATA_ROOT` — container (`DATA_DIR`)
  - `export const FILES_ROOT` — `join(DATA_ROOT, 'files')`
  - `export async function ensureDataLayout(): Promise<void>`

- [ ] **Step 1: Failing layout tests**

```ts
describe('ensureDataLayout', () => {
  test('fresh: creates siblings + marker', async () => {
    // empty tmp DATA_DIR
    await ensureDataLayout(dataDir);
    expect(await exists(join(dataDir, 'files'))).toBe(true);
    expect(await exists(join(dataDir, 's3'))).toBe(true);
    expect(await exists(join(dataDir, 'trash'))).toBe(true);
    expect(await exists(join(dataDir, 'shares'))).toBe(true);
    expect(await exists(join(dataDir, 'multipart'))).toBe(true);
    expect(await exists(join(dataDir, '.bunnyfile-layout-v2'))).toBe(true);
  });

  test('legacy: moves user files into files/, renames dotted internals', async () => {
    await writeFile(join(dataDir, 'a.txt'), 'x');
    await mkdir(join(dataDir, 's3', 'b'), { recursive: true });
    await mkdir(join(dataDir, '.trash'), { recursive: true });
    await mkdir(join(dataDir, '.shares'), { recursive: true });
    await mkdir(join(dataDir, '.multipart'), { recursive: true });
    await ensureDataLayout(dataDir);
    expect(await readFile(join(dataDir, 'files', 'a.txt'), 'utf8')).toBe('x');
    expect(await exists(join(dataDir, 's3', 'b'))).toBe(true);
    expect(await exists(join(dataDir, 'trash'))).toBe(true);
    expect(await exists(join(dataDir, '.trash'))).toBe(false);
  });

  test('idempotent when files/ exists', async () => {
    await ensureDataLayout(dataDir);
    await writeFile(join(dataDir, 'files', 'keep.txt'), 'y');
    await ensureDataLayout(dataDir);
    expect(await readFile(join(dataDir, 'files', 'keep.txt'), 'utf8')).toBe('y');
  });
});
```

- [ ] **Step 2: Implement `layout.ts` per spec §4.4**

- If `files/` exists → stamp marker if missing; return.
- Else migrate moves; stamp marker only on full success; throw on failure (caller refuses listen).

- [ ] **Step 3: Point store at `FILES_ROOT`**

- `absFromRelOrThrow` resolves under `FILES_ROOT`.
- Trash ops use `join(DATA_ROOT, 'trash', ...)` (not under files). Same for `shares` zip removal.
- Call `ensureDataLayout(DATA_ROOT)` from `store.ts` module init **or** `index.ts` before listen — prefer `index.ts` + test harness calling ensure explicitly so unit tests control order. Simplest: `store.ts` top-level `await ensureDataLayout(DATA_ROOT)` after defining `DATA_ROOT` (matches today’s `mkdir`).

- [ ] **Step 4: Scanner / routes / S3**

- Scanner walks `FILES_ROOT`; delete `s3` name skip.
- File routes: delete reserved listing filter + import denylist usage.
- `user-path.ts`: `userRel` can become alias of `safeRelPath` OR delete and use `safeRelPath` everywhere — update call sites; keep tests that prove `s3` under FILES_ROOT is just a normal folder name now (users *can* create `files/s3` — that’s fine and no longer special).

- [ ] **Step 5: Docs**

Storage model section in `docs/s3-compatibility.md` + README cross-link: separate namespaces; global buckets; backup includes whole `DATA_DIR`; reverse-migrate appendix for operators.

- [ ] **Step 6: Full test suite**

```bash
bun test
bun run typecheck
bun run lint
```

Expected: PASS. Fix any test that wrote at `DATA_DIR/hello.txt` without going through `writeUpload` / ensure.

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/files/layout.ts apps/server/src/files/layout.test.ts \
  apps/server/src/files/store.ts apps/server/src/files/scanner.ts \
  apps/server/src/files/user-path.ts apps/server/src/files/routes.ts \
  apps/server/src/shares apps/server/src/s3 apps/server/src/index.ts \
  docs/s3-compatibility.md README.md scripts/screenshot/seed.ts
git commit -m "$(cat <<'EOF'
refactor(storage): split files tree from s3/trash/shares/multipart

DATA_DIR is now a container with files/ as the only user-browsable root.
Boot auto-migrates legacy layouts and drops the reserved-segment denylist.
EOF
)"
```

---

### Task 9: Screenshot seed + dark-mode capture (#567)

**Files:**
- Modify: `scripts/screenshot/seed.ts`
- Modify: `scripts/screenshot/shots.ts`
- Modify: `apps/web/src/routes/_app.files.tsx` and/or `topbar.tsx` **only if needed** for single search chrome
- Possibly: `apps/web/src/components/layout/sidebar.tsx` / list footer copy for count clarity

**Pinned UX fixes:**
- Seed large sparse files for `backups.zip` / `demo-reel.mp4` (e.g. `Bun.spawn(['truncate', '-s', '2G', path])` or `open`+`ftruncate`) so `stat.size` is huge while disk use stays tiny.
- Align metrics: change list footer label from “N total” to “N items” (current folder), keep sidebar badge as global `fileCount` — removes false “bug” reading. (If product prefers matching numbers instead, make root list `total` use the same `fileCount` — prefer copy fix.)
- Shots: set dark theme before capture (`localStorage` / click theme toggle / `page.emulateMedia` is not enough — use the app toggle or `document.documentElement.classList.add('dark')` if that’s how the app works).
- Topbar “Search all files…” + files page filter: for screenshot viewport, hide files-page search when topbar search is visible (CSS/`data-shot` hook), **or** navigate such that only one is visible. Prefer a small `shot` query flag or simply collapse the in-page filter on large screenshots by clicking list view and not focusing filter — inspect UI; if both always show, add `hidden md:...');` only when inappropriate — simplest launch fix: hide the in-page filter input when `mode === 'all'` is not active and rely on topbar for global search in the hero shot.

- [ ] **Step 1: Update seed to v2 paths + sparse sizes**

Write under `join(DATA_DIR, 'files', rel)`. After writes, `truncate` large media/archive placeholders to ≥512MB (2G ideal). Keep text files small.

- [ ] **Step 2: Update shots.ts for dark mode**

After login, enable dark mode the same way users do (find theme control). Then capture browser/preview/share.

- [ ] **Step 3: Fix double search / count copy in web as needed**

Minimal diffs; no redesign.

- [ ] **Step 4: Local capture (optional but preferred before commit)**

```bash
# build web, seed, run server, shots — mirror workflow
```

Commit regenerated PNGs if changed.

- [ ] **Step 5: Commit**

```bash
git add scripts/screenshot/seed.ts scripts/screenshot/shots.ts \
  apps/web/src/routes/_app.files.tsx apps/web/src/components/layout \
  docs/screenshots
git commit -m "$(cat <<'EOF'
chore(screenshots): realistic seed sizes and dark-mode captures

Sparse multi-hundred-MB demo files, clearer item counts, single search chrome
in the hero shot, and dark-mode README screenshots for launch.
EOF
)"
```

---

### Task 10: Final verification + board closeout

- [ ] **Step 1: Run full gates**

```bash
bun test
bun run typecheck
bun run lint
```

Expected: all green.

- [ ] **Step 2: Manual smoke checklist**

1. `POST /api/shares` with `path:"s3"` → 400 (pre-layout) or sharing `files/s3` is a normal folder after layout (cannot reach `DATA_DIR/s3` via userRel).
2. Passworded public GET metadata has no name/size; verify unlocks; POST downloads; GET `?password=` → 401.
3. Abort download with `maxDownloads: 1` still allows a second full download.
4. Stop server, arrange legacy fixture `DATA_DIR`, start → `files/` + marker.
5. README screenshots look credible in dark mode.

- [ ] **Step 3: Board**

Add notes + move #567–#571 to `done`. Move brainstorm #572 to `done`. Re-scope those tasks’ `project` to `bunnyfile` if still under `labby` (recreate/archive if MCP cannot patch `project`).

- [ ] **Step 4: Commit any leftover doc tweaks** (release-note blurb in README if missing)

```bash
git commit -m "docs: release notes for layout migrate and share hardening"
```

---

## Spec coverage checklist

| Spec requirement | Task |
|---|---|
| #568 reserved share create | 1 |
| Shared `userRel` until layout | 1, 8 |
| Password POST-only / no query | 2, 3 |
| Locked metadata + no zip-before-auth | 2 |
| Verify enriched metadata for SPA | 3 |
| TRUST_PROXY / XFF | 4 |
| Download lease | 6 (depends on 5) |
| `createFileStream` cancel | 5 |
| Refuse `BETTER_AUTH_SECRET` | 7 |
| Shared workspace docs | 7 |
| Path helper tests | 7 |
| Symlink doc / defer realpath | 7 |
| SigV4 go/no-go | 7 |
| Layout split + boot migrate | 8 |
| S3 storage model docs | 8 |
| Screenshots seed/dark/search/counts | 9 |
| Full gates + board close | 10 |

## Placeholder / consistency self-review

- No TBD steps; SigV4 explicitly branches go vs document-defer.
- `userRel` exists in Tasks 1–7; Task 8 may replace with `safeRelPath` under `FILES_ROOT` — call that out when editing Task 1 tests (reserved-segment unit tests may be deleted in Task 8 and replaced with “cannot resolve outside FILES_ROOT” tests).
- Lease Task 6 assumes Task 5 cancel semantics.
- Seed path updates land in Task 8 and/or 9 — Task 8 must leave seed writing to a layout the server accepts; Task 9 only adds sparse sizes + shot chrome.
