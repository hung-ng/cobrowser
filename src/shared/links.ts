import { inlineCodeEnds, markdownLines } from './markdown.js';

function inlineLinks(text: string): string {
  const codeEnds = inlineCodeEnds(text);
  const brackets = new Map<number, number>();
  const stack: number[] = [];
  for (let index = 0; index < text.length; index++) {
    if (text[index] === '\\') index++;
    else if (codeEnds.has(index)) index = codeEnds.get(index)! - 1;
    else if (text[index] === '`') while (text[index + 1] === '`') index++;
    else if (text[index] === '[') stack.push(index);
    else if (text[index] === ']' && stack.length) brackets.set(stack.pop()!, index);
  }

  // Bound repeated destination scans when malformed links have no closing delimiter.
  const budget = { left: text.length * 2 };
  const parts: string[] = [];
  let copied = 0;
  for (let index = 0; index < text.length; index++) {
    if (text[index] === '\\') index++;
    else if (codeEnds.has(index)) index = codeEnds.get(index)! - 1;
    else if (text[index] === '`') while (text[index + 1] === '`') index++;
    else if (text[index] === '[' && text[index - 1] !== '!') {
      const labelEnd = brackets.get(index);
      if (labelEnd === undefined || text[labelEnd + 1] !== '(') continue;
      const end = destinationEnd(text, labelEnd + 1, budget);
      if (end === undefined) continue;
      parts.push(text.slice(copied, index), text.slice(index + 1, labelEnd));
      copied = end;
      index = end - 1;
    }
  }
  parts.push(text.slice(copied));
  return parts.join('');
}

function destinationEnd(text: string, start: number, budget: { left: number }): number | undefined {
  let index = start + 1;
  const whitespace = () => {
    while (/\s/.test(text[index] || '') && budget.left-- > 0) index++;
  };
  whitespace();
  if (text[index] === '<') {
    index++;
    while (index < text.length && budget.left-- > 0 && text[index] !== '>') {
      if (text[index] === '\\') index++;
      else if (text[index] === '\n' || text[index] === '<') return undefined;
      index++;
    }
    if (text[index++] !== '>') return undefined;
  } else {
    let depth = 0;
    while (index < text.length && budget.left-- > 0) {
      const char = text[index];
      if (char === '\\') index++;
      else if (char === '(') depth++;
      else if (char === ')') {
        if (!depth) return index + 1;
        depth--;
      } else if (/\s/.test(char)) {
        if (depth) return undefined;
        break;
      } else if (char === '<') return undefined;
      index++;
    }
  }
  whitespace();
  if (text[index] === ')') return index + 1;
  const delimiter = text[index];
  if (delimiter !== '"' && delimiter !== "'" && delimiter !== '(') return undefined;
  const close = delimiter === '(' ? ')' : delimiter;
  index++;
  while (index < text.length && budget.left-- > 0 && text[index] !== close) {
    if (text[index] === '\\') index++;
    index++;
  }
  if (text[index++] !== close) return undefined;
  whitespace();
  return text[index] === ')' ? index + 1 : undefined;
}

export function plainLinks(markdown: string): string {
  const parts: string[] = [];
  let prose = '';
  const flush = () => {
    if (prose) parts.push(inlineLinks(prose));
    prose = '';
  };
  for (const line of markdownLines(markdown)) {
    if (line.kind !== 'prose') {
      flush();
      parts.push(line.raw);
    } else {
      prose += line.raw;
      if (!line.content) flush();
    }
  }
  flush();
  return parts.join('');
}
