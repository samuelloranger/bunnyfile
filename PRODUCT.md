# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

**Primary:** Homelabbers who currently run Nextcloud (or similar) mainly for files and resent the weight — starting with the author dogfooding their own storage.

**Also served (secondary):**
- Developers who want a simple personal S3-compatible store without MinIO’s operational complexity
- Freelancers / small teams who need share links for clients without WeTransfer/Dropbox

**Not targeting:** enterprise, teams larger than about 10, or anyone seeking “Google Drive at home.”

## Product Purpose

BunnyFile is a lightweight, self-hosted file hosting and sharing server. It exists so people can host files and share them — not run a collaboration suite, sync engine, or calendar/contacts/mail stack.

Success means: browse, upload, download, organize, preview, search, and share files reliably on your own hardware, with an S3-compatible API for the tools you already use, at a fraction of Nextcloud’s resource cost.

## Positioning

BunnyFile wins by being *less* than Nextcloud/Seafile, not more: Bun-fast cold start and low idle RAM, a modern SPA for file work, and a first-class S3-compatible API — without WebDAV, SFTP, plugins, or enterprise SSO.

Tagline (binding): **Files, shared. That's it.**

## Operating Context

- Self-hosted on a homelab or VPS; typically one Docker container (Elysia serves `/api/*` and the SPA on `/`)
- Files live on the local filesystem; metadata in SQLite
- Operators often put Caddy (or similar) in front for TLS; optional Tinyauth/Caddy forward-auth as an alternative to native sessions (one auth mode at a time)
- Ecosystem tools via S3: rclone, aws-cli, restic, kopia, Cyberduck, mobile S3 clients
- Shared workspace model: authenticated users share one files tree; folder conventions (e.g. `alice/`) are the separation strategy, not per-user ACLs

## Capabilities and Constraints

**Confirmed capabilities:** browse/upload/download/delete/move, folders, previews, keyboard nav, drag-and-drop, upload progress, FTS search, trash, share links (password/expiry/download limits + QR), native email/password auth (admin/user roles, people management, profile/sessions), S3 API (SigV4, multipart, presigned URLs, per-user access keys) plus in-app S3 console (buckets/objects/keys), light/dark/system theme, OpenAPI at `/api/docs`.

**Hard non-goals (do not implement):**
- Sync clients → Syncthing / rclone
- WebDAV → `rclone serve webdav` in front
- SFTP / FTP → SFTPGo
- Calendar / contacts / mail / Talk / collaborative editing → Nextcloud
- Plugin marketplace, LDAP/SAML, fine-grained RBAC

**Technical invariants:** write-then-rename for file writes; checksums in SQLite; byte-exact round-trip coverage in tests. Data loss is the catastrophic risk.

**Undecided:** formal accessibility standard (see Accessibility & Inclusion).

## Brand Commitments

- **Name:** BunnyFile
- **Tagline:** Files, shared. That's it.
- **Voice:** plain, direct, anti-bloat; prefer “use the right tool for that” over feature creep
- **Assets:** logo (`apps/web/src/assets/logo-transparent.svg`), favicons / OG image under `apps/web/`, release screenshots in `docs/screenshots/`
- **License:** AGPL-3.0

## Evidence on Hand

- Product plan and non-goals: `PLAN.md`
- Public pitch and operator docs: `README.md`
- S3 compatibility notes: `docs/s3-compatibility.md`
- Automated UI screenshots: `docs/screenshots/` (browser, preview, share)
- Design system capture: `DESIGN.md` (visual authority; not product strategy)

**Do not fabricate:** testimonials, customer counts, benchmarks beyond claims already published in README/PLAN, pricing, or a live demo site (demo deferred).

## Product Principles

1. **Less is the product** — every Nextcloud-shaped ask defaults to “use that for that.”
2. **Files stay real** — local filesystem + integrity checks beat abstract blob theater.
3. **Protocols that earn their keep** — REST + S3 yes; WebDAV/SFTP/FTP no.
4. **Homelab-operable** — one process, SQLite, Docker; no Redis/MariaDB tax.
5. **Share without an account factory** — passworded, expiring links for people outside the house.

## Accessibility & Inclusion

**Open decision.** No product-specific WCAG (or similar) bar has been adopted yet. Until decided, prefer semantic HTML, labeled controls, keyboard access, and contrast that meets WCAG AA as engineering practice — without claiming a certified target.
