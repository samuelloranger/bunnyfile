import { describe, expect, it } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import Markdown from 'react-markdown';
import rehypeSanitize from 'rehype-sanitize';
import remarkGfm from 'remark-gfm';

// Mirror the MarkdownViewer cell renderers so the test guards the actual wiring:
// remark-gfm parsing + alignment passed through to inline style.
const components = {
  th: ({ children, style }: { children?: unknown; style?: Record<string, unknown> }) =>
    createElement('th', { style }, children as never),
  td: ({ children, style }: { children?: unknown; style?: Record<string, unknown> }) =>
    createElement('td', { style }, children as never),
} as never;

function render(md: string): string {
  return renderToStaticMarkup(
    createElement(
      Markdown,
      { remarkPlugins: [remarkGfm], rehypePlugins: [rehypeSanitize], components },
      md,
    ),
  );
}

describe('markdown GFM rendering', () => {
  it('renders pipe tables as a <table>', () => {
    const html = render('| A | B |\n|---|---|\n| 1 | 2 |');
    expect(html).toContain('<table');
    expect(html).toContain('<td');
  });

  it('preserves column alignment from GFM markers', () => {
    const html = render('| L | C | R |\n|:---|:---:|---:|\n| 1 | 2 | 3 |');
    expect(html).toContain('text-align:center');
    expect(html).toContain('text-align:right');
  });
});
