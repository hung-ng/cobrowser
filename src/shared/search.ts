export interface SearchMatch {
  line: string;
  section: string;
}

export function findInMarkdown(markdown: string, query: string, limit = 20): SearchMatch[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const matches: SearchMatch[] = [];
  let section = '0';
  const stack: Array<{ level: number; number: string; children: number }> = [];
  let roots = 0;
  for (const rawLine of markdown.split(/\r?\n/)) {
    const heading = /^(#{1,3})\s+(.+?)\s*$/.exec(rawLine);
    if (heading) {
      const level = heading[1].length;
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
    if (!rawLine.toLowerCase().includes(needle)) continue;
    const lower = rawLine.toLowerCase();
    const index = lower.indexOf(needle);
    let line = rawLine;
    if (rawLine.length > 200) {
      const startMarker = index > 80;
      const endMarker = index + needle.length + 80 < rawLine.length;
      const window = 200 - Number(startMarker) - Number(endMarker);
      const start = Math.max(0, Math.min(index - (startMarker ? 80 : 0), rawLine.length - window));
      line = `${startMarker ? '…' : ''}${rawLine.slice(start, start + window)}${endMarker ? '…' : ''}`;
    }
    matches.push({ line, section });
    if (matches.length >= limit) break;
  }
  return matches;
}
