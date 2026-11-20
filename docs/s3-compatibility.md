# S3 API compatibility

BunnyFile exposes an AWS Signature Version 4 S3-compatible API at `/api/s3`. The goal is the **95% path** — enough for backup tools and file clients, not full AWS parity.

## Storage model

`DATA_DIR` is a container with sibling trees:

```
DATA_DIR/
  files/       # user-browsable Files UI + share sources
  s3/          # S3 object bytes (buckets/keys)
  trash/       # soft-deleted files
  shares/      # cached folder-share zips
  multipart/   # S3 multipart scratch
```

The **Files browser and the S3 API are separate namespaces**: objects written with rclone do not appear in the file browser, and files uploaded in the UI are not reachable as S3 objects. Buckets are global — any valid access key can reach every bucket (see README Security on the shared-workspace model). Do not hand-edit the internal directories. A backup of `DATA_DIR` includes user files, S3 objects, trash, share caches, and multipart scratch.

On upgrade from pre-v2 layouts, the first boot moves legacy user entries into `files/` and renames `.trash`/`.shares`/`.multipart` (idempotent; writes `.bunnyfile-layout-v2`).

## Web console

Signed-in users can manage the same `s3/` tree from the app under **S3** (`/s3`):

- List / create / delete buckets (delete requires empty)
- Browse objects with prefix folders, upload, download, delete, copy/move
- Manage access keys at **S3 → Access keys** (`/s3/keys`)

The console uses session cookies (`/api/s3-console/*`), not SigV4. Empty folders are represented by a `.keep` marker object under the prefix (trailing-slash keys cannot be stored on the local filesystem path layer).

## Supported operations

| Operation | Notes |
|---|---|
| `ListBuckets` | `GET /api/s3` |
| `CreateBucket` | `PUT /api/s3/{bucket}` |
| `DeleteBucket` | `DELETE /api/s3/{bucket}` (must be empty) |
| `HeadBucket` | `HEAD /api/s3/{bucket}` |
| `GetBucketLocation` | Reports `S3_REGION` (empty for `us-east-1`, like S3) |
| `GetBucketVersioning` | Always reports versioning as never enabled |
| `PutObject` | Returns `ETag` (MD5 hex). Accepts `aws-chunked` bodies (signed or unsigned, with or without trailers) |
| `GetObject` | Full object + HTTP Range (including suffix ranges); `response-*` header overrides |
| `HeadObject` | Metadata + `ETag` |
| `DeleteObject` | Idempotent |
| `DeleteObjects` | Batch delete of up to 1000 keys (`POST /{bucket}?delete`), including quiet mode |
| `ListObjects` / `ListObjectsV2` | Prefix, delimiter, `start-after`, `encoding-type=url`, pagination (`marker` / `continuation-token`). Keys are listed in UTF-8 byte order, like S3 |
| Multipart upload | `CreateMultipartUpload`, `UploadPart`, `CompleteMultipartUpload`, `AbortMultipartUpload`, `ListParts`, `ListMultipartUploads` |
| `CopyObject` | Via `x-amz-copy-source` on `PUT` |
| Conditional requests | `If-None-Match` / `If-Match` on `PutObject`, `CopyObject` and `CompleteMultipartUpload` (atomic, e.g. Terraform's S3 lockfile; `If-Match` uses strong comparison); `x-amz-copy-source-if-*` on `CopyObject`; `If-Match`, `If-None-Match`, `If-Modified-Since`, `If-Unmodified-Since` on `GetObject` / `HeadObject` |
| Presigned URLs | SigV4 query-string auth for `GET` and `PUT` (max 7-day expiry) |

## Upload integrity

Every write is checked before it is committed. On a mismatch the request fails and any previous version of the object stays as it was.

- `Content-MD5`
- A hex `x-amz-content-sha256` (signed payload)
- `x-amz-checksum-crc32`, `-crc32c`, `-crc64nvme`, `-sha1` and `-sha256`, as headers or as `aws-chunked` trailers. Current AWS SDKs send these by default.
- `aws-chunked` chunk and trailer signatures, and `x-amz-decoded-content-length`
- A full-object checksum on `CompleteMultipartUpload`

## Authentication

Two credential sources work at the same time:

1. **Environment variables** (single global key, good for homelab):
   - `S3_ACCESS_KEY_ID`
   - `S3_SECRET_ACCESS_KEY`
   - `S3_REGION` (default `us-east-1`)
   - `S3_DOMAIN` (optional): a hostname that serves the S3 API at its root (see [Endpoints](#endpoints))

2. **Per-user access keys** (recommended for multi-user):
   - Create keys in the web app under **S3 → Access keys**
   - Keys use the `BFAK…` prefix; the secret is shown once at creation

## Endpoints

The S3 API is reachable two ways. Both use **path-style** addressing: the bucket is the first path segment, never a subdomain.

| Endpoint | Use with |
|---|---|
| `https://your-host.example/api/s3` | rclone, the AWS CLI and AWS SDKs (anything that accepts an endpoint URL with a path) |
| `https://s3.your-host.example` (set `S3_DOMAIN`) | restic, kopia, MinIO `mc` and anything else built on minio-go. These take a bare host as the endpoint and cannot reach `/api/s3` |

**`S3_DOMAIN`**: use a hostname of its own, never the web app's (that host would then serve only S3). When a request's `Host` matches it (for example `S3_DOMAIN=s3.your-host.example`), BunnyFile serves the S3 API at the root of that host. Requests are read as `/{bucket}/{key}`, and the web app and `/api/*` are not served there. Point a DNS name at the same container, keep the `Host` header when proxying (Caddy does by default), and do not rewrite the path, because the signature covers it:

```caddy
s3.your-host.example {
	reverse_proxy bunnyfile:3001
}
```

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
aws configure set default.s3.addressing_style path
# `aws s3 presign` defaults to SigV2 URLs, which BunnyFile does not accept.
aws configure set default.s3.signature_version s3v4

aws --endpoint-url https://your-host.example/api/s3 s3 cp file.txt s3://my-bucket/
aws --endpoint-url https://your-host.example/api/s3 s3 ls s3://my-bucket/
```

AWS SDKs need path-style addressing too: `forcePathStyle: true` (JavaScript), `Config(s3={'addressing_style': 'path'})` (boto3), `UsePathStyle = true` (Go v2).

### restic (needs `S3_DOMAIN`)

```bash
export AWS_ACCESS_KEY_ID=YOUR_ACCESS_KEY_ID
export AWS_SECRET_ACCESS_KEY=YOUR_SECRET_ACCESS_KEY

restic -r s3:https://s3.your-host.example/my-bucket init
restic -r s3:https://s3.your-host.example/my-bucket backup /path/to/data
```

### kopia (needs `S3_DOMAIN`)

```bash
kopia repository create s3 \
  --bucket=my-bucket \
  --endpoint=s3.your-host.example \
  --region=us-east-1 \
  --access-key=YOUR_ACCESS_KEY_ID \
  --secret-access-key=YOUR_SECRET_ACCESS_KEY
```

Add `--disable-tls` if the endpoint is plain HTTP.

### MinIO client (needs `S3_DOMAIN`)

```bash
mc alias set bunnyfile https://s3.your-host.example YOUR_ACCESS_KEY_ID YOUR_SECRET_ACCESS_KEY
mc mirror ./local bunnyfile/my-bucket
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

Requests for these subresources (`?tagging`, `?acl`, `?versions`, `?lifecycle`, …) get `501 NotImplemented`. They never touch the object. If a client fails with errors about these features, check whether it can disable them (most backup tools can).

## Testing

Automated coverage lives in `apps/server/src/s3/`:

- `routes.test.ts` — object lifecycle, CopyObject, presigned URLs
- `multipart.test.ts` — multipart upload lifecycle
- `access-keys.test.ts` — encrypted key storage + CRUD
- `compat.test.ts`: byte-exact sync round-trip (SigV4 API), plus optional `rclone sync` and restic (`S3_DOMAIN` root mode) integration
- `sdk.test.ts`: the AWS SDK for JavaScript over HTTPS, including `aws-chunked` uploads, presigned URLs and conditional writes

Run locally:

```bash
bun test apps/server/src/s3
```

The rclone and restic integration tests run when the binary is on `PATH` and are skipped otherwise. CI installs both.
