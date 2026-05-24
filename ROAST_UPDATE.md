# BunnyFile Product Polish Plan

## Summary

Fix the "unfinished app" problems from the roast by making Files the authenticated center of the product, removing inert controls, clarifying file search/upload workflows, improving share UX, and hiding development-only surfaces in production. Default choices locked in: authenticated users land in Files, public downloads use the existing streaming endpoint via native form POST, and the Components page remains dev-only.

## Key Changes

- Make `/files` the primary authenticated destination:
  - Change authenticated `/` behavior to redirect to `/files`.
  - Remove Home from primary sidebar, or keep it only if it redirects to Files.
  - Keep `HomeDashboard` only if needed for future work; do not expose it in normal navigation.

- Remove or wire unfinished controls:
  - Sidebar `Upload files` button navigates to `/files` and opens the existing file picker through a route/search trigger such as `?upload=1`.
  - Topbar search becomes a real global file search: typing a query and pressing Enter navigates to `/files?search=<query>` or focuses the Files search when already there.
  - Remove inert Help and Support controls until real help content exists.
  - Keep notifications/theme/account controls as-is.

- Hide development-only Components route:
  - Remove `Components` from sidebar.
  - Gate `/_app.components.tsx` with `import.meta.env.DEV`; in production, redirect to `/files` or render a not-found style state.
  - Let TanStack route generation update naturally through the normal dev/build process.

- Simplify and clarify Files search:
  - Replace the overloaded single search behavior with explicit modes:
    - `Current folder` filters the visible folder entries.
    - `All files` uses `/api/files/search`.
  - Add URL-backed search params for `q` and `mode` so topbar/global search can deep-link into Files.
  - Keep existing sort, pagination, keyboard navigation, drag/drop, preview, rename, share, trash, and rescan behavior.
  - Update empty states and tooltips to avoid admin-only language for normal users; keep rescan visible/admin-oriented.

- Improve public share UX without changing the API:
  - Redesign `/s/$token` around the actual shared file: filename as title, size/type metadata, expiry/download-limit/password badges where available.
  - Replace Blob-based browser download with a native form POST to `/api/shares/public/:token/file`, including hidden password input when required.
  - If the download POST returns an error page/JSON for invalid password, accept that limitation for this pass and keep password validation messaging clear before submit.
  - Do not add backend endpoints or schema changes for this plan.

- Improve landing page:
  - Replace generic card-heavy SaaS copy with a product-specific first viewport showing a realistic file-manager preview/mock using existing UI styling.
  - Keep the pitch terse: self-hosted files, sharing, S3-compatible backup clients.
  - Fix misleading buttons: no "Learn more in the app" link to login. Use "Sign in" and, when setup is needed, "Create admin account."

- Tighten copy and trust cues:
  - Replace user-facing "server logs", "SSH / rsync", and similar operator wording outside admin contexts.
  - Keep technical details in Settings, docs, or admin-only help text.
  - Make public share pages feel trustworthy with BunnyFile instance branding and clear availability states.

## Public Interfaces

- No required backend API or database changes.
- Frontend route/search params to add:
  - `/files?path=<path>&q=<query>&mode=folder|all`
  - Optional `/files?upload=1` trigger for opening the file picker from sidebar/topbar/dashboard actions.
- Existing share endpoint remains:
  - `POST /api/shares/public/:token/file`
  - Browser submits directly as a native form POST so the streamed attachment is handled by the browser.

## Test Plan

- Run `bun run typecheck`, `bun run lint`, and `bun test`.
- Add or update focused web tests where practical for:
  - Files search mode state and URL params.
  - Topbar search navigation into Files.
  - Authenticated `/` redirecting to `/files`.
  - Components route production gating logic.
- Manual browser checks:
  - Sidebar Upload opens file picker on `/files`.
  - Topbar search deep-links to all-files search.
  - `/components` is unavailable in production build.
  - Public share download no longer creates a Blob in client code.
  - Mobile layout has no overlapping topbar/search/sidebar controls.

## Assumptions

- "Fix all issues" means product polish and UX behavior, not a full visual rebrand or new backend feature sprint.
- Native form POST is acceptable for this pass even though invalid-password download errors are less polished than a signed-download-token flow.
- Files should be the app's operational home; dashboard work is deferred unless it becomes a genuinely useful overview later.
