# S3 API compatibility

BunnyFile exposes an AWS Signature Version 4 S3-compatible API at `/api/s3`. The goal is the **95% path** — enough for backup tools and file clients, not full AWS parity.

## Supported operations

| Operation | Notes |
|---|---|
| `ListBuckets` | `GET /api/s3` |
| `CreateBucket` | `PUT /api/s3/{bucket}` |
| `DeleteBucket` | `DELETE /api/s3/{bucket}` (must be empty) |
| `HeadBucket` | `HEAD /api/s3/{bucket}` |
| `PutObject` | Returns `ETag` (MD5 hex) |
| `GetObject` | Full object + HTTP Range (including suffix ranges) |
| `HeadObject` | Metadata + `ETag` |
| `DeleteObject` | Idempotent |
| `ListObjects` / `ListObjectsV2` | Prefix, delimiter, pagination (`marker` / `continuation-token`) |
| Multipart upload | `CreateMultipartUpload`, `UploadPart`, `CompleteMultipartUpload`, `AbortMultipartUpload`, `ListParts` |
| `CopyObject` | Via `x-amz-copy-source` on `PUT` |
| Presigned URLs | SigV4 query-string auth for `GET` and `PUT` (max 7-day expiry) |

## Authentication

Two credential sources work at the same time:

1. **Environment variables** (single global key, good for homelab):
   - `S3_ACCESS_KEY_ID`
   - `S3_SECRET_ACCESS_KEY`
   - `S3_REGION` (default `us-east-1`)

2. **Per-user access keys** (recommended for multi-user):
   - Create keys in the web app under **Settings → S3 Access Keys**
   - Keys use the `BFAK…` prefix; the secret is shown once at creation

All S3 requests must use **path-style** URLs: `/api/s3/{bucket}/{key}`.

## Client configuration

### rclone

```ini
[bunnyfile]
type = s3
provider = Other
env_auth = false
access_key_id = YOUR_ACCESS_KEY_ID
secret_access_key = YOUR_SECRET_ACCESS_KEY
endpoint = https://your-host.example/api/s3
region = us-east-1
force_path_style = true
```

```bash
rclone sync ./local bunnyfile:my-bucket
rclone sync bunnyfile:my-bucket ./backup
```

### aws-cli

```bash
aws configure set aws_access_key_id YOUR_ACCESS_KEY_ID
aws configure set aws_secret_access_key YOUR_SECRET_ACCESS_KEY
aws configure set default.region us-east-1

aws --endpoint-url https://your-host.example/api/s3 s3 cp file.txt s3://my-bucket/
aws --endpoint-url https://your-host.example/api/s3 s3 ls s3://my-bucket/
```

### restic

```bash
export AWS_ACCESS_KEY_ID=YOUR_ACCESS_KEY_ID
export AWS_SECRET_ACCESS_KEY=YOUR_SECRET_ACCESS_KEY

restic -r s3:https://your-host.example/my-bucket \
  --option s3.region=us-east-1 \
  --option s3.endpoint-url=https://your-host.example/api/s3 \
  backup /path/to/data
```

### kopia

```kopia
type: s3
config:
  bucket: my-bucket
  endpoint: https://your-host.example/api/s3
  accessKeyID: YOUR_ACCESS_KEY_ID
  secretAccessKey: YOUR_SECRET_ACCESS_KEY
  sessionToken: ""
  region: us-east-1
```

## Intentionally unsupported

These are out of scope per [PLAN.md](../PLAN.md). Clients that require them will not work:

| Feature | Alternative |
|---|---|
| Bucket/object versioning | Use filesystem backups (Kopia, restic) |
| Lifecycle rules | Cron + scripts on the host |
| ACLs / bucket policies | BunnyFile auth + share links |
| Server-side encryption headers (`SSE-*`, `aws:kms`) | Encrypt at rest on the host volume |
| Object lock / legal hold | Not planned |
| Cross-region replication | Single-node homelab design |
| S3 Select / Glacier tiers | Use standard storage class only |
| Event notifications (SNS/SQS) | Not planned |
| CORS configuration API | CORS is fixed for the web app origin policy |

If a client fails with errors about these features, check whether it can disable them (most backup tools can).

## Testing

Automated coverage lives in `apps/server/src/s3/`:

- `routes.test.ts` — object lifecycle, CopyObject, presigned URLs
- `multipart.test.ts` — multipart upload lifecycle
- `access-keys.test.ts` — encrypted key storage + CRUD
- `compat.test.ts` — byte-exact sync round-trip (SigV4 API) + optional `rclone sync` integration

Run locally:

```bash
bun test apps/server/src/s3
```

The rclone integration test runs when `rclone` is on `PATH` and is skipped otherwise (CI installs rclone).
