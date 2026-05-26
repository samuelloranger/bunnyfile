# File Viewer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the rudimentary inline `FilePreviewModal` in `_app.files.tsx` with a polished file viewer system featuring custom video/audio players, pan+zoom image viewing, PDF display, syntax-highlighted code, rendered Markdown, and prev/next navigation.

**Architecture:** Extract a new `FilePreviewModal` component into `components/ui/file-preview-modal.tsx` that dispatches to one of seven focused viewer subcomponents in `components/ui/viewers/`. The parent (`_app.files.tsx`) passes the full entries list so the modal can handle prev/next navigation internally.

**Tech Stack:** React 19, `react-zoom-pan-pinch` (image pan/zoom), `shiki` (syntax highlighting), `react-markdown` + `rehype-sanitize` (Markdown rendering), native HTML5 media API (video/audio controls), Tailwind CSS v4, `bun:test` (no frontend test framework exists — verify each task via `bun run typecheck` and `bun run lint` from the repo root).

---

## File Map

| Action | Path | Responsibility |
|---|---|---|
| Create | `apps/web/src/components/ui/viewers/unsupported-viewer.tsx` | Fallback for unknown MIME types |
| Create | `apps/web/src/components/ui/viewers/pdf-viewer.tsx` | iframe PDF viewer |
| Create | `apps/web/src/components/ui/viewers/image-viewer.tsx` | Pan + zoom image viewer |
| Create | `apps/web/src/components/ui/viewers/video-viewer.tsx` | Custom-controls video player |
| Create | `apps/web/src/components/ui/viewers/audio-player.tsx` | Custom-controls audio player |
| Create | `apps/web/src/components/ui/viewers/code-viewer.tsx` | shiki syntax highlighting |
| Create | `apps/web/src/components/ui/viewers/markdown-viewer.tsx` | react-markdown rendering |
| Create | `apps/web/src/components/ui/file-preview-modal.tsx` | Modal shell, MIME dispatch, navigation |
| Modify | `apps/web/src/routes/_app.files.tsx` | Remove old `FilePreviewModal`, wire new one |

---

## Task 1: Install Dependencies

**Files:**
- Modify: `apps/web/package.json` (via bun add)

- [ ] **Step 1: Add the four new packages to the web app**

```bash
cd apps/web && bun add react-zoom-pan-pinch shiki react-markdown rehype-sanitize
```

Expected: packages appear in `apps/web/package.json` under `dependencies`.

- [ ] **Step 2: Verify TypeScript picks up the types**

```bash
bun run typecheck
```

Expected: no errors (new packages all ship their own types).

- [ ] **Step 3: Commit**

```bash
git add apps/web/package.json bun.lockb
git commit -m "feat(web): add react-zoom-pan-pinch, shiki, react-markdown, rehype-sanitize"
```

---

## Task 2: UnsupportedViewer

**Files:**
- Create: `apps/web/src/components/ui/viewers/unsupported-viewer.tsx`

- [ ] **Step 1: Create the component**

```tsx
// apps/web/src/components/ui/viewers/unsupported-viewer.tsx
import { Download, FileIcon } from 'lucide-react';
import { Button } from '~/components/ui/button';

export function UnsupportedViewer({
  name,
  mime,
  downloadHref,
}: {
  name: string;
  mime: string;
  downloadHref: string;
}) {
  return (
    <div className="flex flex-col items-center gap-4 rounded-lg border border-[hsl(var(--border))] p-8 text-center">
      <FileIcon className="size-12 text-[hsl(var(--muted-foreground))]" />
      <div className="space-y-1">
        <p className="font-medium">{name}</p>
        <p className="text-sm text-[hsl(var(--muted-foreground))]">{mime}</p>
      </div>
      <Button asChild leftIcon={<Download />}>
        <a href={downloadHref} download={name}>
          Download
        </a>
      </Button>
    </div>
  );
}
```

- [ ] **Step 2: Typecheck + lint**

```bash
bun run typecheck && bun run lint
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/ui/viewers/unsupported-viewer.tsx
git commit -m "feat(web): add UnsupportedViewer component"
```

---

## Task 3: PdfViewer

**Files:**
- Create: `apps/web/src/components/ui/viewers/pdf-viewer.tsx`

- [ ] **Step 1: Create the component**

```tsx
// apps/web/src/components/ui/viewers/pdf-viewer.tsx
import { ExternalLink } from 'lucide-react';
import { Button } from '~/components/ui/button';

export function PdfViewer({ src, name }: { src: string; name: string }) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-end">
        <Button variant="outline" size="sm" asChild leftIcon={<ExternalLink />}>
          <a href={src} target="_blank" rel="noopener noreferrer">
            Open in new tab
          </a>
        </Button>
      </div>
      <iframe
        title={name}
        src={src}
        className="h-[75vh] w-full rounded-lg border border-[hsl(var(--border))]"
      />
    </div>
  );
}
```

- [ ] **Step 2: Typecheck + lint**

```bash
bun run typecheck && bun run lint
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/ui/viewers/pdf-viewer.tsx
git commit -m "feat(web): add PdfViewer component"
```

---

## Task 4: ImageViewer

**Files:**
- Create: `apps/web/src/components/ui/viewers/image-viewer.tsx`

- [ ] **Step 1: Create the component**

```tsx
// apps/web/src/components/ui/viewers/image-viewer.tsx
import { RotateCcw, ZoomIn, ZoomOut } from 'lucide-react';
import { TransformComponent, TransformWrapper } from 'react-zoom-pan-pinch';

export function ImageViewer({ src, name }: { src: string; name: string }) {
  return (
    <div
      className="relative overflow-hidden rounded-lg border border-[hsl(var(--border))]"
      style={{
        backgroundImage:
          'repeating-conic-gradient(hsl(var(--muted)) 0% 25%, transparent 0% 50%) 0 / 20px 20px',
      }}
    >
      <TransformWrapper initialScale={1} minScale={0.1} maxScale={10} centerOnInit>
        {({ zoomIn, zoomOut, resetTransform, state }) => (
          <>
            <TransformComponent
              wrapperStyle={{ width: '100%', height: '70vh' }}
              contentStyle={{
                width: '100%',
                height: '100%',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <img
                src={src}
                alt={name}
                style={{ maxWidth: '100%', maxHeight: '70vh', objectFit: 'contain' }}
              />
            </TransformComponent>
            <div className="absolute bottom-3 right-3 flex items-center gap-1 rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--surface)/0.9)] px-2 py-1.5 backdrop-blur-sm">
              <button
                type="button"
                onClick={() => zoomOut()}
                aria-label="Zoom out"
                className="rounded p-1 hover:bg-[hsl(var(--muted))]"
              >
                <ZoomOut className="size-3.5" />
              </button>
              <span className="min-w-[3rem] text-center text-xs tabular-nums">
                {Math.round(state.scale * 100)}%
              </span>
              <button
                type="button"
                onClick={() => zoomIn()}
                aria-label="Zoom in"
                className="rounded p-1 hover:bg-[hsl(var(--muted))]"
              >
                <ZoomIn className="size-3.5" />
              </button>
              <button
                type="button"
                onClick={() => resetTransform()}
                aria-label="Reset zoom"
                className="rounded p-1 hover:bg-[hsl(var(--muted))]"
              >
                <RotateCcw className="size-3.5" />
              </button>
            </div>
          </>
        )}
      </TransformWrapper>
    </div>
  );
}
```

- [ ] **Step 2: Typecheck + lint**

```bash
bun run typecheck && bun run lint
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/ui/viewers/image-viewer.tsx
git commit -m "feat(web): add ImageViewer with pan and zoom"
```

---

## Task 5: VideoViewer

**Files:**
- Create: `apps/web/src/components/ui/viewers/video-viewer.tsx`

- [ ] **Step 1: Create the component**

```tsx
// apps/web/src/components/ui/viewers/video-viewer.tsx
import { Maximize, Pause, Play, Volume2, VolumeX } from 'lucide-react';
import { type ChangeEvent, useEffect, useRef, useState } from 'react';

function formatTime(s: number): string {
  if (!Number.isFinite(s)) return '0:00';
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, '0')}`;
}

export function VideoViewer({ src, name }: { src: string; name: string }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [unsupported, setUnsupported] = useState(false);

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    const onTimeUpdate = () => setCurrentTime(v.currentTime);
    const onDurationChange = () => setDuration(v.duration);
    const onError = () => setUnsupported(true);
    v.addEventListener('play', onPlay);
    v.addEventListener('pause', onPause);
    v.addEventListener('timeupdate', onTimeUpdate);
    v.addEventListener('durationchange', onDurationChange);
    v.addEventListener('error', onError);
    return () => {
      v.removeEventListener('play', onPlay);
      v.removeEventListener('pause', onPause);
      v.removeEventListener('timeupdate', onTimeUpdate);
      v.removeEventListener('durationchange', onDurationChange);
      v.removeEventListener('error', onError);
    };
  }, []);

  function togglePlay() {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) void v.play();
    else v.pause();
  }

  function seek(e: ChangeEvent<HTMLInputElement>) {
    const v = videoRef.current;
    if (!v) return;
    v.currentTime = Number(e.target.value);
  }

  function changeVolume(e: ChangeEvent<HTMLInputElement>) {
    const v = videoRef.current;
    if (!v) return;
    const val = Number(e.target.value);
    v.volume = val;
    setVolume(val);
    setMuted(val === 0);
  }

  function toggleMute() {
    const v = videoRef.current;
    if (!v) return;
    v.muted = !v.muted;
    setMuted(v.muted);
  }

  function requestFullscreen() {
    void videoRef.current?.requestFullscreen();
  }

  return (
    <div className="overflow-hidden rounded-lg border border-[hsl(var(--border))] bg-black">
      {/* biome-ignore lint/a11y/useMediaCaption: arbitrary uploaded videos do not have caption tracks */}
      <video ref={videoRef} src={src} className="max-h-[65vh] w-full object-contain" />
      {unsupported ? (
        <div className="flex flex-col items-center gap-2 p-4 text-center">
          <p className="text-sm text-[hsl(var(--muted-foreground))]">
            This format cannot be played in your browser.
          </p>
          <a
            href={src}
            download={name}
            className="text-sm text-[hsl(var(--primary))] underline"
          >
            Download instead
          </a>
        </div>
      ) : (
        <div className="flex flex-col gap-2 bg-[hsl(var(--surface-2)/0.9)] px-4 py-3">
          <input
            type="range"
            min={0}
            max={duration || 0}
            step={0.1}
            value={currentTime}
            onChange={seek}
            aria-label="Seek"
            className="w-full accent-[hsl(var(--primary))]"
          />
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={togglePlay}
                aria-label={playing ? 'Pause' : 'Play'}
                className="rounded-md p-1 hover:bg-[hsl(var(--muted))]"
              >
                {playing ? <Pause className="size-4" /> : <Play className="size-4" />}
              </button>
              <button
                type="button"
                onClick={toggleMute}
                aria-label={muted ? 'Unmute' : 'Mute'}
                className="rounded-md p-1 hover:bg-[hsl(var(--muted))]"
              >
                {muted || volume === 0 ? (
                  <VolumeX className="size-4" />
                ) : (
                  <Volume2 className="size-4" />
                )}
              </button>
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={muted ? 0 : volume}
                onChange={changeVolume}
                aria-label="Volume"
                className="w-20 accent-[hsl(var(--primary))]"
              />
              <span className="text-xs tabular-nums text-[hsl(var(--muted-foreground))]">
                {formatTime(currentTime)} / {formatTime(duration)}
              </span>
            </div>
            <button
              type="button"
              onClick={requestFullscreen}
              aria-label="Fullscreen"
              className="rounded-md p-1 hover:bg-[hsl(var(--muted))]"
            >
              <Maximize className="size-4" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Typecheck + lint**

```bash
bun run typecheck && bun run lint
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/ui/viewers/video-viewer.tsx
git commit -m "feat(web): add VideoViewer with custom controls"
```

---

## Task 6: AudioPlayer

**Files:**
- Create: `apps/web/src/components/ui/viewers/audio-player.tsx`

- [ ] **Step 1: Create the component**

```tsx
// apps/web/src/components/ui/viewers/audio-player.tsx
import { Music, Pause, Play, Volume2, VolumeX } from 'lucide-react';
import { type ChangeEvent, useEffect, useRef, useState } from 'react';

function formatTime(s: number): string {
  if (!Number.isFinite(s)) return '0:00';
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, '0')}`;
}

export function AudioPlayer({ src, name }: { src: string; name: string }) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [unsupported, setUnsupported] = useState(false);

  useEffect(() => {
    const a = audioRef.current;
    if (!a) return;
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    const onTimeUpdate = () => setCurrentTime(a.currentTime);
    const onDurationChange = () => setDuration(a.duration);
    const onError = () => setUnsupported(true);
    a.addEventListener('play', onPlay);
    a.addEventListener('pause', onPause);
    a.addEventListener('timeupdate', onTimeUpdate);
    a.addEventListener('durationchange', onDurationChange);
    a.addEventListener('error', onError);
    return () => {
      a.removeEventListener('play', onPlay);
      a.removeEventListener('pause', onPause);
      a.removeEventListener('timeupdate', onTimeUpdate);
      a.removeEventListener('durationchange', onDurationChange);
      a.removeEventListener('error', onError);
    };
  }, []);

  function togglePlay() {
    const a = audioRef.current;
    if (!a) return;
    if (a.paused) void a.play();
    else a.pause();
  }

  function seek(e: ChangeEvent<HTMLInputElement>) {
    const a = audioRef.current;
    if (!a) return;
    a.currentTime = Number(e.target.value);
  }

  function changeVolume(e: ChangeEvent<HTMLInputElement>) {
    const a = audioRef.current;
    if (!a) return;
    const val = Number(e.target.value);
    a.volume = val;
    setVolume(val);
    setMuted(val === 0);
  }

  function toggleMute() {
    const a = audioRef.current;
    if (!a) return;
    a.muted = !a.muted;
    setMuted(a.muted);
  }

  return (
    <div className="rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--surface-2))] p-6">
      {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
      <audio ref={audioRef} src={src} preload="metadata" />
      <div className="flex flex-col items-center gap-4">
        <div className="flex size-20 items-center justify-center rounded-full bg-[hsl(var(--muted))]">
          <Music className="size-8 text-[hsl(var(--muted-foreground))]" />
        </div>
        <p className="max-w-sm truncate text-sm font-medium">{name}</p>
        {unsupported ? (
          <div className="text-center">
            <p className="text-sm text-[hsl(var(--muted-foreground))]">
              This format cannot be played in your browser.
            </p>
            <a href={src} download={name} className="text-sm text-[hsl(var(--primary))] underline">
              Download instead
            </a>
          </div>
        ) : (
          <div className="flex w-full flex-col gap-3">
            <input
              type="range"
              min={0}
              max={duration || 0}
              step={0.1}
              value={currentTime}
              onChange={seek}
              aria-label="Seek"
              className="w-full accent-[hsl(var(--primary))]"
            />
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={toggleMute}
                  aria-label={muted ? 'Unmute' : 'Mute'}
                  className="rounded-md p-1 hover:bg-[hsl(var(--muted))]"
                >
                  {muted || volume === 0 ? (
                    <VolumeX className="size-4" />
                  ) : (
                    <Volume2 className="size-4" />
                  )}
                </button>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={muted ? 0 : volume}
                  onChange={changeVolume}
                  aria-label="Volume"
                  className="w-20 accent-[hsl(var(--primary))]"
                />
              </div>
              <button
                type="button"
                onClick={togglePlay}
                aria-label={playing ? 'Pause' : 'Play'}
                className="flex items-center gap-1.5 rounded-md bg-[hsl(var(--primary))] px-4 py-2 text-sm font-medium text-[hsl(var(--primary-foreground))] hover:opacity-90"
              >
                {playing ? <Pause className="size-4" /> : <Play className="size-4" />}
                {playing ? 'Pause' : 'Play'}
              </button>
              <span className="w-24 text-right text-xs tabular-nums text-[hsl(var(--muted-foreground))]">
                {formatTime(currentTime)} / {formatTime(duration)}
              </span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Typecheck + lint**

```bash
bun run typecheck && bun run lint
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/ui/viewers/audio-player.tsx
git commit -m "feat(web): add AudioPlayer with custom controls"
```

---

## Task 7: CodeViewer

**Files:**
- Create: `apps/web/src/components/ui/viewers/code-viewer.tsx`

- [ ] **Step 1: Create the component**

```tsx
// apps/web/src/components/ui/viewers/code-viewer.tsx
import { Check, Copy } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { type Highlighter, createHighlighter } from 'shiki';

const LANGS = [
  'typescript',
  'tsx',
  'javascript',
  'jsx',
  'json',
  'html',
  'css',
  'python',
  'bash',
  'go',
  'rust',
  'yaml',
  'toml',
  'sql',
  'markdown',
  'xml',
  'plaintext',
] as const;

type Lang = (typeof LANGS)[number];

const EXT_TO_LANG: Record<string, Lang> = {
  ts: 'typescript',
  tsx: 'tsx',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'jsx',
  json: 'json',
  html: 'html',
  htm: 'html',
  css: 'css',
  py: 'python',
  sh: 'bash',
  bash: 'bash',
  go: 'go',
  rs: 'rust',
  yml: 'yaml',
  yaml: 'yaml',
  toml: 'toml',
  sql: 'sql',
  md: 'markdown',
  xml: 'xml',
  svg: 'xml',
};

function langFromName(name: string): Lang {
  const ext = name.includes('.') ? name.split('.').pop()?.toLowerCase() : undefined;
  return (ext ? EXT_TO_LANG[ext] : undefined) ?? 'plaintext';
}

let highlighterPromise: Promise<Highlighter> | null = null;

function getHighlighter(): Promise<Highlighter> {
  if (!highlighterPromise) {
    highlighterPromise = createHighlighter({
      themes: ['github-dark', 'github-light'],
      langs: [...LANGS],
    });
  }
  return highlighterPromise;
}

const MAX_BYTES = 200_000;

export function CodeViewer({
  src,
  name,
  mime,
}: {
  src: string;
  name: string;
  mime: string;
}) {
  const [html, setHtml] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const rawRef = useRef('');

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const res = await fetch(src);
        const text = await res.text();
        const sliced = text.slice(0, MAX_BYTES);
        rawRef.current = sliced;
        if (!cancelled) setTruncated(text.length > MAX_BYTES);
        const hl = await getHighlighter();
        const lang = langFromName(name);
        const isDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
        const highlighted = hl.codeToHtml(sliced, {
          lang,
          theme: isDark ? 'github-dark' : 'github-light',
        });
        if (!cancelled) setHtml(highlighted);
      } catch {
        if (!cancelled) setError('Failed to load file');
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [src, name, mime]);

  async function handleCopy() {
    await navigator.clipboard.writeText(rawRef.current);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className="flex flex-col gap-2">
      {truncated && (
        <p className="rounded-md bg-[hsl(var(--surface-2))] px-3 py-1.5 text-xs text-[hsl(var(--muted-foreground))]">
          File truncated at 200 KB
        </p>
      )}
      <div className="relative max-h-[70vh] overflow-auto rounded-lg border border-[hsl(var(--border))]">
        <button
          type="button"
          onClick={handleCopy}
          aria-label="Copy code"
          className="absolute right-2 top-2 z-10 rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--surface))] p-1.5 text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))]"
        >
          {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
        </button>
        {error ? (
          <p className="p-4 text-sm text-[hsl(var(--destructive))]">{error}</p>
        ) : html ? (
          // biome-ignore lint/security/noDangerouslySetInnerHtml: shiki output is safe
          <div dangerouslySetInnerHTML={{ __html: html }} className="text-xs [&_pre]:p-4" />
        ) : (
          <p className="p-4 text-sm text-[hsl(var(--muted-foreground))]">Loading…</p>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Typecheck + lint**

```bash
bun run typecheck && bun run lint
```

Expected: no errors. If biome complains about `noDangerouslySetInnerHtml`, the comment suppressor is already in the code.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/ui/viewers/code-viewer.tsx
git commit -m "feat(web): add CodeViewer with shiki syntax highlighting"
```

---

## Task 8: MarkdownViewer

**Files:**
- Create: `apps/web/src/components/ui/viewers/markdown-viewer.tsx`

- [ ] **Step 1: Create the component**

```tsx
// apps/web/src/components/ui/viewers/markdown-viewer.tsx
import { useEffect, useState } from 'react';
import Markdown from 'react-markdown';
import rehypeSanitize from 'rehype-sanitize';
import { cn } from '~/lib/cn';

const MAX_BYTES = 200_000;

export function MarkdownViewer({ src }: { src: string }) {
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<'rendered' | 'raw'>('rendered');

  useEffect(() => {
    let cancelled = false;
    fetch(src)
      .then((r) => r.text())
      .then((text) => {
        if (!cancelled) setContent(text.slice(0, MAX_BYTES));
      })
      .catch(() => {
        if (!cancelled) setError('Failed to load file');
      });
    return () => {
      cancelled = true;
    };
  }, [src]);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex gap-1 rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--surface-2))] p-1 w-fit">
        {(['rendered', 'raw'] as const).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className={cn(
              'rounded-md px-3 py-1 text-xs font-medium capitalize transition-colors',
              tab === t
                ? 'bg-[hsl(var(--surface))] text-[hsl(var(--foreground))] shadow-sm'
                : 'text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))]',
            )}
          >
            {t}
          </button>
        ))}
      </div>
      <div className="max-h-[70vh] overflow-auto rounded-lg border border-[hsl(var(--border))] p-4">
        {error ? (
          <p className="text-sm text-[hsl(var(--destructive))]">{error}</p>
        ) : content === null ? (
          <p className="text-sm text-[hsl(var(--muted-foreground))]">Loading…</p>
        ) : tab === 'rendered' ? (
          <Markdown
            rehypePlugins={[rehypeSanitize]}
            components={{
              h1: ({ children }) => (
                <h1 className="mb-4 mt-6 text-2xl font-bold first:mt-0">{children}</h1>
              ),
              h2: ({ children }) => (
                <h2 className="mb-3 mt-6 text-xl font-semibold first:mt-0">{children}</h2>
              ),
              h3: ({ children }) => (
                <h3 className="mb-2 mt-4 text-lg font-semibold first:mt-0">{children}</h3>
              ),
              p: ({ children }) => <p className="mb-4 leading-relaxed">{children}</p>,
              code: ({ children }) => (
                <code className="rounded bg-[hsl(var(--surface-2))] px-1 py-0.5 font-mono text-sm">
                  {children}
                </code>
              ),
              pre: ({ children }) => (
                <pre className="mb-4 overflow-auto rounded-lg bg-[hsl(var(--surface-2))] p-4 font-mono text-sm">
                  {children}
                </pre>
              ),
              ul: ({ children }) => <ul className="mb-4 list-disc pl-6">{children}</ul>,
              ol: ({ children }) => <ol className="mb-4 list-decimal pl-6">{children}</ol>,
              li: ({ children }) => <li className="mb-1">{children}</li>,
              blockquote: ({ children }) => (
                <blockquote className="mb-4 border-l-4 border-[hsl(var(--border))] pl-4 text-[hsl(var(--muted-foreground))]">
                  {children}
                </blockquote>
              ),
              a: ({ children, href }) => (
                <a
                  href={href}
                  className="text-[hsl(var(--primary))] underline hover:no-underline"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {children}
                </a>
              ),
              hr: () => <hr className="my-6 border-[hsl(var(--border))]" />,
              table: ({ children }) => (
                <table className="mb-4 w-full border-collapse text-sm">{children}</table>
              ),
              th: ({ children }) => (
                <th className="border border-[hsl(var(--border))] bg-[hsl(var(--surface-2))] px-3 py-2 text-left font-semibold">
                  {children}
                </th>
              ),
              td: ({ children }) => (
                <td className="border border-[hsl(var(--border))] px-3 py-2">{children}</td>
              ),
            }}
          >
            {content}
          </Markdown>
        ) : (
          <pre className="whitespace-pre-wrap text-xs">{content}</pre>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Typecheck + lint**

```bash
bun run typecheck && bun run lint
```

Expected: no errors. If TypeScript complains about `react-markdown` component prop types, they are correct — `react-markdown` v9 passes full node data to components; children is sufficient for simple styling.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/ui/viewers/markdown-viewer.tsx
git commit -m "feat(web): add MarkdownViewer with rendered and raw tabs"
```

---

## Task 9: FilePreviewModal Shell

**Files:**
- Create: `apps/web/src/components/ui/file-preview-modal.tsx`

This is the modal shell that owns MIME dispatch, prev/next navigation, and keyboard shortcuts.

- [ ] **Step 1: Create the component**

```tsx
// apps/web/src/components/ui/file-preview-modal.tsx
import { ChevronLeft, ChevronRight, Download } from 'lucide-react';
import { useEffect, useMemo } from 'react';
import { AudioPlayer } from '~/components/ui/viewers/audio-player';
import { CodeViewer } from '~/components/ui/viewers/code-viewer';
import { ImageViewer } from '~/components/ui/viewers/image-viewer';
import { MarkdownViewer } from '~/components/ui/viewers/markdown-viewer';
import { PdfViewer } from '~/components/ui/viewers/pdf-viewer';
import { UnsupportedViewer } from '~/components/ui/viewers/unsupported-viewer';
import { VideoViewer } from '~/components/ui/viewers/video-viewer';
import { Button } from '~/components/ui/button';
import {
  Modal,
  ModalContent,
  ModalDescription,
  ModalHeader,
  ModalTitle,
} from '~/components/ui/modal';
import { type Entry, type FileEntry } from '~/lib/files';

function viewerFor(entry: FileEntry, src: string) {
  const { mime, name } = entry;
  if (mime.startsWith('image/')) return <ImageViewer src={src} name={name} />;
  if (mime.startsWith('video/')) return <VideoViewer src={src} name={name} />;
  if (mime.startsWith('audio/')) return <AudioPlayer src={src} name={name} />;
  if (mime === 'application/pdf') return <PdfViewer src={src} name={name} />;
  if (mime === 'text/markdown') return <MarkdownViewer src={src} />;
  if (mime.startsWith('text/') || mime === 'application/json')
    return <CodeViewer src={src} name={name} mime={mime} />;
  return <UnsupportedViewer name={name} mime={mime} downloadHref={src} />;
}

export function FilePreviewModal({
  path,
  entry,
  entries,
  onOpenChange,
  onNavigate,
}: {
  path: string | null;
  entry: FileEntry | null;
  entries: Entry[];
  onOpenChange: (open: boolean) => void;
  onNavigate: (path: string) => void;
}) {
  const fileEntries = useMemo(
    () => entries.filter((e): e is FileEntry => e.kind === 'file'),
    [entries],
  );

  const currentIndex = useMemo(
    () => fileEntries.findIndex((e) => e.path === path),
    [fileEntries, path],
  );

  const hasSiblings = fileEntries.length > 1;
  const prevEntry = hasSiblings
    ? fileEntries[(currentIndex - 1 + fileEntries.length) % fileEntries.length]
    : null;
  const nextEntry = hasSiblings
    ? fileEntries[(currentIndex + 1) % fileEntries.length]
    : null;

  useEffect(() => {
    if (!path) return;
    function onKeyDown(e: KeyboardEvent) {
      const tag = (e.target as HTMLElement).tagName.toLowerCase();
      if (['input', 'textarea', 'video', 'audio'].includes(tag)) return;
      if (e.key === 'ArrowLeft' && prevEntry) onNavigate(prevEntry.path);
      if (e.key === 'ArrowRight' && nextEntry) onNavigate(nextEntry.path);
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [path, prevEntry, nextEntry, onNavigate]);

  const open = Boolean(path && entry);
  const src = entry
    ? `/api/files/content?path=${encodeURIComponent(entry.path)}`
    : '';

  return (
    <Modal open={open} onOpenChange={onOpenChange}>
      <ModalContent
        size="xl"
        className="flex max-h-[90vh] max-w-4xl flex-col gap-3 overflow-hidden"
      >
        <div className="flex items-start gap-3 pr-8">
          <ModalHeader className="min-w-0 flex-1">
            <ModalTitle className="truncate">{entry?.name ?? 'Preview'}</ModalTitle>
            <ModalDescription>{entry?.mime ?? ''}</ModalDescription>
          </ModalHeader>
          <div className="mt-0.5 flex shrink-0 items-center gap-1.5">
            {hasSiblings && (
              <>
                <Button
                  variant="outline"
                  size="icon-sm"
                  disabled={!prevEntry}
                  onClick={() => prevEntry && onNavigate(prevEntry.path)}
                  aria-label="Previous file"
                >
                  <ChevronLeft />
                </Button>
                <span className="min-w-[3rem] text-center text-xs tabular-nums text-[hsl(var(--muted-foreground))]">
                  {currentIndex + 1} / {fileEntries.length}
                </span>
                <Button
                  variant="outline"
                  size="icon-sm"
                  disabled={!nextEntry}
                  onClick={() => nextEntry && onNavigate(nextEntry.path)}
                  aria-label="Next file"
                >
                  <ChevronRight />
                </Button>
              </>
            )}
            <Button variant="outline" size="icon-sm" asChild aria-label="Download">
              <a href={src} download={entry?.name}>
                <Download />
              </a>
            </Button>
          </div>
        </div>
        <div key={entry?.path} className="overflow-auto">
          {entry && viewerFor(entry, src)}
        </div>
      </ModalContent>
    </Modal>
  );
}
```

- [ ] **Step 2: Typecheck + lint**

```bash
bun run typecheck && bun run lint
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/ui/file-preview-modal.tsx
git commit -m "feat(web): add FilePreviewModal shell with navigation and MIME dispatch"
```

---

## Task 10: Wire Into _app.files.tsx

**Files:**
- Modify: `apps/web/src/routes/_app.files.tsx`

This task has two parts: add the import and update props, then remove the old inline `FilePreviewModal` function.

- [ ] **Step 1: Add the import at the top of `_app.files.tsx`**

Add this import alongside the other `~/components/ui/*` imports (around line 35–51):

```ts
import { FilePreviewModal } from '~/components/ui/file-preview-modal';
```

- [ ] **Step 2: Update the `previewEntry` type annotation**

The existing `previewEntry` useMemo (around line 176) returns `FileEntry | null`. Update it to import `FileEntry` explicitly so the new component's props align:

At line 62, the existing import is:
```ts
import { type Entry, filesQuery, filesSearchQuery, humanSize, humanTime } from '~/lib/files';
```

Change it to:
```ts
import { type Entry, type FileEntry, filesQuery, filesSearchQuery, humanSize, humanTime } from '~/lib/files';
```

Then update `previewEntry` (line ~176):
```ts
const previewEntry = useMemo((): FileEntry | null => {
  if (!previewPath) return null;
  const found = entries.find((item) => item.path === previewPath);
  return found?.kind === 'file' ? found : null;
}, [entries, previewPath]);
```

- [ ] **Step 3: Update the `<FilePreviewModal>` JSX call (around line 728)**

Replace the existing call:
```tsx
<FilePreviewModal
  path={previewPath}
  entry={previewEntry}
  onOpenChange={(open) => {
    if (!open) setPreviewPath(null);
  }}
/>
```

With:
```tsx
<FilePreviewModal
  path={previewPath}
  entry={previewEntry}
  entries={entries}
  onOpenChange={(open) => {
    if (!open) setPreviewPath(null);
  }}
  onNavigate={setPreviewPath}
/>
```

- [ ] **Step 4: Delete the old inline `FilePreviewModal` function**

Remove lines 1352–1439 (the entire `function FilePreviewModal(...)` block). After deletion the file will shrink by ~90 lines. The `textPreview` state it used is now unused — verify it was only used inside that function and delete the import of `useState` if it becomes unused (it won't — many other hooks use it).

- [ ] **Step 5: Typecheck + lint**

```bash
bun run typecheck && bun run lint
```

Expected: no errors. If lint reports unused imports (e.g. any icon that was only used by the old modal), remove them.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/routes/_app.files.tsx
git commit -m "feat(web): wire new FilePreviewModal into files page"
```

---

## Task 11: Smoke Test in the Browser

This is a manual verification step — there is no automated frontend test suite.

- [ ] **Step 1: Start the dev server**

```bash
bun run dev
```

Open `http://localhost:3900` and log in.

- [ ] **Step 2: Test each viewer**

Upload one file of each type and double-click it to open the preview:

| Type | Test |
|---|---|
| Image (`.jpg` / `.png`) | Opens with checkerboard bg; scroll to zoom; drag to pan; HUD shows %; reset button works |
| Transparent PNG | Checkerboard background is visible |
| Video (`.mp4`) | Custom controls visible; play/pause works; seek bar scrubs; volume slider works; fullscreen button works |
| Audio (`.mp3`) | Music icon placeholder shown; play/pause works; seek bar works |
| PDF (`.pdf`) | Renders in iframe; "Open in new tab" button works |
| TypeScript (`.ts`) | Syntax-highlighted with correct colors; copy button copies to clipboard |
| Markdown (`.md`) | Rendered tab shows formatted prose; Raw tab shows source |
| Unknown type (e.g. `.zip`) | Shows file icon + MIME type + Download button |

- [ ] **Step 3: Test navigation**

With multiple files in a folder: open any file, use `←` / `→` arrow keys and the chevron buttons to navigate. Confirm it wraps around. Confirm the `N / M` counter updates.

- [ ] **Step 4: Fix any issues found, then commit**

```bash
git add -p   # stage only the specific fixes
git commit -m "fix(web): address issues found in file viewer smoke test"
```

---

## Self-Review Notes

- All seven viewer components are covered: Image, Video, Audio, PDF, Code, Markdown, Unsupported.
- Navigation (prev/next + keyboard + wrap-around + counter) is in Task 9.
- `key={entry?.path}` on the viewer wrapper in `FilePreviewModal` ensures full state reset on file change.
- MIME dispatch checks `text/markdown` before `text/*` (it's inside `viewerFor`, ordered correctly).
- The `←`/`→` keyboard listener skips when focus is on `input`, `textarea`, `video`, or `audio` elements.
- Download button in the modal header is present in Task 9.
- Error + fallback handling is in every viewer that fetches (Code, Markdown) and in the media viewers (Video, Audio).
- No new server endpoints required — everything uses `/api/files/content`.
