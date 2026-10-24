export type DocumentFetchContext =
  | { kind: 'worker'; tabId: number }
  | { kind: 'page'; tabId: number; documentId: string; origin: string }
  | { kind: 'file'; tabId: number };

type EventKind = 'before' | 'send' | 'redirect' | 'response' | 'complete' | 'error';
type Phase = 'before' | 'send' | 'outcome' | 'complete' | 'done' | 'network-error';

interface TraceEvent {
  kind: EventKind;
  requestId: string;
  url: string;
  redirectUrl?: string;
  marked?: boolean;
}

interface EventDetails {
  requestId: string;
  url: string;
  redirectUrl?: string;
  method: string;
  type: string;
  tabId: number;
  frameId: number;
  documentId?: string;
  initiator?: string;
  requestHeaders?: chrome.webRequest.HttpHeader[];
}

interface AttemptOptions {
  url: string;
  context: DocumentFetchContext;
  deadline: number;
  assertAllowed: (url: string) => void;
  assertCurrent: () => void;
  onAbort?: (key: string) => void;
}

const MAX_ACTIVE = 16;
const MAX_CANDIDATES = 4;
const MAX_HOPS = 20;
const MAX_EVENTS = 128;
const MAX_BYTES = 128 * 1024;
const MAX_URL_CHARS = 16_384;

export function documentFetchError(code = 'UNREADABLE'): Error & { code: string } {
  const messages: Record<string, string> = {
    UNREADABLE: 'The document request could not be verified; reopen the document and retry.',
    TIMEOUT: 'The document fetch timed out; check the document and retry.',
    DENIED: 'The document is hidden by the denylist; choose a different tab.',
    PAUSED: 'cobrowser was paused; turn it on and retry the command.',
    EXTENSION_DISCONNECTED: 'The helper disconnected; reopen the browser and retry.',
    BAD_REQUEST: 'Too many documents are fetching; read fewer tabs and retry.',
  };
  return Object.assign(new Error(messages[code] || messages.UNREADABLE), { code });
}

function identity(url: string): string {
  const parsed = new URL(url);
  parsed.username = '';
  parsed.password = '';
  parsed.hash = '';
  return parsed.toString();
}

function errorValue(value: unknown): Error {
  return value instanceof Error &&
    'code' in value &&
    ['UNREADABLE', 'TIMEOUT', 'DENIED', 'PAUSED', 'EXTENSION_DISCONNECTED', 'BAD_REQUEST'].includes(
      String(value.code),
    )
    ? value
    : documentFetchError();
}

export class DocumentFetchAttempt {
  readonly key = [...crypto.getRandomValues(new Uint8Array(16))]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
  readonly accept = `*/*, application/x-${this.key};q=0`;
  readonly controller = new AbortController();
  readonly context: DocumentFetchContext;
  private readonly candidates = new Map<string, TraceEvent[]>();
  private readonly failure: Promise<never>;
  private readonly terminal: Promise<void>;
  private rejectFailure!: (error: Error) => void;
  private resolveTerminal!: () => void;
  private readonly timer: ReturnType<typeof setTimeout>;
  private failureValue?: Error;
  private requestId?: string;
  private next: string;
  private phase: Phase = 'before';
  private hops: string[] = [];
  private eventCount = 0;
  private bytes = 0;
  private disposed = false;

  constructor(
    readonly options: AttemptOptions,
    private readonly remove: (attempt: DocumentFetchAttempt) => void,
  ) {
    this.context = options.context;
    this.next = identity(options.url);
    this.failure = new Promise((_, reject) => (this.rejectFailure = reject));
    void this.failure.catch(() => undefined);
    this.terminal = new Promise((resolve) => (this.resolveTerminal = resolve));
    this.timer = setTimeout(
      () => this.cancel(documentFetchError()),
      Math.max(1, options.deadline - Date.now()),
    );
  }

  matches(details: EventDetails): boolean {
    if (this.context.kind === 'file') return false;
    if (this.context.kind === 'worker')
      return (
        details.tabId === -1 && details.initiator === `chrome-extension://${chrome.runtime.id}`
      );
    return (
      details.tabId === this.context.tabId &&
      details.frameId === 0 &&
      details.documentId === this.context.documentId &&
      details.initiator === this.context.origin
    );
  }

  check() {
    if (this.failureValue) throw this.failureValue;
    if (Date.now() >= this.options.deadline) throw documentFetchError();
    this.options.assertCurrent();
  }

  race<T>(value: Promise<T>): Promise<T> {
    return Promise.race([value, this.failure]);
  }

  receive(kind: EventKind, details: EventDetails, marked: boolean) {
    if (this.disposed || this.failureValue) return;
    try {
      this.check();
      if (!this.matches(details)) throw documentFetchError();
      if (marked && this.requestId && details.requestId !== this.requestId)
        throw documentFetchError();
      if (this.requestId && details.requestId !== this.requestId) return;
      let pending = this.candidates.get(details.requestId);
      if (!this.requestId && !pending) {
        if (kind !== 'before' || identity(details.url) !== identity(this.options.url)) {
          if (marked) throw documentFetchError();
          return;
        }
        if (this.candidates.size >= MAX_CANDIDATES) throw documentFetchError();
        pending = [];
        this.candidates.set(details.requestId, pending);
      }
      if (!this.requestId && !pending) throw documentFetchError();
      if (details.url.length > MAX_URL_CHARS || (details.redirectUrl?.length || 0) > MAX_URL_CHARS)
        throw documentFetchError();
      const event: TraceEvent = {
        kind,
        requestId: details.requestId,
        url: details.url,
        redirectUrl: details.redirectUrl,
        marked: kind === 'send' ? marked : undefined,
      };
      const bytes = new TextEncoder().encode(JSON.stringify(event)).byteLength;
      if (this.eventCount >= MAX_EVENTS || this.bytes + bytes > MAX_BYTES)
        throw documentFetchError();
      this.eventCount++;
      this.bytes += bytes;
      if (!this.requestId) {
        pending!.push(event);
        if (!marked) return;
        this.requestId = details.requestId;
        const replay = pending!;
        this.candidates.clear();
        for (const item of replay) this.step(item);
      } else this.step(event);
    } catch (error) {
      this.cancel(errorValue(error));
    }
  }

  private step(event: TraceEvent) {
    const url = identity(event.url);
    this.options.assertAllowed(event.url);
    if (event.kind === 'error') {
      if (url !== this.next || this.phase === 'done' || this.phase === 'network-error')
        throw documentFetchError();
      this.phase = 'network-error';
      this.resolveTerminal();
      return;
    }
    if (url !== this.next) throw documentFetchError();
    if (event.kind === 'before') {
      if (this.phase !== 'before' || this.hops.length >= MAX_HOPS) throw documentFetchError();
      this.hops.push(event.url);
      this.phase = 'send';
    } else if (event.kind === 'send') {
      if (this.phase !== 'send' || !event.marked) throw documentFetchError();
      this.phase = 'outcome';
    } else if (event.kind === 'redirect') {
      if (this.phase !== 'outcome' || !event.redirectUrl) throw documentFetchError();
      const parsed = new URL(event.redirectUrl);
      if (!['http:', 'https:'].includes(parsed.protocol)) throw documentFetchError();
      this.options.assertAllowed(event.redirectUrl);
      if (this.hops.length >= MAX_HOPS) throw documentFetchError();
      this.next = identity(event.redirectUrl);
      this.phase = 'before';
    } else if (event.kind === 'response') {
      if (this.phase !== 'outcome') throw documentFetchError();
      this.phase = 'complete';
    } else if (event.kind === 'complete') {
      if (this.phase !== 'complete') throw documentFetchError();
      this.phase = 'done';
      this.resolveTerminal();
    }
  }

  async finish(url?: string, mode: 'body' | 'network' | 'diagnostic' = 'body'): Promise<string[]> {
    if (this.context.kind === 'file') {
      this.check();
      if (!url || new URL(url).protocol !== 'file:' || identity(url) !== this.next)
        throw documentFetchError();
      this.options.assertAllowed(url);
      return [url];
    }
    await this.race(this.terminal);
    this.check();
    if (!this.requestId || (url && identity(url) !== this.next)) throw documentFetchError();
    if (
      mode === 'network'
        ? this.phase !== 'network-error'
        : mode === 'body'
          ? this.phase !== 'done'
          : !['done', 'network-error'].includes(this.phase)
    )
      throw documentFetchError();
    for (const hop of this.hops) this.options.assertAllowed(hop);
    return this.hops.slice();
  }

  cancel(error: Error) {
    if (this.disposed || this.failureValue) return;
    this.failureValue = error;
    this.rejectFailure(error);
    this.controller.abort();
    this.options.onAbort?.(this.key);
    this.dispose();
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    clearTimeout(this.timer);
    this.remove(this);
    this.candidates.clear();
    this.hops = [];
  }
}

export class DocumentFetchTracker {
  private readonly active = new Set<DocumentFetchAttempt>();

  constructor() {
    const filter: chrome.webRequest.RequestFilter = {
      urls: ['http://*/*', 'https://*/*'],
      types: ['xmlhttprequest'],
    };
    const listen = (kind: EventKind, details: EventDetails) => {
      if (!this.active.size) return;
      const accept =
        kind === 'send'
          ? details.requestHeaders?.find((header) => header.name.toLowerCase() === 'accept')?.value
          : undefined;
      for (const attempt of this.active) {
        const marked = accept === attempt.accept;
        if (marked || attempt.matches(details)) attempt.receive(kind, details, marked);
      }
    };
    chrome.webRequest.onBeforeRequest.addListener((details) => {
      listen('before', details);
      return undefined;
    }, filter);
    chrome.webRequest.onBeforeSendHeaders.addListener(
      (details) => {
        listen('send', details);
        return undefined;
      },
      filter,
      ['requestHeaders'],
    );
    chrome.webRequest.onBeforeRedirect.addListener(
      (details) => listen('redirect', details),
      filter,
    );
    chrome.webRequest.onResponseStarted.addListener(
      (details) => listen('response', details),
      filter,
    );
    chrome.webRequest.onCompleted.addListener((details) => listen('complete', details), filter);
    chrome.webRequest.onErrorOccurred.addListener((details) => listen('error', details), filter);
  }

  begin(options: AttemptOptions): DocumentFetchAttempt {
    if (this.active.size >= MAX_ACTIVE) throw documentFetchError('BAD_REQUEST');
    if (options.url.length > MAX_URL_CHARS) throw documentFetchError();
    const protocol = new URL(options.url).protocol;
    if (
      options.context.kind === 'file'
        ? protocol !== 'file:'
        : !['http:', 'https:'].includes(protocol)
    )
      throw documentFetchError();
    options.assertCurrent();
    options.assertAllowed(options.url);
    const attempt = new DocumentFetchAttempt(options, (item) => this.active.delete(item));
    if ([...this.active].some((item) => item.accept === attempt.accept)) {
      attempt.dispose();
      throw documentFetchError();
    }
    this.active.add(attempt);
    return attempt;
  }

  cancel(code: string, tabId?: number) {
    for (const attempt of this.active)
      if (tabId === undefined || attempt.context.tabId === tabId)
        attempt.cancel(documentFetchError(code));
  }
}
