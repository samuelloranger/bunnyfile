# BunnyFile — Project Plan

**Goal:** A lightweight, self-hosted file hosting and sharing server. Replaces the "files" half of Nextcloud with something Bun-fast, modern, and intentionally minimal.

**Vision:** The tool you reach for when you want to host files and share them — not a collaboration suite, not a sync engine, not a calendar/contacts/mail replacement.

**Tagline (working):** *Files, shared. That's it.*

---

## Status (2026-04-22)

| Phase | State | Notes |
|---|---|---|
| **0 — Foundation** | ✅ Complete | Monorepo, Elysia+Vite, Docker (fixed 3900/3901), CI, Biome, migration runner (Drizzle) |
| **2 — Auth** | 🟡 Partial | Auth is done and core shares are shipped (model/API/public page/rate limit/tests); QR code in share dialog remains. |
| **1 — File operations** | ✅ Complete | Filesystem-first core file ops are shipped (browse/upload/download/delete/move, folder creation, previews, keyboard nav, DnD) with backend endpoint coverage via `bun:test` (Playwright removed from Phase 1 scope). |
| **3 · tus** | ⬜ Not started | |
| **4 · S3 API** | ⬜ Not started | |
| **5 · Launch polish** | ⬜ Not started | |

**What we built ahead of schedule** (prerequisite for anything multi-user):
- Drizzle ORM + generated migrations (replaces the planned hand-rolled runner)
- better-auth (email/password, cookie sessions, CSRF/origin, first-admin setup flow)
- Role-based auth (`admin` / `user`), admin-gated user management (invite, promote/demote, delete)
- Profile page (name/image edit, password change, active sessions + revoke)
- Component library under `apps/web/src/components/ui/` — Radix primitives + Tailwind v4 tokens (Button, Input, Modal, Dropdown, Select, Drawer, ConfirmDialog, Avatar, Tooltip, Badge, Sidebar/Topbar shell)
- Theme system (light / dark / system) wired through CSS custom properties

**Still missing from Phase 2 before it can close:**
- QR code in share dialog

---

## 1. Why this exists

Built because Nextcloud is overkill for a file-only workflow. The market gap isn't "another Nextcloud clone" — it's *"a modern, beautifully designed, Bun-fast file server that speaks enough protocols to be useful everywhere."*

### Differentiation

- **Cold start in <500ms, idle RAM <100MB** — measurable, tweetable, credible vs Nextcloud's ~1GB baseline.
- **2026-quality UI** — most self-hosted tools look like 2015. BunnyFile invests in a custom visual language and a few signature interactions (upload queue, share dialog, file browser density), not an off-the-shelf component library default.
- **S3-compatible API first-class** — instant ecosystem: rclone, aws-cli, Cyberduck, every backup tool, every mobile S3 client. This is the secret weapon.
- **No WebDAV, no SFTP, no FTP** — those protocols are hostile to implement and have better existing tools (SFTPGo). Someone who needs WebDAV can run `rclone serve webdav` in front.
- **HTTP REST + tus resumable uploads** — modern stack, no legacy.

### Non-goals (important)

- ❌ Sync clients (use Syncthing or rclone if you need that)
- ❌ WebDAV (use rclone as a translation layer)
- ❌ SFTP / FTP (use SFTPGo)
- ❌ Calendar / contacts / mail / Talk / Deck
- ❌ Plugin/app marketplace
- ❌ Real-time collaborative editing (OnlyOffice/Collabora integration is explicitly out)
- ❌ Enterprise features (LDAP, SAML, fine-grained RBAC)

**The rule:** every time someone asks for a feature that Nextcloud/Seafile already do well, the answer is "use that for that." BunnyFile doesn't win by being more — it wins by being less, faster, prettier.

---

## 2. Target users

1. **Homelabbers who run Nextcloud for files only** and resent its weight. (Starting with: me.)
2. **Developers** who want a simple S3-compatible store for personal use without running MinIO's complexity.
3. **Freelancers / small teams** who need to drop files to clients via a share link without signing up for WeTransfer/Dropbox.

**NOT targeting:** enterprise, teams >10, anyone who wants "Google Drive at home."

---

## 3. Architecture

```
┌───────────────────────────────────────────────────────────┐
│   React SPA (Vite + TanStack Router + TanStack Query)     │
│   Browse · upload · share · search · QR code · settings   │
└──────────────────────────┬────────────────────────────────┘
                           │  served as static assets by Elysia on /
         ┌─────────────────┴──────────────────┐
         │                                    │
┌────────▼─────────┐                ┌─────────▼──────────┐
│  /api/* routes   │                │  S3-Compatible     │
│  (Elysia + Eden) │                │  API (Sig v4)      │
└────────┬─────────┘                └─────────┬──────────┘
         │                                    │
         └────────────────┬───────────────────┘
                          │
              ┌───────────▼──────────────┐
              │  Core (Bun + TypeScript) │
              │  - Auth                  │
              │  - Share links           │
              │  - File operations       │
              │  - Metadata              │
              └───┬──────────────────┬───┘
                  │                  │
        ┌─────────▼──────┐    ┌──────▼──────────────┐
        │  SQLite        │    │  Local filesystem   │
        │  (metadata)    │    │  (actual files)     │
        └────────────────┘    └─────────────────────┘

Single Elysia process serves both the SPA (on /) and the API (on /api/*).
Single Bun process, single Docker container in production.
```

### Key architectural decisions

| Decision | Rationale |
|---|---|
| **Bun runtime** | Fast startup, built-in bundler, single binary distribution, native SQLite via `bun:sqlite`, excellent HTTP/WebSocket perf |
| **Elysia** for routing | Bun-first, fastest on Bun, end-to-end types via Eden client for the React app, great DX |
| **SQLite** for metadata | Zero-ops, zero-config, perfect for homelab scale (<1M files). No MariaDB/Postgres dependency. |
| **Drizzle ORM + drizzle-kit** | TS schema is the source of truth; migrations are generated from diffs and checked in as plain SQL. Bun-native driver via `drizzle-orm/bun-sqlite`. Escape hatch to raw SQL via `sql\`\`` is always available. Chose over hand-rolled runner for schema/type drift protection. |
| **Local FS** for data | Files stay on disk, easy to back up with Kopia, no blob-store abstraction complexity |
| **React SPA via Vite**, served by Elysia | No SSR, no Nitro, no second server. Elysia serves `apps/web/dist` on `/` and `/api/*` for the backend. One process, one container in production. |
| **TanStack Router + Query** | File-based routing, typed search params, excellent query caching. Used in SPA mode (no Start/SSR). |
| **Radix UI primitives + Tailwind v4 tokens, vendored** | No installed component library. Radix provides headless behavior; `apps/web/src/components/ui/*` wraps each primitive with a theme built on HSL design tokens (light + dark). Distinctiveness comes from the wrapper layer — swap or fork without fighting a library default. |
| **better-auth** for auth | Framework-agnostic, Drizzle adapter is first-class, cookie sessions out of the box, typed client via `inferAdditionalFields<Auth>()`. Elysia integration via per-method handlers (`.all` loses to the SPA fallback in this Elysia version). |
| **No realtime collab** | Reduces scope by 80%, removes need for CRDT/Operational Transform |
| **Auth delegation** | Native auth (done) or forward-auth from Tinyauth/Caddy (todo). Not both at the same time. |
| **tus for uploads** | Resumable, chunked, pause/resume — use `@tus/server` lib, don't reinvent |

### Tech stack

- **Runtime:** Bun ≥ 1.3
- **Backend:** TypeScript, Elysia, `bun:sqlite` via Drizzle ORM (schema in TS, migrations generated by drizzle-kit), better-auth (email/password + cookie sessions), `@tus/server` (Phase 3, wrapped in a thin Elysia adapter)
- **Frontend:** React 19 + Vite 8 + TanStack Router + TanStack Query + Tailwind CSS v4 (SPA, served by Elysia in prod). Radix UI primitives wrapped in `apps/web/src/components/ui/*` with HSL design tokens.
- **Storage:** Local filesystem, SQLite for metadata
- **Testing:** `bun:test` (backend), Vitest + Playwright (frontend + E2E)
- **Lint/format:** Biome (fast, Bun-friendly, Tailwind-directive aware)
- **Packaging:** Docker image, single `bun build --compile` binary as stretch goal

---

## 4. Development phases

Each phase produces **working, usable software**. Phase N always leaves BunnyFile runnable and dogfoodable. No phase ends in a broken mid-state.

### Phase 0 — Foundation (Week 1)

**Deliverable:** "Hello, Bun" skeleton with dev loop, CI, and Docker running.

- [x] Initialize Bun workspace (monorepo: `apps/server`, `apps/web`, `packages/shared`)
- [x] Elysia server responding on `GET /api/health`
- [x] Eden client wired into the web app for typed API calls
- [x] React + Vite SPA scaffold (TanStack Router + Query + Tailwind v4, no component library yet)
- [x] Elysia serves `apps/web/dist` on `/` in production (single process)
- [x] SQLite migration runner — done via **Drizzle ORM + drizzle-kit** (reversed the "no ORM" call; see decisions table). Runs on boot and via `bun run db:migrate`.
- [x] Dev docker-compose with fixed host ports (`3900` web, `3901` server; random-ports experiment reverted — collisions better handled by picking once than re-discovering every run)
- [x] Production Dockerfile (multi-stage, single container)
- [x] GitHub Actions: lint + typecheck + test on PR
- [x] Biome for lint/format (fast, Bun-friendly)
- [x] README with quickstart

**Done when:** `docker compose up` → open browser → see the Vite SPA served by Elysia, with `/api/health` returning JSON.

---

### Phase 1 — Core file operations (Weeks 2–3)

**Deliverable:** A single-user web-only file browser. No auth yet, not exposed to internet.

- [x] Filesystem-first storage model (`DATA_DIR` is source of truth) with SQLite `file_index` as a derived metadata cache
- [x] HTTP REST endpoints: `GET /api/files`, `POST /api/files`, `GET /api/files/:path`, `DELETE /api/files/:path`, `PATCH /api/files/:path` (rename/move) *(implemented as `GET /api/files`, `POST /api/files/upload`, `GET /api/files/content?path=...`, `DELETE /api/files`, `PATCH /api/files`)*
- [x] Directory listing with pagination
- [x] File metadata cache in SQLite (size, mtime, mime, hash)
- [x] Streaming download with Range requests
- [x] Simple multipart upload (tus comes in Phase 2)
- [x] React file browser (Table / Dialog / Command — decide on a primitive layer when we get here; Tailwind for styling either way)
- [x] Drag-and-drop upload
- [x] File preview (images, PDFs inline, text, video)
- [x] Keyboard navigation: j/k/↑/↓, Enter to open, / to search
- [x] Backend tests for core file endpoints (`bun:test`)
- [x] Playwright requirement removed for Phase 1 (backend-only test focus)

**Done when:** I can use BunnyFile to browse `/mnt/storage` in my browser on `localhost:3000`.

---

### Phase 2 — Auth + share links (Week 4)

**Deliverable:** Safe to expose behind Caddy. Share files via public links.

**Auth — done ahead of schedule** (prerequisite before Phase 1 stopped being single-user):

- [x] User table + password hashing via better-auth (scrypt; argon2id is fine too but better-auth ships scrypt by default)
- [x] Session cookies (better-auth's `bunnyfile`-prefixed cookies, 30-day expiry, 1-day refresh, cookie cache)
- [x] Login page (`/login`) and first-admin setup page (`/setup`) with auth guard on `_app.tsx`
- [x] Email/password sign-up and sign-in
- [x] First signup becomes admin (via `databaseHooks.user.create.before`)
- [x] Profile page (`/profile`): name/image update, password change (revokes other sessions), active-session list + per-row revoke
- [x] People page (`/people`): admin lists, invites, promotes/demotes, deletes users — with protections for self-delete and last-admin removal
- [x] Trusted-origin policy (localhost + RFC1918 LAN + explicit env allowlist) shared between better-auth CSRF check and Elysia CORS so they can't disagree

**Shares — implemented (remaining QR only):**

- [x] Share-link model: `{ id, path, expires_at, password_hash?, max_downloads?, created_by }`
- [x] `POST /api/shares` / public share metadata and download endpoints (`GET /api/shares/public/:token`, `GET /api/shares/public/:token/file`) / `DELETE /api/shares/:id`
- [ ] Share-link UI: "Share" button → dialog → copy link + QR code *(copy link done, QR pending)*
- [x] Public share page (no auth, consistent look with the authenticated app)
- [x] Expired/exceeded link renders a friendly 410 page
- [x] Rate limiting on public share access (in-memory token bucket)
- [x] Tests: auth bypass attempts, expired tokens, download limits

**Done when:** I can share a file with a friend via URL+password+expiry, and the share dialog includes QR code generation.

---

### Phase 3 — Resumable uploads (tus) (Week 5)

**Deliverable:** Upload 10GB files without tears.

- [ ] Integrate `@tus/server` behind an Elysia adapter route (`/api/files/tus`)
- [ ] Use `FileStore` as the tus datastore (custom adapter)
- [ ] React uploader using `@tus/js-client`
- [ ] Upload queue UI: progress bars, pause/resume, retry, cancel
- [ ] Resume on page reload (persist upload URL in localStorage)
- [ ] Configurable chunk size and concurrent uploads
- [ ] Tests: simulate mid-upload disconnect, verify resume works

**Done when:** I can start a 5GB upload, kill my WiFi for 30s, reconnect, and it resumes cleanly.

---

### Phase 4 — S3-compatible API (Weeks 6–8)

**Deliverable:** `rclone`, `aws-cli`, `restic`, `kopia`, Cyberduck all work against BunnyFile.

This is the **killer feature**. Take the time to do it right.

- [ ] AWS Signature v4 verification (`crypto.subtle.sign`)
- [ ] S3 XML response helpers
- [ ] **Common path (must work for 95% of clients):**
  - `PutObject`, `GetObject`, `HeadObject`, `DeleteObject`
  - `ListObjectsV2` (with prefix, delimiter, continuation tokens)
  - `CreateBucket`, `DeleteBucket`, `ListBuckets`, `HeadBucket`
- [ ] **Multipart uploads:**
  - `CreateMultipartUpload`, `UploadPart`, `CompleteMultipartUpload`, `AbortMultipartUpload`, `ListParts`
- [ ] `CopyObject` (server-side copy)
- [ ] Presigned URL verification for `GET` / `PUT`
- [ ] Access keys in SQLite (per-user, multiple keys per user)
- [ ] UI to manage S3 credentials (form + table)
- [ ] Compatibility tests:
  - `rclone sync` round-trip
  - `aws s3 cp` bi-directional
  - `restic` full backup/restore cycle
  - `kopia` target (so I can use BunnyFile to back up itself!)
- [ ] Document known-incompatible operations (versioning, lifecycle, ACLs, encryption headers — all skipped intentionally)

**Done when:** I replace my Nextcloud-to-Kopia backup with BunnyFile-as-S3-target, and a round-trip with rclone preserves every byte.

---

### Phase 5 — Polish for launch (Weeks 9–10)

**Deliverable:** Ready for first public release on r/selfhosted / selfh.st.

- [ ] Landing page inside the app (homepage when logged out)
- [ ] Settings page: storage stats, access keys (user management already shipped on `/people`)
- [ ] Email-change flow (currently email is read-only once set)
- [x] Admin vs user roles (shipped early — see Phase 2)
- [ ] Thumbnails for images (generate on upload, cache in SQLite)
- [ ] Full-text filename search (SQLite FTS5)
- [x] Dark mode (shipped early — theme system with light/dark/system toggle in the topbar)
- [ ] OpenAPI spec served at `/api/docs`
- [ ] Prometheus metrics at `/metrics`
- [ ] Graceful shutdown (drain in-flight uploads)
- [ ] Load test: 100 concurrent downloads, 10 concurrent uploads, measure RAM
- [ ] Comprehensive README with screenshots
- [ ] Docker image on GHCR with `latest` / `vX.Y.Z` tags
- [ ] Example docker-compose files (standalone, behind Caddy, behind Tinyauth)
- [ ] Migration guide: "coming from Nextcloud"
- [ ] Demo deployment at `demo.bunnyfile.tld`

**Done when:** I can post on r/selfhosted with screenshots and not cringe.

---

### Phase 6 — Post-launch (ongoing)

**Driven by real user feedback, in rough priority order:**

- [ ] Per-folder permissions (read/write/admin per user)
- [ ] Quota enforcement per user
- [ ] QR-code mobile upload page (tap QR → upload from phone directly)
- [ ] Magic-wormhole-style ephemeral transfers with human-readable codes
- [ ] OIDC integration (beyond forward-auth)
- [ ] OPDS feed for ebooks (if anyone asks)
- [ ] WebSocket live updates (multiple tabs stay in sync)
- [ ] File content search (text extract via a background indexer)
- [ ] `bun build --compile` single-binary distribution
- [ ] Homebrew / apt packaging
- [ ] Postgres adapter for metadata (if anyone hits SQLite limits — unlikely)

---

## 5. Success criteria

**Personal (non-negotiable):**
1. I replace my own Nextcloud-for-files use with BunnyFile within 3 months.
2. BunnyFile backs up itself via Kopia pointed at its own S3 API.
3. I genuinely enjoy using it.

**Public (nice-to-have):**
1. 1,000 GitHub stars within 6 months of Phase 5 launch.
2. Featured in one selfh.st weekly newsletter.
3. At least 5 external contributors merged a PR.
4. 50+ active deployments (anonymous opt-in telemetry, off by default).

If none of the public goals happen, the project still succeeded — I dogfooded a tool I like and learned Bun deeply.

---

## 6. Risks and mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| S3 compatibility edge cases eat a month | High | Scope to "95% of real clients" — document what's unsupported, don't chase spec completeness |
| Bun WebSocket/HTTP perf regression breaks dogfood | Low | Pin Bun version; watch release notes; hold back on upgrades until verified on a staging instance. No Node fallback — Bun-first is a positioning choice. |
| UI primitive-layer decision deferred | ✅ Resolved | Picked Radix UI. Wrappers vendored under `apps/web/src/components/ui/*` with HSL design tokens — swap or fork freely. |
| Hand-rolled migration runner diverges from schema types | ✅ Resolved | Reversed the "no ORM" call and picked Drizzle. `drizzle-kit generate` diffs the TS schema into SQL; types and schema can't drift. Raw SQL escape hatch preserved via `sql\`\``. |
| "Just one more feature" scope creep | High | The non-goals list is sacred. Re-read it every phase. |
| Losing interest when Phase 4 hits gnarly S3 quirks | Medium | Phase 3 must be done and usable before Phase 4 — gives a good fallback state to ship early |
| WebDAV demands from users | Certain | Answer is always "run rclone serve webdav in front." Documented in README. |
| Data loss bug corrupts user files | Catastrophic | Write-then-rename for every write; checksums in SQLite; integration tests that verify byte-exact round trips on every commit |

---

## 7. Open questions (decide before Phase 2)

1. **Branding:** is it really BunnyFile, or do we explore alternatives before commit? (Current leader: BunnyFile. Mascot: a rabbit made of file-folder icons.)
2. **License:** MIT (maximum adoption) or AGPL (prevents SaaS rehosting without contribution)? Leaning MIT.
3. **Config format:** YAML, TOML, or env vars only? Leaning env vars + a `config.toml` for non-secret knobs.
4. **Metadata schema:** single `files` table or `files` + `file_versions` from day one? Leaning single table — versions are a Phase 6 feature if at all. (Auth schema already shipped: `user`, `session`, `account`, `verification`.)
5. **Do we need a background job system?** Probably not for Phase 0–4. Thumbnails in Phase 5 may force a decision. Leaning: in-process queue backed by a SQLite table, no external worker.
6. **Email-change / password-reset flow:** currently email is read-only and password reset requires admin intervention. Decide before a public deploy — probably needs SMTP config + a magic-link plugin for better-auth.

---

## 8. Next actions (today)

- [ ] Create GitHub repo `bunnyfile` (private until Phase 2 complete)
- [ ] Initialize Bun monorepo per Phase 0 checklist
- [ ] Set up project board mirroring these phases
- [ ] Write a one-paragraph `README.md` with the tagline and non-goals
- [ ] Register `bunnyfile.tld` or `bunnyfile.app` (check availability)
- [ ] Sketch the logo (rabbit + folder)

---

## 9. Per-phase implementation plans

When it's time to start a phase, a dedicated `docs/plans/phase-N.md` gets written with task-by-task TDD breakdown (every step, every file, every test, every commit). This document is the north star; those are the execution specs.
