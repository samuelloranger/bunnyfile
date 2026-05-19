# BunnyFile 🐰

> Files, shared. That's it.

Lightweight self-hosted file hosting and sharing, built on Bun. S3-compatible API, upload progress feedback, and a minimal architecture. Replaces the "files" half of Nextcloud — nothing more.

**Status:** Phase 5 — launch polish. See [`PLAN.md`](./PLAN.md).

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

## Production deploy

Pre-built images publish to GHCR on GitHub Release (`ghcr.io/<owner>/bunnyfile:latest`).

Example stacks live in [`deploy/compose/`](./deploy/compose/):

| File | Use case |
|---|---|
| `standalone.yml` | Single container + volume |
| `caddy.yml` | HTTPS reverse proxy |
| `tinyauth.yml` | Forward-auth layout (see PLAN.md) |

Copy `deploy/compose/.env.example` → `.env` and set `BETTER_AUTH_SECRET` before first boot.

## Docs

| Doc | Contents |
|---|---|
| [`docs/s3-compatibility.md`](./docs/s3-compatibility.md) | S3 client setup, supported ops, limitations |
| [`docs/migrating-from-nextcloud.md`](./docs/migrating-from-nextcloud.md) | Files-only migration guide |

## Observability

- **OpenAPI / Swagger UI:** `/api/docs` (REST routes; S3 excluded — use AWS docs)
- **Prometheus metrics:** `GET /metrics`
- **Load smoke test:** `bun scripts/load-test.ts http://localhost:3901`

## Roadmap

See [`PLAN.md`](./PLAN.md) for development phases 0–6.

## S3-compatible API

BunnyFile speaks enough S3 for rclone, aws-cli, restic, and kopia. The API lives at `/api/s3` on the same host as the web app.

**Quick rclone config:**

```ini
[bunnyfile]
type = s3
provider = Other
env_auth = false
access_key_id = YOUR_KEY
secret_access_key = YOUR_SECRET
endpoint = http://localhost:3901/api/s3
region = us-east-1
force_path_style = true
```

Create per-user keys in the app under **Settings**, or set `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` in the environment for a single global key.

Full client setup, supported operations, and known limitations: [`docs/s3-compatibility.md`](./docs/s3-compatibility.md).
