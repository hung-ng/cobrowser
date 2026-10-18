import { redactEmbeddedUrls } from '../shared/url.js';

const status = document.querySelector<HTMLElement>('#status');
const toggle = document.querySelector<HTMLInputElement>('#paused');
const recent = document.querySelector<HTMLElement>('#recent');
let pauseWriteQueue: Promise<void> = Promise.resolve();
let pauseWriteVersion = 0;
function displayValue(value: unknown, maxLength: number): string {
  return redactEmbeddedUrls(
    String(value ?? '')
      .replace(/[\u0000-\u001f\u007f]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim(),
  ).slice(0, maxLength);
}
function render(state: {
  connected?: unknown;
  connectionError?: unknown;
  paused?: unknown;
  recentReads?: unknown;
}) {
  if (status)
    status.textContent = state.connectionError
      ? displayValue(state.connectionError, 500)
      : state.connected === true
        ? 'helper connection is ready'
        : 'helper connection is starting';
  if (toggle) toggle.checked = state.paused === true;
  if (recent) {
    const reads = Array.isArray(state.recentReads)
      ? state.recentReads
          .filter((entry): entry is Record<string, unknown> =>
            Boolean(entry && typeof entry === 'object'),
          )
          .slice(0, 10)
      : [];
    recent.replaceChildren(
      ...(reads.length
        ? reads.map((entry) => {
            const item = document.createElement('li');
            item.textContent = `${displayValue(entry.command || 'read', 40)} · tab ${displayValue(entry.tabId, 32)} · ${displayValue(entry.url, 2_000)}`;
            return item;
          })
        : [Object.assign(document.createElement('li'), { textContent: 'None yet.' })]),
    );
  }
}
void chrome.storage.local
  .get(['connected', 'connectionError', 'paused', 'recentReads'])
  .then(render)
  .catch(() => {
    if (status) status.textContent = 'Could not load cobrowser status. Reload this page.';
  });
chrome.storage.onChanged.addListener((changes) => {
  if (changes.connected || changes.connectionError || changes.paused || changes.recentReads)
    void chrome.storage.local
      .get(['connected', 'connectionError', 'paused', 'recentReads'])
      .then(render)
      .catch(() => {
        if (status) status.textContent = 'Could not load cobrowser status. Reload this page.';
      });
});
toggle?.addEventListener('change', () => {
  const requested = toggle.checked;
  const version = ++pauseWriteVersion;
  pauseWriteQueue = pauseWriteQueue
    .catch(() => undefined)
    .then(async () => {
      try {
        await chrome.storage.local.set({ paused: requested });
      } catch {
        if (version === pauseWriteVersion) {
          toggle.checked = !requested;
          if (status) status.textContent = 'Could not save the pause setting. Try again.';
        }
      }
    });
  void pauseWriteQueue;
});
