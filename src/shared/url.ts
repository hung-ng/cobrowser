export function redactUrl(value: unknown, maxLength = 2_000): string {
  let text = String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  try {
    const parsed = new URL(text);
    if (parsed.username || parsed.password) {
      parsed.username = '';
      parsed.password = '';
      text = parsed.toString();
    }
  } catch {
    /* Keep browser URLs with schemes this parser does not understand. */
  }
  return text.slice(0, maxLength);
}

const EMBEDDED_URL = /https?:\/\/[^\s<>"']+/gi;

export function redactEmbeddedUrls(value: unknown): string {
  return String(value ?? '').replace(EMBEDDED_URL, (candidate) =>
    redactUrl(candidate, Number.MAX_SAFE_INTEGER),
  );
}
