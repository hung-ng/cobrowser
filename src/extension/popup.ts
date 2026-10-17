const status = document.querySelector<HTMLElement>('#status');
const toggle = document.querySelector<HTMLInputElement>('#paused');
if (status)
  chrome.storage.local.get(['connectionError', 'paused']).then((state) => {
    status.textContent = String(state.connectionError || 'helper connection is ready');
    if (toggle) toggle.checked = Boolean(state.paused);
  });
toggle?.addEventListener('change', () => {
  void chrome.storage.local.set({ paused: toggle.checked });
});
