export function redactUrl(value: unknown, maxLength = 2_000): string {
  let text = String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  try {
    const relative = text.startsWith('//');
    const parsed = new URL(relative ? `https:${text}` : text);
    if (parsed.username || parsed.password) {
      parsed.username = '';
      parsed.password = '';
      text = relative ? parsed.toString().slice('https:'.length) : parsed.toString();
    }
  } catch {
    /* Keep browser URLs with schemes this parser does not understand. */
  }
  return text.slice(0, maxLength);
}

const EMBEDDED_URL = /https?:\/\/[^\s<>"']+/gi;
const AUTHORITY_CREDENTIALS = /(https?:\/\/|(?<!:)\/\/)[^/\s?#<>]*@/gi;

export function redactEmbeddedUrls(value: unknown): string {
  // Quotes can belong to a password, so remove userinfo before locating URL boundaries.
  return String(value ?? '')
    .replace(AUTHORITY_CREDENTIALS, '$1')
    .replace(EMBEDDED_URL, (candidate) => redactUrl(candidate, Number.MAX_SAFE_INTEGER));
}
