# Deepen File Library mutations

**Status:** ready-for-agent  
**Date:** 2026-08-01  
**Source:** architecture review (Worth exploring)  
**Related:** Storage path seam; Public Share Access (read path only)

## Problem Statement

Authenticated file mutations are orchestrated in a very large HTTP routes adapter: durable write via Storage, then manual `fileIndex` upsert, search index update, thumbnail kickoff, and SSE broadcast — repeated across upload, move, delete, trash, and restore. Understanding “what happens when a file changes” requires bouncing through the route file and several helpers. Bugs hide in the stitching, not in Storage’s byte path. Tests that only hit HTTP miss the library invariants; tests that only hit Storage miss metadata locality.

## Solution

Deepen a **File Library** module whose interface is the mutation vocabulary: upload, move, trash, restore, remove (and folder create as needed). Behind that interface, File Library owns bytes-via-Storage plus metadata side effects (index, search, thumbnails, change broadcast). HTTP routes become an auth/validate/adapt layer. Later, S3 PutObject-style paths can reuse the same mutation interface where semantics align.

## User Stories

1. As an authenticated user, I want uploading a file to persist bytes durably, so that a crash does not leave a partial visible file.
2. As an authenticated user, I want an uploaded file to appear in listings immediately, so that the UI matches disk.
3. As an authenticated user, I want search to find a file after upload, so that discovery stays current.
4. As an authenticated user, I want thumbnails for eligible images after upload, so that the browser stays visual.
5. As an authenticated user, I want other sessions to learn about changes via existing events, so that multi-tab use stays coherent.
6. As an authenticated user, I want move/rename to update bytes and metadata together, so that orphans and stale index rows do not appear.
7. As an authenticated user, I want trash to remove the file from the library view and keep restore possible, so that deletes are reversible.
8. As an authenticated user, I want restore to bring bytes and metadata back, so that undo works end-to-end.
9. As an authenticated user, I want permanent delete to clear bytes and metadata, so that purge is complete.
10. As an authenticated user, I want folder create to remain available, so that browsing structure still works.
11. As an authenticated user, I want folder archive download behavior unchanged externally, so that zip-from-browser keeps working.
12. As a developer, I want mutation tests at the File Library seam, so that I do not need a full HTTP stack to assert index+bytes invariants.
13. As a developer, I want routes to stop re-implementing index bookkeeping, so that new mutation endpoints cannot forget a step.
14. As an S3 implementer, I want a clear future path to call File Library (or a shared internal mutation helper) for put-like semantics, so that duplication shrinks later without blocking this deepen.
15. As an agent, I want “File Library” as the name for mutation locality, so that navigation matches domain language.
16. As a reviewer, I want Storage to remain the byte seam under File Library, so that we do not merge disk IO and HTTP into one blob.
17. As an operator, I want scanner/watcher reconciliation to keep working, so that external disk edits still heal the index.
18. As a product owner, I want no new UX for this change, so that the deepen is invisible to end users.
19. As a tester, I want failure mid-mutation defined (bytes vs metadata), so that partial failure modes are explicit rather than accidental.
20. As a share owner, I want shares pointing at moved/trashed paths to keep today’s behavior unless a separate spec changes it, so that this deepen does not silently redefine share validity.
21. As a security reviewer, I want path validation to remain before mutation, so that reserved/traversal rules are not weakened.
22. As a performance-conscious host, I want thumbnail work to remain asynchronous where it already is, so that uploads do not block on image work.
23. As a docs reader, I want the shared-workspace model unchanged, so that ACL expectations stay as documented.
24. As a future maintainer, I want one place to add a new post-mutation effect, so that leverage beats copy-paste.

## Implementation Decisions

- Introduce a **File Library** module with a mutation-focused interface: upload, move, trash, restore, remove, and folder create as required by current product behavior.
- File Library calls Storage for bytes; it does not reimplement durable write.
- File Library owns orchestration of file index rows, search upsert/delete, thumbnail scheduling, and files-changed broadcast for those mutations.
- HTTP files routes authenticate, validate user-facing paths, and call File Library; they do not upsert index/search inline for covered mutations.
- Scanner, watcher, and cron remain separate entry points that may call File Library or lower-level helpers — do not force every background job through HTTP shapes.
- Prefer sealed Storage relative-path interface when that spec is done; do not block File Library on it, but avoid widening abs-path leakage.
- Define failure semantics for “bytes committed, metadata failed” (retry, compensate, or surface error) as an explicit decision during implementation grilling if not obvious from prior art — default: prefer failing the request after compensating when safe; never leave silent index lies when detectible.
- No new database tables required for the deepen; use existing index/search/thumbnail tables.
- External `/api/files/*` contracts stay stable.
- S3 reuse is allowed as a follow-on; this spec does not require rewriting S3 routes in the same change set.

## Testing Decisions

- Good tests assert File Library external behavior: after upload/move/trash/restore/remove, disk bytes and index/search visibility match; broadcasts fire when expected.
- Primary module under test: File Library.
- Prior art: files route tests and store integrity tests — keep route tests as adapter smoke; add module-level tests at the new seam for mutation locality.
- Do not assert call order of internal helpers; assert resulting state.
- Thumbnail generation may be asserted as “scheduled / row present” rather than pixel-perfect in unit tests, matching existing thumbnail test style where present.

## Out of Scope

- Public Share Access deepen (except not breaking share create against library paths).
- Sealing Storage abs paths (separate), except consuming it when available.
- New collaboration features, per-user ACL, or PLAN.md non-goals.
- Rewriting the web files browser UI.
- Mandatory S3 route migration in the same PR.
- Changing trash retention policy or adding new trash UX.

## Further Notes

- Architecture review strength: **Worth exploring** — high leverage, larger blast radius than Share Access.
- Deletion test: removing per-route bookkeeping concentrates complexity in File Library; deleting File Library would re-scatter identical stitching across routes.
- Suggested sequence: Public Share Access and/or Storage seam first if abs-path noise blocks clean File Library boundaries; otherwise File Library can deepen against today’s Storage.
- Domain vocabulary: File Library, Storage, file index, search index, thumbnail, trash.
