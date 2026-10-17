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

export function matchesDenylist(url: string, patterns: string[]): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const host = parsed.hostname.toLocaleLowerCase();
  const path = parsed.pathname.replace(/\/+$/, '').toLocaleLowerCase();
  return patterns.some((raw) => {
    const pattern = raw.trim().toLocaleLowerCase().replace(/^\*\./, '').replace(/\/+$/, '');
    if (!pattern) return false;
    const slash = pattern.indexOf('/');
    const patternHost = slash < 0 ? pattern : pattern.slice(0, slash);
    const patternPath = slash < 0 ? '' : pattern.slice(slash);
    const hostMatch = host === patternHost || host.endsWith(`.${patternHost}`);
    return (
      hostMatch && (!patternPath || path === patternPath || path.startsWith(`${patternPath}/`))
    );
  });
}
