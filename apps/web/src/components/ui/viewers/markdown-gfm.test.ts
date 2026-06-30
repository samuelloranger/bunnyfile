import { describe, expect, it } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import Markdown from 'react-markdown';
import rehypeSanitize from 'rehype-sanitize';
import remarkGfm from 'remark-gfm';

// Guards the MarkdownViewer plugin wiring: without remark-gfm, pipe tables
// render as a plain paragraph of "| A | B |" text instead of a <table>.
describe('markdown GFM rendering', () => {
  it('renders pipe tables as a <table>', () => {
    const md = '| A | B |\n|---|---|\n| 1 | 2 |';
    const html = renderToStaticMarkup(
      createElement(Markdown, { remarkPlugins: [remarkGfm], rehypePlugins: [rehypeSanitize] }, md),
    );
    expect(html).toContain('<table');
    expect(html).toContain('<td');
  });
});
