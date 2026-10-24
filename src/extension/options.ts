import { DEFAULT_DENYLIST, normalizeDenylist } from '../shared/denylist.js';
import { parseDenylistDraft } from '../shared/denylist-edit.js';
import {
  OPTIONS_SETTINGS_MESSAGE,
  type OptionsSettingsReply,
  type OptionsSettingsRequest,
} from './options-settings.js';

const input = document.querySelector<HTMLTextAreaElement>('#denylist')!;
const save = document.querySelector<HTMLButtonElement>('#save')!;
const restore = document.querySelector<HTMLButtonElement>('#restore')!;
const status = document.querySelector<HTMLElement>('#status')!;
let loaded = false;
let dirty = false;
let revision = 0;
let pending = 0;
let storageRevision = 0;
let current = [...DEFAULT_DENYLIST];
let baseline: Promise<string[]> = Promise.resolve(current);
let writes: Promise<unknown> = Promise.resolve();
let reads: Promise<void> = Promise.resolve();

function showSaved(patterns: string[]) {
  input.value = patterns.join('\n');
  baseline = Promise.resolve(patterns);
  dirty = false;
}

function readCurrent(): Promise<void> {
  const refresh = reads
    .catch(() => undefined)
    .then(async () => {
      for (let attempt = 0; attempt < 3; attempt++) {
        if (attempt) await new Promise<void>((resolve) => setTimeout(resolve, 25));
        const version = storageRevision;
        try {
          const state = await chrome.storage.local.get({ denylist: DEFAULT_DENYLIST });
          // An intervening event can describe either side of the captured snapshot.
          if (version !== storageRevision) continue;
          current = normalizeDenylist(state.denylist);
          return;
        } catch {
          /* A fresh read may recover from a transient storage failure. */
        }
      }
      throw new Error('The current denylist could not be verified.');
    });
  reads = refresh;
  return refresh;
}

input.disabled = save.disabled = restore.disabled = true;
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.denylist) return;
  storageRevision++;
  if (!loaded || pending) return;
  if (dirty) status.textContent = 'Unsaved changes. The saved denylist has changed.';
  else {
    const changedRevision = revision;
    status.textContent = 'Refreshing the denylist...';
    void readCurrent()
      .then(() => {
        if (dirty || pending || revision !== changedRevision) return;
        showSaved(current);
        status.textContent = 'Denylist updated.';
      })
      .catch(() => {
        if (!dirty && !pending && revision === changedRevision)
          status.textContent = 'The current denylist could not be verified; try Save again.';
      });
  }
});
void readCurrent()
  .then(() => {
    loaded = true;
    showSaved(current);
    input.disabled = save.disabled = restore.disabled = false;
  })
  .catch(() => {
    status.textContent = 'Could not load the denylist. Reload this page.';
  });

input.addEventListener('input', () => {
  revision++;
  dirty = true;
  status.textContent = 'Unsaved changes.';
});

function submit(reset: boolean) {
  if (!loaded) return;
  if (reset) {
    input.value = DEFAULT_DENYLIST.join('\n');
    revision++;
  }
  const draft = input.value;
  const submittedRevision = revision;
  const previous = baseline;
  const intent = reset ? [...DEFAULT_DENYLIST] : parseDenylistDraft(draft).patterns;
  pending++;
  dirty = true;
  status.textContent = 'Saving...';
  const operation = writes
    .catch(() => undefined)
    .then(async () => {
      const before = await previous;
      let reply: OptionsSettingsReply;
      try {
        const request: OptionsSettingsRequest = reset
          ? { type: OPTIONS_SETTINGS_MESSAGE, action: 'restore' }
          : { type: OPTIONS_SETTINGS_MESSAGE, action: 'save', baseline: before, draft };
        reply = await chrome.runtime.sendMessage(request);
        if (!reply || typeof reply.ok !== 'boolean') throw new Error('Missing save reply.');
      } catch {
        reply = {
          ok: false,
          message: reset
            ? 'Could not restore the defaults. Try again.'
            : 'Could not save the denylist. Try again.',
        };
      }
      let message = reply.message;
      if (reply.ok) {
        try {
          await readCurrent();
          if (revision === submittedRevision) showSaved(current);
        } catch {
          if (revision === submittedRevision) dirty = false;
          message =
            'The save completed, but the current denylist could not be verified; try Save again.';
        }
      }
      status.textContent =
        revision === submittedRevision ? message : `${message} You have unsaved changes.`;
      pending--;
      return reply.ok ? intent : before;
    });
  // A later draft is based on submitted intent, before it has seen any merged rules.
  baseline = operation;
  writes = operation;
}

save.addEventListener('click', () => submit(false));
restore.addEventListener('click', () => submit(true));
