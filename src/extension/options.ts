import {
  DEFAULT_DENYLIST,
  MAX_DENYLIST_ENTRIES,
  normalizeDenylist,
  normalizeDenylistPattern,
} from '../shared/denylist.js';
const input = document.querySelector<HTMLTextAreaElement>('#denylist');
const save = document.querySelector<HTMLButtonElement>('#save');
const restore = document.querySelector<HTMLButtonElement>('#restore');
const status = document.querySelector<HTMLElement>('#status');
let userChanged = false;
let writeQueue: Promise<void> = Promise.resolve();

function persist(
  denylist: string[],
  message: string,
  failureMessage = 'Could not save the denylist. Try again.',
) {
  writeQueue = writeQueue
    .catch(() => undefined)
    .then(async () => {
      try {
        await chrome.storage.local.set({ denylist });
        if (status) status.textContent = message;
      } catch {
        if (status) status.textContent = failureMessage;
      }
    });
  void writeQueue;
}

void chrome.storage.local
  .get({ denylist: DEFAULT_DENYLIST })
  .then((state) => {
    const denylist = normalizeDenylist(state.denylist);
    if (input && !userChanged) input.value = denylist.join('\n');
  })
  .catch(() => {
    if (status) status.textContent = 'Could not load the denylist. Reload this page.';
  });
input?.addEventListener('input', () => {
  userChanged = true;
});
save?.addEventListener('click', () => {
  userChanged = true;
  const lines = (input?.value || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const truncatedCount = Math.max(0, lines.length - MAX_DENYLIST_ENTRIES);
  const effectiveLines = lines.slice(0, MAX_DENYLIST_ENTRIES);
  const normalizedLines = effectiveLines.map(normalizeDenylistPattern);
  const invalidCount = normalizedLines.filter((line) => line === undefined).length;
  const validLines = normalizedLines.filter((line): line is string => line !== undefined);
  const duplicateCount = validLines.length - new Set(validLines).size;
  const normalizedCount = normalizedLines.filter(
    (line, index) => line !== undefined && line !== lines[index],
  ).length;
  const denylist = normalizeDenylist(lines);
  const message =
    lines.length > 0 && validLines.length === 0
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
  persist(denylist, message);
});
restore?.addEventListener('click', () => {
  userChanged = true;
  if (input) input.value = DEFAULT_DENYLIST.join('\n');
  persist(DEFAULT_DENYLIST, 'Defaults restored.', 'Could not restore the defaults. Try again.');
});
