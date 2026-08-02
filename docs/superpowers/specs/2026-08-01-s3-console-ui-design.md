# S3 Console UI

**Status:** ready-for-agent  
**Date:** 2026-08-01  
**Source:** product gap after `files/` vs `s3/` layout split (no in-app bucket browser)  
**Related:** existing SigV4 `/api/s3`; access keys in Settings; `docs/s3-compatibility.md`; Storage path seam (separate, not required)

## Problem Statement

S3 object bytes live under `DATA_DIR/s3/` and are invisible in the Files browser by design. Operators can only inspect or mutate buckets via external clients (rclone, aws-cli, Cyberduck). The SPA only manages access keys under Settings. After the layout split, that gap is obvious: there is no first-class place in BunnyFile to see or manage the S3 namespace.

## Solution

Ship a session-authenticated **S3 console** in the SPA: top-level **S3** nav with bucket list, object browser (full in-browser CRUD), and relocated access-key management. Backend work centers on a deep **Bucket Library** module that owns bucket/object operations over the shared `s3/` tree. Thin JSON routes serve the SPA; existing SigV4 `/api/s3` remains the external-client adapter and must keep using the same on-disk layout (ideally calling into Bucket Library or shared helpers so path rules cannot diverge).

**Access policies / IAM / per-key bucket scopes are explicitly deferred.** Keys stay global (any valid key reaches every bucket); the UI and docs state that clearly.

## User Stories

1. As a signed-in user, I want a top-level **S3** nav item, so that buckets are discoverable without leaving the app for rclone.
2. As a signed-in user, I want to list buckets with created dates, so that I can see what exists on this instance.
3. As a signed-in user, I want to create a bucket with a validated name, so that I can start storing objects without a CLI.
4. As a signed-in user, I want to delete an empty bucket, so that I can clean up unused namespaces; non-empty deletes must fail clearly.
5. As a signed-in user, I want to browse objects in a bucket with prefix breadcrumbs, so that folder-like navigation works with delimiter listing.
6. As a signed-in user, I want to upload objects with progress, so that large puts feel like Files uploads.
7. As a signed-in user, I want to download an object, so that I can retrieve bytes without SigV4 tooling.
8. As a signed-in user, I want to delete one or more objects, so that I can manage clutter in-browser.
9. As a signed-in user, I want to copy or move objects (same or other bucket), so that reorganization does not require a client.
10. As a signed-in user, I want to create a prefix (“folder”) without inventing fake policy objects when delimiter listing already surfaces prefixes, so that empty folders behave predictably.
11. As a signed-in user, I want access keys managed under `/s3/keys` (not Settings), so that buckets and credentials live in one product area.
12. As a signed-in user, I want the key-create flow to show the secret once and offer an endpoint snippet for `/api/s3`, so that rclone/aws setup stays easy.
13. As a signed-in user, I want clear UI copy that any access key can reach every bucket, so that the shared-workspace model is not mistaken for IAM.
14. As an operator, I want Files to never list `s3/` objects, so that the namespace split remains intact.
15. As an external S3 client, I want SigV4 `/api/s3` behavior unchanged, so that existing backups and tools do not break.
16. As a developer, I want Bucket Library testable without HTTP, so that byte-exact and path-safety checks stay fast.
17. As a product owner, I want no fine-grained RBAC or JSON IAM policies in this work, so that PLAN/PRODUCT non-goals hold.
18. As a designer, I want the console to reuse existing UI primitives and Files patterns, so that S3 does not become a second visual system.

## Implementation Decisions

- **Approach:** Session REST console (Approach 1). The SPA never holds access-key secrets for ordinary browse/upload; it uses cookie sessions like Files.
- **Module:** Introduce **Bucket Library** with a small interface approximately: `listBuckets`, `createBucket`, `deleteBucket`, `listObjects` (prefix + delimiter + pagination as needed), `putObject`, `getObject` / stream, `headObject`, `deleteObject`, `copyObject`, and prefix creation (see Folders / prefixes). Implementation owns `S3_ROOT` layout rules and durable write/stream invariants.
- **HTTP adapter:** Thin authenticated JSON routes (e.g. `/api/s3-console/*` or `/api/buckets/*`) map session → Bucket Library → JSON/stream responses. 401 when unauthenticated.
- **Who can use it:** Any signed-in user (same shared-workspace model as Files). Admin-only gates are out of scope for v1.
- **SigV4 `/api/s3`:** Remains the external adapter. Prefer routing its storage mutations through Bucket Library (or extract shared helpers immediately) so console and API cannot disagree on traversal, bucket naming, or empty-bucket rules.
- **SPA routes:** `/s3` (bucket list), `/s3/$bucket` (object browser; prefix via path or search param), `/s3/keys` (access keys). Nav label: **S3**.
- **Keys:** Move UI from Settings into `/s3/keys`. Keep existing key crypto and list/create/revoke behavior; wire path may stay `/api/settings/s3-keys` or move under the console prefix with a thin alias — pick one in the plan, do not fork two key stores.
- **Object UX:** List-first browser with breadcrumbs; upload with existing progress patterns; download-first for objects in v1 (inline preview only if reusing existing viewers is cheap). Multi-select delete reports per-item failures rather than silent partial success.
- **Folders / prefixes:** Prefer **prefix-only** empty folders when the list API can represent them via delimiter; avoid durable zero-byte marker objects unless required for empty-prefix visibility. The implementation plan must pick one mechanism and test it.
- **Copy/move:** Supported across buckets on the same instance; move = copy + delete with clear failure if delete fails after copy.
- **Docs:** Update README / `docs/s3-compatibility.md` / PRODUCT capabilities to mention the console and restate global keys. Settings may link to `/s3/keys` if a remnant pointer helps.
- **No schema change** required for buckets/objects (filesystem remains source of truth). Access-key tables unchanged unless a route path rename needs nothing else.

## Testing Decisions

- Primary seam: **Bucket Library** module tests — create/list/delete bucket; put/get/delete byte-exact; list prefix+delimiter; copy; reject traversal and invalid bucket/key names; delete non-empty bucket → conflict.
- Adapter tests: session required; happy-path list/upload/delete JSON; empty vs non-empty bucket delete status codes.
- Existing SigV4 `compat.test.ts` (and related) must stay green.
- No mandatory Playwright E2E for v1; optional manual checklist: create bucket → upload → download → delete object → delete bucket; create/revoke key.
- Do not replace S3 wire compatibility suites with console-only coverage.

## Out of Scope

- IAM / JSON policies / per-key bucket scopes / ACLs / fine-grained RBAC (PLAN non-goal).
- Versioning, lifecycle, encryption headers, multipart **UI** (multipart remains API-only).
- Bridging Files tree and S3 namespace (no showing `s3/` under Files, no “promote file to object” in v1).
- Browser SigV4 client talking to `/api/s3` for the console.
- Completing the Storage abs-path seam deepen (`2026-08-01-seal-storage-path-seam.md`) as a prerequisite — share helpers if useful, but do not block the console on that deepen.
- Redesigning the whole app shell or inventing new primitive libraries.

## Further Notes

- Deletion test: if Bucket Library were removed, path safety and durable put/list rules would re-scatter across SigV4 routes and SPA adapters — the module earns its keep.
- Domain vocabulary: S3 console, Bucket Library, bucket, object key, prefix, access key, shared workspace. SigV4 API is a separate adapter, not the SPA transport.
- Success / done-when: a signed-in user can manage buckets, objects, and keys entirely under **S3** without rclone; Files remains free of S3 objects; external clients still work against `/api/s3`.
