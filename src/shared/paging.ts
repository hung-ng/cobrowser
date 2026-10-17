export function splitPages(text: string, maxChars: number): string[] {
  if (text.length <= maxChars) return [text];
  const paragraphs = text.split(/\n\s*\n/);
  const pages: string[] = [];
  let current = '';
  for (const paragraph of paragraphs) {
    if (paragraph.length > maxChars) {
      if (current) (pages.push(current), (current = ''));
      for (let i = 0; i < paragraph.length; i += maxChars)
        pages.push(paragraph.slice(i, i + maxChars));
    } else if (!current) current = paragraph;
    else if (current.length + 2 + paragraph.length <= maxChars) current += `\n\n${paragraph}`;
    else (pages.push(current), (current = paragraph));
  }
  if (current || !pages.length) pages.push(current);
  return pages;
}

export function capText(
  text: string,
  maxChars: number,
  nextCommand?: string,
  label = 'more',
): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  const suffix = nextCommand ? `\n\n${label}: ${nextCommand}` : '';
  if (suffix.length >= maxChars) return { text: suffix.slice(0, maxChars), truncated: true };
  const take = Math.max(0, maxChars - suffix.length);
  return { text: `${text.slice(0, take)}${suffix}`, truncated: true };
}
