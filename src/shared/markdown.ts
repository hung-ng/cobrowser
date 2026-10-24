type Container = { kind: 'quote' } | { kind: 'list'; indent: number };

interface MarkdownLine {
  raw: string;
  content: string;
  kind: 'prose' | 'code' | 'fence';
}

function removeIndent(text: string, amount: number): string | undefined {
  let index = 0;
  let width = 0;
  while (width < amount && (text[index] === ' ' || text[index] === '\t')) {
    width += text[index++] === '\t' ? 4 - (width % 4) : 1;
  }
  return width < amount ? undefined : ' '.repeat(width - amount) + text.slice(index);
}

function removeQuote(text: string): string | undefined {
  const marker = /^ {0,3}>/.exec(text);
  if (!marker) return undefined;
  const rest = text.slice(marker[0].length);
  return rest[0] === ' ' || rest[0] === '\t' ? removeIndent(rest, 1)! : rest;
}

export function* markdownLines(markdown: string): Generator<MarkdownLine> {
  let containers: Container[] = [];
  let fence: { marker: string; length: number } | undefined;
  let paragraph = false;
  for (const raw of markdown.match(/[^\n]*\n|[^\n]+$/g) || []) {
    const line = raw.replace(/\r?\n$/, '');
    let content = line;
    let matched = 0;
    for (const container of containers) {
      const rest =
        container.kind === 'quote'
          ? removeQuote(content)
          : !content.trim()
            ? ''
            : removeIndent(content, container.indent);
      if (rest === undefined) break;
      content = rest;
      matched++;
    }
    if (matched !== containers.length) {
      fence = undefined;
      if (line.trim()) containers = containers.slice(0, matched);
      paragraph = false;
    }
    if (fence) {
      const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(content);
      if (
        marker &&
        marker[1][0] === fence.marker &&
        marker[1].length >= fence.length &&
        !marker[2].trim()
      ) {
        fence = undefined;
        yield { raw, content, kind: 'fence' };
      } else yield { raw, content, kind: 'code' };
      continue;
    }
    if (!line.trim()) {
      paragraph = false;
      yield { raw, content: '', kind: 'prose' };
      continue;
    }
    while (true) {
      const quoted = removeQuote(content);
      if (quoted !== undefined) {
        containers.push({ kind: 'quote' });
        content = quoted;
        paragraph = false;
        continue;
      }
      const item = /^( {0,3})([-+*]|\d{1,9}[.)])([ \t]+|$)/.exec(content);
      if (!item) break;
      const markerWidth = item[1].length + item[2].length;
      let column = markerWidth;
      for (const space of item[3]) column += space === '\t' ? 4 - (column % 4) : 1;
      const padding = column - markerWidth;
      const consumed = padding > 0 && padding <= 4 ? padding : 1;
      containers.push({ kind: 'list', indent: markerWidth + consumed });
      content = item[3] ? removeIndent(content.slice(markerWidth), consumed)! : '';
      paragraph = false;
    }
    if (!content.trim()) {
      paragraph = false;
      yield { raw, content: '', kind: 'prose' };
      continue;
    }
    const indented = removeIndent(content, 4);
    if (indented !== undefined && !paragraph) {
      yield { raw, content: indented, kind: 'code' };
      continue;
    }
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(content);
    if (marker && (marker[1][0] !== '`' || !marker[2].includes('`'))) {
      fence = { marker: marker[1][0], length: marker[1].length };
      paragraph = false;
      yield { raw, content, kind: 'fence' };
      continue;
    }
    paragraph = !/^ {0,3}(?:#{1,6}(?:[ \t]|$)|(?:=+|-+)[ \t]*$|(?:[-*_][ \t]*){3,}$)/.test(content);
    yield { raw, content, kind: 'prose' };
  }
}

export function inlineCodeEnds(text: string): Map<number, number> {
  const ticks: Array<{ start: number; length: number }> = [];
  for (let index = 0; index < text.length; index++) {
    // Backslashes inside code cannot escape a closing delimiter.
    if (text[index] === '`') {
      const start = index;
      while (text[index + 1] === '`') index++;
      ticks.push({ start, length: index - start + 1 });
    }
  }
  const nextTick = new Map<number, number>();
  const ends = new Map<number, number>();
  for (const tick of ticks.reverse()) {
    const next = nextTick.get(tick.length);
    if (next !== undefined) ends.set(tick.start, next);
    const escapedFirst = tick.length > 1 ? nextTick.get(tick.length - 1) : undefined;
    if (escapedFirst !== undefined) ends.set(tick.start + 1, escapedFirst);
    nextTick.set(tick.length, tick.start + tick.length);
  }
  return ends;
}
