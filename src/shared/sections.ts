import { markdownHeadings } from './headings.js';

export interface SectionNode {
  number: string;
  title: string;
  level: number;
  text: string;
  words: number;
  children: SectionNode[];
}

export const MAX_SECTION_NUMBER_CHARS = 256;

export function isSectionNumber(value: unknown): boolean {
  if (typeof value !== 'string' && typeof value !== 'number') return false;
  const text = String(value);
  return (
    text.length <= MAX_SECTION_NUMBER_CHARS && /^(?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*))*$/.test(text)
  );
}

function wordsOf(text: string): number {
  return text.trim() ? text.trim().split(/\s+/).length : 0;
}

export function buildSectionTree(markdown: string): SectionNode[] {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const roots: SectionNode[] = [];
  const stack: SectionNode[] = [];
  const headings = markdownHeadings(markdown);
  let preamble = '';
  for (const [index, line] of lines.entries()) {
    const heading = headings.get(index);
    if (!heading) {
      if (stack.length)
        stack[stack.length - 1].text += `${stack[stack.length - 1].text ? '\n' : ''}${line}`;
      else preamble += `${preamble ? '\n' : ''}${line}`;
      continue;
    }
    const { level, title } = heading;
    while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
    const parent = stack[stack.length - 1];
    const siblingCount = parent ? parent.children.length + 1 : roots.length + 1;
    const number = parent ? `${parent.number}.${siblingCount}` : String(siblingCount);
    const node = { number, title, level, text: line, words: 0, children: [] };
    if (parent) parent.children.push(node);
    else roots.push(node);
    stack.push(node);
  }
  if (preamble.trim())
    roots.unshift({
      number: '0',
      title: 'Introduction',
      level: 0,
      text: preamble.trim(),
      words: wordsOf(preamble),
      children: [],
    });
  const finalize = (node: SectionNode) => {
    const own = node.text.trim();
    const childText = node.children.map((child) => finalize(child)).join('\n\n');
    node.text = [own, childText].filter(Boolean).join('\n\n');
    node.words = wordsOf(node.text);
    return node.text;
  };
  roots.forEach((root) => finalize(root));
  return roots;
}

export function flattenSections(tree: SectionNode[]): SectionNode[] {
  return tree.flatMap((section) => [section, ...flattenSections(section.children)]);
}

export function sectionOutline(tree: SectionNode[]): string {
  return flattenSections(tree)
    .map((section) => `${section.number}. ${section.title} (${section.words} words)`)
    .join('\n');
}
