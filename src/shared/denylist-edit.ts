import { MAX_DENYLIST_ENTRIES, normalizeDenylist, normalizeDenylistPattern } from './denylist.js';

export const MAX_DENYLIST_DRAFT_CHARS = 524_544;

export function parseDenylistDraft(draft: string): { patterns: string[]; message: string } {
  const lines = draft
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const truncatedCount = Math.max(0, lines.length - MAX_DENYLIST_ENTRIES);
  const normalized = lines.slice(0, MAX_DENYLIST_ENTRIES).map(normalizeDenylistPattern);
  const invalidCount = normalized.filter((line) => line === undefined).length;
  const valid = normalized.filter((line): line is string => line !== undefined);
  const duplicateCount = valid.length - new Set(valid).size;
  const normalizedCount = normalized.filter(
    (line, index) => line !== undefined && line !== lines[index],
  ).length;
  const message =
    lines.length > 0 && valid.length === 0
      ? truncatedCount
        ? `No valid entries in the first ${MAX_DENYLIST_ENTRIES} lines. Defaults restored. Ignored ${truncatedCount} entries after the first ${MAX_DENYLIST_ENTRIES}.`
        : 'No valid entries. Defaults restored.'
      : truncatedCount
        ? `Saved. Ignored ${truncatedCount} entries after the first ${MAX_DENYLIST_ENTRIES}.`
        : invalidCount
          ? `Saved. Ignored ${invalidCount} invalid line${invalidCount === 1 ? '' : 's'}.`
          : duplicateCount
            ? `Saved. Removed ${duplicateCount} duplicate line${duplicateCount === 1 ? '' : 's'}.`
            : normalizedCount
              ? 'Saved. Entries normalized.'
              : 'Saved.';
  return { patterns: normalizeDenylist(lines), message };
}

export function mergeDenylistEdit(base: string[], edited: string[], current: string[]): string[] {
  const before = new Set(base);
  const after = new Set(edited);
  const stored = new Set(current);
  const merged =
    before.size === stored.size && base.every((pattern) => stored.has(pattern))
      ? [...edited]
      : [
          ...current.filter((pattern) => !before.has(pattern) || after.has(pattern)),
          ...edited.filter((pattern) => !before.has(pattern) && !stored.has(pattern)),
        ];
  if (merged.length > MAX_DENYLIST_ENTRIES)
    throw new Error(
      `The combined denylist exceeds ${MAX_DENYLIST_ENTRIES} entries; remove some patterns and save again.`,
    );
  return merged;
}
