# Absorb folder-share zip into Public Share Access

**Status:** ready-for-agent  
**Date:** 2026-08-01  
**Source:** architecture review (Speculative)  
**Related:** Deepen Public Share Access (parent); Storage path seam

## Problem Statement

Folder shares introduce a third shallow module between Share HTTP routes and Storage: fingerprinting the folder via the file index, ensuring a cached zip on disk, rebuilding under an in-process lock, and cleaning up on revoke. Understanding “download this folder share” means bouncing across share routes, folder-zip helpers, the generic zipper, and Storage ROOT joins. Deepening folder-zip alone fails the deletion test — it would only relocate shallowness. The complexity belongs inside Public Share Access.

## Solution

Do **not** deepen folder-zip as its own public module. Absorb folder-share materialization (fingerprint, ensure/build, invalidate/remove) into **Public Share Access**. Keep a generic folder zipper as an internal implementation detail (byte packing only). Routes and other callers never orchestrate zip cache policy.

## User Stories

1. As a share recipient, I want folder shares to download as a single zip, so that I receive the whole folder.
2. As a share recipient, I want a stale folder (files changed since last zip) to produce a fresh zip, so that downloads match current contents.
3. As a share recipient, I want concurrent downloads of the same folder share not to stampede rebuilds, so that the server stays stable.
4. As a share recipient, I want metadata size for a folder share to match the zip I will get, so that the UI is honest.
5. As a share owner, I want creating a folder share to prepare the zip artifact without me thinking about cache files, so that sharing stays one action.
6. As a share owner, I want revoking a folder share to delete its cached zip, so that disk does not keep orphan archives.
7. As a share owner, I want file shares to remain unaffected by zip machinery, so that simple shares stay simple.
8. As a developer, I want zip cache policy tested through Public Share Access, so that I do not treat folder-zip as a second seam.
9. As a developer, I want the generic zipper to only pack bytes from a folder root, so that product policy does not leak into the zipper.
10. As a developer, I want fingerprint logic hidden behind Share Access, so that index-query details are not imported by HTTP adapters.
11. As an operator, I want existing cron/sweep cleanup of orphan share zips to keep working or move with the absorb, so that disk stays tidy.
12. As an operator, I want on-disk zip locations to remain compatible unless Storage seam work relocates them deliberately, so that upgrades are calm.
13. As an agent, I want one module owning “folder share as downloadable artifact,” so that navigation does not invent a zip service.
14. As a reviewer, I want no new public interface named after folder-zip, so that shallowness is not re-exported.
15. As a product owner, I want no new folder-share UX in this change, so that absorb stays structural.
16. As a tester, I want rebuild-on-stale and rebuild-on-missing-zip covered at the Share Access seam, so that cache bugs fail tests not production.
17. As a security reviewer, I want folder shares to still respect reserved-path and password/lease rules via Share Access, so that zip absorb cannot bypass gating.
18. As a Storage consumer, I want share artifact cleanup to go through Storage helpers, so that ROOT joins do not return to routes.
19. As a future maintainer, I want deleting the old folder-zip facade to concentrate complexity, so that the deletion test passes.
20. As a docs author, I want folder download (authenticated archive) vs folder share (cached zip) distinguished, so that the two features are not conflated.

## Implementation Decisions

- This spec is an absorb into Public Share Access, not a standalone deep module.
- Public Share Access owns: folder fingerprint, ensure/build zip for a share id + folder rel, invalidate/remove on revoke, and using the zip as the byte source in `beginDownload` / unlocked metadata.
- Generic zipper remains an internal byte-packing helper with no share policy (no fingerprint, no share id layout).
- Remove or privatize any standalone folder-zip public interface once Share Access owns the policy.
- In-process rebuild coalescing stays an implementation detail of Share Access (single Bun process assumption unchanged).
- Authenticated “download folder as zip” for logged-in users may keep using the streaming zipper path; do not force that feature through share cache unless product already does.
- Prefer Storage-relative helpers for artifact paths when the Storage seam spec lands.
- No schema changes required; fingerprint sidecars / zip files remain filesystem artifacts unless a later spec says otherwise.
- External share HTTP behavior stays stable.

## Testing Decisions

- Good tests go through Public Share Access (or existing folder-share tests refocused there): create folder share → download bytes; mutate folder → next download reflects change; revoke → artifact gone; concurrent ensure does not double-build destructively.
- Do not add a second public test seam for folder-zip policy.
- Prior art: folder-share and folder-zip tests — migrate assertions upward into Share Access coverage; keep zipper tests for pure pack/stream behavior only.
- Assert zip content identity at a coarse level (entry names / file bytes sampled) already used by prior art, not implementation of the rebuild Map.

## Out of Scope

- Redesigning folder share UX.
- Replacing fflate/zipper library.
- Multi-process distributed zip build locks.
- Deepening folder-zip as its own deep module (explicitly rejected).
- Changing authenticated folder archive streaming except where necessary to avoid duplicating policy.
- New share product features.

## Further Notes

- Architecture review strength: **Speculative** as a solo candidate; **mandatory companion** when implementing Public Share Access.
- Deletion test: deleting a standalone folder-zip module after absorb should not re-scatter policy — policy lives in Share Access; only the generic zipper remains.
- Implement with or immediately after `2026-08-01-deepen-public-share-access.md`; do not schedule as an independent epic.
- Domain vocabulary: Public Share Access, folder zip, fingerprint, Storage, zipper (internal).
