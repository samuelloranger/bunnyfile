# API/Ops Features — Design Spec

**Date:** 2026-04-24
**Phase:** 5 — Launch Polish
**Scope:** OpenAPI spec at `/api/docs` + graceful shutdown with in-flight upload draining

---

## 1. OpenAPI Spec

### Approach

Use the `@elysiajs/swagger` plugin. It generates an OpenAPI 3.0 spec automatically from Elysia's existing typed route annotations — no manual YAML maintenance.

### Endpoints

| Path | Description |
|------|-------------|
| `/api/docs` | Swagger UI (interactive browser) |
| `/api/docs/json` | Raw OpenAPI JSON spec |

### Configuration

- **Title:** BunnyFile API
- **Version:** pulled from `Bun.env.APP_VERSION ?? '0.0.1'`
- **S3 routes excluded:** The S3 API follows the AWS S3 spec; AWS docs are the authoritative reference. Documenting it here would add noise and drift.

### Implementation

One `.use(swagger(...))` call added to `apps/server/src/index.ts`. No other files change.

---

## 2. Graceful Shutdown

### Problem

`writeUpload` streams file bytes to a `.tmp` file, then renames atomically. If the process exits mid-stream, the rename never happens and the upload is silently lost. Same applies to multipart assembly in `completeMultipartUpload`.

### Approach

In-flight counter + drain loop. On SIGTERM/SIGINT:

1. Stop accepting new connections (`server.stop()`)
2. Wait for the active-upload counter to reach zero (poll every 200ms, 30s timeout)
3. Log a warning if timeout expires without draining
4. `process.exit(0)`

### New module: `apps/server/src/inflight.ts`

```
trackUpload<T>(p: Promise<T>): Promise<T>
  Wraps a promise. Increments counter before, decrements on settle.

drainUploads(timeoutMs?: number): Promise<void>
  Polls until counter === 0 or timeoutMs elapsed (default 30_000).
  Logs a warning if it times out with uploads still in progress.
```

### Integration points

| File | Change |
|------|--------|
| `files/store.ts` — `writeUpload` | Wrap the write + rename in `trackUpload` |
| `s3/multipart.ts` — `completeMultipartUpload` | Wrap the part-assembly + rename in `trackUpload` |
| `index.ts` — `import.meta.main` block | Register `SIGTERM` + `SIGINT` handlers |

`uploadPart` (individual part buffers) is short-lived I/O and does not need tracking — only the final assembly that produces the committed file does.

### Signal handling in `index.ts`

```
const server = app.listen(...)

process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)

async function shutdown() {
  server.stop()
  await drainUploads()
  process.exit(0)
}
```

### Timeout behaviour

Default 30s. If uploads are still in progress after the timeout, log a warning listing the count and exit anyway. Partial `.tmp` files are cleaned up by the existing error-path `rm(tmp, { force: true })` on the next startup attempt, or left harmlessly in the data directory.

---

## Out of scope

- Prometheus metrics (removed from scope)
- Load test script (removed from scope)
- Draining non-upload in-flight requests (short-lived reads; OS connection draining via `server.stop()` is sufficient)
