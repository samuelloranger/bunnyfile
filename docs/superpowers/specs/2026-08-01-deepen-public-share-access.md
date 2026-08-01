# Deepen Public Share Access

**Status:** ready-for-agent  
**Date:** 2026-08-01  
**Source:** architecture review (Strong / top recommendation)  
**Related:** absorb folder-share zip (companion spec); Storage path seam (runner-up)

## Problem Statement

Anyone who works on public shares — including agents and future maintainers — has to reconstruct one idea (“may this token download?”) from an HTTP route handler that also owns password checks, download-count leases, folder-zip materialization, rate limiting, and filesystem probes. Bugs and security fixes keep landing in the hottest file because policy lives in the adapter, not behind a deep module. Tests either go through Elysia or miss the lease/zip interactions entirely.

## Solution

Introduce a deep **Public Share Access** module with a small interface: inspect a token, verify a password, and begin a download. HTTP routes become a thin adapter. Folder-zip cache policy and download leases sit behind that interface so locality concentrates: one place to fix max-download races, password gating, and folder-share bytes.

## User Stories

1. As a share recipient, I want to open a public link and see whether the share is available, so that I know if I can download.
2. As a share recipient, I want locked shares to hide file identity until I prove the password, so that casual link viewers learn nothing useful.
3. As a share recipient, I want to enter a password and unlock metadata, so that I can confirm I have the right file before downloading.
4. As a share recipient, I want a wrong password to fail clearly, so that I can retry without wondering if the link is dead.
5. As a share recipient, I want an expired share to refuse download, so that time-boxed sharing is trustworthy.
6. As a share recipient, I want a revoked share to refuse download, so that the owner can kill a link immediately.
7. As a share recipient, I want a max-download share to refuse further downloads once the limit is reached, so that the owner’s cap is honored.
8. As a share recipient, I want a cancelled mid-download not to permanently consume a leased slot, so that flaky networks don’t burn the quota.
9. As a share recipient, I want a completed download to count exactly once, so that counters stay honest.
10. As a share recipient, I want folder shares to download as a zip, so that I get the whole folder in one action.
11. As a share recipient, I want folder-share size/name to reflect the zip artifact, so that the UI matches what I will receive.
12. As a share recipient, I want passworded downloads to send the password in the POST body only, so that passwords do not appear in URLs or logs.
13. As a share recipient, I want open (no-password) shares to still download via the same begin-download path, so that one code path owns policy.
14. As a rate-limited client, I want abusive hammering of a token to get 429, so that share endpoints stay usable for others.
15. As a share owner, I want creating a file share to remain a simple authenticated action, so that sharing stays frictionless.
16. As a share owner, I want creating a folder share to materialize (or schedule) the zip behind the same access module, so that create and download stay consistent.
17. As a share owner, I want revoking a share to invalidate public access immediately, so that leaked links die on revoke.
18. As a share owner, I want listing my shares to keep working unchanged, so that management UI does not regress.
19. As a developer, I want to test inspect/verify/beginDownload without standing up HTTP, so that policy tests are fast and precise.
20. As a developer, I want lease commit/release behavior testable at the module seam, so that max-download races are caught without browser automation.
21. As a developer, I want folder-zip freshness decisions behind the same seam, so that I do not bounce through three modules to understand one download.
22. As an agent working in this repo, I want one module name for “public share access,” so that AI navigation and human navigation agree.
23. As an operator, I want existing public URLs (`/s/:token` and `/api/shares/public/...`) to keep working, so that already-shared links do not break.
24. As a product owner, I want no new share product features in this change, so that the deepen stays an architecture win, not scope creep.

## Implementation Decisions

- Build a **Public Share Access** module whose interface is approximately: `inspect(token)`, `verify(token, password?)`, `beginDownload(token, password?)` (names may vary; shape is the decision).
- `inspect` returns availability + locked/unlocked public metadata per existing hardening rules (locked shares do not leak path/name/size/mime).
- `verify` proves password when required and returns unlocked metadata; does not start a download by itself.
- `beginDownload` performs authorize → resolve bytes (file or folder zip) → apply download-count lease → return a stream plus content headers enough for the HTTP adapter to build a Response.
- HTTP share routes become an adapter: map status codes and wire rate-limit + request IP around the module; they do not own share state machines.
- Download-lease hooks remain an internal detail of Public Share Access (or a private helper it owns), not a second public seam.
- Folder-share zip ensure/build/invalidate is absorbed behind this module (see companion absorb spec); callers do not orchestrate zip cache from routes.
- Prefer relative-path Storage calls once the Storage path-seam deepen lands; until then, minimize abs-path leakage from this module’s interface even if internals still resolve paths.
- No schema change required for the deepen itself; existing `shareLink` columns and counters remain the source of truth.
- Public HTTP contracts stay stable: create/list/revoke authenticated routes and public inspect/verify/download endpoints keep their URLs and response shapes unless a bug fix demands otherwise.
- Web public share page keeps verify-then-native-POST download flow; no UI redesign in this spec.

## Testing Decisions

- Good tests assert external behavior at the Public Share Access seam: given token/password/stream lifecycle, assert status, metadata redaction, counter lease semantics, and bytes identity — not internal helper call order.
- Primary module under test: Public Share Access.
- Prefer existing share route/folder-share/download-lease tests as prior art; migrate or add focused module tests at the new seam rather than only HTTP-level coverage.
- Cover at least: locked metadata redaction; bad password; expired/revoked/maxed; lease release on cancel; lease commit on complete; file vs folder zip download; rate limit remains at HTTP adapter (optional thin adapter test).
- Do not require browser E2E for the deepen; keep `s.$token` behavior covered indirectly via API contracts already used by the page.

## Out of Scope

- New share product features (QR, per-user ACL, analytics, custom domains).
- Redesigning the public share web UI.
- Sealing the Storage abs-path seam (separate spec) except for not widening leakage.
- File Library mutation deepen (separate spec).
- S3 API changes.
- Changing PLAN.md non-goals or adding sync/WebDAV/etc.

## Further Notes

- Architecture review strength: **Strong**; hottest recent git surface.
- Deletion test: collapsing policy out of the HTTP adapter concentrates complexity behind a smaller interface.
- Companion speculative work: absorb folder-share zip into this module rather than deepening `folder-zip` alone.
- Domain vocabulary: Share, Public Share Access, Storage, download lease, folder zip. No `CONTEXT.md` yet — add “Public Share Access” if/when domain-modeling runs.
