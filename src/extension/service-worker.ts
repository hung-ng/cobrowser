import { DEFAULT_DENYLIST, matchesDenylist } from '../shared/denylist.js';
import { NATIVE_HOST, PROTOCOL_VERSION, VERSION } from '../shared/constants.js';
import { encodeFrame } from '../shared/native.js';

interface OpenTimes {
  [tabId: string]: number;
}
interface RequestMessage {
  id: number;
  method: string;
  params?: any;
}
let nativePort: chrome.runtime.Port | undefined;
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
let reconnectDelay = 1000;
let openTimes: OpenTimes = {};

const storageSession = () => (chrome.storage as any).session as chrome.storage.StorageArea;
async function loadOpenTimes() {
  const result = await storageSession().get('openTimes');
  openTimes = (result.openTimes || {}) as OpenTimes;
}
async function saveOpenTimes() {
  await storageSession().set({ openTimes });
}
async function denyPatterns(): Promise<string[]> {
  const result = await chrome.storage.local.get({ denylist: DEFAULT_DENYLIST });
  return Array.isArray(result.denylist) ? result.denylist : DEFAULT_DENYLIST;
}
async function paused(): Promise<boolean> {
  const result = await chrome.storage.local.get({ paused: false });
  return Boolean(result.paused);
}
function send(value: unknown) {
  try {
    nativePort?.postMessage(value);
  } catch {
    /* reconnect handler will restore the port */
  }
}
function errorResponse(id: number, code: string, message: string) {
  send({ id, ok: false, error: { code, message } });
}

async function connect() {
  if (nativePort) return;
  try {
    const port = chrome.runtime.connectNative(NATIVE_HOST);
    nativePort = port;
    reconnectDelay = 1000;
    port.onMessage.addListener((message) => void handleRequest(message as RequestMessage));
    port.onDisconnect.addListener(() => {
      const lastError = chrome.runtime.lastError;
      if (lastError) void chrome.storage.local.set({ connectionError: lastError.message });
      nativePort = undefined;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(() => {
        reconnectTimer = undefined;
        void connect();
      }, reconnectDelay);
      reconnectDelay = Math.min(30_000, reconnectDelay * 2);
    });
    send({ event: 'hello', data: { version: VERSION, protocol: PROTOCOL_VERSION } });
  } catch (error) {
    await chrome.storage.local.set({
      connectionError: error instanceof Error ? error.message : String(error),
    });
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      void connect();
    }, reconnectDelay);
    reconnectDelay = Math.min(30_000, reconnectDelay * 2);
  }
}

async function tabList() {
  const [tabs, lastFocused] = await Promise.all([
    chrome.tabs.query({}),
    chrome.windows.getLastFocused({ windowTypes: ['normal'] }),
  ]);
  const patterns = await denyPatterns();
  let hidden = 0;
  const visible = tabs
    .filter((tab) => {
      if (tab.incognito) return false;
      if (matchesDenylist(tab.url || '', patterns)) {
        hidden++;
        return false;
      }
      return true;
    })
    .map((tab) => ({
      id: tab.id!,
      windowId: tab.windowId!,
      active: Boolean(tab.active),
      title: tab.title || '',
      url: tab.url || '',
      lastAccessed: tab.lastAccessed,
      openedAt: openTimes[String(tab.id!)],
      discarded: Boolean(tab.discarded),
      incognito: Boolean(tab.incognito),
      denied: matchesDenylist(tab.url || '', patterns),
    }));
  return { tabs: visible, hidden, frontWindowId: lastFocused.id };
}

async function tabInfo(tabId: number) {
  let tab: chrome.tabs.Tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    throw Object.assign(
      new Error(`Tab ${tabId} was not found. Run cobrowser tabs and choose an existing tab.`),
      { code: 'TAB_NOT_FOUND' },
    );
  }
  const patterns = await denyPatterns();
  if (tab.incognito || matchesDenylist(tab.url || '', patterns))
    throw Object.assign(new Error('This tab is hidden by the denylist. Choose a different tab.'), {
      code: 'DENIED',
    });
  return {
    id: tab.id!,
    windowId: tab.windowId!,
    active: Boolean(tab.active),
    title: tab.title || '',
    url: tab.url || '',
    lastAccessed: tab.lastAccessed,
    openedAt: openTimes[String(tab.id!)],
    discarded: Boolean(tab.discarded),
    incognito: Boolean(tab.incognito),
    denied: false,
  };
}

function waitForLoaded(tabId: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(
        Object.assign(new Error('The tab did not finish loading. Check the page and try again.'), {
          code: 'TIMEOUT',
        }),
      );
    }, 15_000);
    const listener = (changedId: number, changeInfo: { status?: string }) => {
      if (changedId === tabId && changeInfo.status === 'complete') {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function snapshot(tabId: number) {
  let tab: chrome.tabs.Tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    throw Object.assign(
      new Error(`Tab ${tabId} was not found. Run cobrowser tabs and choose an existing tab.`),
      { code: 'TAB_NOT_FOUND' },
    );
  }
  const patterns = await denyPatterns();
  if (matchesDenylist(tab.url || '', patterns))
    throw Object.assign(new Error('This tab is hidden by the denylist. Choose a different tab.'), {
      code: 'DENIED',
    });
  let reloaded = false;
  if (tab.discarded || !tab.url || tab.status === 'unloaded') {
    const loaded = waitForLoaded(tabId);
    await chrome.tabs.reload(tabId);
    await loaded;
    tab = await chrome.tabs.get(tabId);
    reloaded = true;
  }
  if (!/^https?:|^file:/.test(tab.url || ''))
    throw Object.assign(
      new Error('This page cannot be read. Use an http, https, or allowed file URL.'),
      { code: 'UNREADABLE' },
    );
  try {
    const executions = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => ({
        url: location.href,
        title: document.title,
        html: document.documentElement?.outerHTML || '',
        contentType: document.contentType,
        scrollHeight: document.documentElement?.scrollHeight || 0,
        clientHeight: document.documentElement?.clientHeight || 0,
        feed: Boolean(document.querySelector('[role="feed"]')),
      }),
    });
    const result = executions[0]?.result;
    if (!result) throw new Error('The page returned no content. Check the page and try again.');
    return { ...result, reloaded };
  } catch (error) {
    throw Object.assign(
      new Error(
        'The page could not be injected. Turn on file URL access if this is a file, then try again.',
      ),
      { code: 'UNREADABLE', cause: error },
    );
  }
}

async function handleRequest(message: RequestMessage) {
  if (!message || typeof message.id !== 'number') return;
  try {
    if (await paused())
      throw Object.assign(new Error('cobrowser is paused. Turn it on in the extension popup.'), {
        code: 'PAUSED',
      });
    let result: any;
    if (message.method === 'tabs') result = await tabList();
    else if (message.method === 'tab') result = await tabInfo(Number(message.params?.id));
    else if (message.method === 'read') result = await snapshot(Number(message.params?.id));
    else
      throw Object.assign(
        new Error('Unknown extension request. Use a supported cobrowser command.'),
        {
          code: 'BAD_REQUEST',
        },
      );
    send({ id: message.id, ok: true, result });
  } catch (error: any) {
    errorResponse(
      message.id,
      error?.code || 'BAD_REQUEST',
      error?.message || 'The extension request failed. Restart the browser and try again.',
    );
  }
}

chrome.tabs.onCreated.addListener((tab) => {
  if (tab.id !== undefined) {
    openTimes[String(tab.id)] = Date.now();
    void saveOpenTimes();
  }
});
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (!changeInfo.url) return;
  void (async () => {
    if (await paused()) return;
    const patterns = await denyPatterns();
    if (matchesDenylist(changeInfo.url!, patterns)) return;
    send({ event: 'tab_changed', data: { tabId } });
  })().catch(() => undefined);
});
chrome.tabs.onRemoved.addListener((tabId) => {
  delete openTimes[String(tabId)];
  void saveOpenTimes();
  void paused()
    .then((isPaused) => {
      if (!isPaused) send({ event: 'tab_closed', data: { tabId } });
    })
    .catch(() => undefined);
});
chrome.runtime.onStartup.addListener(() => void connect());
chrome.runtime.onInstalled.addListener(() => void connect());
chrome.alarms.create('cobrowser-reconnect', { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'cobrowser-reconnect' && !nativePort) void connect();
});
void loadOpenTimes();
void connect();
