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
  const patterns = await denyPatterns();
  const seen = new Set<object>();
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
    for (const entry of Object.values(record)) visit(entry);
  };
  visit(result);
}

async function assertGuardAllowed(params: Record<string, unknown> | undefined) {
  const urls = params?.urls;
  const tabs = params?.tabs;
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
      const expected = value as { id: number; url: string };
      const tab = await getTab(expected.id);
      assertTabAllowed(tab, patterns);
      const expectedHash = (value as { urlHash?: string }).urlHash;
      const matches = expectedHash
        ? (await tabUrlHash(tab.url)) === expectedHash.toLowerCase()
        : comparableTabUrl(tab.url) === comparableTabUrl(expected.url);
      if (!matches)
        throw Object.assign(new Error('The tab changed while delivering the result.'), {
          code: 'TIMEOUT',
        });
    }
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
    }));
  return { tabs: visible, hidden, frontWindowId: lastFocused.id };
}

async function tabInfo(tabId: number) {
  await openTimesReady;
  const tab = await getTab(tabId);
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

async function fetchWithTimeout(
  requestUrl: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  return fetch(requestUrl, {
    ...init,
    signal: AbortSignal.timeout(Math.max(1, timeoutMs)),
  });
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

async function fetchSpecial(
  tabId: number,
  url: string,
  kind: 'pdf' | 'google-doc' | 'google-sheet' | 'google-slide',
) {
  const exportInfo = googleExportUrl(url);
  const target = kind === 'pdf' ? url : exportInfo?.url;
  if (!target)
    throw Object.assign(new Error('This Google file URL is not an exportable document.'), {
      code: 'UNREADABLE',
    });
  const targets =
    kind === 'google-doc' ? [target, target.replace('format=md', 'format=txt')] : [target];
  let lastStatus = 0;
  let emptyGoogleDoc: { kind: 'google-doc'; text: string } | undefined;
  const deadline = Date.now() + SPECIAL_FETCH_TIMEOUT_MS;
  for (const requestUrl of targets) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    const pageResult = await fetchSpecialInPage(tabId, requestUrl, kind, remaining);
    if (pageResult?.url) assertTabAllowed({ url: pageResult.url }, await denyPatterns());
    if (pageResult?.ok) {
      if (kind === 'pdf') return { kind, base64: pageResult.base64 || '' };
      const text = pageResult.text || '';
      if (kind !== 'google-doc' || text.trim()) return { kind, text };
      emptyGoogleDoc = { kind, text: '' };
      continue;
    }
    if (pageResult?.status) lastStatus = pageResult.status;
    const fallbackTimeout = deadline - Date.now();
    if (fallbackTimeout <= 0) break;
    let response: Response;
    try {
      response = await fetchWithTimeout(
        requestUrl,
        { credentials: 'include', redirect: 'follow' },
        fallbackTimeout,
      );
    } catch {
      continue;
    }
    if (response.url) assertTabAllowed({ url: response.url }, await denyPatterns());
    if (!response.ok) {
      lastStatus = response.status;
      if (response.body) await response.body.cancel().catch(() => undefined);
      continue;
    }
    if (kind === 'pdf') {
      const result = await readResponseBytes(response, 45 * 1024 * 1024);
      if (result.tooLarge)
        throw Object.assign(
          new Error('The PDF is too large to return. Open a smaller document and try again.'),
          { code: 'BAD_REQUEST' },
        );
      if (!result.bytes) continue;
      return { kind, base64: bytesToBase64(result.bytes) };
    }
    const result = await readResponseBytes(response, MAX_SPECIAL_TEXT_BYTES);
    if (result.tooLarge)
      throw Object.assign(
        new Error(
          'The exported document is too large to return. Open a smaller document and try again.',
        ),
        { code: 'BAD_REQUEST' },
      );
    if (!result.bytes) continue;
    const text = new TextDecoder().decode(result.bytes);
    if (specialTextTooLarge(text))
      throw Object.assign(
        new Error(
          'The exported document is too large to return. Open a smaller document and try again.',
        ),
        { code: 'BAD_REQUEST' },
      );
    if (kind !== 'google-doc' || text.trim()) return { kind, text };
    emptyGoogleDoc = { kind, text: '' };
  }
  if (lastStatus === 413)
    throw Object.assign(
      new Error(
        'The exported document is too large to return. Open a smaller document and try again.',
      ),
      { code: 'BAD_REQUEST' },
    );
  if (lastStatus)
    throw Object.assign(
      new Error(
        `The page could not be fetched (${lastStatus}). Check that you can open it in the browser.`,
      ),
      { code: 'UNREADABLE' },
    );
  if (emptyGoogleDoc) return emptyGoogleDoc;
  throw Object.assign(
    new Error('The document could not be fetched. Check that you can open it in the browser.'),
    { code: 'UNREADABLE' },
  );
}

async function fetchSpecialInPage(
  tabId: number,
  url: string,
  kind: 'pdf' | 'google-doc' | 'google-sheet' | 'google-slide',
  timeoutMs: number,
): Promise<
  { ok: boolean; url?: string; status?: number; text?: string; base64?: string } | undefined
> {
  try {
    const executions = await chrome.scripting.executeScript({
      target: { tabId },
      func: async (request: { url: string; kind: string; timeoutMs: number }) => {
        try {
          const response = await fetch(request.url, {
            credentials: 'include',
            redirect: 'follow',
            signal: AbortSignal.timeout(Math.max(1, request.timeoutMs)),
          });
          if (!response.ok) {
            if (response.body) await response.body.cancel().catch(() => undefined);
            return { ok: false, url: response.url, status: response.status };
          }
          const readBytes = async (limit: number) => {
            const contentLength = Number(response.headers.get('content-length'));
            if (Number.isFinite(contentLength) && contentLength > limit) {
              if (response.body) await response.body.cancel().catch(() => undefined);
              return { tooLarge: true as const };
            }
            const reader = response.body?.getReader();
            if (!reader) {
              const bytes = new Uint8Array(await response.arrayBuffer());
              return bytes.byteLength > limit
                ? { tooLarge: true as const }
                : { bytes, tooLarge: false as const };
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
                  return { tooLarge: true as const };
                }
                chunks.push(chunk);
              }
            } catch {
              await reader.cancel().catch(() => undefined);
              return { tooLarge: false as const };
            }
            const bytes = new Uint8Array(size);
            let offset = 0;
            for (const chunk of chunks) {
              bytes.set(chunk, offset);
              offset += chunk.byteLength;
            }
            return { bytes, tooLarge: false as const };
          };
          if (request.kind === 'pdf') {
            const result = await readBytes(45 * 1024 * 1024);
            if (result.tooLarge) return { ok: false, url: response.url, status: 413 };
            if (!result.bytes) return undefined;
            const bytes = result.bytes;
            let binary = '';
            for (let offset = 0; offset < bytes.length; offset += 0x8000)
              binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
            return { ok: true, url: response.url, base64: btoa(binary) };
          }
          const result = await readBytes(32 * 1024 * 1024);
          if (result.tooLarge || !result.bytes)
            return { ok: false, url: response.url, status: 413 };
          const text = new TextDecoder().decode(result.bytes);
          if (
            new TextEncoder().encode(text).byteLength > 32 * 1024 * 1024 ||
            new TextEncoder().encode(JSON.stringify({ text })).byteLength > 48 * 1024 * 1024
          )
            return { ok: false, url: response.url, status: 413 };
          return { ok: true, url: response.url, text };
        } catch {
          return undefined;
        }
      },
      args: [{ url, kind, timeoutMs }],
    });
    return executions[0]?.result;
  } catch {
    return undefined;
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
  if (special) {
    try {
      const specialData = await fetchSpecial(tab.id!, tab.url || '', special);
      const current = await verifyReadTab(tab.id!, tab.url || '');
      return {
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
        url: result.url,
        title: result.title,
        contentType: result.contentType,
        special: specialData,
        reloaded,
      };
    }
    return { ...result, reloaded };
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

async function queryTab(tabId: number, selector: string, html: boolean, limit: number) {
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
  try {
    const executions = await chrome.scripting.executeScript({
      target: { tabId },
      func: (value: { selector: string; html: boolean; limit: number; maxValueChars: number }) => ({
        url: location.href,
        values: Array.from(document.querySelectorAll(value.selector))
          .slice(0, value.limit)
          .map((node) => {
            const text = value.html
              ? (node as Element).outerHTML
              : (node as HTMLElement).innerText || node.textContent || '';
            return text.length > value.maxValueChars
              ? `${text.slice(0, value.maxValueChars)}…`
              : text;
          }),
      }),
      args: [
        {
          selector,
          html,
          limit: Math.max(1, Math.min(100, limit)),
          maxValueChars: MAX_QUERY_VALUE_CHARS,
        },
      ],
    });
    const result = executions[0]?.result as { url?: string; values?: string[] } | undefined;
    if (!result)
      throw Object.assign(new Error('The page returned no query results.'), { code: 'UNREADABLE' });
    assertTabAllowed(result || {}, await denyPatterns());
    await verifyReadTab(tabId, result.url || tab.url);
    return { url: result.url || tab.url, values: result.values || [] };
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
  try {
    const executions = await chrome.scripting.executeScript({
      target: { tabId: id },
      func: (maxChars: number) => {
        const active = document.activeElement as HTMLInputElement | HTMLTextAreaElement | null;
        let text = '';
        if (active && 'selectionStart' in active && active.selectionStart !== active.selectionEnd)
          text = active.value.slice(active.selectionStart || 0, active.selectionEnd || 0);
        else text = window.getSelection()?.toString() || '';
        if (text.length > maxChars) text = `${text.slice(0, maxChars)}…`;
        return { url: location.href, text };
      },
      args: [MAX_SELECTION_CHARS],
    });
    const result = executions[0]?.result as { url?: string; text?: string } | undefined;
    if (!result)
      throw Object.assign(new Error('The page returned no selection.'), { code: 'UNREADABLE' });
    assertTabAllowed(result || {}, await denyPatterns());
    await verifyReadTab(id, result.url || tab.url);
    return { tabId: id, url: result.url || tab.url, text: String(result.text || '') };
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
    if (!after?.id || after.id !== tab.id || after.url !== tab.url)
      throw Object.assign(
        new Error('The visible tab changed while capturing. Try the screenshot again.'),
        { code: 'TIMEOUT' },
      );
    assertTabAllowed(after, await denyPatterns());
    return {
      windowId: window.id,
      tabId: after.id,
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
    if (await paused())
      throw Object.assign(new Error('cobrowser is paused. Turn it on in the extension popup.'), {
        code: 'PAUSED',
      });
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
      await assertGuardAllowed(message.params);
      result = {};
    } else
      throw Object.assign(
        new Error('Unknown extension request. Use a supported cobrowser command.'),
        {
          code: 'BAD_REQUEST',
        },
      );
    await assertResultAllowed(result);
    // Denylist traversal is asynchronous, so pause must be checked after it too.
    if (await paused())
      throw Object.assign(new Error('cobrowser is paused. Turn it on in the extension popup.'), {
        code: 'PAUSED',
      });
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
