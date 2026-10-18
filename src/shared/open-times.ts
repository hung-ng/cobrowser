export interface OpenTimes {
  [tabId: string]: number;
}

export function normalizeOpenTimes(value: unknown): OpenTimes {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const normalized: OpenTimes = {};
  for (const [tabId, openedAt] of Object.entries(value)) {
    if (!/^\d+$/.test(tabId) || typeof openedAt !== 'number' || !Number.isSafeInteger(openedAt))
      continue;
    const numericTabId = Number(tabId);
    if (openedAt >= 0 && Number.isSafeInteger(numericTabId) && numericTabId >= 0)
      normalized[String(numericTabId)] = openedAt;
  }
  return normalized;
}
