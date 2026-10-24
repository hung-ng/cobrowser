import {
  DEFAULT_DENYLIST,
  MAX_DENYLIST_ENTRIES,
  MAX_DENYLIST_PATTERN_LENGTH,
  normalizeDenylist,
  normalizeDenylistPattern,
} from '../shared/denylist.js';
import {
  MAX_DENYLIST_DRAFT_CHARS,
  mergeDenylistEdit,
  parseDenylistDraft,
} from '../shared/denylist-edit.js';

export const OPTIONS_SETTINGS_MESSAGE = 'cobrowser:denylist';
export type OptionsSettingsRequest =
  | { type: typeof OPTIONS_SETTINGS_MESSAGE; action: 'save'; baseline: string[]; draft: string }
  | { type: typeof OPTIONS_SETTINGS_MESSAGE; action: 'restore' };
export type OptionsSettingsReply =
  { ok: true; denylist: string[]; message: string } | { ok: false; message: string };

function validRequest(value: Record<string, unknown>): value is OptionsSettingsRequest {
  if (value.action === 'restore')
    return Object.keys(value).every((key) => key === 'type' || key === 'action');
  return (
    value.action === 'save' &&
    Object.keys(value).every((key) => ['type', 'action', 'baseline', 'draft'].includes(key)) &&
    typeof value.draft === 'string' &&
    value.draft.length <= MAX_DENYLIST_DRAFT_CHARS &&
    Array.isArray(value.baseline) &&
    value.baseline.length <= MAX_DENYLIST_ENTRIES &&
    value.baseline.every(
      (pattern) =>
        typeof pattern === 'string' &&
        pattern.length <= MAX_DENYLIST_PATTERN_LENGTH &&
        normalizeDenylistPattern(pattern) === pattern,
    ) &&
    new Set(value.baseline).size === value.baseline.length
  );
}

export function registerOptionsSettings() {
  let writes: Promise<void> = Promise.resolve();
  chrome.runtime.onMessage.addListener((message: unknown, sender, respond) => {
    if (
      !message ||
      typeof message !== 'object' ||
      Array.isArray(message) ||
      (message as Record<string, unknown>).type !== OPTIONS_SETTINGS_MESSAGE
    )
      return false;
    const optionsUrl = chrome.runtime.getURL('options.html');
    if (
      sender.id !== chrome.runtime.id ||
      (sender.frameId !== undefined && sender.frameId !== 0) ||
      sender.url?.split(/[?#]/, 1)[0] !== optionsUrl
    )
      return false;
    if (!validRequest(message as Record<string, unknown>)) {
      respond({
        ok: false,
        message: 'The denylist save request is invalid; reload this page and try again.',
      });
      return false;
    }
    const request = message as OptionsSettingsRequest;
    writes = writes
      .catch(() => undefined)
      .then(async () => {
        let reply: OptionsSettingsReply;
        try {
          if (request.action === 'restore') {
            await chrome.storage.local.set({ denylist: [...DEFAULT_DENYLIST] });
            reply = { ok: true, denylist: [...DEFAULT_DENYLIST], message: 'Defaults restored.' };
          } else {
            const parsed = parseDenylistDraft(request.draft);
            const state = await chrome.storage.local.get({ denylist: DEFAULT_DENYLIST });
            const denylist = mergeDenylistEdit(
              request.baseline,
              parsed.patterns,
              normalizeDenylist(state.denylist),
            );
            await chrome.storage.local.set({ denylist });
            reply = {
              ok: true,
              denylist,
              message:
                denylist.join('\n') === parsed.patterns.join('\n')
                  ? parsed.message
                  : parsed.message.includes('Defaults restored.')
                    ? parsed.message.replace(
                        'Defaults restored.',
                        'Default entries merged with saved changes.',
                      )
                    : `${parsed.message} Newer changes kept.`,
            };
          }
        } catch (error) {
          reply = {
            ok: false,
            message:
              error instanceof Error && error.message.startsWith('The combined denylist exceeds ')
                ? error.message
                : request.action === 'restore'
                  ? 'Could not restore the defaults. Try again.'
                  : 'Could not save the denylist. Try again.',
          };
        }
        respond(reply);
      });
    return true;
  });
}
