type TextSize = (text: string) => number;
const characterCount: TextSize = (text) => text.length;

export const jsonTextSize: TextSize = (text) => JSON.stringify(text).length - 2;

function boundedPrefix(text: string, limit: number, size: TextSize): string {
  let length = 0;
  let used = 0;
  for (const character of text) {
    const cost = size(character);
    if (used + cost > limit) break;
    used += cost;
    length += character.length;
  }
  return text.slice(0, length);
}

export function splitPages(text: string, maxChars: number, size = characterCount): string[] {
  const limit = Number.isFinite(maxChars) && maxChars >= 1 ? Math.floor(maxChars) : 1;
  if (size(text) <= limit) return [text];
  const pages: string[] = [];
  let offset = 0;
  while (offset < text.length) {
    let part =
      boundedPrefix(text.slice(offset), limit, size) ||
      String.fromCodePoint(text.codePointAt(offset)!);
    if (offset + part.length < text.length) {
      let boundary = 0;
      for (const match of part.matchAll(/\n\s*\n/g))
        if (part.slice(0, match.index).trim()) boundary = match.index + match[0].length;
      if (boundary) part = part.slice(0, boundary);
    }
    pages.push(part);
    offset += part.length;
  }
  return pages.length ? pages : [''];
}

export function capText(
  text: string,
  maxChars: number,
  nextCommand?: string,
  label = 'more',
  size = characterCount,
): { text: string; truncated: boolean } {
  if (size(text) <= maxChars) return { text, truncated: false };
  const suffix = nextCommand ? `\n\n${label}: ${nextCommand}` : '';
  if (size(suffix) > maxChars)
    return {
      text: boundedPrefix(
        `Raise maxChars to ${size(suffix) + 128} and retry.`,
        Math.max(0, maxChars),
        size,
      ),
      truncated: true,
    };
  const take = Math.max(0, maxChars - size(suffix));
  return { text: `${boundedPrefix(text, take, size)}${suffix}`, truncated: true };
}

export function capContinuationText(text: string, maxChars: number): string {
  const continuation = /\n\n(next|more): ([^\n]+)$/.exec(text);
  if (!continuation) return boundedPrefix(text, maxChars, characterCount);
  const prefix = text.slice(0, continuation.index);
  return capText(
    prefix + `\n\n${continuation[1]}: ${continuation[2]}`,
    maxChars,
    continuation[2],
    continuation[1],
  ).text;
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
      const candidate = { ...withoutData, text: capContinuationText(original, middle) };
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
  const status = 'ok' in payload ? { ok: payload.ok } : {};
  if (fits(status)) return status;
  if (fits({})) return {};
  throw new RangeError('A JSON object needs at least two characters.');
}
