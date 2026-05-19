# Migrating from Nextcloud (files only)

You run Nextcloud for files and nothing else. BunnyFile is built for exactly that workflow — without calendars, Talk, or a 1 GB PHP stack.

## What maps cleanly

| Nextcloud | BunnyFile |
|---|---|
| Files app / Web UI | `/files` in the SPA |
| Public share links | Share dialog + `/s/:token` |
| External storage (local disk) | `DATA_DIR` on the host volume |
| Desktop sync | **Not built-in** — use [Syncthing](https://syncthing.net/) or [rclone](https://rclone.org/) |
| WebDAV | **Not built-in** — run `rclone serve webdav` in front if needed |
| S3 / primary storage apps | Native S3 API at `/api/s3` |

## Migration steps

### 1. Copy file bytes

Stop Nextcloud writes, then copy your data directory to BunnyFile's `DATA_DIR`:

```bash
# Example: Nextcloud data root → BunnyFile data root
rsync -aH --info=progress2 /var/www/nextcloud/data/admin/files/ /opt/bunnyfile/data/files/
```

BunnyFile uses a flat filesystem layout (no per-user `files/` subdirs unless you create them). If you had multiple Nextcloud users, pick a folder layout that makes sense for your household — e.g. `alice/`, `bob/` top-level directories.

### 2. Start BunnyFile and rescan

```bash
docker compose -f deploy/compose/standalone.yml up -d
```

Sign in as admin, then **Settings** or hit `POST /api/files/rescan` (admin) to rebuild the SQLite index from disk.

### 3. Point backups at the S3 API

Create S3 access keys in **Settings**, then repoint Kopia/restic/rclone:

```ini
# rclone remote
[bunnyfile]
type = s3
provider = Other
endpoint = https://your-host.example/api/s3
access_key_id = BFAK...
secret_access_key = ...
region = us-east-1
force_path_style = true
```

See [`docs/s3-compatibility.md`](./s3-compatibility.md) for restic/kopia examples.

### 4. Recreate share links

Nextcloud share tokens do not transfer. Create new BunnyFile shares for anything still in active use — they support expiry, passwords, download limits, and QR codes.

### 5. Retire Nextcloud (when ready)

Keep Nextcloud read-only until you've verified:

- File counts and spot-checks match
- A backup tool round-trip (`rclone sync` or restic restore) preserves bytes
- Critical share links are reissued

## What not to migrate

- **User accounts** — recreate users on `/people` (admin invites)
- **Activity / versions / trash** — BunnyFile has no file versioning in v1
- **Collabora/OnlyOffice** — out of scope; keep Nextcloud for that if needed
- **Mobile sync app** — use Syncthing or an S3 client against BunnyFile

## Typical homelab end state

```
Internet → Caddy → BunnyFile (SPA + /api + /api/s3)
                      └── volume: /data (SQLite + files)
Kopia/restic ──S3──► BunnyFile (backups land in s3/my-backups bucket)
Phone/laptop ──Syncthing──► host folder ──rsync──► BunnyFile DATA_DIR (optional)
```

You're done when BunnyFile is the only service you open for "drop a file and share a link."
