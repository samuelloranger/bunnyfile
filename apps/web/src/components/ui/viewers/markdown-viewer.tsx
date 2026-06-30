import { useEffect, useState } from 'react';
import Markdown from 'react-markdown';
import rehypeSanitize from 'rehype-sanitize';
import remarkGfm from 'remark-gfm';
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
      <div className="max-h-[calc(90vh_-_10rem)] overflow-auto rounded-lg border border-[hsl(var(--border))] p-4">
        {error ? (
          <p className="text-sm text-[hsl(var(--destructive))]">{error}</p>
        ) : content === null ? (
          <p className="text-sm text-[hsl(var(--muted-foreground))]">Loading…</p>
        ) : tab === 'rendered' ? (
          <Markdown
            remarkPlugins={[remarkGfm]}
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
                  href={href ?? '#'}
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
