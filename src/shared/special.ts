export type SpecialKind = 'pdf' | 'google-doc' | 'google-sheet' | 'google-slide';

export interface GoogleExport {
  kind: Exclude<SpecialKind, 'pdf'>;
  url: string;
  contentType: string;
}

function googleId(url: URL, type: string): string | undefined {
  const match = new RegExp(`/${type}/(?:u/\\d+/)?d/([^/]+)`).exec(url.pathname);
  return match?.[1];
}

export function googleExportUrl(rawUrl: string): GoogleExport | undefined {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
  if (url.hostname !== 'docs.google.com') return undefined;
  if (url.pathname.startsWith('/document/')) {
    const id = googleId(url, 'document');
    return id
      ? {
          kind: 'google-doc',
          url: `https://docs.google.com/document/d/${encodeURIComponent(id)}/export?format=md`,
          contentType: 'text/markdown',
        }
      : undefined;
  }
  if (url.pathname.startsWith('/spreadsheets/')) {
    const id = googleId(url, 'spreadsheets');
    if (!id) return undefined;
    const gid =
      new URLSearchParams(url.hash.replace(/^#/, '')).get('gid') || url.searchParams.get('gid');
    const suffix = gid ? `&gid=${encodeURIComponent(gid)}` : '';
    return {
      kind: 'google-sheet',
      url: `https://docs.google.com/spreadsheets/d/${encodeURIComponent(id)}/export?format=csv${suffix}`,
      contentType: 'text/csv',
    };
  }
  if (url.pathname.startsWith('/presentation/')) {
    const id = googleId(url, 'presentation');
    return id
      ? {
          kind: 'google-slide',
          url: `https://docs.google.com/presentation/d/${encodeURIComponent(id)}/export/txt`,
          contentType: 'text/plain',
        }
      : undefined;
  }
  return undefined;
}

export function isPdfUrl(rawUrl: string, contentType?: string): boolean {
  if (contentType?.toLowerCase().split(';', 1)[0].trim() === 'application/pdf') return true;
  try {
    return new URL(rawUrl).pathname.toLowerCase().endsWith('.pdf');
  } catch {
    return false;
  }
}

export function specialKind(rawUrl: string, contentType?: string): SpecialKind | undefined {
  if (isPdfUrl(rawUrl, contentType)) return 'pdf';
  return googleExportUrl(rawUrl)?.kind;
}
