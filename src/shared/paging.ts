export function splitPages(text: string, maxChars: number): string[] {
  const limit = Number.isFinite(maxChars) && maxChars >= 1 ? Math.floor(maxChars) : 1;
  if (text.length <= limit) return [text];
  const paragraphs = text.split(/\n\s*\n/);
  const pages: string[] = [];
  let current = '';
  for (const paragraph of paragraphs) {
    if (paragraph.length > limit) {
      if (current) (pages.push(current), (current = ''));
      for (let i = 0; i < paragraph.length; i += limit) pages.push(paragraph.slice(i, i + limit));
    } else if (!current) current = paragraph;
    else if (current.length + 2 + paragraph.length <= limit) current += `\n\n${paragraph}`;
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

function capEmbeddedText(text: string, maxChars: number): string {
  const continuation = /\n\n(next|more): ([^\n]+)$/.exec(text);
  if (!continuation) return text.slice(0, maxChars);
  const suffix = `\n\n${continuation[1]}: ${continuation[2]}`;
  if (suffix.length > maxChars) return '';
  const prefix = text.slice(0, continuation.index);
  if (prefix.length + suffix.length <= maxChars) return `${prefix}${suffix}`;
  return `${prefix.slice(0, Math.max(0, maxChars - suffix.length))}${suffix}`;
}

/** Keep structured responses within the same cap as their human-readable text. */
export function capResponse(
  payload: Record<string, unknown>,
  maxChars: number,
): Record<string, unknown> {
  const fits = (value: Record<string, unknown>) => JSON.stringify(value).length <= maxChars;
  if (fits(payload)) return payload;

  const withoutData = { ...payload };
  delete withoutData.data;
  if (fits(withoutData)) return withoutData;

  if (typeof withoutData.text === 'string') {
    const original = withoutData.text;
    let low = 0;
    let high = original.length;
    let best: Record<string, unknown> | undefined;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      const candidate = { ...withoutData, text: capEmbeddedText(original, middle) };
      if (fits(candidate)) {
        best = candidate;
        low = middle + 1;
      } else high = middle - 1;
    }
    if (best) return best;
  }

  if (
    withoutData.error &&
    typeof withoutData.error === 'object' &&
    !Array.isArray(withoutData.error)
  ) {
    const error = withoutData.error as Record<string, unknown>;
    const message = typeof error.message === 'string' ? error.message : '';
    let low = 0;
    let high = message.length;
    let best: Record<string, unknown> | undefined;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      const candidate = {
        ...withoutData,
        error: { ...error, message: message.slice(0, middle) },
      };
      if (fits(candidate)) {
        best = candidate;
        low = middle + 1;
      } else high = middle - 1;
    }
    if (best) return best;
  }

  const minimal: Record<string, unknown> = {};
  if ('ok' in payload) minimal.ok = payload.ok;
  if ('error' in payload) minimal.error = payload.error;
  if (fits(minimal)) return minimal;
  return 'ok' in payload ? { ok: payload.ok } : {};
}
