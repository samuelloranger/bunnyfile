# S3 Phase 4 Remaining Features — Design Spec

Date: 2026-04-23
Status: Approved

## Scope

Complete the remaining Phase 4 S3-compatible API items needed to satisfy the done-when criterion: "replace Nextcloud-to-Kopia backup with BunnyFile-as-S3-target, and a round-trip with rclone preserves every byte."

Features in scope:
1. Multipart uploads (CreateMultipartUpload, UploadPart, CompleteMultipartUpload, AbortMultipartUpload, ListParts)
2. CopyObject
3. Presigned URLs (GET + PUT)
4. Access keys in SQLite (per-user, multiple keys, encrypted secrets) + UI

## Code Structure

Option B: split multipart into its own module, extend sigv4.ts for presigned URL support.

New files:
- `apps/server/src/s3/multipart.ts` — multipart upload handler
- `apps/server/src/s3/access-keys.ts` — access key CRUD routes (BunnyFile session auth)

Modified files:
- `apps/server/src/s3/sigv4.ts` — add `verifyPresigned()` export, refactor key lookup to callback
- `apps/server/src/s3/routes.ts` — presigned dispatch, multipart dispatch, CopyObject
- `apps/server/src/db/schema.ts` — three new tables
- `apps/server/src/db/migrations/0005_s3_multipart_and_access_keys.sql`
- `apps/web/src/routes/_app.settings.tsx` (or equivalent) — S3 access keys UI section

## Database Schema

### `s3_multipart_upload`
| column | type | notes |
|---|---|---|
| upload_id | TEXT PK | UUID |
| bucket | TEXT NOT NULL | |
| key | TEXT NOT NULL | |
| created_at | timestamp | |

Index: `(bucket, key)` for listing uploads per object.

### `s3_multipart_part`
| column | type | notes |
|---|---|---|
| upload_id | TEXT | FK → s3_multipart_upload CASCADE DELETE |
| part_number | INT | 1–10000 |
| size | INT NOT NULL | bytes |
| md5 | TEXT NOT NULL | hex MD5 of this part |
| path | TEXT NOT NULL | absolute path to temp file |

Composite PK: `(upload_id, part_number)`.

Parts stored at `{DATA_DIR}/.multipart/{uploadId}/{zero-padded-partNumber}`.

### `s3_access_key`
| column | type | notes |
|---|---|---|
| id | TEXT PK | UUID |
| user_id | TEXT | FK → user CASCADE DELETE |
| access_key_id | TEXT UNIQUE | `BFAK` + 16 random alphanumeric chars |
| secret_key_encrypted | TEXT | `iv_hex:ciphertext_hex` |
| name | TEXT NOT NULL | human label |
| created_at | timestamp | |

Encryption: AES-256-GCM. Key derived from `BETTER_AUTH_SECRET` via `crypto.hkdfSync('sha256', secret, salt, info, 32)`. Each key pair uses a fresh random 12-byte IV. Secret is returned **once** at creation and never again.

## SigV4 Presigned URL Verification

`sigv4.ts` changes:
- `verifySigV4(request, lookupKey)` — `lookupKey: (accessKeyId: string) => string | null` replaces the config struct. Checks env-var key first, then DB.
- New export `verifyPresigned(request, lookupKey)` — reads auth from query params instead of `Authorization` header:
  - `X-Amz-Algorithm`, `X-Amz-Credential`, `X-Amz-Date`, `X-Amz-Expires`, `X-Amz-SignedHeaders`, `X-Amz-Signature`
  - Payload hash = `UNSIGNED-PAYLOAD`
  - `X-Amz-Signature` excluded from canonical query
  - Validity: `X-Amz-Date` to `X-Amz-Date + X-Amz-Expires` (max 7 days = 604800 seconds)

`routes.ts` detects presigned requests by presence of `X-Amz-Signature` in query string.

Shared `lookupKey` callback tries env-var key, then queries `s3_access_key` table, decrypts and returns secret.

## Multipart Uploads (`multipart.ts`)

Single exported function: `handleMultipart(request, set, bucket, key, url, lookupKey)`.

### CreateMultipartUpload — `POST /api/s3/{bucket}/{key}?uploads`
1. Generate UUID `uploadId`
2. Insert into `s3_multipart_upload`
3. `mkdir {DATA_DIR}/.multipart/{uploadId}/`
4. Return `<InitiateMultipartUploadResult><Bucket/><Key/><UploadId/></InitiateMultipartUploadResult>`

### UploadPart — `PUT /api/s3/{bucket}/{key}?partNumber=N&uploadId=X`
1. Validate `uploadId` exists in DB; `partNumber` 1–10000
2. Stream request body to `{DATA_DIR}/.multipart/{uploadId}/{zero-padded-N}` computing MD5 in one pass
3. Upsert `s3_multipart_part` (replace if part was previously uploaded)
4. Return `200` with `ETag: "md5hex"` header

### CompleteMultipartUpload — `POST /api/s3/{bucket}/{key}?uploadId=X`
1. Parse XML body via regex to extract ordered `[{partNumber, etag}]` list
2. Load parts from DB ordered by `part_number`
3. Verify client ETags match DB MD5s (mismatch → 400 InvalidPart)
4. Stream parts sequentially into `{DATA_DIR}/s3/{bucket}/{key}.tmp-{uuid}`, then rename
5. Compute final ETag: `"md5(concat(binary_md5_of_each_part))-{numParts}"`
6. Upsert `s3_object` with final size, mtime, md5
7. Delete temp part files + `s3_multipart_upload` row (CASCADE deletes parts)
8. Return `<CompleteMultipartUploadResult><Location/><Bucket/><Key/><ETag/></CompleteMultipartUploadResult>`

### AbortMultipartUpload — `DELETE /api/s3/{bucket}/{key}?uploadId=X`
1. Load part paths from DB
2. Delete all part files (best-effort)
3. Delete `s3_multipart_upload` row (CASCADE deletes parts)
4. Delete temp directory
5. Return `204`

### ListParts — `GET /api/s3/{bucket}/{key}?uploadId=X`
Return `<ListPartsResult>` with `<Part>` elements containing `PartNumber`, `ETag`, `Size`.

## CopyObject (`routes.ts`)

Detected by `x-amz-copy-source` header on object `PUT`.

1. Parse header value as `/bucket/key` (URL-decode, validate both)
2. Look up source MD5 from `s3_object`; if missing, compute MD5 from disk
3. `copyFile(src, dst_tmp)` then `rename(dst_tmp, dst)` (write-then-rename invariant)
4. `stat(dst)` for size + mtime
5. Upsert `s3_object` for destination
6. Return `<CopyObjectResult><ETag/><LastModified/></CopyObjectResult>`

## Access Keys Backend (`access-keys.ts`)

Routes under `/api/s3/access-keys`, protected by BunnyFile session auth (not SigV4).

- `GET /api/s3/access-keys` — list caller's keys: `[{id, access_key_id, name, created_at}]` (no secrets)
- `POST /api/s3/access-keys` body `{name}` — generate key pair, return `{access_key_id, secret_access_key}` once
- `DELETE /api/s3/access-keys/:id` — revoke (user can only revoke own keys; admin can revoke any)

## Access Keys UI

New "S3 Access Keys" section on the settings page:
- Table: key name, access key ID, created date, Revoke button
- "Generate New Key" button → modal showing `access_key_id` + `secret_access_key` with copy buttons and "I've saved this key" confirmation before closing
- Uses Eden client for type-safe API calls

## Testing

- `s3/multipart.test.ts` — full lifecycle: create → upload 3 parts → complete; abort cleans up temp files; ListParts; ETag format validation
- `s3/sigv4.test.ts` (extend existing) — presigned GET + PUT verification; expiry enforcement
- `s3/routes.test.ts` (extend existing) — CopyObject happy path + cross-bucket copy
- `s3/access-keys.test.ts` — CRUD, secret returned once, encryption round-trip

## Out of Scope

Per PLAN.md: versioning, lifecycle policies, ACLs, encryption headers, CORS configuration.
