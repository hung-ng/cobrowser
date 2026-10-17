export interface SectionNode {
  number: string;
  title: string;
  level: number;
  text: string;
  words: number;
  children: SectionNode[];
}

function wordsOf(text: string): number {
  return text.trim() ? text.trim().split(/\s+/).length : 0;
}

export function buildSectionTree(markdown: string): SectionNode[] {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const roots: SectionNode[] = [];
  const stack: SectionNode[] = [];
  let preamble = '';
  const append = (node: SectionNode) => {
    while (stack.length && stack[stack.length - 1].level >= node.level) stack.pop();
    if (stack.length) stack[stack.length - 1].children.push(node);
    else roots.push(node);
    stack.push(node);
  };
  for (const line of lines) {
    const match = /^(#{1,3})\s+(.+?)\s*$/.exec(line);
    if (!match) {
      if (stack.length)
        stack[stack.length - 1].text += `${stack[stack.length - 1].text ? '\n' : ''}${line}`;
      else preamble += `${preamble ? '\n' : ''}${line}`;
      continue;
    }
    const level = match[1].length;
    const parent =
      stack.length && stack[stack.length - 1].level < level ? stack[stack.length - 1] : undefined;
    const siblingCount = parent ? parent.children.length + 1 : roots.length + 1;
    const number = parent ? `${parent.number}.${siblingCount}` : String(siblingCount);
    append({ number, title: match[2], level, text: '', words: 0, children: [] });
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
  const finalize = (node: SectionNode, inherited = '') => {
    const own = node.text.trim();
    const childText = node.children.map((child) => finalize(child, inherited)).join('\n\n');
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
