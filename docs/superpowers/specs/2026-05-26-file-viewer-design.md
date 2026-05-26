# File Viewer Design

**Date:** 2026-05-26  
**Status:** Approved

## Overview

Replace the rudimentary inline `FilePreviewModal` in `_app.files.tsx` with a proper, polished file viewer system. The viewer opens as a modal overlay and supports custom video/audio players, pan+zoom image viewing, PDF display, syntax-highlighted code, and rendered Markdown. Prev/next navigation cycles through files in the current folder without closing the modal.

## Architecture

### File Structure

```
apps/web/src/components/ui/
  file-preview-modal.tsx        ← modal shell, navigation, viewer dispatch
  viewers/
    image-viewer.tsx
    video-viewer.tsx
    audio-player.tsx
    pdf-viewer.tsx
    code-viewer.tsx
    markdown-viewer.tsx
    unsupported-viewer.tsx
```

### Responsibilities

**`file-preview-modal.tsx`** owns:
- The `Modal` / `ModalContent` wrapper
- Prev/next navigation state (current index into the files-only subset of `entries`)
- MIME-based dispatch to the correct viewer component
- Top bar: filename, MIME badge, download button, close button
- Keyboard listener for `←` / `→` arrow keys (active only while modal is open)

**Each viewer** owns only its own rendering and local state (playback position, zoom level, fetch state). No viewer knows about navigation or the file list.

### MIME Dispatch

| MIME prefix / value | Viewer |
|---|---|
| `image/*` | ImageViewer |
| `video/*` | VideoViewer |
| `audio/*` | AudioPlayer |
| `application/pdf` | PdfViewer |
| `text/markdown` | MarkdownViewer |
| `text/*`, `application/json` | CodeViewer |
| anything else | UnsupportedViewer |

`text/markdown` is checked before `text/*` so Markdown files get the richer viewer.

## Individual Viewers

### ImageViewer

- Powered by `react-zoom-pan-pinch`
- Image initially fit-to-container, centered
- Scroll wheel and pinch gesture zoom; click-drag to pan
- HUD in bottom-right: zoom percentage, zoom-in, zoom-out, reset buttons
- Dark checkerboard CSS background to make transparent PNGs visible

### VideoViewer

- Native `<video>` element with `controls` hidden
- Custom control bar at the bottom of a `bg-black` letterbox container:
  - Play/pause button
  - Current time / total duration
  - Seek bar (`<input type="range">`)
  - Volume slider + mute toggle
  - Fullscreen button
- Built using the native `HTMLMediaElement` API — no extra library

### AudioPlayer

- Native `<audio>` element, hidden
- Centered card layout:
  - Large file-type icon placeholder
  - Filename
  - Play/pause button + seek bar + time display
  - Volume slider + mute toggle
- Built using the native `HTMLMediaElement` API — no extra library

### PdfViewer

- `<iframe>` at `100% width`, `75vh` height
- Thin toolbar above: filename + "Open in new tab" button
- No custom PDF rendering — relies on browser's built-in PDF viewer

### CodeViewer

- Fetches file text via `GET /api/files/content?path=...` (capped at 200KB)
- Language auto-detected from file extension
- Rendered via `shiki` using `github-dark` in dark mode and `github-light` in light mode (detected via `prefers-color-scheme` or the app's theme class)
- Falls back to plain monospace text if language is unrecognized
- Copy-to-clipboard button in the top-right corner
- Shows a banner "File truncated at 200KB" when the cap is hit

### MarkdownViewer

- Fetches file text via `GET /api/files/content?path=...`
- Rendered via `react-markdown` + `rehype-sanitize` (raw HTML stripped)
- Tailwind prose classes for typography
- "Rendered" / "Raw" tab toggle so the user can inspect the source

### UnsupportedViewer

- Generic file icon
- MIME type label
- Prominent download button
- No "coming soon" language

## Navigation

- `FilePreviewModal` receives `entries` (full list) and `previewPath` from `_app.files.tsx`
- It derives `fileEntries = entries.filter(e => e.kind === 'file')`
- Prev/next buttons increment/decrement the current index; wraps around
- A new `onNavigate(path: string)` prop replaces `setPreviewPath` calls from inside the modal
- Keyboard: `←` / `→` keys, listener skips when focus is on `<input>`, `<video>`, `<audio>`, or `<textarea>`
- Prev/next buttons are hidden (not disabled) when `fileEntries.length <= 1`

## Data Flow

- No new server endpoints required
- Image, video, audio, PDF: URL passed directly to browser element (`/api/files/content?path=...`)
- Code, Markdown: fetched client-side inside the viewer component
- State reset: each viewer receives `key={entry.path}` so React remounts on file change, cleanly resetting all local state

## Error Handling

| Scenario | Behaviour |
|---|---|
| Content fetch failure (code/markdown) | Inline error message + "Download instead" link |
| Unsupported MIME type | UnsupportedViewer with download button |
| Text file truncated at 200KB | Banner at top of CodeViewer |
| Unsafe HTML in Markdown | Stripped by `rehype-sanitize`; Raw tab still available |
| Browser can't play audio/video format | Fallback message below player + download link |

## Dependencies

| Package | Purpose |
|---|---|
| `react-zoom-pan-pinch` | Image pan + zoom |
| `shiki` | Syntax highlighting for CodeViewer |
| `react-markdown` | Markdown rendering |
| `rehype-sanitize` | Sanitize Markdown HTML output |

All are frontend-only additions. No server changes required.

## What Is Not Changing

- The `/api/files/content` endpoint — used as-is
- The `previewPath` / `onOpenChange` state in `_app.files.tsx` — the prop interface is extended minimally (add `onNavigate`, pass `entries`)
- The `Modal` / `ModalContent` primitive components
- All other routes and components
