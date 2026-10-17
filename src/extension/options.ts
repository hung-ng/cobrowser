import { DEFAULT_DENYLIST } from '../shared/denylist.js';
const input = document.querySelector<HTMLTextAreaElement>('#denylist');
const save = document.querySelector<HTMLButtonElement>('#save');
const restore = document.querySelector<HTMLButtonElement>('#restore');
void chrome.storage.local.get({ denylist: DEFAULT_DENYLIST }).then((state) => {
  if (input) input.value = (state.denylist as string[]).join('\n');
});
save?.addEventListener('click', () => {
  void chrome.storage.local.set({
    denylist: (input?.value || '')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean),
  });
});
restore?.addEventListener('click', () => {
  if (input) input.value = DEFAULT_DENYLIST.join('\n');
});
