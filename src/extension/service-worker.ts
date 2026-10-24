import { DEFAULT_DENYLIST, matchesDenylist, normalizeDenylist } from '../shared/denylist.js';
import {
  EXTENSION_REVISION,
  MAX_GUARD_URL_CHARS,
  NATIVE_HOST,
  normalizeErrorCode,
  PROTOCOL_VERSION,
  VERSION,
} from '../shared/constants.js';
import { googleExportUrl, specialKind } from '../shared/special.js';
import { normalizeOpenTimes, type OpenTimes } from '../shared/open-times.js';
import { redactEmbeddedUrls } from '../shared/url.js';
import {
  DocumentFetchTracker,
  documentFetchError,
  type DocumentFetchAttempt,
} from './document-fetch-tracker.js';
import { documentPageFetch, type DocumentPageResult } from './document-page-fetch.js';
import { registerOptionsSettings } from './options-settings.js';

registerOptionsSettings();

interface RequestMessage {
  id: number;
  method: string;
  params?: Record<string, unknown>;
}
let nativePort: chrome.runtime.Port | undefined;
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
let reconnectDelay = 1000;
let openTimes: OpenTimes = {};
let openTimesLoaded = false;
const pendingOpenTimes = new Map<string, number | undefined>();
let openTimesReady = Promise.resolve();
let openTimesSaveQueue: Promise<void> = Promise.resolve();
let inFlight = 0;
let badgeTimer: ReturnType<typeof setTimeout> | undefined;
let protocolError: string | undefined;
let handshakePending = false;
let handshakeTimer: ReturnType<typeof setTimeout> | undefined;
let recentReadsQueue: Promise<void> = Promise.resolve();
let connectionStateQueue: Promise<void> = Promise.resolve();
const pauseSession = crypto.randomUUID();
let pauseGeneration = 0;
let policyGeneration = 0;
let documentGeneration = 0;
const documentVersions = new Map<number, number>();
const activationVersions = new Map<number, number>();
const documentFetches = new DocumentFetchTracker();

interface GuardAccess {
  policyEpoch: string;
  tabs: Array<{ id: number; documentEpoch: string }>;
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.paused?.newValue === true) pauseGeneration++;
  if (area === 'local' && changes.denylist) policyGeneration++;
  if (area === 'local' && changes.paused?.newValue === true) documentFetches.cancel('PAUSED');
  if (area === 'local' && changes.denylist) documentFetches.cancel('DENIED');
});

chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (change.url || change.status === 'loading') documentVersions.set(tabId, ++documentGeneration);
  if (change.url || change.status === 'loading') documentFetches.cancel('TIMEOUT', tabId);
});
chrome.tabs.onRemoved.addListener((tabId) => {
  documentVersions.delete(tabId);
  documentFetches.cancel('TIMEOUT', tabId);
});
chrome.tabs.onReplaced.addListener((added, removed) => {
  documentVersions.delete(removed);
  documentVersions.set(added, ++documentGeneration);
  documentFetches.cancel('TIMEOUT', removed);
});
chrome.tabs.onActivated.addListener(({ windowId }) => {
  activationVersions.set(windowId, (activationVersions.get(windowId) ?? 0) + 1);
});
chrome.windows.onRemoved.addListener((windowId) => activationVersions.delete(windowId));

function documentEpoch(tabId: number): string {
  if (!documentVersions.has(tabId)) documentVersions.set(tabId, ++documentGeneration);
  return `${pauseSession}:${documentVersions.get(tabId)}`;
}

function assertDocumentEpoch(tabId: number, expected: string) {
  if (expected !== `${pauseSession}:${documentVersions.get(tabId)}`)
    throw Object.assign(
      new Error('The document changed while delivering the result; retry the command.'),
      { code: 'TIMEOUT' },
    );
}

function policyEpoch(): string {
  return `${pauseSession}:${policyGeneration}`;
}

function assertPolicyEpoch(expected: string) {
  if (expected !== policyEpoch())
    throw Object.assign(
      new Error('The denylist changed while delivering the result; retry the command.'),
      { code: 'DENIED' },
    );
}

function assertGuardAccess(access: GuardAccess) {
  assertPolicyEpoch(access.policyEpoch);
  for (const tab of access.tabs) assertDocumentEpoch(tab.id, tab.documentEpoch);
}

function pauseEpoch(): string {
  return `${pauseSession}:${pauseGeneration}`;
}

async function assertNotPaused(expected: string) {
  const isPaused = await paused();
  if (isPaused || expected !== pauseEpoch())
    throw Object.assign(new Error('cobrowser was paused; turn it on and retry the command.'), {
      code: 'PAUSED',
    });
}

const storageSession = () => (chrome.storage as any).session as chrome.storage.StorageArea;
function cleanErrorMessage(value: unknown, fallback: string): string {
  return (
    redactEmbeddedUrls(
      String(value ?? fallback)
        .replace(/[\u0000-\u001f\u007f]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim(),
    ).slice(0, 500) || fallback
  );
}
function setConnectionState(connected: boolean, connectionError?: string) {
  const safeError = connectionError
    ? cleanErrorMessage(connectionError, 'The helper connection failed.')
    : undefined;
  connectionStateQueue = connectionStateQueue
    .catch(() => undefined)
    .then(async () => {
      try {
        await chrome.storage.local.set({
          connected,
          ...(safeError ? { connectionError: safeError } : {}),
        });
        if (connected) await chrome.storage.local.remove('connectionError');
      } catch {
        /* Status is best effort and must not interrupt the native connection. */
      }
    });
  return connectionStateQueue;
}

async function loadOpenTimes() {
  let persisted: OpenTimes = {};
  try {
    const result = await storageSession().get('openTimes');
    persisted = normalizeOpenTimes(result.openTimes);
  } catch {
    /* Session storage is optional on older Chromium builds. */
  }
  openTimes = { ...persisted };
  for (const [tabId, openedAt] of pendingOpenTimes) {
    if (openedAt === undefined) delete openTimes[tabId];
    else openTimes[tabId] = openedAt;
  }
  pendingOpenTimes.clear();
  openTimesLoaded = true;
  await saveOpenTimes().catch(() => undefined);
}
async function saveOpenTimes() {
  const snapshot = { ...openTimes };
  openTimesSaveQueue = openTimesSaveQueue
    .catch(() => undefined)
    .then(async () => {
      try {
        await storageSession().set({ openTimes: snapshot });
      } catch {
        /* Session storage is optional on older Chromium builds. */
      }
    });
  await openTimesSaveQueue;
}
async function denyPatterns(): Promise<string[]> {
  const result = await chrome.storage.local.get({ denylist: DEFAULT_DENYLIST });
  return normalizeDenylist(result.denylist);
}
async function paused(): Promise<boolean> {
  const result = await chrome.storage.local.get({ paused: false });
  return result.paused === true;
}
function send(value: unknown, port?: chrome.runtime.Port) {
  const target = port || nativePort;
  if (!target || (port && nativePort !== port)) return;
  try {
    target.postMessage(value);
  } catch {
    /* reconnect handler will restore the port */
  }
}

function setBusy(busy: boolean) {
  if (busy) {
    if (badgeTimer) clearTimeout(badgeTimer);
    void chrome.action.setBadgeText({ text: '•' }).catch(() => undefined);
    void chrome.action.setBadgeBackgroundColor({ color: '#2563eb' }).catch(() => undefined);
    return;
  }
  if (badgeTimer) clearTimeout(badgeTimer);
  badgeTimer = setTimeout(() => {
    badgeTimer = undefined;
    if (!inFlight) void chrome.action.setBadgeText({ text: '' }).catch(() => undefined);
  }, 2_000);
}
function errorResponse(id: number, code: string, message: string, port?: chrome.runtime.Port) {
  send(
    {
      id,
      ok: false,
      error: {
        code: normalizeErrorCode(code, 'BAD_REQUEST'),
        message: cleanErrorMessage(message, 'The extension request failed. Try again.'),
      },
    },
    port,
  );
}

function isNativeRequest(value: unknown): value is RequestMessage {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const message = value as { id?: unknown; method?: unknown; params?: unknown };
  return (
    Number.isSafeInteger(message.id) &&
    (message.id as number) > 0 &&
    typeof message.method === 'string' &&
    /^[a-z][a-z0-9_-]*$/i.test(message.method) &&
    (message.params === undefined ||
      (typeof message.params === 'object' &&
        message.params !== null &&
        !Array.isArray(message.params)))
  );
}

function disconnectForProtocol(port: chrome.runtime.Port, message: string) {
  protocolError = message;
  void setConnectionState(false, message);
  try {
    port.disconnect();
  } catch {
    /* The disconnect listener will finish cleanup. */
  }
}

function tabNotFound(tabId: number): Error {
  return Object.assign(
    new Error(`Tab ${tabId} was not found. Run cobrowser tabs and choose an existing tab.`),
    { code: 'TAB_NOT_FOUND' },
  );
}

async function getTab(tabId: number): Promise<chrome.tabs.Tab> {
  try {
    return await chrome.tabs.get(tabId);
  } catch {
    throw tabNotFound(tabId);
  }
}

function assertTabAllowed(tab: { incognito?: boolean; url?: string }, patterns: string[]) {
  if (tab.incognito)
    throw Object.assign(new Error('Incognito tabs cannot be read. Choose a normal tab.'), {
      code: 'DENIED',
    });
  if (matchesDenylist(tab.url || '', patterns))
    throw Object.assign(new Error('This tab is hidden by the denylist. Choose a different tab.'), {
      code: 'DENIED',
    });
}

function normalizeRecentRead(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const data = value as Record<string, unknown>;
  if (!('command' in data) && !('time' in data) && !('tabId' in data) && !('url' in data))
    return undefined;
  const entry: Record<string, unknown> = {
    command:
      typeof data.command === 'string'
        ? cleanErrorMessage(data.command, 'read').slice(0, 40)
        : 'read',
    time:
      typeof data.time === 'string'
        ? cleanErrorMessage(data.time, new Date().toISOString()).slice(0, 80)
        : new Date().toISOString(),
  };
  if (typeof data.tabId === 'number' && Number.isSafeInteger(data.tabId)) entry.tabId = data.tabId;
  if (typeof data.url === 'string') entry.url = cleanErrorMessage(data.url, '').slice(0, 2_000);
  return entry;
}

function recordRecentRead(data: Record<string, unknown> | undefined) {
  const entry =
    normalizeRecentRead(data) ||
    ({ command: 'read', time: new Date().toISOString() } satisfies Record<string, unknown>);
  recentReadsQueue = recentReadsQueue
    .catch(() => undefined)
    .then(async () => {
      const state = await chrome.storage.local.get({ recentReads: [] });
      const recent = Array.isArray(state.recentReads)
        ? state.recentReads
            .slice(0, 10)
            .map(normalizeRecentRead)
            .filter((value): value is Record<string, unknown> => value !== undefined)
        : [];
      await chrome.storage.local.set({
        recentReads: [entry, ...recent].slice(0, 10),
      });
    })
    .catch(() => undefined);
}

function scheduleReconnect() {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  const delay = reconnectDelay;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = undefined;
    void connect();
  }, delay);
  void chrome.alarms
    .create('cobrowser-reconnect-once', { when: Date.now() + delay })
    .catch(() => undefined);
  reconnectDelay = Math.min(30_000, reconnectDelay * 2);
}

async function connect() {
  if (nativePort) return;
  try {
    const port = chrome.runtime.connectNative(NATIVE_HOST);
    nativePort = port;
    protocolError = undefined;
    handshakePending = true;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = undefined;
    void setConnectionState(false, 'The helper connection is starting.');
    port.onMessage.addListener((message) => {
      if (nativePort !== port) return;
      if (!message || typeof message !== 'object' || Array.isArray(message)) {
        disconnectForProtocol(port, 'The helper returned invalid data. Run cobrowser doctor.');
        return;
      }
      const event = (message as { event?: unknown }).event;
      if (event !== undefined && typeof event !== 'string') {
        disconnectForProtocol(port, 'The helper returned an invalid event. Run cobrowser doctor.');
        return;
      }
      if (event === 'hello_ack') {
        handshakePending = false;
        if (handshakeTimer) {
          clearTimeout(handshakeTimer);
          handshakeTimer = undefined;
        }
        const data = (
          message as {
            data?: {
              protocol?: number;
              version?: string;
              extensionVersion?: unknown;
              extensionRevision?: unknown;
            };
          }
        ).data;
        if (
          data?.extensionRevision !== undefined &&
          (typeof data.extensionRevision !== 'string' ||
            !/^[a-f0-9]{64}$/.test(data.extensionRevision))
        ) {
          disconnectForProtocol(
            port,
            'The helper returned invalid build details; run cobrowser setup and retry.',
          );
          return;
        }
        if (
          (typeof data?.extensionVersion === 'string' && data.extensionVersion !== VERSION) ||
          (typeof data?.extensionRevision === 'string' &&
            data.extensionRevision !== EXTENSION_REVISION)
        ) {
          chrome.runtime.reload();
        } else if (data?.protocol !== PROTOCOL_VERSION || data.version !== VERSION) {
          disconnectForProtocol(
            port,
            'The helper and extension versions do not match. Run cobrowser setup again.',
          );
        } else {
          protocolError = undefined;
          reconnectDelay = 1000;
          void setConnectionState(true);
        }
        return;
      }
      if (event === 'reload_extension') {
        documentFetches.cancel('EXTENSION_DISCONNECTED');
        chrome.runtime.reload();
        return;
      }
      if (event === 'read') {
        const data = (
          message as { data?: { command?: string; tabId?: number; url?: string; time?: string } }
        ).data;
        recordRecentRead(data);
        return;
      }
      if (event !== undefined) return;
      if (!isNativeRequest(message)) {
        disconnectForProtocol(
          port,
          'The helper returned an invalid request. Run cobrowser doctor.',
        );
        return;
      }
      void handleRequest(message, port);
    });
    handshakeTimer = setTimeout(() => {
      if (nativePort === port && handshakePending) port.disconnect();
    }, 5_000);
    port.onDisconnect.addListener(() => {
      if (nativePort !== port) return;
      documentFetches.cancel('EXTENSION_DISCONNECTED');
      if (handshakeTimer) {
        clearTimeout(handshakeTimer);
        handshakeTimer = undefined;
      }
      const lastError = chrome.runtime.lastError;
      void setConnectionState(
        false,
        protocolError ||
          lastError?.message ||
          'The helper disconnected. Restart the browser and try again.',
      );
      nativePort = undefined;
      handshakePending = false;
      scheduleReconnect();
    });
    send({
      event: 'hello',
      data: { version: VERSION, protocol: PROTOCOL_VERSION, extensionRevision: EXTENSION_REVISION },
    });
  } catch (error) {
    await setConnectionState(false, error instanceof Error ? error.message : String(error));
    scheduleReconnect();
  }
}

function comparableTabUrl(value: unknown): string {
  const text = typeof value === 'string' ? value : '';
  try {
    const parsed = new URL(text);
    parsed.username = '';
    parsed.password = '';
    return parsed.toString();
  } catch {
    return text;
  }
}

async function tabUrlHash(value: unknown): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(comparableTabUrl(value)),
  );
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function assertResultAllowed(result: unknown) {
  const expectedPolicy = policyEpoch();
  const patterns = await denyPatterns();
  const seen = new Set<object>();
  const documents: Array<{ id: number; documentEpoch: string }> = [];
  const visit = (value: unknown) => {
    if (!value || typeof value !== 'object' || seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry);
      return;
    }
    const record = value as { incognito?: unknown; url?: unknown } & Record<string, unknown>;
    if (typeof record.url === 'string')
      assertTabAllowed({ incognito: record.incognito === true, url: record.url }, patterns);
    if (typeof record.documentEpoch === 'string') {
      const id = typeof record.tabId === 'number' ? record.tabId : record.id;
      if (typeof id === 'number') documents.push({ id, documentEpoch: record.documentEpoch });
    }
    if (Array.isArray(record.sourceUrls))
      for (const url of record.sourceUrls)
        if (typeof url === 'string') assertTabAllowed({ url }, patterns);
    for (const entry of Object.values(record)) visit(entry);
  };
  visit(result);
  return () => {
    assertPolicyEpoch(expectedPolicy);
    for (const document of documents) assertDocumentEpoch(document.id, document.documentEpoch);
  };
}

async function assertGuardAllowed(params: Record<string, unknown> | undefined) {
  const urls = params?.urls;
  const tabs = params?.tabs;
  const prior = params?.access as GuardAccess | undefined;
  if (
    prior !== undefined &&
    (!prior ||
      typeof prior !== 'object' ||
      typeof prior.policyEpoch !== 'string' ||
      prior.policyEpoch.length > 100 ||
      !Array.isArray(prior.tabs) ||
      prior.tabs.length > 200 ||
      prior.tabs.some(
        (tab) =>
          !tab ||
          !Number.isSafeInteger(tab.id) ||
          tab.id < 0 ||
          typeof tab.documentEpoch !== 'string' ||
          tab.documentEpoch.length > 100,
      ))
  )
    throw Object.assign(
      new Error('The helper sent invalid guard access metadata; retry the command.'),
      { code: 'BAD_REQUEST' },
    );
  const access: GuardAccess = {
    policyEpoch: prior?.policyEpoch ?? policyEpoch(),
    tabs: prior?.tabs.slice() ?? [],
  };
  assertGuardAccess(access);
  if (
    urls !== undefined &&
    (!Array.isArray(urls) ||
      urls.length > 200 ||
      urls.some((url) => typeof url !== 'string' || url.length > MAX_GUARD_URL_CHARS))
  )
    throw Object.assign(new Error('The helper sent invalid guard URLs.'), { code: 'BAD_REQUEST' });
  if (
    tabs !== undefined &&
    (!Array.isArray(tabs) ||
      tabs.length > 200 ||
      tabs.some(
        (value) =>
          !value ||
          typeof value !== 'object' ||
          Array.isArray(value) ||
          !Number.isSafeInteger((value as { id?: unknown }).id) ||
          ((value as { id: number }).id as number) < 0 ||
          typeof (value as { url?: unknown }).url !== 'string' ||
          (value as { url: string }).url.length > MAX_GUARD_URL_CHARS ||
          typeof (value as { documentEpoch?: unknown }).documentEpoch !== 'string' ||
          (value as { documentEpoch: string }).documentEpoch.length > 100 ||
          ((value as { urlHash?: unknown }).urlHash !== undefined &&
            (typeof (value as { urlHash?: unknown }).urlHash !== 'string' ||
              !/^[0-9a-f]{64}$/i.test((value as { urlHash: string }).urlHash))),
      ))
  )
    throw Object.assign(new Error('The helper sent invalid guard tabs.'), { code: 'BAD_REQUEST' });
  const patterns = await denyPatterns();
  if (Array.isArray(urls)) for (const url of urls) assertTabAllowed({ url }, patterns);
  if (Array.isArray(tabs))
    for (const value of tabs) {
      const expected = value as { id: number; url: string; documentEpoch: string };
      const tab = await getTab(expected.id);
      assertTabAllowed(tab, patterns);
      assertDocumentEpoch(expected.id, expected.documentEpoch);
      const expectedHash = (value as { urlHash?: string }).urlHash;
      const matches = expectedHash
        ? (await tabUrlHash(tab.url)) === expectedHash.toLowerCase()
        : comparableTabUrl(tab.url) === comparableTabUrl(expected.url);
      if (!matches)
        throw Object.assign(new Error('The tab changed while delivering the result.'), {
          code: 'TIMEOUT',
        });
      const previous = access.tabs.find((tab) => tab.id === expected.id);
      if (previous && previous.documentEpoch !== expected.documentEpoch)
        throw Object.assign(
          new Error('The document changed while delivering the result; retry the command.'),
          { code: 'TIMEOUT' },
        );
      if (!previous) access.tabs.push({ id: expected.id, documentEpoch: expected.documentEpoch });
    }
  if (access.tabs.length > 200)
    throw Object.assign(new Error('The helper sent too many guard tabs; retry the command.'), {
      code: 'BAD_REQUEST',
    });
  assertGuardAccess(access);
  return access;
}

async function verifyReadTab(tabId: number, expectedUrl: string): Promise<chrome.tabs.Tab> {
  const tab = await getTab(tabId);
  assertTabAllowed(tab, await denyPatterns());
  if (comparableTabUrl(tab.url) !== comparableTabUrl(expectedUrl))
    throw Object.assign(new Error('The tab changed while it was being read. Try again.'), {
      code: 'TIMEOUT',
    });
  return tab;
}

async function tabList() {
  await openTimesReady;
  const [tabs, lastFocused] = await Promise.all([
    chrome.tabs.query({}),
    chrome.windows.getLastFocused({ windowTypes: ['normal'] }),
  ]);
  const epochs = new Map(tabs.map((tab) => [tab.id!, documentEpoch(tab.id!)]));
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
      status: tab.status,
      incognito: Boolean(tab.incognito),
      denied: matchesDenylist(tab.url || '', patterns),
      documentEpoch: epochs.get(tab.id!),
    }));
  return { tabs: visible, hidden, frontWindowId: lastFocused.id };
}

async function tabInfo(tabId: number) {
  await openTimesReady;
  const tab = await getTab(tabId);
  const expectedDocument = documentEpoch(tabId);
  const patterns = await denyPatterns();
  assertTabAllowed(tab, patterns);
  return {
    id: tab.id!,
    windowId: tab.windowId!,
    active: Boolean(tab.active),
    title: tab.title || '',
    url: tab.url || '',
    lastAccessed: tab.lastAccessed,
    openedAt: openTimes[String(tab.id!)],
    discarded: Boolean(tab.discarded),
    status: tab.status,
    incognito: Boolean(tab.incognito),
    denied: false,
    documentEpoch: expectedDocument,
  };
}

function waitForLoaded(
  tabId: number,
  acceptAlreadyComplete = false,
): { promise: Promise<void>; cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let listener: ((changedId: number, changeInfo: { status?: string }) => void) | undefined;
  let removedListener: ((removedId: number) => void) | undefined;
  const cleanup = () => {
    if (timer) clearTimeout(timer);
    if (listener) chrome.tabs.onUpdated.removeListener(listener);
    if (removedListener) chrome.tabs.onRemoved.removeListener(removedListener);
    timer = undefined;
    listener = undefined;
    removedListener = undefined;
  };
  const promise = new Promise<void>((resolve, reject) => {
    timer = setTimeout(() => {
      cleanup();
      reject(
        Object.assign(new Error('The tab did not finish loading. Check the page and try again.'), {
          code: 'TIMEOUT',
        }),
      );
    }, 15_000);
    listener = (changedId: number, changeInfo: { status?: string }) => {
      if (changedId === tabId && changeInfo.status === 'complete') {
        cleanup();
        resolve();
      }
    };
    removedListener = (removedId: number) => {
      if (removedId !== tabId) return;
      cleanup();
      reject(tabNotFound(tabId));
    };
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.onRemoved.addListener(removedListener);
    void chrome.tabs.get(tabId).then(
      (tab) => {
        if (acceptAlreadyComplete && tab.status === 'complete') {
          cleanup();
          resolve();
        }
      },
      () => {
        cleanup();
        reject(tabNotFound(tabId));
      },
    );
  });
  return { promise, cancel: cleanup };
}

async function reloadTab(tabId: number): Promise<void> {
  try {
    await chrome.tabs.reload(tabId);
  } catch (error) {
    try {
      await chrome.tabs.get(tabId);
    } catch {
      throw tabNotFound(tabId);
    }
    throw Object.assign(new Error('The tab could not be reloaded. Check the page and try again.'), {
      code: 'UNREADABLE',
      cause: error,
    });
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  const values = bytes;
  let result = '';
  const chunk = 0x8000;
  for (let offset = 0; offset < values.length; offset += chunk)
    result += String.fromCharCode(...values.subarray(offset, offset + chunk));
  return btoa(result);
}

const MAX_SPECIAL_TEXT_BYTES = 32 * 1024 * 1024;
const MAX_SPECIAL_FRAME_BYTES = 48 * 1024 * 1024;
const SPECIAL_FETCH_TIMEOUT_MS = 15_000;
const MAX_SELECTION_CHARS = 4 * 1024 * 1024;
const MAX_QUERY_VALUE_CHARS = 50_000;

function specialTextTooLarge(value: string): boolean {
  return (
    new TextEncoder().encode(value).byteLength > MAX_SPECIAL_TEXT_BYTES ||
    new TextEncoder().encode(JSON.stringify({ text: value })).byteLength > MAX_SPECIAL_FRAME_BYTES
  );
}

function responseBytesTooLarge(response: Response, limit: number): boolean {
  const contentLength = Number(response.headers.get('content-length'));
  return Number.isFinite(contentLength) && contentLength > limit;
}

async function readResponseBytes(
  response: Response,
  limit: number,
): Promise<{ bytes?: Uint8Array; tooLarge: boolean }> {
  if (responseBytesTooLarge(response, limit)) {
    if (response.body) await response.body.cancel().catch(() => undefined);
    return { tooLarge: true };
  }
  const reader = response.body?.getReader();
  if (!reader) {
    try {
      const bytes = new Uint8Array(await response.arrayBuffer());
      return bytes.byteLength > limit ? { tooLarge: true } : { bytes, tooLarge: false };
    } catch {
      return { tooLarge: false };
    }
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      const chunk = new Uint8Array(next.value);
      size += chunk.byteLength;
      if (size > limit) {
        await reader.cancel();
        return { tooLarge: true };
      }
      chunks.push(chunk);
    }
  } catch {
    await reader.cancel().catch(() => undefined);
    return { tooLarge: false };
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes, tooLarge: false };
}

interface SpecialFetchChecks {
  deadline: number;
  tabId: number;
  tabUrl: string;
  check: () => void;
  allowed: (url: string) => void;
  finish: (
    attempt: DocumentFetchAttempt,
    url?: string,
    mode?: 'body' | 'network' | 'diagnostic',
  ) => Promise<string[]>;
}

type SpecialPageResult = DocumentPageResult & { sourceUrls: string[] };

async function fetchWithinDeadline<T>(value: Promise<T>, deadline: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      value,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(documentFetchError()), Math.max(1, deadline - Date.now()));
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function fetchSpecial(
  tabId: number,
  url: string,
  kind: 'pdf' | 'google-doc' | 'google-sheet' | 'google-slide',
) {
  const deadline = Date.now() + SPECIAL_FETCH_TIMEOUT_MS;
  const expectedDocument = documentEpoch(tabId);
  const expectedPause = pauseEpoch();
  const expectedPolicy = policyEpoch();
  await fetchWithinDeadline(assertNotPaused(expectedPause), deadline);
  const patterns = await fetchWithinDeadline(denyPatterns(), deadline);
  const check = () => {
    assertPolicyEpoch(expectedPolicy);
    assertDocumentEpoch(tabId, expectedDocument);
    if (pauseEpoch() !== expectedPause) throw documentFetchError('PAUSED');
    if (!nativePort || handshakePending) throw documentFetchError('EXTENSION_DISCONNECTED');
  };
  const checks: SpecialFetchChecks = {
    deadline,
    tabId,
    tabUrl: url,
    check,
    allowed: (value) => assertTabAllowed({ url: value }, patterns),
    finish: (attempt, resultUrl, mode = 'body') =>
      attempt.race(
        (async () => {
          const urls = await attempt.finish(resultUrl, mode);
          await assertNotPaused(expectedPause);
          await verifyReadTab(tabId, url);
          attempt.check();
          return urls;
        })(),
      ),
  };
  check();
  const exportInfo = googleExportUrl(url);
  const target = kind === 'pdf' ? url : exportInfo?.url;
  if (!target)
    throw Object.assign(new Error('This Google file URL is not an exportable document.'), {
      code: 'UNREADABLE',
    });
  const file = new URL(target).protocol === 'file:';
  if (file && !(await fetchWithinDeadline(chrome.extension.isAllowedFileSchemeAccess(), deadline)))
    throw Object.assign(
      new Error('Local files are unavailable; turn on file URL access for cobrowser and retry.'),
      { code: 'UNREADABLE' },
    );
  const targets =
    kind === 'google-doc' ? [target, target.replace('format=md', 'format=txt')] : [target];
  let lastStatus = 0;
  let emptyGoogleDoc: { kind: 'google-doc'; text: string; sourceUrls: string[] } | undefined;
  for (const requestUrl of targets) {
    check();
    if (Date.now() >= deadline) throw documentFetchError();
    checks.allowed(requestUrl);
    const pageResult = await fetchSpecialInPage(tabId, requestUrl, kind, checks);
    if (pageResult?.ok) {
      if (kind === 'pdf')
        return { kind, base64: pageResult.base64 || '', sourceUrls: pageResult.sourceUrls };
      const text = pageResult.text || '';
      if (kind !== 'google-doc' || text.trim())
        return { kind, text, sourceUrls: pageResult.sourceUrls };
      emptyGoogleDoc = { kind, text: '', sourceUrls: pageResult.sourceUrls };
      continue;
    }
    if (pageResult?.status) lastStatus = pageResult.status;
    check();
    if (Date.now() >= deadline) throw documentFetchError();
    const attempt = documentFetches.begin({
      url: requestUrl,
      context: { kind: file ? 'file' : 'worker', tabId },
      deadline,
      assertAllowed: checks.allowed,
      assertCurrent: check,
    });
    try {
      let response: Response;
      try {
        response = await attempt.race(
          fetch(requestUrl, {
            credentials: 'include',
            redirect: file ? 'error' : 'follow',
            headers: file ? undefined : { Accept: attempt.accept },
            signal: attempt.controller.signal,
          }),
        );
      } catch {
        attempt.check();
        if (file) throw documentFetchError();
        await checks.finish(attempt, undefined, 'network');
        continue;
      }
      if (!response.ok) {
        lastStatus = response.status;
        await response.body?.cancel().catch(() => undefined);
        await checks.finish(attempt, response.url, 'diagnostic');
        continue;
      }
      const result = await attempt.race(
        readResponseBytes(response, kind === 'pdf' ? 45 * 1024 * 1024 : MAX_SPECIAL_TEXT_BYTES),
      );
      attempt.check();
      if (result.tooLarge) {
        lastStatus = 413;
        break;
      }
      if (!result.bytes) {
        if (file) throw documentFetchError();
        await checks.finish(attempt, response.url, 'network');
        continue;
      }
      const sourceUrls = specialSourceUrls(...(await checks.finish(attempt, response.url)));
      if (kind === 'pdf') return { kind, base64: bytesToBase64(result.bytes), sourceUrls };
      const text = new TextDecoder().decode(result.bytes);
      if (specialTextTooLarge(text)) {
        lastStatus = 413;
        break;
      }
      if (kind !== 'google-doc' || text.trim()) return { kind, text, sourceUrls };
      emptyGoogleDoc = { kind, text: '', sourceUrls };
    } finally {
      attempt.controller.abort();
      attempt.dispose();
    }
  }
  if (lastStatus === 413)
    throw Object.assign(
      new Error('The document is too large to return; open a smaller document and retry.'),
      { code: 'BAD_REQUEST' },
    );
  if (lastStatus)
    throw Object.assign(
      new Error(
        `The page could not be fetched (${lastStatus}); check that it opens in the browser and retry.`,
      ),
      { code: 'UNREADABLE' },
    );
  if (emptyGoogleDoc) return emptyGoogleDoc;
  throw Object.assign(
    new Error('The document could not be fetched; check that it opens in the browser and retry.'),
    { code: 'UNREADABLE' },
  );
}

function specialSourceUrls(...urls: Array<string | undefined>): string[] {
  return [
    ...new Set(
      urls
        .filter((url): url is string => Boolean(url))
        .map((url) => {
          const parsed = new URL(url);
          parsed.username = '';
          parsed.password = '';
          parsed.search = '';
          parsed.hash = '';
          return parsed.toString();
        }),
    ),
  ];
}

async function fetchSpecialInPage(
  tabId: number,
  url: string,
  kind: 'pdf' | 'google-doc' | 'google-sheet' | 'google-slide',
  checks: SpecialFetchChecks,
): Promise<SpecialPageResult | undefined> {
  let metadata: chrome.scripting.InjectionResult<DocumentPageResult> | undefined;
  try {
    [metadata] = await fetchWithinDeadline(
      chrome.scripting.executeScript({
        target: { tabId },
        func: documentPageFetch,
        args: [{ action: 'metadata' }],
      }),
      checks.deadline,
    );
  } catch {
    checks.check();
    await fetchWithinDeadline(verifyReadTab(tabId, checks.tabUrl), checks.deadline);
    return undefined;
  }
  checks.check();
  if (
    !metadata?.documentId ||
    metadata.result?.outcome !== 'metadata' ||
    comparableTabUrl(metadata.result.url) !== comparableTabUrl(checks.tabUrl)
  )
    throw documentFetchError();
  const target = { tabId, documentIds: [metadata.documentId] };
  const file = new URL(url).protocol === 'file:';
  const attempt = documentFetches.begin({
    url,
    context: file
      ? { kind: 'file', tabId }
      : {
          kind: 'page',
          tabId,
          documentId: metadata.documentId,
          origin: metadata.result.origin || '',
        },
    deadline: checks.deadline,
    assertAllowed: checks.allowed,
    assertCurrent: checks.check,
    onAbort: (key) => {
      void chrome.scripting
        .executeScript({ target, func: documentPageFetch, args: [{ action: 'cancel', key }] })
        .catch(() => undefined);
    },
  });
  const key = attempt.key;
  try {
    const [prepared] = await attempt.race(
      chrome.scripting.executeScript({
        target,
        func: documentPageFetch,
        args: [{ action: 'prepare', key, deadline: checks.deadline }],
      }),
    );
    attempt.check();
    if (prepared?.documentId !== metadata.documentId || prepared.result?.outcome !== 'prepared')
      throw documentFetchError();
    const [execution] = await attempt.race(
      chrome.scripting.executeScript({
        target,
        world: 'ISOLATED',
        func: documentPageFetch,
        args: [
          {
            action: 'fetch',
            key,
            url,
            kind,
            accept: file ? undefined : attempt.accept,
            deadline: checks.deadline,
          },
        ],
      }),
    );
    attempt.check();
    if (execution?.documentId !== metadata.documentId || !execution.result)
      throw documentFetchError();
    const result = execution.result;
    if (result.outcome === 'network') {
      if (file) {
        // Local PDF pages can reject fetch while the extension still has file access.
        checks.check();
        await fetchWithinDeadline(verifyReadTab(tabId, checks.tabUrl), checks.deadline);
        return undefined;
      }
      await checks.finish(attempt, undefined, 'network');
      return undefined;
    }
    if (result.outcome !== 'response' || !result.url) throw documentFetchError();
    if (result.status === 413)
      throw Object.assign(
        new Error('The document is too large to return; open a smaller document and retry.'),
        { code: 'BAD_REQUEST' },
      );
    const sourceUrls = specialSourceUrls(
      ...(await checks.finish(attempt, result.url, result.ok ? 'body' : 'diagnostic')),
    );
    return { ...result, sourceUrls };
  } finally {
    void chrome.scripting
      .executeScript({ target, func: documentPageFetch, args: [{ action: 'cancel', key }] })
      .catch(() => undefined);
    attempt.dispose();
  }
}

function pageIsReadable(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const hostname = parsed.hostname.replace(/\.+$/, '');
  const blockedHost = ['chromewebstore.google.com', 'chrome.google.com'].some(
    (host) => hostname === host || hostname.endsWith(`.${host}`),
  );
  return (
    (parsed.protocol === 'http:' || parsed.protocol === 'https:' || parsed.protocol === 'file:') &&
    !blockedHost
  );
}

async function snapshot(tabId: number) {
  let tab = await getTab(tabId);
  const patterns = await denyPatterns();
  if (tab.incognito)
    throw Object.assign(new Error('Incognito tabs cannot be read. Choose a normal tab.'), {
      code: 'DENIED',
    });
  if (matchesDenylist(tab.url || '', patterns))
    throw Object.assign(new Error('This tab is hidden by the denylist. Choose a different tab.'), {
      code: 'DENIED',
    });
  let reloaded = false;
  if (tab.discarded || !tab.url || tab.status === 'unloaded') {
    const loaded = waitForLoaded(tabId);
    try {
      await reloadTab(tabId);
      await loaded.promise;
    } finally {
      loaded.cancel();
    }
    tab = await getTab(tabId);
    reloaded = true;
  } else if (tab.status === 'loading') {
    const loaded = waitForLoaded(tabId, true);
    try {
      await loaded.promise;
    } finally {
      loaded.cancel();
    }
    tab = await getTab(tabId);
  }
  assertTabAllowed(tab, await denyPatterns());
  if (!pageIsReadable(tab.url || ''))
    throw Object.assign(
      new Error('This page cannot be read. Use an http, https, or allowed file URL.'),
      { code: 'UNREADABLE' },
    );
  const special = specialKind(tab.url || '');
  const expectedDocument = documentEpoch(tabId);
  if (special) {
    try {
      const specialData = await fetchSpecial(tab.id!, tab.url || '', special);
      const current = await verifyReadTab(tab.id!, tab.url || '');
      return {
        tabId,
        documentEpoch: expectedDocument,
        url: current.url || '',
        title: current.title || '',
        contentType: special === 'pdf' ? 'application/pdf' : 'text/plain',
        special: specialData,
        reloaded,
      };
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error) throw error;
      throw Object.assign(
        new Error('The document could not be exported. Check that it is open and try again.'),
        {
          code: 'UNREADABLE',
        },
      );
    }
  }
  try {
    const executions = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const html = document.documentElement?.outerHTML || '';
        const tooLarge =
          html.length > 32 * 1024 * 1024 ||
          new TextEncoder().encode(JSON.stringify({ html })).byteLength > 48 * 1024 * 1024;
        return {
          url: location.href,
          title: document.title,
          html: tooLarge ? '' : html,
          tooLarge,
          contentType: document.contentType,
          scrollHeight: document.documentElement?.scrollHeight || 0,
          clientHeight: document.documentElement?.clientHeight || 0,
          feed: Boolean(document.querySelector('[role="feed"]')),
          canvas: Boolean(document.querySelector('canvas')),
        };
      },
    });
    const result = executions[0]?.result;
    if (!result) throw new Error('The page returned no content. Check the page and try again.');
    if (result.tooLarge)
      throw Object.assign(
        new Error('The page is too large to read. Use a narrower query or a screenshot instead.'),
        { code: 'BAD_REQUEST' },
      );
    assertTabAllowed(result, await denyPatterns());
    await verifyReadTab(tabId, result.url || '');
    if (specialKind(result.url, result.contentType) === 'pdf') {
      const specialData = await fetchSpecial(tab.id!, result.url, 'pdf');
      await verifyReadTab(tab.id!, result.url);
      return {
        tabId,
        documentEpoch: expectedDocument,
        url: result.url,
        title: result.title,
        contentType: result.contentType,
        special: specialData,
        reloaded,
      };
    }
    return { ...result, reloaded, tabId, documentEpoch: expectedDocument };
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error) throw error;
    throw Object.assign(
      new Error(
        'The page could not be injected. Turn on file URL access if this is a file, then try again.',
      ),
      { code: 'UNREADABLE', cause: error },
    );
  }
}

async function queryTab(tabId: number, selector: string, html: boolean, limit: number, offset = 0) {
  let tab = await tabInfo(tabId);
  if (tab.status !== 'loading' && !pageIsReadable(tab.url))
    throw Object.assign(
      new Error('This page cannot be queried. Use an http, https, or allowed file URL.'),
      {
        code: 'UNREADABLE',
      },
    );
  if (!selector.trim())
    throw Object.assign(new Error('A CSS selector is required.'), { code: 'BAD_REQUEST' });
  const needsReload = tab.discarded || tab.status === 'unloaded';
  if (needsReload || tab.status === 'loading') {
    const loaded = waitForLoaded(tabId, !needsReload && tab.status === 'loading');
    try {
      if (needsReload) await reloadTab(tabId);
      await loaded.promise;
    } finally {
      loaded.cancel();
    }
    tab = await tabInfo(tabId);
    if (!pageIsReadable(tab.url))
      throw Object.assign(
        new Error('This page cannot be queried. Use an http, https, or allowed file URL.'),
        { code: 'UNREADABLE' },
      );
  }
  const expectedDocument = documentEpoch(tabId);
  try {
    const executions = await chrome.scripting.executeScript({
      target: { tabId },
      func: (value: {
        selector: string;
        html: boolean;
        limit: number;
        maxValueChars: number;
        offset: number;
      }) => {
        const nodes = document.querySelectorAll(value.selector);
        const count = Math.min(nodes.length, value.limit);
        const values: string[] = [];
        let position = 0;
        let output = '';
        let hasMore = false;
        for (let index = 0; index < count; index++) {
          const node = nodes[index];
          const raw = value.html
            ? node.outerHTML
            : typeof (node as HTMLElement).innerText === 'string'
              ? (node as HTMLElement).innerText
              : node.textContent || '';
          // Redact the whole element before a chunk can split a URL or its credentials.
          const text = raw
            .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
            .replace(/(https?:\/\/|(?<!:)\/\/)[^/\s?#<>]*@/gi, '$1')
            .replace(/https?:\/\/[^\s<>"']+/gi, (candidate) => {
              try {
                const parsed = new URL(candidate);
                if (!parsed.username && !parsed.password) return candidate;
                parsed.username = '';
                parsed.password = '';
                return parsed.toString();
              } catch {
                return candidate;
              }
            });
          const numbered = `${index ? '\n\n' : ''}${index + 1}. ${text}`;
          const end = position + numbered.length;
          if (value.offset < end) {
            const start = Math.max(0, value.offset - position);
            let take = Math.min(numbered.length - start, value.maxValueChars - output.length);
            const last = numbered.charCodeAt(start + take - 1);
            if (last >= 0xd800 && last <= 0xdbff && start + take < numbered.length) take--;
            output += numbered.slice(start, start + take);
            hasMore = start + take < numbered.length || index + 1 < count;
            if (hasMore && output.length >= value.maxValueChars - 1) break;
          }
          if (value.offset === 0 && end <= value.maxValueChars) values.push(text);
          position = end;
        }
        return {
          url: location.href,
          text: output,
          hasMore,
          values: value.offset === 0 && !hasMore ? values : undefined,
          outOfRange: !output && value.offset > position,
        };
      },
      args: [
        {
          selector,
          html,
          limit: Math.max(1, Math.min(100, limit)),
          maxValueChars: MAX_QUERY_VALUE_CHARS,
          offset,
        },
      ],
    });
    const result = executions[0]?.result as
      | { url?: string; values?: string[]; text?: string; hasMore?: boolean; outOfRange?: boolean }
      | undefined;
    if (!result)
      throw Object.assign(new Error('The page returned no query results.'), { code: 'UNREADABLE' });
    assertTabAllowed(result || {}, await denyPatterns());
    await verifyReadTab(tabId, result.url || tab.url);
    if (result.outOfRange)
      throw Object.assign(new Error('The query offset is past the output; retry with offset 0.'), {
        code: 'BAD_REQUEST',
      });
    return {
      tabId,
      documentEpoch: expectedDocument,
      url: result.url || tab.url,
      text: result.text || '',
      hasMore: result.hasMore === true,
      values: result.values,
    };
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error) throw error;
    throw Object.assign(new Error('The CSS selector could not be run on this page.'), {
      code: 'BAD_REQUEST',
    });
  }
}

async function selection(tabId?: number) {
  let id = tabId;
  if (id === undefined) {
    const window = await chrome.windows.getLastFocused({ windowTypes: ['normal'] });
    const active =
      window.id === undefined ? [] : await chrome.tabs.query({ windowId: window.id, active: true });
    id = active[0]?.id;
  }
  if (id === undefined)
    throw Object.assign(
      new Error('No active tab was found. Open a normal browser window and try again.'),
      { code: 'TAB_NOT_FOUND' },
    );
  let tab = await tabInfo(id);
  if (tab.status !== 'loading' && !pageIsReadable(tab.url))
    throw Object.assign(new Error('This page has no readable selection.'), { code: 'UNREADABLE' });
  const needsReload = tab.discarded || tab.status === 'unloaded';
  if (needsReload || tab.status === 'loading') {
    const loaded = waitForLoaded(id, !needsReload && tab.status === 'loading');
    try {
      if (needsReload) await reloadTab(id);
      await loaded.promise;
    } finally {
      loaded.cancel();
    }
    tab = await tabInfo(id);
    if (!pageIsReadable(tab.url))
      throw Object.assign(new Error('This page has no readable selection.'), {
        code: 'UNREADABLE',
      });
  }
  const expectedDocument = documentEpoch(id);
  try {
    const executions = await chrome.scripting.executeScript({
      target: { tabId: id },
      func: (maxChars: number) => {
        const shadowRoot = (node: Node | null | undefined) =>
          node instanceof HTMLElement ? chrome.dom.openOrClosedShadowRoot(node) : null;
        let active = document.activeElement;
        for (;;) {
          const inner = shadowRoot(active)?.activeElement;
          if (!inner) break;
          active = inner;
        }
        if (active instanceof HTMLInputElement && active.type === 'password')
          return { url: location.href, password: true };
        const selected = window.getSelection();
        if (selected) {
          const roots: ShadowRoot[] = [];
          const composed = typeof selected.getComposedRanges === 'function';
          const scopes = [selected];
          let scopeIndex = 0;
          for (;;) {
            const scoped = scopes[scopeIndex];
            const ranges = composed
              ? selected.getComposedRanges({ shadowRoots: roots })
              : Array.from({ length: scoped.rangeCount }, (_, index) => scoped.getRangeAt(index));
            let discovered = false;
            for (const range of ranges) {
              const first = range.startContainer.childNodes[range.startOffset];
              // Chromium retargets a retained control selection to the boundary around its input.
              const control =
                range.startContainer === range.endContainer &&
                (range.endOffset === range.startOffset + 1 ||
                  (!composed && range.collapsed && scoped.type === 'Range'));
              if (control && first instanceof HTMLInputElement && first.type === 'password')
                return { url: location.href, password: true };
              for (const node of [
                range.startContainer,
                first,
                range.endContainer,
                range.collapsed ? first : range.endContainer.childNodes[range.endOffset - 1],
              ]) {
                const root = shadowRoot(node);
                if (!root || roots.includes(root)) continue;
                roots.push(root);
                discovered = true;
                if (!composed) {
                  const inner = (
                    root as ShadowRoot & { getSelection?: () => Selection | null }
                  ).getSelection?.();
                  if (!inner) throw new Error('The browser could not identify the selection.');
                  scopes.push(inner);
                }
              }
            }
            if (composed ? !discovered : ++scopeIndex === scopes.length) break;
          }
        }
        let text = '';
        if (
          (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) &&
          active.selectionStart !== active.selectionEnd
        )
          text = active.value.slice(active.selectionStart || 0, active.selectionEnd || 0);
        else text = selected?.toString() || '';
        if (text.length > maxChars) text = `${text.slice(0, maxChars)}…`;
        return { url: location.href, text };
      },
      args: [MAX_SELECTION_CHARS],
    });
    const result = executions[0]?.result as
      { url?: string; text?: string; password?: boolean } | undefined;
    if (!result)
      throw Object.assign(new Error('The page returned no selection.'), { code: 'UNREADABLE' });
    if (result.password)
      throw Object.assign(
        new Error('Password selections are private; select other text and try again.'),
        { code: 'DENIED' },
      );
    assertTabAllowed(result || {}, await denyPatterns());
    await verifyReadTab(id, result.url || tab.url);
    return {
      tabId: id,
      documentEpoch: expectedDocument,
      url: result.url || tab.url,
      text: String(result.text || ''),
    };
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error) throw error;
    throw Object.assign(new Error('The page selection could not be read.'), { code: 'UNREADABLE' });
  }
}

async function screenshot(windowId?: number) {
  const window =
    windowId === undefined
      ? await chrome.windows.getLastFocused({ windowTypes: ['normal'] })
      : await chrome.windows.get(windowId);
  if (window.id === undefined)
    throw Object.assign(new Error('No browser window was found.'), { code: 'TAB_NOT_FOUND' });
  const expectedActivation = activationVersions.get(window.id) ?? 0;
  const active = await chrome.tabs.query({ windowId: window.id, active: true });
  const tab = active[0];
  if (!tab?.id)
    throw Object.assign(new Error('The browser window has no visible tab.'), {
      code: 'TAB_NOT_FOUND',
    });
  const patterns = await denyPatterns();
  if (tab.incognito)
    throw Object.assign(new Error('Incognito tabs cannot be captured. Choose a normal tab.'), {
      code: 'DENIED',
    });
  if (matchesDenylist(tab.url || '', patterns))
    throw Object.assign(
      new Error('The visible tab is hidden by the denylist. Choose a different window.'),
      { code: 'DENIED' },
    );
  const expectedDocument = documentEpoch(tab.id);
  try {
    const dataUrl = await chrome.tabs.captureVisibleTab(window.id, { format: 'png' });
    if (dataUrl.length > 60 * 1024 * 1024)
      throw Object.assign(
        new Error(
          'The screenshot is too large to return. Reduce the browser window size and try again.',
        ),
        { code: 'BAD_REQUEST' },
      );
    const after = (await chrome.tabs.query({ windowId: window.id, active: true }))[0];
    const currentPatterns = await denyPatterns();
    if (
      !after?.id ||
      after.id !== tab.id ||
      after.url !== tab.url ||
      (activationVersions.get(window.id) ?? 0) !== expectedActivation
    )
      throw Object.assign(
        new Error('The visible tab changed while capturing. Try the screenshot again.'),
        { code: 'TIMEOUT' },
      );
    assertTabAllowed(after, currentPatterns);
    return {
      windowId: window.id,
      tabId: after.id,
      documentEpoch: expectedDocument,
      title: after.title || '',
      url: after.url || '',
      dataUrl,
    };
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error) throw error;
    throw Object.assign(
      new Error('The visible tab could not be captured. Check browser screen capture permissions.'),
      { code: 'UNREADABLE' },
    );
  }
}

async function handleRequest(message: RequestMessage, port: chrome.runtime.Port) {
  if (!isNativeRequest(message)) return;
  const expectedPauseEpoch = message.params?.pauseEpoch ?? pauseEpoch();
  inFlight++;
  setBusy(true);
  try {
    if (handshakePending)
      throw Object.assign(
        new Error('The helper connection is still starting. Try again shortly.'),
        {
          code: 'EXTENSION_DISCONNECTED',
        },
      );
    if (protocolError)
      throw Object.assign(new Error(protocolError), { code: 'EXTENSION_DISCONNECTED' });
    if (typeof expectedPauseEpoch !== 'string' || expectedPauseEpoch.length > 100)
      throw Object.assign(new Error('The helper sent an invalid pause token; retry the command.'), {
        code: 'BAD_REQUEST',
      });
    await assertNotPaused(expectedPauseEpoch);
    let result: any;
    if (message.method === 'tabs') result = await tabList();
    else if (message.method === 'tab') result = await tabInfo(Number(message.params?.id));
    else if (message.method === 'read') result = await snapshot(Number(message.params?.id));
    else if (message.method === 'query')
      result = await queryTab(
        Number(message.params?.id),
        String(message.params?.selector || ''),
        Boolean(message.params?.html),
        Number(message.params?.limit) || 20,
        Number(message.params?.offset) || 0,
      );
    else if (message.method === 'selection')
      result = await selection(
        message.params?.id === undefined ? undefined : Number(message.params.id),
      );
    else if (message.method === 'screenshot')
      result = await screenshot(
        message.params?.windowId === undefined ? undefined : Number(message.params.windowId),
      );
    else if (message.method === 'guard') {
      const access = await assertGuardAllowed(message.params);
      result = { pauseEpoch: expectedPauseEpoch, access };
    } else
      throw Object.assign(
        new Error('Unknown extension request. Use a supported cobrowser command.'),
        {
          code: 'BAD_REQUEST',
        },
      );
    const recheckDocuments = await assertResultAllowed(result);
    await assertNotPaused(expectedPauseEpoch);
    recheckDocuments();
    if (message.method === 'guard') assertGuardAccess(result.access);
    send({ id: message.id, ok: true, result }, port);
  } catch (error: any) {
    errorResponse(
      message.id,
      error?.code || 'BAD_REQUEST',
      error?.message || 'The extension request failed. Restart the browser and try again.',
      port,
    );
  } finally {
    inFlight = Math.max(0, inFlight - 1);
    if (!inFlight) setBusy(false);
  }
}

chrome.tabs.onCreated.addListener((tab) => {
  if (tab.id !== undefined) {
    const tabId = String(tab.id);
    const openedAt = Date.now();
    openTimes[tabId] = openedAt;
    if (openTimesLoaded) void saveOpenTimes();
    else pendingOpenTimes.set(tabId, openedAt);
    send({ event: 'tab_created', data: { tabId: tab.id } });
  }
});
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (!changeInfo.url && changeInfo.status !== 'loading') return;
  send({ event: 'tab_changed', data: { tabId } });
});
chrome.tabs.onReplaced.addListener((addedTabId, removedTabId) => {
  const oldKey = String(removedTabId);
  const newKey = String(addedTabId);
  const openedAt = openTimes[oldKey];
  delete openTimes[oldKey];
  if (openedAt === undefined) {
    delete openTimes[newKey];
    if (openTimesLoaded) void saveOpenTimes();
    else {
      pendingOpenTimes.set(oldKey, undefined);
      pendingOpenTimes.set(newKey, undefined);
    }
  } else {
    openTimes[newKey] = openedAt;
    if (openTimesLoaded) void saveOpenTimes();
    else {
      pendingOpenTimes.set(oldKey, undefined);
      pendingOpenTimes.set(newKey, openedAt);
    }
  }
  send({ event: 'tab_closed', data: { tabId: removedTabId } });
  send({ event: 'tab_changed', data: { tabId: addedTabId } });
});
chrome.tabs.onRemoved.addListener((tabId) => {
  const key = String(tabId);
  delete openTimes[key];
  if (openTimesLoaded) void saveOpenTimes();
  else pendingOpenTimes.set(key, undefined);
  send({ event: 'tab_closed', data: { tabId } });
});
chrome.runtime.onStartup.addListener(() => void connect());
chrome.runtime.onInstalled.addListener(() => void connect());
void chrome.alarms.create('cobrowser-reconnect', { periodInMinutes: 1 }).catch(() => undefined);
chrome.alarms.onAlarm.addListener((alarm) => {
  if (
    (alarm.name === 'cobrowser-reconnect' || alarm.name === 'cobrowser-reconnect-once') &&
    !nativePort
  )
    void connect();
});
openTimesReady = loadOpenTimes();
void connect();
