# BunnyFile 🐰

> Files, shared. That's it.

Lightweight self-hosted file hosting and sharing, built on Bun. S3-compatible API, upload progress feedback, and a minimal architecture. Replaces the "files" half of Nextcloud — nothing more.

**Status:** Pre-alpha. See [`PLAN.md`](./PLAN.md).

## Non-goals (what BunnyFile deliberately is NOT)

- ❌ Nextcloud clone
- ❌ Sync client (use Syncthing / rclone)
- ❌ WebDAV / SFTP / FTP (use SFTPGo or rclone in front)
- ❌ Calendar / contacts / mail / Talk / collaborative editing
- ❌ Plugin marketplace
- ❌ Enterprise SSO / LDAP

If you need those, Nextcloud and Seafile are great. BunnyFile wins by being less.

## The pitch

- **Fast:** cold start <500ms, idle RAM <100MB
- **Compatible:** first-class S3 API — rclone, aws-cli, restic, kopia, Cyberduck all just work
- **Minimal:** Bun + SQLite + local filesystem. No Redis, no MariaDB, no Elasticsearch
- **Reliable:** upload progress feedback in the SPA plus byte-exact integrity testing

## Stack

- **Runtime:** Bun ≥ 1.3
- **Server:** Elysia (serves `/api/*` and the built web app on `/`)
- **Web:** React 19 + Vite + TanStack Router + TanStack Query + Tailwind CSS (SPA — no SSR)
- **Storage:** Local filesystem, SQLite (`bun:sqlite`) for metadata
- **Tests:** `bun:test`
- **Lint/format:** Biome
- **Typed API client:** Elysia Eden (web → server)

## Quickstart (dev)

```bash
bun install

# Run server + web in parallel (web proxies /api to server)
bun run dev

# Or individually:
bun run dev:server   # → http://localhost:3901
bun run dev:web      # → http://localhost:3900
```

Server exposes `GET /api/health`. In dev, the web app runs on Vite and proxies `/api` to the server.

## Quickstart (docker, dev)

Dev Compose assigns **random available host ports** to avoid collisions:

```bash
bun run docker:up      # starts containers
bun run docker:ports   # prints the assigned URLs
bun run docker:down
```

## Production

Single container. Elysia serves `/api/*` and the built SPA on `/`:

```bash
docker build -t bunnyfile .
docker run -p 3901:3901 -v bunnyfile-data:/data bunnyfile
```

## Scripts

| Script | What |
|---|---|
| `bun run dev` | Run server + web in parallel (Bun workspaces filter) |
| `bun run build` | Build web → `apps/web/dist` and bundle server |
| `bun test` | Run `bun:test` suites across the workspace |
| `bun run typecheck` | `tsc --noEmit` in every package |
| `bun run lint` / `lint:fix` | Biome |

## Roadmap

See [`PLAN.md`](./PLAN.md) for development phases 0–6.
