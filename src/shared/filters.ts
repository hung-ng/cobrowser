export interface TabInfo {
  id: number;
  windowId: number;
  active: boolean;
  title: string;
  url: string;
  lastAccessed?: number;
  openedAt?: number;
  discarded?: boolean;
  status?: string;
  incognito?: boolean;
  denied?: boolean;
}

export interface TabFilter {
  match?: string;
  sinceMs?: number;
  now?: number;
  window?: number | 'front';
  active?: boolean;
}

export function filterTabs(tabs: TabInfo[], filter: TabFilter, frontWindowId?: number): TabInfo[] {
  const words = (filter.match ?? '').trim().toLowerCase().split(/\s+/).filter(Boolean);
  const now = filter.now ?? Date.now();
  const cutoff = filter.sinceMs === undefined ? undefined : now - filter.sinceMs;
  return tabs
    .filter(
      (tab) =>
        filter.window === undefined ||
        (filter.window === 'front'
          ? tab.windowId === frontWindowId
          : tab.windowId === filter.window),
    )
    .filter((tab) => !filter.active || tab.active)
    .filter((tab) => cutoff === undefined || (tab.openedAt !== undefined && tab.openedAt >= cutoff))
    .filter((tab) => words.every((word) => `${tab.title} ${tab.url}`.toLowerCase().includes(word)))
    .sort((a, b) => {
      if (a.openedAt !== undefined && b.openedAt !== undefined && a.openedAt !== b.openedAt)
        return b.openedAt - a.openedAt;
      if (a.openedAt !== undefined) return -1;
      if (b.openedAt !== undefined) return 1;
      const access = (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0);
      return access || b.id - a.id;
    });
}

export function siteForUrl(url: string): string {
  try {
    const host = new URL(url).hostname.replace(/^www\./i, '');
    return host || url;
  } catch {
    return url;
  }
}
