import { markdownHeadings } from './headings.js';
import { inlineCodeEnds, markdownLines } from './markdown.js';

export interface SearchMatch {
  line: string;
  section: string;
}

const escapable = /^[!-/:-@\[-`{-~]$/;
const punctuation = /[\p{P}\p{S}]/u;

function before(text: string, index: number): string {
  const last = text.charCodeAt(index - 1);
  return text.slice(index - (last >= 0xdc00 && last <= 0xdfff ? 2 : 1), index);
}

function inlineText(text: string): string {
  const codeEnds = inlineCodeEnds(text);

  const parts: Array<{ text: string; remaining?: number; opens?: boolean; closes?: boolean }> = [];
  const openers = new Map<string, number[]>();
  let copied = 0;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (char === '\\' && escapable.test(text[index + 1] || '')) {
      parts.push({ text: text.slice(copied, index) }, { text: text[++index] });
      copied = index + 1;
    } else if (char === '`') {
      let length = 1;
      while (text[index + length] === '`') length++;
      const end = codeEnds.get(index);
      if (end === undefined) {
        index += length - 1;
        continue;
      }
      let code = text.slice(index + length, end - length);
      if (code.startsWith(' ') && code.endsWith(' ') && /\S/.test(code)) code = code.slice(1, -1);
      parts.push({ text: text.slice(copied, index) }, { text: code });
      index = end - 1;
      copied = end;
    } else if (char === '*' || char === '_' || char === '~') {
      let end = index + 1;
      while (text[end] === char) end++;
      const length = end - index;
      if (char === '~' && length > 2) {
        index = end - 1;
        continue;
      }
      const previous = before(text, index);
      const next = end < text.length ? String.fromCodePoint(text.codePointAt(end)!) : '';
      const left =
        Boolean(next) &&
        !/\s/.test(next) &&
        (!punctuation.test(next) || !previous || /\s/.test(previous) || punctuation.test(previous));
      const right =
        Boolean(previous) &&
        !/\s/.test(previous) &&
        (!punctuation.test(previous) || !next || /\s/.test(next) || punctuation.test(next));
      const opens = left && (char !== '_' || !right || punctuation.test(previous));
      const closes = right && (char !== '_' || !left || punctuation.test(next));
      parts.push({ text: text.slice(copied, index) });
      const part = { text: char, remaining: length, opens, closes };
      const delimiter = char === '~' ? `${char}${length}` : char;
      const candidates = openers.get(delimiter) || [];
      if (closes) {
        while (part.remaining && candidates.length) {
          const opener = parts[candidates[candidates.length - 1]];
          if (
            char !== '~' &&
            (opens || opener.closes) &&
            (length + opener.remaining!) % 3 === 0 &&
            (length % 3 !== 0 || opener.remaining! % 3 !== 0)
          )
            break;
          const take = Math.min(part.remaining, opener.remaining!);
          if (!take) break;
          part.remaining -= take;
          opener.remaining! -= take;
          if (!opener.remaining) candidates.pop();
        }
      }
      if (opens && part.remaining) candidates.push(parts.length);
      openers.set(delimiter, candidates);
      parts.push(part);
      index = end - 1;
      copied = end;
    }
  }
  parts.push({ text: text.slice(copied) });
  return parts
    .map((part) => (part.remaining === undefined ? part.text : part.text.repeat(part.remaining)))
    .join('');
}

function* renderedLines(markdown: string): Generator<string> {
  for (const line of markdownLines(markdown)) {
    if (line.kind === 'fence') {
      yield '';
      continue;
    }
    if (line.kind === 'code') {
      yield line.content;
      continue;
    }
    let content = line.content.trimStart();
    if (/^ {0,3}#{1,6}[\t ]+/.test(line.content))
      content = content.replace(/^#{1,6}[\t ]+/, '').replace(/[\t ]+#+[\t ]*$/, '');
    yield inlineText(content);
  }
}

// Scalar widths map offsets without replacing contextual whole-line lowercase matching.
function matchBounds(line: string, index: number, length: number): [number, number] {
  let position = 0;
  let folded = 0;
  let start = 0;
  for (const char of line) {
    const next = folded + char.toLowerCase().length;
    if (folded <= index && index < next) start = position;
    position += char.length;
    if (next >= index + length) return [start, position];
    folded = next;
  }
  return [start, position];
}

function excerpt(line: string, start: number, end: number): string {
  if (line.length <= 200) return line;
  let from = Math.max(0, start - Math.min(80, Math.max(0, 198 - (end - start))));
  let to = Math.min(line.length, from + 198);
  if (to === line.length) from = Math.max(0, to - 199);
  const first = line.charCodeAt(from);
  if (first >= 0xdc00 && first <= 0xdfff) from++;
  const last = line.charCodeAt(to - 1);
  if (last >= 0xd800 && last <= 0xdbff) to--;
  return `${from ? '…' : ''}${line.slice(from, to)}${to < line.length ? '…' : ''}`;
}

export function findInMarkdown(markdown: string, query: string, limit = 20): SearchMatch[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const matches: SearchMatch[] = [];
  const headings = markdownHeadings(markdown);
  let section = '0';
  const stack: Array<{ level: number; number: string; children: number }> = [];
  let roots = 0;
  let lineIndex = 0;
  for (const line of renderedLines(markdown)) {
    const heading = headings.get(lineIndex++);
    if (heading) {
      const { level } = heading;
      while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
      if (stack.length) {
        const parent = stack[stack.length - 1];
        parent.children++;
        section = `${parent.number}.${parent.children}`;
      } else {
        roots++;
        section = String(roots);
      }
      stack.push({ level, number: section, children: 0 });
    }
    const index = line.toLowerCase().indexOf(needle);
    if (index < 0) continue;
    const [start, end] = matchBounds(line, index, needle.length);
    matches.push({ line: excerpt(line, start, end), section });
    if (matches.length >= limit) break;
  }
  return matches;
}
