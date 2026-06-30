import { Check, Copy } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { createHighlighter, type Highlighter } from 'shiki';

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
  mime: _mime,
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
  }, [src, name]);

  async function handleCopy() {
    // navigator.clipboard is undefined on insecure (plain-HTTP) origins — guard
    // so the button doesn't throw on a LAN deploy without TLS.
    if (!navigator.clipboard) return;
    try {
      await navigator.clipboard.writeText(rawRef.current);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // clipboard write denied — ignore
    }
  }

  return (
    <div className="flex flex-col gap-2">
      {truncated && (
        <p className="rounded-md bg-[hsl(var(--surface-2))] px-3 py-1.5 text-xs text-[hsl(var(--muted-foreground))]">
          File truncated at 200 KB
        </p>
      )}
      <div className="relative max-h-[calc(90vh_-_10rem)] overflow-auto rounded-lg border border-[hsl(var(--border))]">
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
