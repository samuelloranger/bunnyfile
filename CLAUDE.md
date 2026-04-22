# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project status

**Pre-alpha.** Phase 0 skeleton is in place: Bun workspace, Elysia server with `/api/health`, Vite + TanStack Router SPA, Tailwind v4, Docker (dev + single-container prod), CI. Treat `PLAN.md` as the authoritative spec. Per-phase execution details should live in `docs/plans/phase-N.md` files (create one before starting a phase).

## The non-goals list is load-bearing

BunnyFile wins by being *less* than Nextcloud/Seafile, not more. Before adding any feature, check it against `PLAN.md` §1 "Non-goals". If a user asks for any of these, the answer is "use the right tool for that" — do not implement:

- Sync clients → Syncthing / rclone
- WebDAV → `rclone serve webdav` in front
- SFTP / FTP → SFTPGo
- Calendar / contacts / mail / Talk / collaborative editing → Nextcloud
- Plugin marketplace, LDAP/SAML, fine-grained RBAC → out of scope

Scope creep is the #1 risk named in `PLAN.md` §6. Push back on "just one more feature" asks.

## Architecture

```
React SPA (Vite build → apps/web/dist)
        │
        │   served as static assets on /
        ▼
   Elysia (Bun) ──► /api/*   ──► Core (auth / shares / files / metadata)
                                    ├─► SQLite (bun:sqlite, metadata)
                                    └─► Local filesystem (file bytes)
```

**Key architectural choice:** one Elysia process serves both the SPA (on `/`) and the API (on `/api/*`). No SSR, no Nitro, no second server — one Bun process, one Docker container in production.

**Repo layout:**

```
apps/
  server/        # Elysia app, serves /api/* and apps/web/dist on /
    src/index.ts # exports `app` and `type App` for Eden
  web/           # Vite React SPA
    src/
      routes/    # file-based routes (TanStack Router)
      main.tsx   # client entry
      router.tsx # createRouter wrapped around routeTree.gen.ts
      lib/api.ts # Eden treaty<App> client
packages/
  shared/        # types/constants shared between server and web
```

## Stack

- **Runtime:** Bun ≥ 1.3. Use `bun:sqlite` natively, no ORM — raw SQL with a migration runner.
- **Backend:** TypeScript + Elysia + `@tus/server` (wrap in a thin Elysia adapter when Phase 3 lands). Typed API surface consumed by the web app via Elysia **Eden** (`treaty<App>`). Tests via `bun:test`.
- **Frontend:** React 19 + Vite 8 + TanStack Router (SPA mode, file-based routes) + TanStack Query + Tailwind CSS v4.
- **No component library yet.** We deliberately skipped shadcn/ui at Phase 0 to keep the door open for a custom visual language. When complex primitives are needed (dialogs, command palette, dropdowns), evaluate Radix/Ark/bespoke and commit the chosen primitives into the repo.
- **Lint/format:** Biome (`bun run lint` / `lint:fix`). Tailwind directives in CSS are enabled in `biome.json`.
- **Packaging:** Multi-stage `Dockerfile` → single container running `bun run apps/server/src/index.ts`. The `apps/web/dist` bundle is baked into the image.

**Auth model (Phase 2):** native sessions (argon2id via `Bun.password`) OR forward-auth (`Remote-User` header from Tinyauth/Caddy) — one mode at a time, not both.

**Storage invariant:** every file write must be write-then-rename, with a checksum stored in SQLite, and integration tests must verify byte-exact round trips. Data loss is the catastrophic risk (`PLAN.md` §6).

**S3 API scope (Phase 4):** cover the 95% path (`PutObject`, `GetObject`, `HeadObject`, `DeleteObject`, `ListObjectsV2`, multipart, `CopyObject`, presigned URLs, basic bucket ops). Versioning, lifecycle, ACLs, encryption headers are explicitly skipped.

## Phase gating

Each phase in `PLAN.md` §4 must leave BunnyFile runnable and dogfoodable — never ship a broken mid-state. Each phase has an explicit "Done when" criterion; don't claim a phase is complete until that criterion is met. Sequence: Phase 0 (✅ foundation) → 1 (file ops) → 2 (auth + shares) → 3 (tus) → 4 (S3) → 5 (launch polish).

## Commands

| Script | What |
|---|---|
| `bun install` | Install workspace deps |
| `bun run dev` | Run server + web in parallel (Bun workspace filter) |
| `bun run dev:server` / `dev:web` | Run one side only |
| `bun run build` | Build web → `apps/web/dist`, bundle server |
| `bun test` | Run `bun:test` across the workspace |
| `bun run typecheck` | `tsc --noEmit` per package |
| `bun run lint` / `lint:fix` | Biome |
| `bun run docker:up` / `docker:down` | Dev Compose (random host ports) |
| `bun run docker:ports` | Print the assigned host ports |

## Dev ports

Fixed dev ports: **web on `3900`, API on `3901`**. Vite proxies `/api` → `:3901`. Docker Compose binds the same ports on the host — no translation. If either port is already in use locally, change it in one place: `docker-compose.yml` + the `WEB_PORT`/`SERVER_PORT` fallbacks in the app configs.

## When touching the web app

- Routes are file-based under `apps/web/src/routes/`. `routeTree.gen.ts` is generated by the TanStack router Vite plugin on dev/build — do not hand-edit it and leave it out of git (already in `.gitignore`).
- API calls go through the Eden client at `apps/web/src/lib/api.ts` (`import { api }`) so request/response types flow from `@bunnyfile/server`'s exported `App` type.
- `HeadContent` / `Scripts` / anything SSR-shaped is **not used** — this is a pure SPA served by Elysia.

## When touching the server

- The server exports `app` and `type App` from `apps/server/src/index.ts`. `App` is what the web app imports via `treaty<App>` — changing the API shape flows through Eden types automatically.
- In production, `app.get('/*', ...)` serves `apps/web/dist`. In dev, this path is unreached because Vite handles the browser and only proxies `/api`.
- `import.meta.dir` is used to locate `apps/web/dist` relative to the server file — keep the relative path in sync if the layout changes.
