export const DEFAULT_DENYLIST = [
  'paypal.com',
  'stripe.com',
  'chase.com',
  'bankofamerica.com',
  'wellsfargo.com',
  'capitalone.com',
  'americanexpress.com',
  'icloud.com/mail',
  'mail.google.com',
  'outlook.live.com',
  'outlook.office.com',
  'mail.proton.me',
  'mail.yahoo.com',
  'app.fastmail.com',
  'app.hey.com',
  '1password.com',
  'lastpass.com',
  'bitwarden.com',
  'dashlane.com',
];
export const MAX_DENYLIST_ENTRIES = 256;
export const MAX_DENYLIST_PATTERN_LENGTH = 2_048;

export function normalizeDenylistPattern(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim().toLowerCase();
  if (
    !trimmed ||
    trimmed.length > MAX_DENYLIST_PATTERN_LENGTH ||
    trimmed.includes('://') ||
    /[\s\u0000-\u001f\u007f]/.test(trimmed)
  )
    return undefined;
  const withoutWildcard = trimmed.replace(/^\*\./, '');
  const canonical = withoutWildcard.replace(/\/+$/, '').replace(/\.+$/, '');
  const slash = canonical.indexOf('/');
  const host = slash < 0 ? canonical : canonical.slice(0, slash);
  const ipv6 = /^\[[0-9a-f:.]+\]$/i.test(host);
  const labels = host.split('.');
  const dnsHost =
    host.length <= 253 &&
    labels.every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label));
  if (!host || (!ipv6 && !dnsHost)) return undefined;
  const path = slash < 0 ? '' : canonical.slice(slash);
  if (path && (!path.startsWith('/') || /[?#]/.test(path))) return undefined;
  return `${host}${path}`;
}

export function normalizeDenylist(value: unknown): string[] {
  if (!Array.isArray(value)) return DEFAULT_DENYLIST;
  const patterns = [
    ...new Set(
      value
        .slice(0, MAX_DENYLIST_ENTRIES)
        .flatMap((pattern) => [normalizeDenylistPattern(pattern)].filter(Boolean)),
    ),
  ] as string[];
  return value.length > 0 && patterns.length === 0 ? DEFAULT_DENYLIST : patterns;
}

function comparablePath(path: string): string {
  // A malformed suffix must not prevent a valid escaped prefix from matching.
  path = path.replace(/(?:%[0-9a-f]{2})+/gi, (escaped) =>
    new TextDecoder('utf-8', { ignoreBOM: true }).decode(
      Uint8Array.from(escaped.match(/%[0-9a-f]{2}/gi)!, (byte) => parseInt(byte.slice(1), 16)),
    ),
  );
  return path.replace(/\/+$/, '').toLowerCase();
}

export function matchesDenylist(url: string, patterns: string[]): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const host = parsed.hostname.toLowerCase().replace(/\.+$/, '');
  const path = comparablePath(parsed.pathname);
  return patterns.some((raw) => {
    if (typeof raw !== 'string') return false;
    const pattern = normalizeDenylistPattern(raw);
    if (!pattern) return false;
    const slash = pattern.indexOf('/');
    const patternHost = (slash < 0 ? pattern : pattern.slice(0, slash)).replace(/\.+$/, '');
    const patternPath = slash < 0 ? '' : comparablePath(pattern.slice(slash));
    const hostMatch = host === patternHost || host.endsWith(`.${patternHost}`);
    return (
      hostMatch && (!patternPath || path === patternPath || path.startsWith(`${patternPath}/`))
    );
  });
}
