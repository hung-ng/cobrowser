import { markdownLines } from './markdown.js';

export function markdownHeadings(markdown: string): Map<number, { level: number; title: string }> {
  const headings = new Map<number, { level: number; title: string }>();
  let index = 0;
  for (const line of markdownLines(markdown)) {
    const heading =
      line.kind === 'prose' ? /^ {0,3}(#{1,3})[\t ]+(.+?)\s*$/.exec(line.content) : null;
    if (heading)
      headings.set(index, {
        level: heading[1].length,
        title: heading[2].replace(/[\t ]+#+[\t ]*$/, '').trim(),
      });
    index++;
  }
  return headings;
}
