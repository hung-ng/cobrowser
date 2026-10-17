import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { capText, splitPages } from './shared/paging.js';
import { filterTabs, siteForUrl, type TabInfo } from './shared/filters.js';
import { flattenSections, sectionOutline, type SectionNode } from './shared/sections.js';
import { MAX_CHARS, NATIVE_HOST, PROTOCOL_VERSION, VERSION } from './shared/constants.js';
import {
  NativeFrameDecoder,
  encodeFrame,
  MAX_EXTENSION_FRAME,
  MAX_HELPER_FRAME,
} from './shared/native.js';
import {
  convertSnapshot,
  plainLinks,
  type ConvertedPage,
  type PageSnapshot,
} from './shared/read.js';

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

function homeDir(): string {
  return process.env.COBROWSER_HOME || path.join(os.homedir(), '.cobrowser');
}
function browserName(): string {
  const i = process.argv.indexOf('--browser');
  return i >= 0 ? process.argv[i + 1] || 'chrome' : 'chrome';
}
function logFile(home: string, browser: string): string {
  return path.join(home, 'logs', `helper-${browser}.log`);
}

class Logger {
  constructor(private readonly file: string) {}
  write(message: string) {
    try {
      if (fs.existsSync(this.file) && fs.statSync(this.file).size > 1_000_000)
        fs.renameSync(this.file, `${this.file}.1`);
      fs.appendFileSync(this.file, `${new Date().toISOString()} ${message}\n`);
    } catch {
      /* logging must not break the helper */
    }
  }
}

class ExtensionRouter {
  private nextId = 1;
  private pending = new Map<
    number,
    { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
  >();
  private sendNative: ((value: unknown) => void) | undefined;
  onEvent: ((event: string, data: any) => void) | undefined;
  connected = false;
  setSender(send: (value: unknown) => void) {
    this.sendNative = send;
    this.connected = true;
  }
  disconnected() {
    this.connected = false;
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
    if (message.event) {
      if (message.event === 'hello') {
        logger.write('extension connected');
        this.sendNative?.({
          event: 'hello_ack',
          data: { version: VERSION, protocol: PROTOCOL_VERSION },
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
            message.error?.message ||
              'The extension returned an error. Restart the browser and try again.',
          ),
          {
            code: message.error?.code || 'EXTENSION_DISCONNECTED',
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
}

interface CacheEntry {
  page: ConvertedPage;
  at: number;
}

function formatTabLine(tab: TabInfo): string {
  const marker = `${tab.active ? '*' : ' '} ${tab.discarded ? 'z' : ' '}`;
  const title = (tab.title || '(untitled)').replace(/\s+/g, ' ').slice(0, 60);
  return `${tab.id} ${marker} ${siteForUrl(tab.url).padEnd(18)} ${title}`.trimEnd();
}

function commandArg(value: unknown): string {
  const text = String(value);
  return /^[a-zA-Z0-9._/:=-]+$/.test(text) ? text : JSON.stringify(text);
}

function pageCommand(
  tabId: number,
  section: string | undefined,
  page: number,
  params: RequestBody,
): string {
  const args = ['cobrowser', 'read', String(tabId)];
  if (section !== undefined) args.push('--section', section);
  args.push('--page', String(page));
  if (params.full) args.push('--full');
  if (params.links) args.push('--links');
  if (params.maxChars !== undefined) args.push('--max-chars', commandArg(params.maxChars));
  return args.join(' ');
}

function sectionCommand(tabId: number, section: string, params: RequestBody): string {
  const args = ['cobrowser', 'read', String(tabId), '--section', section];
  if (params.full) args.push('--full');
  if (params.links) args.push('--links');
  if (params.maxChars !== undefined) args.push('--max-chars', commandArg(params.maxChars));
  return args.join(' ');
}

function tabsCommand(offset: number, params: RequestBody): string {
  const args = ['cobrowser', 'tabs'];
  if (params.match) args.push('--match', commandArg(params.match));
  if (params.since) args.push('--since', commandArg(params.since));
  if (params.window !== undefined) args.push('--window', commandArg(params.window));
  if (params.active) args.push('--active');
  if (params.limit !== undefined) args.push('--limit', commandArg(params.limit));
  args.push('--offset', String(offset));
  if (params.maxChars !== undefined) args.push('--max-chars', commandArg(params.maxChars));
  return args.join(' ');
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
): string {
  const noteText = note ? `\n\n${note}` : '';
  let budget = Math.max(1, cap - prefix.length - noteText.length - 80);
  let pages: string[] = [];
  for (let attempt = 0; attempt < 12; attempt++) {
    pages = splitPages(text, budget);
    const nextCommand = pageCommand(tabId, section, Math.max(2, pages.length), params);
    const nextLength = `\n\nnext: ${nextCommand}`.length;
    const nextBudget = Math.max(1, cap - prefix.length - noteText.length - nextLength);
    if (nextBudget === budget) break;
    budget = nextBudget;
  }
  const start = pageNumber === undefined ? 0 : pageNumber - 1;
  if (start < 0 || start >= pages.length)
    throw Object.assign(
      new Error(`Page ${pageNumber} was not found. Choose a page from the previous response.`),
      { code: 'BAD_REQUEST' },
    );
  const next =
    start + 1 < pages.length ? pageCommand(tabId, section, start + 2, params) : undefined;
  const base = `${prefix}${pages[start]}${noteText}`;
  if (!next) return capText(base, cap).text;
  return withNext(base, next, cap);
}

function withNext(text: string, command: string, cap: number): string {
  const rendered = `${text}\n\nnext: ${command}`;
  return rendered.length <= cap ? rendered : capText(text, cap, command, 'next').text;
}

function readBody(markdown: string, params: RequestBody): string {
  return params.links ? markdown : plainLinks(markdown);
}

function maxCharsFor(value: unknown): number {
  if (value === undefined) return MAX_CHARS;
  const result = Number(value);
  if (!Number.isInteger(result) || result < 1)
    throw Object.assign(new Error('Use a positive character limit such as 20000.'), {
      code: 'BAD_REQUEST',
    });
  return result;
}

function formatRead(
  tab: TabInfo,
  page: ConvertedPage,
  params: RequestBody,
  note = page.note || '',
): string {
  const sections = flattenSections(page.sections);
  const sectionCount = sections.some((section) => section.level > 0) ? sections.length : 0;
  const header = `## ${tab.id} · ${siteForUrl(page.url)} · ${tab.title || page.title}\n${page.url}\n${page.words.toLocaleString()} words · ${sectionCount} sections`;
  const cap = maxCharsFor(params.maxChars);
  const prefix = `${header}\n\n`;
  const sectionNumber = params.section === undefined ? undefined : String(params.section);
  const requestedPage = params.page === undefined ? undefined : Number(params.page);
  if (requestedPage !== undefined && (!Number.isInteger(requestedPage) || requestedPage < 1))
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
    );
  }

  if (requestedPage !== undefined) {
    return pagedText(
      readBody(page.markdown, params),
      cap,
      prefix,
      note,
      tab.id,
      undefined,
      params,
      requestedPage,
    );
  }

  if (page.words <= 1500) {
    const body = readBody(page.markdown, params);
    const next = pageCommand(tab.id, undefined, 1, params);
    return capText(`${prefix}${body}${note ? `\n\n${note}` : ''}`, cap, next, 'next').text;
  }

  const outline = sectionOutline(page.sections);
  const hasHeadings = page.sections.some((section) => section.level > 0);
  if (!hasHeadings) {
    const pages = splitPages(page.markdown, Math.max(1, cap - prefix.length - 80));
    return withNext(
      `${prefix}${pages.length} pages${note ? `\n\n${note}` : ''}`,
      pageCommand(tab.id, undefined, 1, params),
      cap,
    );
  }
  const firstSection = page.sections[0]?.number;
  const next =
    firstSection === undefined
      ? pageCommand(tab.id, undefined, 1, params)
      : sectionCommand(tab.id, firstSection, params);
  return withNext(`${prefix}${outline}${note ? `\n\n${note}` : ''}`, next, cap);
}

function compactTab(tab: TabInfo): Record<string, unknown> {
  return {
    id: tab.id,
    windowId: tab.windowId,
    active: tab.active,
    title: tab.title.slice(0, 60),
    url: tab.url.slice(0, 200),
    lastAccessed: tab.lastAccessed,
    openedAt: tab.openedAt,
    discarded: tab.discarded,
  };
}

function pageData(page: ConvertedPage): Record<string, unknown> {
  return {
    url: page.url,
    title: page.title,
    words: page.words,
    sections: flattenSections(page.sections).map(({ number, title, level, words }) => ({
      number,
      title,
      level,
      words,
    })),
    pages: page.pages.length,
    note: page.note,
  };
}

function boundedResponse(payload: Record<string, unknown>, maxChars: number) {
  if (JSON.stringify(payload).length <= maxChars) return payload;
  if (payload.data !== undefined) {
    const withoutData = { ...payload };
    delete withoutData.data;
    return withoutData;
  }
  return payload;
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
  if (socketPath.length >= 104)
    throw new Error(
      'The cobrowser home path is too long for a Unix socket. Set COBROWSER_HOME to a shorter path and try again.',
    );
  if (fs.existsSync(socketPath)) {
    const alive = await new Promise<boolean>((resolve) => {
      const socket = net.createConnection(socketPath);
      const done = (value: boolean) => {
        socket.destroy();
        resolve(value);
      };
      socket.once('connect', () => done(true));
      socket.once('error', () => done(false));
      setTimeout(() => done(false), 250);
    });
    if (alive) {
      logger.write('another helper is running');
      return;
    }
    await fsp.unlink(socketPath).catch(() => undefined);
  }
  const router = new ExtensionRouter();
  const cache = new Map<string, CacheEntry>();
  router.onEvent = (event, data) => {
    if (event === 'tab_changed' || event === 'tab_closed') {
      for (const key of cache.keys()) if (key.startsWith(`${data?.tabId}:`)) cache.delete(key);
    }
  };
  let server: http.Server | undefined;
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    logger.write('helper shutting down');
    server?.close();
    await fsp.unlink(socketPath).catch(() => undefined);
    process.exit(0);
  };
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
  server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    request.on('end', async () => {
      const send = (status: number, payload: unknown) => {
        const body = JSON.stringify(payload);
        response.writeHead(status, {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
        });
        response.end(body);
      };
      try {
        const body: RequestBody = chunks.length
          ? JSON.parse(Buffer.concat(chunks).toString('utf8'))
          : {};
        if (request.method !== 'POST' || !request.url?.startsWith('/v1/'))
          return send(404, {
            ok: false,
            error: { code: 'BAD_REQUEST', message: 'Unknown cobrowser command. Use tabs or read.' },
          });
        const command = request.url.slice('/v1/'.length).split('?')[0];
        if (command === 'tabs') {
          const result = await router.request('tabs', body);
          const tabs = result.tabs as TabInfo[];
          const selected = filterTabs(
            tabs,
            { match: body.match, sinceMs: body.sinceMs, window: body.window, active: body.active },
            result.frontWindowId,
          );
          const offset = Math.max(0, Number(body.offset) || 0);
          const limit = Math.max(1, Math.min(200, Number(body.limit) || 50));
          const visible = selected.slice(offset, offset + limit);
          const nextCommand = tabsCommand(offset + limit, body);
          const rawText = [
            ...visible.map(formatTabLine),
            `${Math.min(offset + visible.length, selected.length)} of ${selected.length} tabs${result.hidden ? ` · ${result.hidden} hidden by denylist` : ''}${offset + visible.length < selected.length ? ` · more: ${nextCommand}` : ''}`,
          ].join('\n');
          const maxChars = maxCharsFor(body.maxChars);
          const text = capText(rawText, maxChars, nextCommand).text;
          const payload = boundedResponse(
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
          return send(200, payload);
        }
        if (command === 'read') {
          const id = Number(body.id);
          if (!Number.isInteger(id))
            throw Object.assign(new Error('A tab id is required. Use cobrowser read <id>.'), {
              code: 'BAD_REQUEST',
            });
          const tab = (await router.request('tab', { id })) as TabInfo;
          const full = Boolean(body.full);
          const key = `${id}:${tab.url}:${full ? 'full' : 'reader'}`;
          const cached = cache.get(key);
          let page: ConvertedPage;
          let reloaded = false;
          if (cached && Date.now() - cached.at < 600_000) page = cached.page;
          else {
            const snapshot = (await router.request('read', { id }, 20_000)) as PageSnapshot;
            page = convertSnapshot(snapshot, full);
            reloaded = Boolean(snapshot.reloaded);
            cache.set(key, { page, at: Date.now() });
          }
          const note = [page.note, reloaded ? 'page was asleep and has been reloaded' : undefined]
            .filter(Boolean)
            .join('\n');
          const text = formatRead(tab, page, body, note);
          const maxChars = maxCharsFor(body.maxChars);
          try {
            await fsp.appendFile(
              path.join(home, 'logs', 'reads.jsonl'),
              `${JSON.stringify({ time: new Date().toISOString(), browser, agent: request.headers['x-cobrowser-agent'] || 'unknown', command: 'read', tabId: id, url: page.url, chars: text.length })}\n`,
            );
          } catch {
            /* the read still succeeds if logging fails */
          }
          return send(200, boundedResponse({ ok: true, text, data: pageData(page) }, maxChars));
        }
        throw Object.assign(new Error('Unknown cobrowser command. Use tabs or read.'), {
          code: 'BAD_REQUEST',
        });
      } catch (error: any) {
        const code = error?.code || 'BAD_REQUEST';
        const message = error?.message || 'The cobrowser request failed.';
        send(code === 'BAD_REQUEST' ? 400 : 500, { ok: false, error: { code, message } });
      }
    });
  });
  router.setSender(sendNative);
  server!.listen(socketPath, () => {
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
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
