import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { createHash } from 'node:crypto';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { extensionBuildRevision } from './shared/extension-build.js';
import process from 'node:process';
import {
  capResponse,
  capText as measuredCapText,
  jsonTextSize,
  splitPages,
} from './shared/paging.js';
import { filterTabs, siteForUrl, type TabInfo } from './shared/filters.js';
import { flattenSections, isSectionNumber, sectionOutline } from './shared/sections.js';
import {
  MAX_CHARS,
  MAX_GUARD_URL_CHARS,
  MAX_SCREENSHOT_CHARS,
  normalizeErrorCode,
  PROTOCOL_VERSION,
  VERSION,
} from './shared/constants.js';
import {
  NativeFrameDecoder,
  encodeFrame,
  MAX_EXTENSION_FRAME,
  MAX_HELPER_FRAME,
} from './shared/native.js';
import {
  convertSnapshot,
  convertSpecialSnapshot,
  plainLinks,
  type ConvertedPage,
  type PageSnapshot,
} from './shared/read.js';
import { findInMarkdown } from './shared/search.js';
import { parseDuration } from './shared/duration.js';
import { shellCommandArg } from './shared/command.js';
import { redactEmbeddedUrls, redactUrl } from './shared/url.js';

interface NativeMessage {
  id?: number;
  method?: string;
  params?: unknown;
  event?: string;
  data?: any;
  ok?: boolean;
  result?: any;
  error?: any;
}
interface RequestBody {
  [key: string]: any;
}
interface GuardTab {
  id: number;
  url: string;
  documentEpoch: string;
}

type GuardedTabInfo = TabInfo & { documentEpoch: string };

interface GuardAccess {
  policyEpoch: string;
  tabs: Array<{ id: number; documentEpoch: string }>;
}

const SIMPLE_BROWSER_NAME = /^[a-z0-9][a-z0-9._-]*$/i;
const MAX_READ_LOG_BYTES = 5_000_000;
const CACHE_TTL_MS = 600_000;
const MAX_CACHE_ENTRIES = 32;
const MAX_CACHE_BYTES = 128 * 1024 * 1024;
const MAX_SELECTOR_CHARS = 10_000;
const MAX_SEARCH_CHARS = 10_000;
const MAX_READ_TABS = 200;
const MIN_SOCKET_CHARS = 64;

function capText(text: string, cap: number, next?: string, label = 'more') {
  return measuredCapText(text, cap, next, label, jsonTextSize);
}

function responseCap(params: RequestBody): number {
  const cap = maxCharsFor(params.maxChars);
  if (cap < MIN_SOCKET_CHARS)
    throw error('BAD_REQUEST', `Use maxChars of at least ${MIN_SOCKET_CHARS}.`);
  const overhead = integerParam(params.responseOverhead, 'responseOverhead', 0, 0, cap - 12);
  return cap - overhead;
}

function responseTextCap(params: RequestBody): number {
  return Math.max(0, responseCap(params) - JSON.stringify({ ok: true, text: '' }).length);
}

function oneLine(value: unknown, maxLength = 200): string {
  return redactEmbeddedUrls(
    String(value ?? '')
      .replace(/[\u0000-\u001f\u007f]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim(),
  ).slice(0, maxLength);
}

function requestAgent(value: string | string[] | undefined): string {
  let name = Array.isArray(value) ? value.join(',') : value || 'unknown';
  try {
    name = decodeURIComponent(name);
  } catch {
    /* Older clients may send a literal percent sign. */
  }
  return oneLine(name, 120) || 'unknown';
}

function homeDir(): string {
  return path.resolve(process.env.COBROWSER_HOME || path.join(os.homedir(), '.cobrowser'));
}
function browserName(): string {
  const i = process.argv.indexOf('--browser');
  const value = i >= 0 ? process.argv[i + 1] : 'chrome';
  if (!value || value.startsWith('-'))
    throw new Error('Use --browser with a simple name such as chrome or arc.');
  if (!SIMPLE_BROWSER_NAME.test(value))
    throw new Error('Use a simple browser name such as chrome or arc.');
  return value.toLowerCase();
}
function logFile(home: string, browser: string): string {
  return path.join(home, 'logs', `helper-${browser}.log`);
}

function extensionDiskVersion(home: string): string | undefined {
  try {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(home, 'extension', 'manifest.json'), 'utf8'),
    ) as { version?: unknown };
    return typeof manifest.version === 'string' ? manifest.version : undefined;
  } catch {
    return undefined;
  }
}

class Logger {
  constructor(private readonly file: string) {}
  write(message: string) {
    try {
      const safeMessage = message.replace(/[\u0000-\u001f\u007f]/g, ' ');
      if (fs.existsSync(this.file) && fs.statSync(this.file).size > 1_000_000)
        fs.renameSync(this.file, `${this.file}.1`);
      fs.appendFileSync(this.file, `${new Date().toISOString()} ${safeMessage}\n`, { mode: 0o600 });
      fs.chmodSync(this.file, 0o600);
    } catch {
      /* logging must not break the helper */
    }
  }
}

class ExtensionRouter {
  constructor(
    private readonly diskExtensionVersion?: string,
    private readonly diskExtensionRevision?: string,
  ) {}
  private nextId = 1;
  private pending = new Map<
    number,
    { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
  >();
  private sendNative: ((value: unknown) => void) | undefined;
  onEvent: ((event: string, data: any) => void) | undefined;
  connected = false;
  extensionRevision: string | undefined;
  setSender(send: (value: unknown) => void) {
    this.sendNative = send;
    this.connected = false;
    this.extensionRevision = undefined;
  }
  disconnected() {
    this.connected = false;
    this.extensionRevision = undefined;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(
        Object.assign(new Error('The extension disconnected. Restart the browser and try again.'), {
          code: 'EXTENSION_DISCONNECTED',
        }),
      );
    }
    this.pending.clear();
  }
  handle(message: NativeMessage, logger: Logger) {
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      logger.write('invalid native message');
      return;
    }
    if (message.event !== undefined && typeof message.event !== 'string') {
      logger.write('invalid native event');
      return;
    }
    if (message.id !== undefined && !Number.isSafeInteger(message.id)) {
      logger.write('invalid native message id');
      return;
    }
    if (message.ok !== undefined && typeof message.ok !== 'boolean') {
      logger.write('invalid native response');
      return;
    }
    if (message.event) {
      if (message.event === 'hello') {
        const data = message.data as
          { protocol?: number; version?: string; extensionRevision?: unknown } | undefined;
        this.extensionRevision =
          typeof data?.extensionRevision === 'string' &&
          /^[a-f0-9]{64}$/.test(data.extensionRevision)
            ? data.extensionRevision
            : undefined;
        this.connected =
          data?.protocol === PROTOCOL_VERSION &&
          data.version === VERSION &&
          (!this.diskExtensionRevision || this.extensionRevision === this.diskExtensionRevision);
        logger.write(this.connected ? 'extension connected' : 'extension version mismatch');
        this.sendNative?.({
          event: 'hello_ack',
          data: {
            version: VERSION,
            protocol: PROTOCOL_VERSION,
            extensionVersion: this.diskExtensionVersion,
            extensionRevision: this.diskExtensionRevision,
          },
        });
      }
      this.onEvent?.(message.event, message.data);
      return;
    }
    if (message.id === undefined) return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.ok) pending.resolve(message.result);
    else
      pending.reject(
        Object.assign(
          new Error(
            typeof message.error?.message === 'string'
              ? message.error.message
              : 'The extension returned an error. Restart the browser and try again.',
          ),
          {
            code: normalizeErrorCode(message.error?.code, 'EXTENSION_DISCONNECTED'),
          },
        ),
      );
  }
  request(method: string, params: unknown, timeoutMs = 15_000): Promise<any> {
    if (!this.connected || !this.sendNative)
      return Promise.reject(
        Object.assign(new Error('The extension disconnected. Restart the browser and try again.'), {
          code: 'EXTENSION_DISCONNECTED',
        }),
      );
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          Object.assign(
            new Error(
              'The extension timed out. Check that the browser is responsive and try again.',
            ),
            { code: 'TIMEOUT' },
          ),
        );
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.sendNative!({ id, method, params });
    });
  }
  event(event: string, data?: unknown) {
    this.sendNative?.({ event, data });
  }
}

interface CacheEntry {
  page: ConvertedPage;
  sourceUrls: string[];
  documentEpoch: string;
  at: number;
  bytes: number;
}

interface LoadedSnapshot {
  snapshot: PageSnapshot & { documentEpoch: string };
  reloaded: boolean;
}

interface PendingRead {
  promise: Promise<LoadedSnapshot>;
  token: object;
}

function pageCacheBytes(page: ConvertedPage): number {
  let bytes = Buffer.byteLength(page.url, 'utf8') + Buffer.byteLength(page.title, 'utf8');
  bytes += Buffer.byteLength(page.markdown, 'utf8');
  for (const part of page.pages) bytes += Buffer.byteLength(part, 'utf8');
  const visit = (section: ConvertedPage['sections'][number]): void => {
    bytes += Buffer.byteLength(section.title, 'utf8') + Buffer.byteLength(section.text, 'utf8');
    for (const child of section.children) visit(child);
  };
  for (const section of page.sections) visit(section);
  if (page.note) bytes += Buffer.byteLength(page.note, 'utf8');
  return bytes;
}

function pruneCache(cache: Map<string, CacheEntry>, now = Date.now()) {
  for (const [key, entry] of cache) {
    if (now - entry.at >= CACHE_TTL_MS) cache.delete(key);
  }
  let bytes = 0;
  for (const entry of cache.values()) bytes += entry.bytes;
  if (cache.size <= MAX_CACHE_ENTRIES && bytes <= MAX_CACHE_BYTES) return;
  const oldest = [...cache.entries()].sort(([, left], [, right]) => left.at - right.at);
  for (const [key, entry] of oldest) {
    if (cache.size <= MAX_CACHE_ENTRIES && bytes <= MAX_CACHE_BYTES) break;
    cache.delete(key);
    bytes -= entry.bytes;
  }
}

function formatTabLine(tab: TabInfo): string {
  const marker = `${tab.active ? '*' : ' '} ${tab.discarded ? 'z' : ' '}`;
  const title = oneLine(tab.title || '(untitled)', 60);
  const site = oneLine(siteForUrl(tab.url), 18);
  return `${tab.id} ${marker} ${site.padEnd(18)} ${title}`.trimEnd();
}

function commandArg(value: unknown): string {
  return shellCommandArg(value);
}

function commandPrefix(browser?: string): string[] {
  return browser ? ['cobrowser', '--browser', browser] : ['cobrowser'];
}

function continuationBrowser(home: string, browser: string): string | undefined {
  try {
    const sockets = fs
      .readdirSync(path.join(home, 'run'))
      .filter((name) => name.endsWith('.sock') && SIMPLE_BROWSER_NAME.test(name.slice(0, -5)));
    return sockets.length > 1 ? browser : undefined;
  } catch {
    return undefined;
  }
}

function pageCommand(
  tabId: number,
  section: string | undefined,
  page: number,
  params: RequestBody,
  browser?: string,
): string {
  const args = [...commandPrefix(browser), 'read', String(tabId)];
  if (section !== undefined) args.push('--section', section);
  args.push('--page', String(page));
  if (params.pageSize !== undefined) args.push('--page-size', String(params.pageSize));
  if (params.full) args.push('--full');
  if (params.links) args.push('--links');
  if (params.maxChars !== undefined) args.push('--max-chars', commandArg(params.maxChars));
  return args.join(' ');
}

function readCommand(tabIds: number[], params: RequestBody, browser?: string): string {
  const args = [...commandPrefix(browser), 'read', ...tabIds.map(String)];
  if (params.section !== undefined) args.push('--section', commandArg(params.section));
  if (params.page !== undefined) args.push('--page', commandArg(params.page));
  if (params.pageSize !== undefined) args.push('--page-size', commandArg(params.pageSize));
  if (params.full) args.push('--full');
  if (params.links) args.push('--links');
  if (params.maxChars !== undefined) args.push('--max-chars', commandArg(params.maxChars));
  return args.join(' ');
}

function continuationCommand(text: string): string | undefined {
  return /\n\n(?:next|more): ([^\n]+)$/.exec(text)?.[1];
}

function sectionCommand(
  tabId: number,
  section: string,
  params: RequestBody,
  browser?: string,
): string {
  const args = [...commandPrefix(browser), 'read', String(tabId), '--section', section];
  if (params.full) args.push('--full');
  if (params.links) args.push('--links');
  if (params.maxChars !== undefined) args.push('--max-chars', commandArg(params.maxChars));
  return args.join(' ');
}

function tabsCommand(offset: number, params: RequestBody, browser?: string): string {
  const args = [...commandPrefix(browser), 'tabs'];
  if (params.match) {
    const match = commandArg(params.match);
    if (String(params.match).startsWith('--')) args.push(`--match=${match}`);
    else args.push('--match', match);
  }
  if (params.since) args.push('--since', commandArg(params.since));
  if (params.window !== undefined) args.push('--window', commandArg(params.window));
  if (params.active) args.push('--active');
  if (params.limit !== undefined) args.push('--limit', commandArg(params.limit));
  args.push('--offset', String(offset));
  if (params.maxChars !== undefined) args.push('--max-chars', commandArg(params.maxChars));
  return args.join(' ');
}

function continuationMaxChars(maxChars: number): number {
  if (maxChars >= Number.MAX_SAFE_INTEGER) return Number.MAX_SAFE_INTEGER;
  return Math.min(Number.MAX_SAFE_INTEGER, Math.max(maxChars + 1, maxChars * 2));
}

function findCommand(tabId: number, query: string, maxChars: number, browser?: string): string {
  return [
    ...commandPrefix(browser),
    'find',
    String(tabId),
    '--max-chars',
    String(continuationMaxChars(maxChars)),
    '--',
    commandArg(query),
  ].join(' ');
}

function queryCommand(
  tabId: number,
  selector: string,
  params: RequestBody,
  maxChars: number,
  browser?: string,
): string {
  const args = [...commandPrefix(browser), 'query', String(tabId), commandArg(selector)];
  if (params.html) args.push('--html');
  if (params.limit !== undefined) args.push('--limit', commandArg(params.limit));
  if (params.offset !== undefined) args.push('--offset', commandArg(params.offset));
  args.push('--max-chars', String(maxChars));
  return args.join(' ');
}

function selectionCommand(tabId: number | undefined, maxChars: number, browser?: string): string {
  const args = [...commandPrefix(browser), 'selection'];
  if (tabId !== undefined) args.push(String(tabId));
  args.push('--max-chars', String(continuationMaxChars(maxChars)));
  return args.join(' ');
}

function logCommand(limit: number, maxChars: number, browser?: string): string {
  return `${[...commandPrefix(browser), 'log', '--limit', String(limit)].join(' ')} --max-chars ${continuationMaxChars(maxChars)}`;
}

interface RenderedRead {
  text: string;
  pages?: number;
}

function pagedText(
  text: string,
  cap: number,
  prefix: string,
  note: string,
  tabId: number,
  section: string | undefined,
  params: RequestBody,
  pageNumber?: number,
  browser?: string,
  documentPages?: string[],
): RenderedRead {
  const noteText = note ? `\n\n${note}` : '';
  const physicalPages = documentPages?.length ? documentPages : undefined;
  const fixedPages =
    physicalPages ||
    (params.pageSize === undefined ? undefined : splitPages(text, params.pageSize, jsonTextSize));
  if (
    params.pageSize === undefined &&
    (!physicalPages || pageNumber === undefined) &&
    jsonTextSize(prefix + text + noteText) <= cap
  ) {
    if (pageNumber !== undefined && pageNumber !== 1)
      throw error(
        'BAD_REQUEST',
        `Page ${pageNumber} was not found. Choose a page from the previous response.`,
      );
    return { text: prefix + text + noteText, pages: physicalPages?.length ?? 1 };
  }
  const largerCap = { ...params, maxChars: continuationMaxChars(maxCharsFor(params.maxChars)) };
  if (
    jsonTextSize(
      prefix + noteText + `\n\nnext: ${pageCommand(tabId, section, 2, params, browser)}`,
    ) >= cap
  )
    return {
      text: withContinuation(
        '',
        pageCommand(tabId, section, pageNumber || 1, largerCap, browser),
        cap,
        'more',
      ),
      pages: fixedPages?.length,
    };
  let budget = params.pageSize ?? Math.max(1, cap - jsonTextSize(prefix + noteText) - 80);
  let pages: string[] = fixedPages || [];
  if (!physicalPages && params.pageSize === undefined)
    for (let attempt = 0; attempt < 12; attempt++) {
      pages = splitPages(text, budget, jsonTextSize);
      const nextCommand = pageCommand(
        tabId,
        section,
        Math.max(2, pages.length),
        { ...params, pageSize: budget },
        browser,
      );
      const nextLength = jsonTextSize(`\n\nnext: ${nextCommand}`);
      const nextBudget = Math.max(
        1,
        Math.min(budget, cap - jsonTextSize(prefix + noteText) - nextLength),
      );
      if (nextBudget === budget) break;
      budget = nextBudget;
    }
  const pageParams = physicalPages ? params : { ...params, pageSize: budget };
  if (!fixedPages) pages = splitPages(text, budget, jsonTextSize);
  const start = pageNumber === undefined ? 0 : pageNumber - 1;
  if (start < 0 || start >= pages.length)
    throw Object.assign(
      new Error(`Page ${pageNumber} was not found. Choose a page from the previous response.`),
      { code: 'BAD_REQUEST' },
    );
  const next =
    start + 1 < pages.length
      ? pageCommand(tabId, section, start + 2, pageParams, browser)
      : undefined;
  const base = `${prefix}${pages[start]}${noteText}`;
  if (jsonTextSize(base + (next ? `\n\nnext: ${next}` : '')) > cap)
    return {
      text: withContinuation(
        '',
        pageCommand(tabId, section, start + 1, largerCap, browser),
        cap,
        'more',
      ),
      pages: fixedPages?.length,
    };
  return { text: next ? withNext(base, next, cap) : capText(base, cap).text, pages: pages.length };
}

function withNext(text: string, command: string, cap: number): string {
  return withContinuation(text, command, cap, 'next');
}

function withContinuation(text: string, command: string, cap: number, label: string): string {
  const rendered = `${text}\n\n${label}: ${command}`;
  return capText(rendered, cap, command, label).text;
}

function withAdditionalNext(text: string, command: string, cap: number): string | undefined {
  const continuation = /\n\n(next|more): ([^\n]+)$/.exec(text);
  if (!continuation || continuation[2] === command) return withNext(text, command, cap);
  const suffix = `\n\n${continuation[1]}: ${continuation[2]}\n\nalso: ${command}`;
  if (jsonTextSize(suffix) > cap) return undefined;
  const prefix = text.slice(0, continuation.index);
  return `${capText(prefix, cap - jsonTextSize(suffix)).text}${suffix}`;
}

function readBody(markdown: string, params: RequestBody): string {
  return params.links ? markdown : plainLinks(markdown);
}

function maxCharsFor(value: unknown): number {
  if (value === undefined) return MAX_CHARS;
  if (
    (typeof value !== 'number' && typeof value !== 'string') ||
    (typeof value === 'string' && !value.trim())
  )
    throw Object.assign(new Error('Use a positive character limit such as 20000.'), {
      code: 'BAD_REQUEST',
    });
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 1)
    throw Object.assign(new Error('Use a positive character limit such as 20000.'), {
      code: 'BAD_REQUEST',
    });
  return result;
}

function integerParam(
  value: unknown,
  label: string,
  fallback: number,
  minimum: number,
  maximum?: number,
): number {
  if (value === undefined) return fallback;
  if (
    (typeof value !== 'number' && typeof value !== 'string') ||
    (typeof value === 'string' && !value.trim())
  )
    throw error(
      'BAD_REQUEST',
      maximum === undefined
        ? `Use a whole number of at least ${minimum} for ${label}.`
        : `Use a whole number from ${minimum} to ${maximum} for ${label}.`,
    );
  const result = Number(value);
  if (
    !Number.isSafeInteger(result) ||
    result < minimum ||
    (maximum !== undefined && result > maximum)
  )
    throw error(
      'BAD_REQUEST',
      maximum === undefined
        ? `Use a whole number of at least ${minimum} for ${label}.`
        : `Use a whole number from ${minimum} to ${maximum} for ${label}.`,
    );
  return result;
}

function optionalBoolean(value: unknown, label: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') throw error('BAD_REQUEST', `Use true or false for ${label}.`);
  return value;
}

function optionalText(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw error('BAD_REQUEST', `Use text for ${label}.`);
  return value;
}

function boundedText(value: unknown, label: string, maxLength: number): string | undefined {
  const text = optionalText(value, label);
  if (text !== undefined && text.length > maxLength)
    throw error('BAD_REQUEST', `Use a shorter ${label}.`);
  return text;
}

function numericParam(value: unknown, label: string, minimum = 0): number {
  if (
    (typeof value !== 'number' && typeof value !== 'string') ||
    (typeof value === 'string' && !value.trim())
  )
    throw error('BAD_REQUEST', `Use a numeric ${label}.`);
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < minimum)
    throw error('BAD_REQUEST', `Use a non-negative numeric ${label}.`);
  return result;
}

function sectionParam(value: unknown): string | number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' && typeof value !== 'number')
    throw error('BAD_REQUEST', 'Use a section number such as 2 or 2.1.');
  if (!isSectionNumber(value)) throw error('BAD_REQUEST', 'Use a section number such as 2 or 2.1.');
  return value;
}

function windowParam(value: unknown): number | 'front' | undefined {
  if (value === undefined || value === 'front') return value;
  if (typeof value !== 'number' && typeof value !== 'string')
    throw error('BAD_REQUEST', 'Use --window front or a numeric window id.');
  if (typeof value === 'string' && !value.trim())
    throw error('BAD_REQUEST', 'Use --window front or a numeric window id.');
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0)
    throw error('BAD_REQUEST', 'Use --window front or a numeric window id.');
  return result;
}

function formatRead(
  tab: TabInfo,
  page: ConvertedPage,
  params: RequestBody,
  note = page.note || '',
  browser?: string,
): RenderedRead {
  const sections = flattenSections(page.sections);
  const sectionCount = sections.some((section) => section.level > 0) ? sections.length : 0;
  const title = oneLine(page.title || tab.title || '(untitled)');
  const url = safeUrl(page.url);
  const header = `## ${tab.id} · ${siteForUrl(url)} · ${title}\n${url}\n${page.words.toLocaleString()} words · ${sectionCount} sections`;
  const cap = responseTextCap(params);
  const prefix = `${header}\n\n`;
  const sectionNumber = params.section === undefined ? undefined : String(params.section);
  if (sectionNumber !== undefined && !isSectionNumber(sectionNumber))
    throw error('BAD_REQUEST', 'Use a section number such as 2 or 2.1.');
  const requestedPage = params.page === undefined ? undefined : Number(params.page);
  if (requestedPage !== undefined && (!Number.isSafeInteger(requestedPage) || requestedPage < 1))
    throw Object.assign(
      new Error(`Page ${params.page} was not found. Choose a positive page number.`),
      { code: 'BAD_REQUEST' },
    );

  if (sectionNumber !== undefined) {
    const section = sections.find((item) => item.number === sectionNumber);
    if (!section)
      throw Object.assign(
        new Error(
          `Section ${sectionNumber} was not found. Run cobrowser read ${tab.id} to see the outline.`,
        ),
        { code: 'BAD_REQUEST' },
      );
    return pagedText(
      readBody(section.text, params),
      cap,
      prefix,
      note,
      tab.id,
      sectionNumber,
      params,
      requestedPage,
      browser,
    );
  }

  const rendered = pagedText(
    readBody(page.markdown, params),
    cap,
    prefix,
    note,
    tab.id,
    undefined,
    params,
    requestedPage,
    browser,
    page.pagesAreDocumentPages ? page.pages.map((text) => readBody(text, params)) : undefined,
  );
  if (requestedPage !== undefined || page.words <= 1500) {
    return rendered;
  }

  const outline = sectionOutline(page.sections);
  const hasHeadings = page.sections.some((section) => section.level > 0);
  if (!hasHeadings) {
    return {
      text: withNext(
        `${prefix}${rendered.pages === undefined ? 'Read a page with a larger character cap.' : `${rendered.pages} pages`}${note ? `\n\n${note}` : ''}`,
        pageCommand(tab.id, undefined, 1, params, browser),
        cap,
      ),
      pages: rendered.pages,
    };
  }
  const firstSection = page.sections[0]?.number;
  const next =
    firstSection === undefined
      ? pageCommand(tab.id, undefined, 1, params, browser)
      : sectionCommand(tab.id, firstSection, params, browser);
  return {
    text: withNext(`${prefix}${outline}${note ? `\n\n${note}` : ''}`, next, cap),
    pages: rendered.pages,
  };
}

function compactTab(tab: TabInfo): Record<string, unknown> {
  return {
    id: tab.id,
    windowId: tab.windowId,
    active: tab.active,
    title: oneLine(tab.title, 60),
    url: safeUrl(tab.url, 200),
    lastAccessed: tab.lastAccessed,
    openedAt: tab.openedAt,
    discarded: tab.discarded,
    status: tab.status,
  };
}

function pageData(page: ConvertedPage, pages: number | undefined): Record<string, unknown> {
  return {
    url: safeUrl(page.url),
    title: oneLine(pdfSafeText(page.title), 200),
    words: page.words,
    sections: flattenSections(page.sections).map(({ number, title, level, words }) => ({
      number,
      title: oneLine(pdfSafeText(title), 200),
      level,
      words,
    })),
    pages,
    note: page.note,
  };
}

function error(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

function pdfSafeText(value: string): string {
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
}

function safeUrl(value: unknown, maxLength = 2_000): string {
  return redactUrl(pdfSafeText(String(value ?? '')), maxLength);
}

function comparableGuardUrl(value: unknown): string {
  const text = pdfSafeText(String(value ?? ''));
  try {
    const parsed = new URL(text);
    parsed.username = '';
    parsed.password = '';
    return parsed.toString();
  } catch {
    return text;
  }
}

/* The short value is for denylist checks. The hash preserves exact identity for long URLs. */
function guardUrl(value: unknown): string {
  return comparableGuardUrl(value).slice(0, MAX_GUARD_URL_CHARS);
}
function guardUrlHash(value: unknown): string {
  return createHash('sha256').update(comparableGuardUrl(value)).digest('hex');
}

function requireDocumentEpoch(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 100)
    throw error(
      'EXTENSION_DISCONNECTED',
      'The extension sent no document identity; run cobrowser setup and retry the command.',
    );
  return value;
}

function requireGuardAccess(value: unknown): GuardAccess {
  const access = value as GuardAccess | undefined;
  if (
    !access ||
    typeof access !== 'object' ||
    typeof access.policyEpoch !== 'string' ||
    !access.policyEpoch ||
    access.policyEpoch.length > 100 ||
    !Array.isArray(access.tabs) ||
    access.tabs.length > 200 ||
    access.tabs.some(
      (tab) =>
        !tab ||
        !Number.isSafeInteger(tab.id) ||
        tab.id < 0 ||
        typeof tab.documentEpoch !== 'string' ||
        !tab.documentEpoch ||
        tab.documentEpoch.length > 100,
    )
  )
    throw error(
      'EXTENSION_DISCONNECTED',
      'The extension sent invalid guard access metadata; run cobrowser setup and retry the command.',
    );
  return access;
}

function safeLogEntry(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const source = value as Record<string, unknown>;
  const entry: Record<string, unknown> = {};
  if (typeof source.time === 'string') entry.time = oneLine(source.time, 80);
  if (typeof source.browser === 'string') entry.browser = oneLine(source.browser, 80);
  if (typeof source.agent === 'string') entry.agent = oneLine(source.agent, 120);
  if (typeof source.command === 'string') entry.command = oneLine(source.command, 80);
  if (typeof source.tabId === 'number' && Number.isSafeInteger(source.tabId) && source.tabId >= 0)
    entry.tabId = source.tabId;
  if (typeof source.url === 'string') {
    const url = oneLine(safeUrl(source.url), 2_000);
    if (url) entry.url = url;
  }
  if (typeof source.chars === 'number' && Number.isSafeInteger(source.chars) && source.chars >= 0)
    entry.chars = source.chars;
  return Object.keys(entry).length ? entry : undefined;
}

interface HelperServerOptions {
  browser: string;
  home: string;
  socketPath: string;
  router: ExtensionRouter;
  cache: Map<string, CacheEntry>;
  pendingReads: Map<string, PendingRead>;
  invalidatedReads: WeakSet<object>;
  expectedReloads: WeakSet<object>;
  readsLog: string;
  logger: Logger;
  appendLog: (entry: Record<string, unknown>) => Promise<void>;
  recordRead: (entry: Record<string, unknown>) => Promise<void>;
  stop: (exitCode?: number) => Promise<void>;
}

function createHelperServer(options: HelperServerOptions): http.Server {
  const {
    browser,
    home,
    socketPath,
    router,
    cache,
    pendingReads,
    invalidatedReads,
    expectedReloads,
    readsLog,
    logger,
    appendLog,
    recordRead,
    stop,
  } = options;
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    let bodySize = 0;
    let tooLarge = false;
    let requestAborted = request.aborted;
    const abandonRequest = () => {
      requestAborted = true;
      chunks.length = 0;
    };
    request.once('aborted', abandonRequest);
    request.once('error', abandonRequest);
    request.once('close', () => {
      if (!request.complete) abandonRequest();
    });
    response.once('close', abandonRequest);
    response.once('error', () => {
      requestAborted = true;
    });
    request.on('data', (chunk) => {
      if (requestAborted) return;
      bodySize += chunk.length;
      if (bodySize <= 1_000_000) chunks.push(Buffer.from(chunk));
      else tooLarge = true;
    });
    request.on('end', async () => {
      if (requestAborted) return;
      let validatedCap = MAX_CHARS;
      const send = (status: number, payload: unknown) => {
        if (requestAborted || response.destroyed || response.writableEnded) return;
        const body = JSON.stringify(capResponse(payload as Record<string, unknown>, validatedCap));
        response.writeHead(status, {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
        });
        response.end(body);
      };
      let body: RequestBody = {};
      try {
        if (tooLarge)
          throw error('BAD_REQUEST', 'The request is too large. Send a smaller command.');
        if (chunks.length) {
          try {
            const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
              throw new Error('request body must be an object');
            body = parsed as RequestBody;
          } catch {
            throw error('BAD_REQUEST', 'The request body is not valid JSON.');
          }
        }
        validatedCap = responseCap(body);
        if (request.method !== 'POST' || !request.url?.startsWith('/v1/'))
          return send(404, {
            ok: false,
            error: {
              code: 'BAD_REQUEST',
              message: 'Unknown cobrowser command. Use a supported cobrowser command.',
            },
          });
        const command = request.url.slice('/v1/'.length).split('?')[0];
        const commandBrowser = continuationBrowser(home, browser);
        const assertRequestActive = () => {
          if (requestAborted || response.destroyed)
            throw error('BROWSER_OFFLINE', 'The client closed the request.');
        };
        let requestPauseEpoch: string | undefined;
        let pauseReady: Promise<void> | undefined;
        const extensionRequest = async (
          method: string,
          params: Record<string, unknown>,
          timeoutMs = 15_000,
        ) => {
          assertRequestActive();
          // One token covers snapshots, conversion, logging, and every final guard.
          pauseReady ??= router.request('guard', {}).then((result) => {
            if (typeof result?.pauseEpoch !== 'string')
              throw error(
                'EXTENSION_DISCONNECTED',
                'The extension sent no pause token; run cobrowser setup and retry the command.',
              );
            requestPauseEpoch = result.pauseEpoch;
          });
          await pauseReady;
          assertRequestActive();
          return router.request(method, { ...params, pauseEpoch: requestPauseEpoch }, timeoutMs);
        };
        const ensureActive = async (urls: string[] = [], tabs: GuardTab[] = []) => {
          assertRequestActive();
          const guarded = urls.map((value) => guardUrl(value));
          const guardedTabs = tabs.map((tab) => ({
            id: tab.id,
            url: guardUrl(tab.url),
            urlHash: guardUrlHash(tab.url),
            documentEpoch: requireDocumentEpoch(tab.documentEpoch),
          }));
          const batches = Math.max(guarded.length, guardedTabs.length);
          let access: GuardAccess | undefined;
          let index = 0;
          do {
            let count = Math.min(32, batches - index);
            const params = () => ({
              urls: guarded.slice(index, index + count),
              tabs: guardedTabs.slice(index, index + count),
              access,
            });
            // Include escaping and accumulated identities in the native frame budget.
            while (
              count > 0 &&
              Buffer.byteLength(
                JSON.stringify({
                  id: Number.MAX_SAFE_INTEGER,
                  method: 'guard',
                  params: { ...params(), pauseEpoch: requestPauseEpoch ?? 'x'.repeat(100) },
                }),
                'utf8',
              ) >
                MAX_HELPER_FRAME - 1_024
            )
              count--;
            if (!count && index < batches)
              throw error(
                'BAD_REQUEST',
                'The guard metadata is too large; read fewer tabs and retry the command.',
              );
            const result = await extensionRequest('guard', params(), 15_000);
            access = requireGuardAccess(result.access);
            index += count;
          } while (index < batches);
          assertRequestActive();
        };
        if (command === 'restart') {
          const reloadExtension = optionalBoolean(body.reloadExtension, 'reloadExtension') ?? true;
          if (reloadExtension) router.event('reload_extension');
          send(200, {
            ok: true,
            text: reloadExtension ? 'The extension is restarting.' : 'The helper is restarting.',
          });
          setTimeout(() => void stop(), 100);
          return;
        }
        if (command === 'status') {
          return send(200, {
            ok: true,
            data: {
              connected: router.connected,
              version: VERSION,
              protocol: PROTOCOL_VERSION,
              extensionVersion: extensionDiskVersion(home),
              extensionRevision: router.extensionRevision,
            },
          });
        }
        if (command === 'tabs') {
          body.match = boundedText(body.match, 'match', MAX_SEARCH_CHARS);
          body.since = optionalText(body.since, 'since');
          const parsedSince = body.since === undefined ? undefined : parseDuration(body.since);
          if (body.sinceMs !== undefined) {
            body.sinceMs = integerParam(body.sinceMs, 'since', 0, 0);
            if (parsedSince !== undefined && body.sinceMs !== parsedSince)
              throw error('BAD_REQUEST', 'The since and sinceMs filters must agree.');
          } else if (parsedSince !== undefined) body.sinceMs = parsedSince;
          body.window = windowParam(body.window);
          body.active = optionalBoolean(body.active, 'active');
          const offset = integerParam(body.offset, 'offset', 0, 0);
          const limit = integerParam(body.limit, 'limit', 50, 1, 200);
          const maxChars = responseCap(body);
          const textCap = responseTextCap(body);
          const result = await extensionRequest('tabs', body);
          assertRequestActive();
          const tabs = result.tabs as TabInfo[];
          const selected = filterTabs(
            tabs,
            { match: body.match, sinceMs: body.sinceMs, window: body.window, active: body.active },
            result.frontWindowId,
          );
          const visible = selected.slice(offset, offset + limit);
          const render = () => {
            const end = offset + visible.length;
            const next = end < selected.length ? tabsCommand(end, body, commandBrowser) : undefined;
            return (
              [
                ...visible.map(formatTabLine),
                `${Math.min(end, selected.length)} of ${selected.length} tabs${result.hidden ? ` · ${result.hidden} hidden by denylist` : ''}`,
              ].join('\n') + (next ? `\n\nmore: ${next}` : '')
            );
          };
          let text = render();
          while (visible.length && jsonTextSize(text) > textCap) {
            visible.pop();
            text = render();
          }
          if (!visible.length && offset < selected.length)
            text = withNext(
              'The character cap is too small to list a tab.',
              tabsCommand(
                offset,
                { ...body, maxChars: continuationMaxChars(maxCharsFor(body.maxChars)) },
                commandBrowser,
              ),
              textCap,
            );
          else text = capText(text, textCap).text;
          const payload = capResponse(
            {
              ok: true,
              text,
              data: {
                tabs: visible.map(compactTab),
                count: selected.length,
                hidden: result.hidden || 0,
                total: selected.length,
              },
            },
            maxChars,
          );
          await ensureActive(
            visible.map((tab) => tab.url),
            visible.map((tab) => ({
              id: tab.id,
              url: tab.url,
              documentEpoch: (tab as GuardedTabInfo).documentEpoch,
            })),
          );
          return send(200, payload);
        }
        const readOne = async (id: number, full = false, render = false) => {
          if (!Number.isSafeInteger(id))
            throw error('BAD_REQUEST', 'A tab id is required. Use cobrowser read <id>.');
          assertRequestActive();
          const tab = (await extensionRequest('tab', { id })) as GuardedTabInfo;
          assertRequestActive();
          const snapshotKey = `${id}:${tab.url}`;
          const key = `${snapshotKey}:${full ? 'full' : 'reader'}`;
          const now = Date.now();
          pruneCache(cache, now);
          const cached =
            tab.discarded || tab.status === 'unloaded' || tab.status === 'loading'
              ? undefined
              : cache.get(key);
          let page: ConvertedPage;
          let sourceUrls: string[] = [];
          let documentEpoch: string;
          let reloaded = false;
          if (
            cached &&
            now - cached.at < CACHE_TTL_MS &&
            cached.documentEpoch === requireDocumentEpoch(tab.documentEpoch)
          ) {
            page = cached.page;
            sourceUrls = cached.sourceUrls;
            documentEpoch = cached.documentEpoch;
          } else {
            let pending = pendingReads.get(snapshotKey);
            let loading = pending?.promise;
            if (!loading) {
              const token = {};
              const expectsReload =
                tab.discarded || tab.status === 'unloaded' || tab.status === 'loading';
              if (expectsReload) expectedReloads.add(token);
              loading = (async (): Promise<LoadedSnapshot> => {
                let snapshot: LoadedSnapshot['snapshot'];
                try {
                  snapshot = (await extensionRequest(
                    'read',
                    { id },
                    20_000,
                  )) as LoadedSnapshot['snapshot'];
                  requireDocumentEpoch(snapshot.documentEpoch);
                } finally {
                  expectedReloads.delete(token);
                }
                return { snapshot, reloaded: Boolean(snapshot.reloaded) };
              })();
              pending = { promise: loading, token };
              pendingReads.set(snapshotKey, pending);
              void loading.then(
                () => {
                  if (pendingReads.get(snapshotKey) === pending) pendingReads.delete(snapshotKey);
                },
                () => {
                  if (pendingReads.get(snapshotKey) === pending) pendingReads.delete(snapshotKey);
                },
              );
            }
            const loadedSnapshot = await loading;
            assertRequestActive();
            if (pending && invalidatedReads.has(pending.token))
              throw error('TIMEOUT', 'The tab changed while it was being read. Try again.');
            page = loadedSnapshot.snapshot.special
              ? convertSpecialSnapshot(loadedSnapshot.snapshot)
              : convertSnapshot(loadedSnapshot.snapshot, full);
            sourceUrls = loadedSnapshot.snapshot.special?.sourceUrls ?? [];
            documentEpoch = loadedSnapshot.snapshot.documentEpoch;
            reloaded = loadedSnapshot.reloaded;
            assertRequestActive();
            if (pending && invalidatedReads.has(pending.token))
              throw error('TIMEOUT', 'The tab changed while it was being read. Try again.');
            cache.set(key, {
              page,
              sourceUrls,
              documentEpoch,
              at: Date.now(),
              bytes:
                pageCacheBytes(page) +
                sourceUrls.reduce((sum, url) => sum + Buffer.byteLength(url, 'utf8'), 0),
            });
            pruneCache(cache);
          }
          assertRequestActive();
          const note = [page.note, reloaded ? 'page was asleep and has been reloaded' : undefined]
            .filter(Boolean)
            .join('\n');
          return {
            id,
            tab,
            page,
            sourceUrls,
            documentEpoch,
            reloaded,
            note,
            rendered: render ? formatRead(tab, page, body, note, commandBrowser) : undefined,
          };
        };
        if (command === 'read') {
          if (Array.isArray(body.ids) && body.ids.length > MAX_READ_TABS)
            throw error('BAD_REQUEST', `Read at most ${MAX_READ_TABS} tabs at a time.`);
          const ids = Array.isArray(body.ids)
            ? body.ids.map((value: unknown) => numericParam(value, 'tab id'))
            : [numericParam(body.id, 'tab id')];
          if (!ids.length || ids.some((id: number) => !Number.isSafeInteger(id)))
            throw error('BAD_REQUEST', 'A tab id is required. Use cobrowser read <id>.');
          body.section = sectionParam(body.section);
          if (body.page !== undefined) body.page = integerParam(body.page, 'page', 1, 1);
          if (body.pageSize !== undefined)
            body.pageSize = integerParam(body.pageSize, 'pageSize', 1, 1);
          body.full = optionalBoolean(body.full, 'full');
          body.links = optionalBoolean(body.links, 'links');
          const maxChars = responseCap(body);
          const textCap = responseTextCap(body);
          const items: Array<{
            id: number;
            data: Record<string, unknown>;
            url: string;
            chars: number;
          }> = [];
          const guardUrls: string[] = [];
          const guardTabs: GuardTab[] = [];
          let text = '';
          let remaining: string | undefined;
          for (let index = 0; index < ids.length; index++) {
            if (index > 0 && continuationCommand(text)) {
              remaining = readCommand(ids.slice(index), body, commandBrowser);
              break;
            }
            const item = await readOne(ids[index], body.full === true, true);
            const rendered = item.rendered!;
            const candidate = text ? `${text}\n\n${rendered.text}` : rendered.text;
            if (jsonTextSize(candidate) > textCap) {
              remaining = readCommand(ids.slice(index), body, commandBrowser);
              break;
            }
            // Keep only response metadata after each converted page is rendered.
            items.push({
              id: item.id,
              data: pageData(item.page, rendered.pages),
              url: safeUrl(item.page.url),
              chars: rendered.text.length,
            });
            guardUrls.push(item.page.url, ...item.sourceUrls);
            guardTabs.push({ id: item.id, url: item.page.url, documentEpoch: item.documentEpoch });
            text = candidate;
          }
          if (remaining && continuationCommand(text) !== remaining) {
            const combined = withAdditionalNext(text, remaining, textCap);
            const original = text.replace(/\n\n(?:next|more): [^\n]+$/, '');
            if (combined !== undefined && combined.startsWith(original)) text = combined;
            else
              text = withNext(
                '',
                readCommand(
                  ids,
                  { ...body, maxChars: continuationMaxChars(maxCharsFor(body.maxChars)) },
                  commandBrowser,
                ),
                textCap,
              );
          } else text = capText(text, textCap).text;
          await ensureActive(guardUrls, guardTabs);
          for (const item of items)
            await recordRead({
              time: new Date().toISOString(),
              browser,
              agent: requestAgent(request.headers['x-cobrowser-agent']),
              command: 'read',
              tabId: item.id,
              url: item.url,
              chars: item.chars,
            });
          await ensureActive(guardUrls, guardTabs);
          return send(
            200,
            capResponse(
              {
                ok: true,
                text,
                data:
                  ids.length === 1
                    ? items[0].data
                    : items.map((item) => ({ tabId: item.id, ...item.data })),
              },
              maxChars,
            ),
          );
        }
        if (command === 'find') {
          const id = numericParam(body.id, 'tab id');
          const query = (boundedText(body.query, 'query', MAX_SEARCH_CHARS) || '').trim();
          if (!query) throw error('BAD_REQUEST', 'A search phrase is required.');
          const maxChars = maxCharsFor(body.maxChars);
          const textCap = responseTextCap(body);
          const item = await readOne(id);
          const matches = findInMarkdown(readBody(item.page.markdown, {}), query);
          const text = matches.length
            ? matches
                .map(
                  (match, index) => `${index + 1}. [${match.section}] ${pdfSafeText(match.line)}`,
                )
                .join('\n')
            : `No matches for ${JSON.stringify(query)}.`;
          await ensureActive(
            [item.page.url, ...item.sourceUrls],
            [{ id, url: item.page.url, documentEpoch: item.documentEpoch }],
          );
          await recordRead({
            time: new Date().toISOString(),
            browser,
            agent: requestAgent(request.headers['x-cobrowser-agent']),
            command: 'find',
            tabId: id,
            url: safeUrl(item.page.url),
            chars: text.length,
          });
          await ensureActive(
            [item.page.url, ...item.sourceUrls],
            [{ id, url: item.page.url, documentEpoch: item.documentEpoch }],
          );
          return send(
            200,
            capResponse(
              {
                ok: true,
                text: capText(
                  text,
                  textCap,
                  findCommand(id, query, maxChars, commandBrowser),
                  'next',
                ).text,
                data: { matches },
              },
              responseCap(body),
            ),
          );
        }
        if (command === 'query') {
          const id = numericParam(body.id, 'tab id');
          if (!Number.isSafeInteger(id))
            throw error(
              'BAD_REQUEST',
              'A tab id is required. Use cobrowser query <id> <selector>.',
            );
          const selector = boundedText(body.selector, 'selector', MAX_SELECTOR_CHARS) || '';
          if (!selector.trim()) throw error('BAD_REQUEST', 'A CSS selector is required.');
          const html = optionalBoolean(body.html, 'html') || false;
          const limit = integerParam(body.limit, 'limit', 20, 1, 100);
          const maxChars = maxCharsFor(body.maxChars);
          const textCap = responseTextCap(body);
          const offset = integerParam(body.offset, 'offset', 0, 0);
          const tab = (await extensionRequest('tab', { id })) as TabInfo;
          const result = await extensionRequest(
            'query',
            {
              id,
              selector,
              html,
              limit,
              offset,
            },
            20_000,
          );
          assertRequestActive();
          const values = Array.isArray(result?.values)
            ? result.values.map((value: unknown) => redactEmbeddedUrls(pdfSafeText(String(value))))
            : undefined;
          const output =
            typeof result?.text === 'string'
              ? result.text
              : values
                  ?.map((value: string, index: number) => `${index + 1}. ${value}`)
                  .join('\n\n') || '';
          const hasMore = result?.hasMore === true;
          let text =
            output || (offset ? 'No more query text.' : 'No elements matched the selector.');
          let nextOffset: number | undefined;
          if (hasMore || jsonTextSize(text) > textCap) {
            const reserve = queryCommand(
              id,
              selector,
              { ...body, html, offset: Number.MAX_SAFE_INTEGER },
              maxChars,
              commandBrowser,
            );
            const budget = textCap - jsonTextSize(`\n\nnext: ${reserve}`);
            const fragment = capText(output, Math.max(0, budget)).text;
            if (fragment) {
              nextOffset = offset + fragment.length;
              text = withNext(
                fragment,
                queryCommand(
                  id,
                  selector,
                  { ...body, html, offset: nextOffset },
                  maxChars,
                  commandBrowser,
                ),
                textCap,
              );
            } else {
              text = withNext(
                '',
                queryCommand(
                  id,
                  selector,
                  { ...body, html, offset },
                  continuationMaxChars(maxChars),
                  commandBrowser,
                ),
                textCap,
              );
            }
          }
          await ensureActive(
            [result?.url || tab.url],
            [
              {
                id,
                url: result?.url || tab.url,
                documentEpoch: requireDocumentEpoch(result.documentEpoch),
              },
            ],
          );
          await recordRead({
            time: new Date().toISOString(),
            browser,
            agent: requestAgent(request.headers['x-cobrowser-agent']),
            command: 'query',
            tabId: id,
            url: safeUrl(result?.url || tab.url),
            chars: text.length,
          });
          await ensureActive(
            [result?.url || tab.url],
            [
              {
                id,
                url: result?.url || tab.url,
                documentEpoch: requireDocumentEpoch(result.documentEpoch),
              },
            ],
          );
          return send(
            200,
            capResponse(
              {
                ok: true,
                text,
                data: {
                  values: nextOffset === undefined && !hasMore ? values : undefined,
                  offset,
                  nextOffset,
                },
              },
              responseCap(body),
            ),
          );
        }
        if (command === 'selection') {
          const id = body.id === undefined ? undefined : numericParam(body.id, 'tab id');
          const maxChars = maxCharsFor(body.maxChars);
          const textCap = responseTextCap(body);
          const result = await extensionRequest(
            'selection',
            id === undefined ? {} : { id },
            20_000,
          );
          assertRequestActive();
          const text = redactEmbeddedUrls(
            pdfSafeText(typeof result.text === 'string' ? result.text : '(no text is selected)'),
          );
          const safeResult = {
            tabId:
              typeof result.tabId === 'number' && Number.isSafeInteger(result.tabId)
                ? result.tabId
                : undefined,
            url: safeUrl(result.url),
            text,
          };
          await ensureActive(
            [result.url],
            safeResult.tabId === undefined
              ? []
              : [
                  {
                    id: safeResult.tabId,
                    url: result.url,
                    documentEpoch: requireDocumentEpoch(result.documentEpoch),
                  },
                ],
          );
          await recordRead({
            time: new Date().toISOString(),
            browser,
            agent: requestAgent(request.headers['x-cobrowser-agent']),
            command: 'selection',
            tabId: safeResult.tabId,
            url: safeResult.url,
            chars: text.length,
          });
          await ensureActive(
            [result.url],
            safeResult.tabId === undefined
              ? []
              : [
                  {
                    id: safeResult.tabId,
                    url: result.url,
                    documentEpoch: requireDocumentEpoch(result.documentEpoch),
                  },
                ],
          );
          return send(
            200,
            capResponse(
              {
                ok: true,
                text: capText(
                  text,
                  textCap,
                  selectionCommand(safeResult.tabId, maxChars, commandBrowser),
                  'next',
                ).text,
                data: safeResult,
              },
              responseCap(body),
            ),
          );
        }
        if (command === 'screenshot') {
          const windowId =
            body.windowId === undefined ? undefined : numericParam(body.windowId, 'window id');
          const result = await extensionRequest(
            'screenshot',
            windowId === undefined ? {} : { windowId },
            20_000,
          );
          assertRequestActive();
          const safeResult = {
            windowId:
              typeof result.windowId === 'number' && Number.isSafeInteger(result.windowId)
                ? result.windowId
                : undefined,
            tabId:
              typeof result.tabId === 'number' && Number.isSafeInteger(result.tabId)
                ? result.tabId
                : undefined,
            title: oneLine(result.title),
            url: safeUrl(result.url),
            dataUrl: typeof result.dataUrl === 'string' ? result.dataUrl : '',
          };
          const maxChars = maxCharsFor(body.maxChars);
          const metadata = { ...safeResult, dataUrl: undefined };
          let payload = capResponse({ ok: true, text: '', data: safeResult }, maxChars);
          if (!(payload.data as Record<string, unknown> | undefined)?.dataUrl)
            payload = capResponse(
              {
                ok: true,
                text: `The screenshot was omitted because it exceeds the response cap; use a larger maxChars value up to ${MAX_SCREENSHOT_CHARS}.`,
                data: metadata,
              },
              maxChars,
            );
          await ensureActive(
            [result.url],
            safeResult.tabId === undefined
              ? []
              : [
                  {
                    id: safeResult.tabId,
                    url: result.url,
                    documentEpoch: requireDocumentEpoch(result.documentEpoch),
                  },
                ],
          );
          await recordRead({
            time: new Date().toISOString(),
            browser,
            agent: requestAgent(request.headers['x-cobrowser-agent']),
            command: 'screenshot',
            tabId: safeResult.tabId,
            url: safeResult.url,
            chars: 0,
          });
          await ensureActive(
            [result.url],
            safeResult.tabId === undefined
              ? []
              : [
                  {
                    id: safeResult.tabId,
                    url: result.url,
                    documentEpoch: requireDocumentEpoch(result.documentEpoch),
                  },
                ],
          );
          return send(200, payload);
        }
        if (command === 'log') {
          const limit = integerParam(body.limit, 'limit', 20, 1, 200);
          const maxChars = maxCharsFor(body.maxChars);
          const textCap = responseTextCap(body);
          await extensionRequest('tabs', {});
          assertRequestActive();
          let entries: Record<string, unknown>[] = [];
          for (const file of [readsLog, `${readsLog}.1`]) {
            if (entries.length >= limit) break;
            try {
              const lines = (await fsp.readFile(file, 'utf8')).split('\n');
              for (let index = lines.length - 1; index >= 0 && entries.length < limit; index--) {
                if (!lines[index]) continue;
                try {
                  const entry = JSON.parse(lines[index]);
                  const normalized = safeLogEntry(entry);
                  if (normalized) entries.push(normalized);
                } catch {
                  /* A partial or corrupt line should not hide older valid reads. */
                }
              }
            } catch {
              /* A missing or unreadable log file should not hide another valid one. */
            }
          }
          const text =
            entries
              .map(
                (entry) =>
                  `${oneLine(entry.time)} ${oneLine(entry.browser || browser, 80)} ${oneLine(entry.agent || 'unknown', 120)} ${oneLine(entry.command)} tab ${oneLine(entry.tabId ?? '-', 32)}${entry.url ? ` ${oneLine(entry.url)}` : ''}`,
              )
              .join('\n') || 'No reads yet.';
          await ensureActive(
            entries.flatMap((entry) => (typeof entry.url === 'string' ? [entry.url] : [])),
          );
          return send(
            200,
            capResponse(
              {
                ok: true,
                text: capText(text, textCap, logCommand(limit, maxChars, commandBrowser), 'next')
                  .text,
                data: entries,
              },
              responseCap(body),
            ),
          );
        }
        throw error('BAD_REQUEST', 'Unknown cobrowser command. Use a supported cobrowser command.');
      } catch (error: any) {
        const code = normalizeErrorCode(error?.code, 'BAD_REQUEST');
        const message = oneLine(error?.message || 'The cobrowser request failed.', 500);
        let maxChars = MAX_CHARS;
        try {
          maxChars = responseCap(body);
        } catch {
          /* Keep the full useful error when the requested cap is itself invalid. */
        }
        send(
          code === 'BAD_REQUEST' ? 400 : 500,
          capResponse({ ok: false, error: { code, message } }, maxChars),
        );
      }
    });
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 32;
  server.on('error', (error) => {
    logger.write(`socket error: ${error instanceof Error ? error.message : String(error)}`);
    void stop(1);
  });
  return server;
}

interface SocketIdentity {
  dev: bigint;
  ino: bigint;
}

function socketIdentity(socketPath: string): SocketIdentity | undefined {
  try {
    const stat = fs.lstatSync(socketPath, { bigint: true });
    return stat.isSocket() ? { dev: stat.dev, ino: stat.ino } : undefined;
  } catch {
    return undefined;
  }
}

function unlinkOwnedSocket(socketPath: string, owned: SocketIdentity | undefined) {
  if (!owned) return;
  const current = socketIdentity(socketPath);
  if (current?.dev !== owned.dev || current.ino !== owned.ino) return;
  try {
    fs.unlinkSync(socketPath);
  } catch {
    /* Another helper may have already removed the socket. */
  }
}

async function run() {
  const home = homeDir();
  const browser = browserName();
  await fsp.mkdir(path.join(home, 'run'), { recursive: true, mode: 0o700 });
  await fsp.mkdir(path.join(home, 'logs'), { recursive: true, mode: 0o700 });
  await fsp.chmod(path.join(home, 'run'), 0o700);
  await fsp.chmod(path.join(home, 'logs'), 0o700);
  const logger = new Logger(logFile(home, browser));
  const socketPath = path.join(home, 'run', `${browser}.sock`);
  if (Buffer.byteLength(socketPath, 'utf8') >= 104)
    throw new Error(
      'The cobrowser home path is too long for a Unix socket. Set COBROWSER_HOME to a shorter path and try again.',
    );
  if (fs.existsSync(socketPath)) {
    const staleSocket = socketIdentity(socketPath);
    const alive = await new Promise<boolean>((resolve) => {
      const socket = net.createConnection(socketPath);
      let settled = false;
      let timer: NodeJS.Timeout | undefined;
      const done = (value: boolean) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        socket.destroy();
        resolve(value);
      };
      socket.once('connect', () => done(true));
      socket.once('error', () => done(false));
      timer = setTimeout(() => done(false), 250);
    });
    if (alive) {
      logger.write('another helper is running');
      return;
    }
    unlinkOwnedSocket(socketPath, staleSocket);
  }
  const router = new ExtensionRouter(
    extensionDiskVersion(home),
    extensionBuildRevision(path.join(home, 'extension')),
  );
  const cache = new Map<string, CacheEntry>();
  const pendingReads = new Map<string, PendingRead>();
  const invalidatedReads = new WeakSet<object>();
  const expectedReloads = new WeakSet<object>();
  const invalidateTab = (tabId: number, expectedReloadEvent = false) => {
    for (const key of cache.keys()) if (key.startsWith(`${tabId}:`)) cache.delete(key);
    for (const [key, pending] of pendingReads) {
      if (!key.startsWith(`${tabId}:`)) continue;
      if (expectedReloadEvent && expectedReloads.has(pending.token)) continue;
      invalidatedReads.add(pending.token);
      pendingReads.delete(key);
    }
  };
  router.onEvent = (event, data) => {
    if (event === 'tab_created' || event === 'tab_changed' || event === 'tab_closed') {
      const tabId = Number(data?.tabId);
      if (Number.isSafeInteger(tabId) && tabId >= 0) invalidateTab(tabId, event === 'tab_changed');
    }
  };
  let server: http.Server | undefined;
  let ownedSocket: SocketIdentity | undefined;
  let stopping = false;
  const readsLog = path.join(home, 'logs', 'reads.jsonl');
  let readLogQueue: Promise<void> = Promise.resolve();
  const appendLog = (entry: Record<string, unknown>) => {
    readLogQueue = readLogQueue
      .catch(() => undefined)
      .then(async () => {
        try {
          const existing = await fsp.stat(readsLog).catch(() => undefined);
          if (existing && existing.size > MAX_READ_LOG_BYTES) {
            await fsp.rm(`${readsLog}.1`, { force: true });
            await fsp.rename(readsLog, `${readsLog}.1`);
          }
          await fsp.appendFile(readsLog, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
          await fsp.chmod(readsLog, 0o600);
        } catch {
          /* logging must not break a read */
        }
      });
    return readLogQueue;
  };
  const recordRead = async (entry: Record<string, unknown>) => {
    const normalized: Record<string, unknown> = {
      ...entry,
      time: typeof entry.time === 'string' ? entry.time : new Date().toISOString(),
    };
    if (typeof normalized.url === 'string') normalized.url = safeUrl(normalized.url);
    await appendLog(normalized);
    router.event('read', {
      command: normalized.command,
      tabId: normalized.tabId,
      url: normalized.url,
      time: normalized.time,
    });
  };
  const stop = async (exitCode = 0) => {
    if (stopping) return;
    stopping = true;
    logger.write('helper shutting down');
    // Closing a Unix listener also unlinks its path, which may belong to a newer helper.
    unlinkOwnedSocket(socketPath, ownedSocket);
    process.exit(exitCode);
  };
  process.once('SIGINT', () => void stop(130));
  process.once('SIGTERM', () => void stop(143));
  const sendNative = (value: unknown) => {
    try {
      process.stdout.write(encodeFrame(value, MAX_HELPER_FRAME), (error) => {
        if (error) void stop();
      });
    } catch {
      void stop();
    }
  };
  process.stdout.on('error', () => void stop());
  const decoder = new NativeFrameDecoder(MAX_EXTENSION_FRAME);
  process.stdin.on('data', (chunk: Buffer) => {
    try {
      for (const message of decoder.push(chunk)) {
        router.handle(message as NativeMessage, logger);
      }
    } catch (error) {
      logger.write(`native input error: ${String(error)}`);
      void stop();
    }
  });
  router.setSender(sendNative);
  server = createHelperServer({
    browser,
    home,
    socketPath,
    router,
    cache,
    pendingReads,
    invalidatedReads,
    expectedReloads,
    readsLog,
    logger,
    appendLog,
    recordRead,
    stop,
  });
  server.listen(socketPath, () => {
    ownedSocket = socketIdentity(socketPath);
    try {
      fs.chmodSync(socketPath, 0o600);
    } catch {
      /* best effort on platforms without chmod */
    }
    logger.write(`listening on ${socketPath}`);
  });
  process.stdin.on('end', () => void stop());
  process.stdin.on('close', () => void stop());
}

run().catch((error) => {
  process.stderr.write(`${oneLine(error instanceof Error ? error.message : String(error), 500)}\n`);
  process.exit(1);
});
