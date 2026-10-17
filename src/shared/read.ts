import { parseHTML } from 'linkedom';
import { Readability } from '@mozilla/readability';
import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';
import { buildSectionTree, type SectionNode } from './sections.js';
import { splitPages } from './paging.js';

export interface PageSnapshot {
  url: string;
  title: string;
  html: string;
  contentType?: string;
  scrollHeight?: number;
  clientHeight?: number;
  feed?: boolean;
  reloaded?: boolean;
}

export interface ConvertedPage {
  url: string;
  title: string;
  markdown: string;
  words: number;
  sections: SectionNode[];
  pages: string[];
  note?: string;
}

const FEED_HOSTS =
  /(^|\.)((x|twitter|reddit|linkedin|facebook|instagram)\.com|threads\.net|bsky\.app)$/i;

export function convertSnapshot(snapshot: PageSnapshot, full = false): ConvertedPage {
  const { document } = parseHTML(snapshot.html);
  for (const selector of ['script', 'style', 'noscript', 'svg', 'iframe'])
    document.querySelectorAll(selector).forEach((node) => node.remove());
  let content = document.body?.innerHTML ?? snapshot.html;
  if (!full) {
    try {
      const article = new Readability(document as unknown as Document).parse();
      if (article?.textContent && article.textContent.trim().length >= 200)
        content = article.content ?? content;
    } catch {
      /* malformed pages still get the body text */
    }
  }
  const turndown = new TurndownService({
    headingStyle: 'atx',
    bulletListMarker: '-',
    codeBlockStyle: 'fenced',
  });
  turndown.use(gfm);
  let markdown = turndown
    .turndown(content)
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  markdown = markdown.replace(/!\[([^\]]*)\]\([^)]*\)/g, (_, alt: string) =>
    alt ? `[image: ${alt}]` : '',
  );
  const words = markdown ? markdown.split(/\s+/).length : 0;
  const sections = buildSectionTree(markdown);
  const notes = [
    FEED_HOSTS.test(new URL(snapshot.url).hostname) || snapshot.feed
      ? 'more may load on scroll'
      : undefined,
  ].filter(Boolean) as string[];
  return {
    url: snapshot.url,
    title: snapshot.title,
    markdown,
    words,
    sections,
    pages: splitPages(markdown, 20_000),
    note: notes.length ? notes.join('\n') : undefined,
  };
}

export function plainLinks(markdown: string): string {
  return markdown.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1');
}
