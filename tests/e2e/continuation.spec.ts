import { test, expect } from '@playwright/test';
import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { request } from 'node:http';
import path from 'node:path';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { promisify } from 'node:util';
import { encodeFrame, NativeFrameDecoder } from '../../src/shared/native.js';

const exec = promisify(execFile);
const root = path.resolve(import.meta.dirname, '../..');
const plain = Array.from({ length: 80 }, (_, i) => `token${String(i).padStart(3, '0')}`).join(' ');
const large = 'A'.repeat(50_000) + 'TAIL_MARKER';
const queryValues = [
  large,
  '\n"\\😀 '.repeat(250),
  'https://user:secret@example.test/path',
  'LAST_ELEMENT',
];
const linkHtml = `<html><body><pre><code>const x = "[name](type)";</code></pre>
<p>Use <code>[inline](type)</code> and <code>\`[ticks](type)\`</code>.</p>
<p><a href="https://example.test/a_(b)">Alpha</a> and
<a href="https://example.test/nested">Label [extra]</a> and
<a href="https://example.test/title_(nested)" title="A title (with parentheses)">Titled</a>.</p></body></html>`;
const sectionText = '😀"\\'.repeat(40);
const nestedListHtml = `<html><body><ol><li>Outer<ul><li>
<a href="https://example.test/nested-list">Inner</a><ul><li>
<a href="https://example.test/deep-list">Deep</a></li></ul></li></ul>
<p>Continuation <a href="https://example.test/list-continuation">More</a></p>
<pre><code>[literal](type)</code></pre></li></ol></body></html>`;
const htmlForTab = new Map([
  [43, '<html><body><p>SECONDONLY</p></body></html>'],
  [44, linkHtml],
  [
    45,
    `<html><body><h1>Selected</h1><p>${sectionText}</p><h1>Other</h1><p>Other body.</p></body></html>`,
  ],
  [46, nestedListHtml],
  [47, `<html><body><p>${plain} --help --json --max-chars</p></body></html>`],
]);
let home = '';
let helper: ChildProcessWithoutNullStreams;
let nativeReplyLengths: number[] = [];
const tabs = new Map([
  [
    42,
    {
      id: 42,
      windowId: 1,
      active: false,
      url: 'https://example.test/plain',
      title: 'Plain',
      status: 'complete',
    },
  ],
  [
    43,
    {
      id: 43,
      windowId: 1,
      active: true,
      url: 'https://example.test/query',
      title: 'Query',
      status: 'complete',
    },
  ],
  [
    763692891,
    {
      id: 763692891,
      windowId: 1,
      active: false,
      url: 'https://example.test/plain',
      title: 'Article title with metadata',
      status: 'complete',
    },
  ],
  [
    44,
    {
      id: 44,
      windowId: 1,
      active: false,
      url: 'https://example.test/links',
      title: 'Links',
      status: 'complete',
    },
  ],
  [
    45,
    {
      id: 45,
      windowId: 1,
      active: false,
      url: 'https://example.test/sections',
      title: 'Sections',
      status: 'complete',
    },
  ],
  [
    46,
    {
      id: 46,
      windowId: 1,
      active: false,
      url: 'https://example.test/lists',
      title: 'Lists',
      status: 'complete',
    },
  ],
  [
    47,
    {
      id: 47,
      windowId: 1,
      active: false,
      url: 'https://example.test/flags',
      title: 'Flags --help',
      status: 'complete',
    },
  ],
  [
    48,
    {
      id: 48,
      windowId: 1,
      active: false,
      url: 'https://example.test/another-flag',
      title: '--help',
      status: 'complete',
    },
  ],
]);
const originalTabs = [...tabs.values()].map(({ id, active, windowId, url }) => ({
  id,
  active,
  windowId,
  url,
}));
let forbiddenCalls = 0;
const timers = new Set<ReturnType<typeof setTimeout>>();
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const environment = () => ({ ...process.env, COBROWSER_HOME: home });
function event() {
  const listeners: ((value: any) => void)[] = [];
  return { listeners, addListener: (fn: (value: any) => void) => listeners.push(fn) };
}
function rawRequest(
  command: string,
  body: unknown,
): Promise<{ status: number; body: string; payload: any }> {
  return new Promise((resolve, reject) => {
    const req = request(
      { socketPath: path.join(home, 'run/probe.sock'), path: `/v1/${command}`, method: 'POST' },
      (res) => {
        let output = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => (output += chunk));
        res.on('end', () =>
          resolve({ status: res.statusCode!, body: output, payload: JSON.parse(output) }),
        );
      },
    );
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });
}
async function cli(...args: string[]) {
  return exec(process.execPath, [path.join(root, 'dist/cli.js'), '--browser', 'probe', ...args], {
    env: environment(),
    maxBuffer: 2_000_000,
  });
}
function splitContinuation(text: string) {
  const match = /\n\n(?:next|more): ([^\n]+)$/.exec(text);
  return { content: match ? text.slice(0, match.index) : text, next: match?.[1] };
}
async function follow(command: string) {
  expect(command.startsWith('cobrowser ')).toBe(true);
  const result = await exec(
    '/bin/sh',
    [
      '-c',
      `${quote(process.execPath)} ${quote(path.join(root, 'dist/cli.js'))} ${command.slice('cobrowser '.length)}`,
    ],
    { env: environment(), maxBuffer: 2_000_000 },
  );
  return result.stdout.replace(/\n$/, '');
}

async function followJson(command: string) {
  return JSON.parse(await follow(`${command} --json`));
}

async function mcpRead(args: Record<string, unknown>) {
  const child = spawn(
    process.execPath,
    [path.join(root, 'dist/cli.js'), '--browser', 'probe', 'mcp'],
    { env: environment() },
  );
  let stdout = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => (stdout += chunk));
  child.stdin.end(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'read_tab', arguments: args },
    }) + '\n',
  );
  await once(child, 'exit');
  const response = JSON.parse(stdout.trim());
  expect(response.error).toBeUndefined();
  expect(response.result.isError).not.toBe(true);
  expect(JSON.stringify(response).length).toBeLessThanOrEqual(Number(args.maxChars ?? 20_000));
  return response.result;
}

async function readAllTabs(first: string, retry: (cap: number) => Promise<string>) {
  const pending = [first];
  const received = new Map<number, string>();
  const seen = new Set<string>();
  for (let attempt = 0; pending.length && attempt < 100; attempt++) {
    const text = pending.shift()!;
    const raise = /^Raise maxChars to (\d+)/.exec(text);
    if (raise) {
      pending.push(await retry(Number(raise[1])));
      continue;
    }
    const content = text.split(/\n\n(?:next|more|also): /)[0];
    for (const block of content.split(/\n\n(?=## \d+ ·)/)) {
      const match = /^## (\d+) ·[^\n]*\n[^\n]*\n[^\n]*\n\n([\s\S]*)$/.exec(block);
      if (match) received.set(Number(match[1]), (received.get(Number(match[1])) || '') + match[2]);
    }
    for (const match of text.matchAll(/\n\n(?:next|more|also): (cobrowser [^\n]+)/g)) {
      expect(seen.has(match[1])).toBe(false);
      seen.add(match[1]);
      pending.push(await follow(match[1]));
    }
  }
  expect(pending).toHaveLength(0);
  expect(received.get(42)).toBe(plain);
  expect(received.get(43)).toBe('SECONDONLY');
}

test.describe('public continuations', () => {
  test.beforeAll(async () => {
    home = await mkdtemp('/tmp/cbc-');
    helper = spawn(process.execPath, [path.join(root, 'dist/helper.js'), '--browser', 'probe'], {
      env: environment(),
    });
    const onMessage = event();
    const noop = async () => {};
    const storage = {
      get: async (defaults: any) => (typeof defaults === 'string' ? {} : defaults),
      set: noop,
      remove: noop,
    };
    const forbid = async () => {
      forbiddenCalls++;
      throw new Error('The browser view changed.');
    };
    const port = {
      onMessage,
      onDisconnect: event(),
      postMessage(value: unknown) {
        nativeReplyLengths.push(Buffer.byteLength(JSON.stringify(value)));
        helper.stdin.write(encodeFrame(value));
      },
      disconnect: forbid,
    };
    const sandbox: Record<string, any> = {
      URL,
      TextEncoder,
      Uint8Array,
      crypto: webcrypto,
      setTimeout: (callback: () => void, delay: number) => {
        const timer = setTimeout(callback, delay);
        timers.add(timer);
        return timer;
      },
      clearTimeout,
    };
    const context = vm.createContext(sandbox);
    sandbox.chrome = {
      runtime: {
        connectNative: () => port,
        onStartup: event(),
        onInstalled: event(),
        onMessage: event(),
      },
      storage: { local: storage, session: storage, onChanged: event() },
      webRequest: {
        onBeforeRequest: event(),
        onBeforeSendHeaders: event(),
        onBeforeRedirect: event(),
        onResponseStarted: event(),
        onCompleted: event(),
        onErrorOccurred: event(),
      },
      tabs: {
        get: async (id: number) => {
          const tab = tabs.get(id);
          if (!tab) throw new Error('missing tab');
          return tab;
        },
        query: async () => [...tabs.values()],
        onCreated: event(),
        onUpdated: event(),
        onReplaced: event(),
        onRemoved: event(),
        onActivated: event(),
        update: forbid,
        highlight: forbid,
        create: forbid,
        move: forbid,
        reload: forbid,
      },
      windows: { getLastFocused: async () => ({ id: 1 }), onRemoved: event(), update: forbid },
      action: { setBadgeText: noop, setBadgeBackgroundColor: noop },
      alarms: { create: noop, onAlarm: event() },
      scripting: {
        executeScript: async ({ target, func, args = [] }: any) => {
          const tab = tabs.get(target.tabId)!;
          sandbox.location = { href: tab.url };
          sandbox.document = {
            title: tab.title,
            contentType: 'text/html',
            documentElement: {
              outerHTML:
                htmlForTab.get(target.tabId) ||
                `<html><body><article><p>${plain}</p></article></body></html>`,
            },
            querySelector: () => null,
            querySelectorAll: (selector: string) => {
              const values =
                selector === 'body'
                  ? [large]
                  : selector === '[data-values]'
                    ? queryValues
                    : selector === '[data-many]'
                      ? Array.from({ length: 110 }, (_, i) => `element${i}`)
                      : [large];
              return values.map((innerText) => ({ innerText, outerHTML: `<p>${innerText}</p>` }));
            },
          };
          return [{ result: func(...args) }];
        },
      },
    };
    const decoder = new NativeFrameDecoder();
    helper.stdout.on('data', (chunk) => {
      for (const value of decoder.push(chunk))
        for (const listener of onMessage.listeners) listener(value);
    });
    vm.runInContext(
      await readFile(path.join(root, 'dist/extension/service-worker.js'), 'utf8'),
      context,
    );
    await expect
      .poll(async () => {
        try {
          return (await rawRequest('status', {})).payload.data?.connected;
        } catch {
          return false;
        }
      })
      .toBe(true);
  });
  test.afterAll(async () => {
    helper?.stdin.end();
    if (helper && helper.exitCode === null) await once(helper, 'exit');
    for (const timer of timers) clearTimeout(timer);
    if (home) await rm(home, { recursive: true, force: true });
  });
  test.afterEach(() => {
    expect(forbiddenCalls).toBe(0);
    expect(
      [...tabs.values()].map(({ id, active, windowId, url }) => ({ id, active, windowId, url })),
    ).toEqual(originalTabs);
  });

  for (const cap of [64, 90, 100, 110, 120, 180, 350]) {
    test(`retrieves every tab by following continuations at cap ${cap}`, async () => {
      const socket = async (maxChars: number) => {
        const result = await rawRequest('read', { ids: [42, 43], maxChars });
        expect(result.body.length).toBeLessThanOrEqual(maxChars);
        expect(result.payload.ok).toBe(true);
        return result.payload.text;
      };
      await readAllTabs(await socket(cap), socket);
      const command = async (maxChars: number) => {
        const { stdout } = await cli('read', '42', '43', '--max-chars', String(maxChars));
        expect(stdout.length).toBeLessThanOrEqual(maxChars);
        return stdout.replace(/\n$/, '');
      };
      await readAllTabs(await command(cap), command);
    });
  }
  for (const cap of [100, 120, 160, 180, 350]) {
    test(`retrieves every tab through MCP continuations at cap ${cap}`, async () => {
      const call = async (maxChars: number) =>
        (await mcpRead({ ids: [42, 43], maxChars })).content[0].text;
      await readAllTabs(await call(cap), call);
    });
  }

  test('preserves code and nested link labels while removing only destinations', async () => {
    const expected =
      '```\nconst x = "[name](type)";\n```\n\nUse `[inline](type)` and `` `[ticks](type)` ``.\n\nAlpha and Label \\[extra\\] and Titled.';
    const socket = await rawRequest('read', { id: 44, full: true });
    const json = JSON.parse((await cli('read', '44', '--full', '--json')).stdout);
    const rpc = await mcpRead({ id: 44, full: true });
    for (const text of [socket.payload.text, json.text, rpc.content[0].text]) {
      expect(text.slice(text.indexOf('\n\n') + 2)).toBe(expected);
    }
    const links = await rawRequest('read', { id: 44, full: true, links: true });
    expect(links.payload.text).toContain('https://example.test/a_\\(b\\)');
    expect(links.payload.text).toContain('https://example.test/nested');
    expect(links.payload.text).toContain('A title (with parentheses)');
  });

  test('removes nested HTML list destinations by default and retains them with links', async () => {
    for (const links of [false, true]) {
      const socket = await rawRequest('read', { id: 46, full: true, links });
      const json = JSON.parse(
        (await cli('read', '46', '--full', '--json', ...(links ? ['--links'] : []))).stdout,
      );
      const rpc = await mcpRead({ id: 46, full: true, links });
      for (const text of [socket.payload.text, json.text, rpc.content[0].text]) {
        for (const label of ['Inner', 'Deep', 'More', '[literal](type)'])
          expect(text).toContain(label);
        for (const destination of ['nested-list', 'deep-list', 'list-continuation']) {
          expect(text.includes(`https://example.test/${destination}`)).toBe(links);
        }
      }
    }
  });

  test('keeps native privacy metadata out of public read, query and tab results', async () => {
    for (const [command, params] of [
      ['read', { id: 46, full: true }],
      ['query', { id: 43, selector: '[data-many]', limit: 1 }],
      ['tabs', {}],
    ] as const) {
      const result = (await rawRequest(command, params)).payload;
      expect(result.ok).toBe(true);
      expect(result.data).toBeDefined();
      expect(JSON.stringify(result)).not.toMatch(
        /"(?:documentEpoch|policyEpoch|pauseEpoch|access)":/,
      );
    }
  });

  test('reports pages for the selected section and JSON-sized body boundaries', async () => {
    const pageSize = 30;
    const params = { id: 45, section: '1', full: true, page: 1, pageSize, maxChars: 10_000 };
    const complete = (await rawRequest('read', { id: 45, section: '1', full: true })).payload.text;
    const expectedBody = complete.slice(complete.indexOf('\n\n') + 2);
    const first = (await rawRequest('read', params)).payload;
    const texts: string[] = [];
    let result = first;
    for (let index = 0; index < 50; index++) {
      expect(result.ok).toBe(true);
      expect(result.data.pages).toBe(first.data.pages);
      const { content, next } = splitContinuation(result.text);
      texts.push(content.slice(content.indexOf('\n\n') + 2));
      if (!next) break;
      result = await followJson(next);
    }
    expect(texts.join('')).toBe(expectedBody);
    expect(first.data.pages).toBe(texts.length);
    expect(texts.length).toBeGreaterThan(1);
    const past = await rawRequest('read', { ...params, page: texts.length + 1 });
    expect(past.payload.error.code).toBe('BAD_REQUEST');
    const json = JSON.parse(
      (
        await cli(
          'read',
          '45',
          '--section',
          '1',
          '--full',
          '--page-size',
          String(pageSize),
          '--json',
        )
      ).stdout,
    );
    expect(json.data.pages).toBe(texts.length);
    const rpc = await mcpRead(params);
    expect(rpc.structuredContent.data.pages).toBe(texts.length);
    expect((await rawRequest('read', { ...params, section: '2' })).payload.data.pages).toBe(1);
  });

  test('counts the pages reached by whole-body and link-preserving continuations', async () => {
    for (const id of [42, 44]) {
      for (const links of [false, true]) {
        const params = { id, full: true, links, pageSize: 90, maxChars: 10_000 };
        const complete = (await rawRequest('read', { id, full: true, links })).payload.text;
        let result = (await rawRequest('read', params)).payload;
        const count = result.data.pages;
        const bodies: string[] = [];
        for (let index = 0; index < 50; index++) {
          expect(result.data.pages).toBe(count);
          const { content, next } = splitContinuation(result.text);
          bodies.push(content.slice(content.indexOf('\n\n') + 2));
          if (!next) break;
          result = await followJson(next);
        }
        expect(bodies.length).toBe(count);
        expect(bodies.join('').replace(/\s+/g, '')).toBe(
          complete.slice(complete.indexOf('\n\n') + 2).replace(/\s+/g, ''),
        );
        const past = await rawRequest('read', { ...params, page: count + 1 });
        expect(past.payload.error.code).toBe('BAD_REQUEST');
      }
    }
  });

  test('reconstructs a capped short read by running every continuation', async () => {
    let text = (await rawRequest('read', { id: 42, maxChars: 350 })).payload.text;
    let output = '';
    const seen = new Set<string>();
    for (let page = 0; page < 100; page++) {
      const { content, next } = splitContinuation(text);
      output += content.includes('\n\n') ? content.slice(content.indexOf('\n\n') + 2) : '';
      if (!next) break;
      expect(seen.has(next)).toBe(false);
      seen.add(next);
      text = await follow(next);
    }
    expect(output).toBe(plain);
  });

  test('grows a retry cap before choosing useful page boundaries', async () => {
    let text = (await rawRequest('read', { id: 763692891, maxChars: 100 })).payload.text;
    let receivedBody = false;
    for (let attempt = 0; attempt < 8; attempt++) {
      const { content, next } = splitContinuation(text);
      if (content) {
        expect(content).toContain('token000 token001 token002');
        receivedBody = true;
        break;
      }
      expect(next).toBeTruthy();
      expect(next).not.toContain('--page-size');
      text = await follow(next!);
    }
    expect(receivedBody).toBe(true);
    const explicit = await rawRequest('read', {
      id: 763692891,
      page: 1,
      pageSize: 1,
      maxChars: 200,
    });
    expect(splitContinuation(explicit.payload.text).next).toContain('--page-size 1');
  });

  for (const cap of [900, 100_000, 200_000]) {
    test(`reconstructs query text past 50000 characters at cap ${cap}`, async () => {
      let text = (
        await cli('query', '43', '[data-values]', '--max-chars', String(cap))
      ).stdout.replace(/\n$/, '');
      let output = '';
      const seen = new Set<string>();
      for (let page = 0; page < 600; page++) {
        const { content, next } = splitContinuation(text);
        output += content;
        if (!next) break;
        expect(seen.has(next)).toBe(false);
        seen.add(next);
        text = await follow(next);
      }
      expect(output).toBe(
        queryValues
          .map((value, i) => `${i + 1}. ${value.replace('https://user:secret@', 'https://')}`)
          .join('\n\n'),
      );
      expect(output).not.toContain('secret');
      expect(Math.max(...nativeReplyLengths)).toBeLessThan(650_000);
    });
  }

  test('retries long search and selector arguments without cutting commands', async () => {
    const phrase = 'missing phrase '.repeat(30);
    const first = await rawRequest('find', { id: 42, query: phrase, maxChars: 200 });
    expect(first.body.length).toBeLessThanOrEqual(200);
    expect(first.payload.text).not.toMatch(/(?:next|more):/);
    const cap = Number(/Raise maxChars to (\d+)/.exec(first.payload.text)![1]);
    let text = (await rawRequest('find', { id: 42, query: phrase, maxChars: cap })).payload.text;
    for (let count = 0; count < 8; count++) {
      const { next } = splitContinuation(text);
      if (!next) break;
      text = await follow(next);
    }
    expect(text).toBe(`No matches for ${JSON.stringify(phrase.trim())}.`);
    const selector = `[data-label="${'long '.repeat(70)}'quoted'"]`;
    const small = await rawRequest('query', { id: 43, selector, maxChars: 200 });
    expect(small.payload.text).not.toMatch(/(?:next|more):/);
    const larger = Number(/Raise maxChars to (\d+)/.exec(small.payload.text)![1]);
    const queried = await rawRequest('query', { id: 43, selector, maxChars: larger });
    const { next } = splitContinuation(queried.payload.text);
    expect(next).toBeTruthy();
    expect(await follow(next!)).not.toContain('BAD_REQUEST');
  });

  test('finds flag-shaped text literally and follows its capped retry', async () => {
    for (const query of ['--help', '--json', '--max-chars']) {
      const result = await cli('find', '47', '--json', '--', query);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.ok).toBe(true);
      expect(parsed.data.matches.length).toBeGreaterThan(0);
      expect(parsed.text).toContain(query);
    }
    let text = (await rawRequest('find', { id: 47, query: '--help', maxChars: 100 })).payload.text;
    expect(splitContinuation(text).next).toBeTruthy();
    for (let count = 0; count < 8; count++) {
      const { next } = splitContinuation(text);
      if (!next) break;
      text = await follow(next);
    }
    expect(splitContinuation(text).next).toBeUndefined();
    expect(text).toContain('--help');
    expect(text).not.toContain('Global options:');
  });

  test('filters flag-shaped text and follows its literal filter continuation', async () => {
    const expected = [47, 48];
    const listed = JSON.parse((await cli('tabs', '--match=--help', '--json')).stdout);
    expect(listed.data.tabs.map((tab: { id: number }) => tab.id).sort()).toEqual(expected);
    let result = (await rawRequest('tabs', { match: '--help', limit: 1, maxChars: 1000 })).payload;
    const ids: number[] = [];
    for (let count = 0; count < 4; count++) {
      ids.push(...result.data.tabs.map((tab: { id: number }) => tab.id));
      const { next } = splitContinuation(result.text);
      if (!next) break;
      expect(next).toContain('--match=--help');
      result = await followJson(next);
    }
    expect(ids.sort()).toEqual(expected);
  });

  test('rejects impossible socket caps while the CLI preserves tiny final output', async () => {
    for (const cap of [1, 10, 63]) {
      const result = await rawRequest('read', { id: 42, maxChars: cap });
      expect(result.status).toBe(400);
      expect(result.payload).toMatchObject({
        ok: false,
        error: { code: 'BAD_REQUEST', message: 'Use maxChars of at least 64.' },
      });
    }
    for (const cap of [64, 100]) {
      const result = await rawRequest('read', {
        id: 42,
        maxChars: cap,
        responseOverhead: cap - 12,
      });
      expect(result.status).toBe(200);
      expect(result.body.length).toBeLessThanOrEqual(12);
    }
    const overhead = await rawRequest('read', { id: 42, maxChars: 100, responseOverhead: 89 });
    expect(overhead.status).toBe(400);
    for (const cap of [1, 10]) {
      for (const json of [false, true]) {
        const result = await cli(
          'read',
          '42',
          '--max-chars',
          String(cap),
          ...(json ? ['--json'] : []),
        );
        expect(result.stdout.length).toBeLessThanOrEqual(cap);
        if (json) expect(() => JSON.parse(result.stdout)).not.toThrow();
      }
    }
  });

  test('accepts query offsets through MCP and keeps a 100-character response valid', async () => {
    const input = [
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { clientInfo: { name: 'continuation-test', version: '1' } },
      },
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'query_tab',
          arguments: { id: 43, selector: 'body', offset: 50_003, maxChars: 300 },
        },
      },
      {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'query_tab', arguments: { id: 43, selector: 'body', maxChars: 100 } },
      },
    ];
    const child = spawn(
      process.execPath,
      [path.join(root, 'dist/cli.js'), '--browser', 'probe', 'mcp'],
      { env: environment() },
    );
    let stdout = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stdin.end(input.map((value) => JSON.stringify(value)).join('\n') + '\n');
    await once(child, 'exit');
    const responses = stdout
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(responses.find((value) => value.id === 2).result.content[0].text).toBe('TAIL_MARKER');
    const tiny = responses.find((value) => value.id === 3);
    expect(tiny.error).toBeUndefined();
    expect(tiny.result.isError).not.toBe(true);
    expect(JSON.stringify(tiny).length).toBeLessThanOrEqual(100);
  });

  test('keeps the 100-element limit with query offsets', async () => {
    const result = await rawRequest('query', { id: 43, selector: '[data-many]', limit: 100 });
    expect(result.payload.text).toContain('100. element99');
    expect(result.payload.text).not.toContain('element100');
    const invalid = await rawRequest('query', { id: 43, selector: 'body', limit: 101 });
    expect(invalid.status).toBe(400);
  });
});
