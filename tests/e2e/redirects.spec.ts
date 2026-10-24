import { test, expect, chromium, type BrowserContext, type Page } from '@playwright/test';
import { createServer, request as httpRequest, type Server } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { cert, key } from '../fixtures/redirects-tls.js';

const exec = promisify(execFile);
const root = path.resolve(import.meta.dirname, '../..');
const extensionId = 'laeencopealhcofijafpfkicblippbnp';
let context: BrowserContext;
let home = '';
let profile = '';
let server: Server;
let tlsServer: ReturnType<typeof createHttpsServer>;
let port = 0;
let tlsPort = 0;
let held: Array<() => void> = [];
let hits: Array<{ host: string; url: string; method: string; accept: string; cookie: string }> = [];

const url = (host: string, pathname: string) => `http://${host}:${port}${pathname}`;
const pdf = (text: string) =>
  `%PDF-1.4\n1 0 obj\n<<>>\nendobj\nstream\nBT (${text}) Tj ET\nendstream\n%%EOF`;

async function worker() {
  await expect
    .poll(() => context.serviceWorkers().find((item) => item.url().includes('service-worker')))
    .toBeTruthy();
  return context.serviceWorkers().find((item) => item.url().includes('service-worker'))!;
}

async function tabId(page: Page) {
  return (await worker()).evaluate(
    async (href) => (await chrome.tabs.query({})).filter((tab) => tab.url === href).at(-1)!.id!,
    page.url(),
  );
}

async function privacy(settings: { paused?: boolean; denylist?: string[] }) {
  await (await worker()).evaluate((settings) => chrome.storage.local.set(settings), settings);
}

async function invariant() {
  const browser = await (
    await worker()
  ).evaluate(async () => ({
    focused: (await chrome.windows.getLastFocused({ windowTypes: ['normal'] })).id,
    tabs: (await chrome.tabs.query({}))
      .map((tab) => ({ id: tab.id, window: tab.windowId, active: tab.active, url: tab.url }))
      .sort((a, b) => a.id! - b.id!),
  }));
  const scroll = await Promise.all(
    context
      .pages()
      .map((page) =>
        page
          .evaluate(() => ({ url: location.href, x: scrollX, y: scrollY }))
          .catch(() => ({ url: page.url(), x: null, y: null })),
      ),
  );
  return { browser, scroll };
}

async function unchanged<T>(action: () => Promise<T>): Promise<T> {
  const before = await invariant();
  try {
    return await action();
  } finally {
    expect(await invariant()).toEqual(before);
  }
}

async function socket(command: string, body: Record<string, unknown> = {}) {
  return new Promise<Record<string, any>>((resolve, reject) => {
    const request = httpRequest(
      {
        socketPath: path.join(home, 'run/chromium.sock'),
        path: `/v1/${command}`,
        method: 'POST',
        headers: { 'content-type': 'application/json' },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        response.on('error', reject);
        response.on('end', () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    request.once('error', reject);
    request.end(JSON.stringify(body));
  });
}

async function cli(...args: string[]) {
  return exec(
    process.execPath,
    [path.join(root, 'dist/cli.js'), '--browser', 'chromium', ...args],
    { env: { ...process.env, COBROWSER_HOME: home } },
  );
}

async function mcpRead(id: number) {
  const child = spawn(
    process.execPath,
    [path.join(root, 'dist/cli.js'), '--browser', 'chromium', 'mcp'],
    { env: { ...process.env, COBROWSER_HOME: home }, stdio: ['pipe', 'pipe', 'pipe'] },
  );
  let output = '';
  child.stdout.on('data', (chunk) => {
    output += String(chunk);
  });
  const done = new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) =>
      code === 0 ? resolve() : reject(new Error('The private MCP fixture failed.')),
    );
  });
  child.stdin.end(
    `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'redirect-fixture', version: '1' } } })}\n${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'read_tab', arguments: { id } } })}\n`,
  );
  await done;
  return output
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
    .find((reply) => reply.id === 2);
}

async function pageAt(pathname: string) {
  const page = await context.newPage();
  await page.goto(url('article.test', pathname));
  return { page, id: await tabId(page) };
}

// Only delivery of selected synthetic-host events changes; Chromium still performs real fetches.
const deliveryFixture = `
globalThis.redirectDeliveryFault = '';
globalThis.redirectDeliveredFaults = [];
for (const name of ['onBeforeRequest','onBeforeSendHeaders','onResponseStarted','onCompleted']) {
  const event = chrome.webRequest?.[name];
  if (!event) continue;
  const add = event.addListener.bind(event);
  event.addListener = (callback, ...args) => add((details) => {
    const mode = globalThis.redirectDeliveryFault;
    const pathname = new URL(details.url).pathname;
    if (!mode || !pathname.startsWith('/fault-')) return callback(details);
    const injected = () => globalThis.redirectDeliveredFaults.push(mode);
    if (name === 'onBeforeSendHeaders' && mode === 'missing-marker') {
      injected();
      return callback({...details, requestHeaders: details.requestHeaders.map(h => h.name.toLowerCase() === 'accept' ? {...h,value:'*/*'} : h)});
    }
    if (name === 'onBeforeSendHeaders' && mode === 'drop-middle-send' && pathname.endsWith('/middle.pdf')) {
      injected();
      return;
    }
    if (name === 'onBeforeSendHeaders' && mode === 'wrong-document') {
      injected();
      return callback({...details,documentId:'wrong-document'});
    }
    callback(details);
    if (name === 'onBeforeSendHeaders' && mode === 'ambiguous') {
      injected();
      callback({...details,requestId:details.requestId+'-other'});
    }
    if ((name === 'onResponseStarted' && mode === 'duplicate-response') || (name === 'onCompleted' && mode === 'duplicate-complete')) {
      injected();
      callback(details);
    }
  }, ...args);
}
`;

test.describe.serial('document redirect provenance', () => {
  test.beforeAll(async () => {
    home = await mkdtemp('/tmp/cb-redirect-home-');
    profile = await mkdtemp('/tmp/cb-redirect-profile-');
    const handler = (
      request: import('node:http').IncomingMessage,
      response: import('node:http').ServerResponse,
    ) => {
      const requestUrl = new URL(request.url || '/', 'http://fixture.test');
      const pathname = requestUrl.pathname;
      const host = String(request.headers.host).split(':')[0];
      hits.push({
        host,
        url: request.url || '/',
        method: request.method || '',
        accept: request.headers.accept || '',
        cookie: request.headers.cookie || '',
      });
      if (
        request.headers['sec-fetch-dest'] === 'document' ||
        request.headers.accept?.includes('text/html')
      ) {
        response.setHeader('content-type', 'text/html');
        response.end(
          '<html><head><title>Redirect fixture</title></head><body><h1>Redirect fixture</h1><p>Public article.</p></body></html>',
        );
        return;
      }
      if (request.method === 'OPTIONS') {
        response.writeHead(403);
        response.end();
        return;
      }
      if (request.headers.origin && !pathname.startsWith('/worker-')) {
        response.setHeader('access-control-allow-origin', request.headers.origin);
        response.setHeader('access-control-allow-credentials', 'true');
      }
      response.setHeader('vary', 'Origin');
      response.setHeader(
        'cache-control',
        pathname.includes('cached') ? 'public,max-age=3600' : 'no-store',
      );
      if (pathname === '/chips/start.pdf') {
        response.writeHead(302, { location: `https://private.test:${tlsPort}/chips/final.pdf` });
        response.end();
        return;
      }
      if (pathname.startsWith('/loop/')) {
        const n = Number(pathname.split('/')[2].replace('.pdf', ''));
        response.writeHead(302, { location: url('article.test', `/loop/${n + 1}.pdf`) });
        response.end();
        return;
      }
      if (pathname.endsWith('/start.pdf')) {
        response.writeHead(302, {
          location: url(
            'private.test',
            `${pathname.replace('/start.pdf', '/middle.pdf')}${requestUrl.search}`,
          ),
        });
        response.end();
        return;
      }
      if (pathname.endsWith('/middle.pdf')) {
        response.writeHead(302, {
          location: url(
            'article.test',
            `${pathname.replace('/middle.pdf', '/final.pdf')}${requestUrl.search}`,
          ),
        });
        response.end();
        return;
      }
      response.setHeader('content-type', 'application/pdf');
      const text = pathname.startsWith('/chips/')
        ? request.headers.cookie?.includes('partition-proof=page-session')
          ? 'Partitioned session retained'
          : 'Missing partitioned session'
        : 'Allowed redirect document';
      if (
        pathname.includes('stream') ||
        pathname.includes('stall') ||
        pathname.startsWith('/slot/')
      ) {
        response.write('%PDF-1.4\n1 0 obj\n<<>>\nendobj\nstream\nBT ');
        held.push(() => response.end(`(${text}) Tj ET\nendstream\n%%EOF`));
        return;
      }
      response.end(pdf(text));
    };
    server = createServer({ maxHeaderSize: 64 * 1024 }, handler);
    tlsServer = createHttpsServer({ key, cert, maxHeaderSize: 64 * 1024 }, handler);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    await new Promise<void>((resolve) => tlsServer.listen(0, '127.0.0.1', resolve));
    port = (server.address() as import('node:net').AddressInfo).port;
    tlsPort = (tlsServer.address() as import('node:net').AddressInfo).port;
    const extension = path.join(home, 'extension');
    await cp(path.join(root, 'dist/extension'), extension, { recursive: true });
    const workerFile = path.join(extension, 'service-worker.js');
    const built = await readFile(workerFile, 'utf8');
    const header = built.indexOf('\n') + 1;
    await writeFile(
      workerFile,
      `${built.slice(0, header)}${deliveryFixture}\n${built.slice(header)}`,
    );
    const launcher = path.join(home, 'host.sh');
    await writeFile(
      launcher,
      `#!/bin/sh\nexport COBROWSER_HOME='${home}'\nexec '${process.execPath}' '${path.join(root, 'dist/helper.js')}' --browser chromium\n`,
    );
    await chmod(launcher, 0o755);
    await mkdir(path.join(profile, 'NativeMessagingHosts'), { recursive: true });
    await writeFile(
      path.join(profile, 'NativeMessagingHosts/cobrowser.json'),
      JSON.stringify({
        name: 'cobrowser',
        description: 'Redirect fixture',
        path: launcher,
        type: 'stdio',
        allowed_origins: [`chrome-extension://${extensionId}/`],
      }),
    );
    context = await chromium.launchPersistentContext(profile, {
      channel: 'chromium',
      headless: process.env.HEADED !== '1',
      args: [
        `--disable-extensions-except=${extension}`,
        `--load-extension=${extension}`,
        '--ignore-certificate-errors',
        '--host-resolver-rules=MAP *.test 127.0.0.1',
      ],
    });
    await context.pages()[0]!.goto(url('article.test', '/article'));
    await expect
      .poll(async () => (await cli('tabs').catch(() => ({ stdout: '' }))).stdout)
      .toContain('Redirect fixture');
    await context.addCookies([
      {
        name: 'session-proof',
        value: 'retained',
        domain: 'article.test',
        path: '/',
        httpOnly: true,
        sameSite: 'Lax',
      },
    ]);
  });

  test.beforeEach(async () => {
    hits = [];
    held = [];
    await privacy({ paused: false, denylist: [] });
    await (
      await worker()
    ).evaluate(() => {
      (globalThis as any).redirectDeliveryFault = '';
    });
  });
  test.afterEach(async () => {
    held.forEach((release) => release());
    await privacy({ paused: false, denylist: [] });
    await (
      await worker()
    ).evaluate(() => {
      (globalThis as any).redirectDeliveryFault = '';
    });
  });
  test.afterAll(async () => {
    await context?.close();
    server?.closeAllConnections();
    tlsServer?.closeAllConnections();
    await Promise.all([
      new Promise<void>((resolve) => server?.close(() => resolve())),
      new Promise<void>((resolve) => tlsServer?.close(() => resolve())),
    ]);
    await Promise.all(
      [home, profile].filter(Boolean).map((item) => rm(item, { recursive: true, force: true })),
    );
  });

  test('blocks a denied middle hop before returning document text through socket, CLI and MCP', async () => {
    const { page, id } = await pageAt('/denied/start.pdf');
    try {
      await privacy({ denylist: ['private.test'] });
      await unchanged(async () => {
        expect(await socket('read', { id })).toMatchObject({
          ok: false,
          error: { code: 'DENIED' },
        });
        const failure = await cli('read', String(id)).catch((error) => error);
        expect(failure.stderr).toContain('DENIED');
        expect(failure.stdout).not.toContain('Allowed redirect document');
        expect(JSON.stringify(await mcpRead(id))).toContain('DENIED');
        expect(
          await readFile(path.join(home, 'logs/reads.jsonl'), 'utf8').catch(() => ''),
        ).not.toContain('/denied/');
      });
    } finally {
      await page.close();
    }
  });

  test('preserves ordinary and partitioned sessions through allowed redirects and cache reads', async () => {
    const first = await pageAt('/cached/start.pdf');
    const chips = await pageAt('/chips/start.pdf');
    try {
      await context.addCookies([
        {
          name: 'partition-proof',
          value: 'page-session',
          domain: 'private.test',
          path: '/',
          secure: true,
          httpOnly: true,
          sameSite: 'None',
          partitionKey: 'http://article.test',
        },
      ]);
      await first.page.evaluate(async () => {
        await (await fetch(location.href, { credentials: 'include', cache: 'reload' })).text();
      });
      await unchanged(async () => {
        const cachedHits = hits.length;
        expect((await socket('read', { id: first.id })).text).toContain(
          'Allowed redirect document',
        );
        expect(hits).toHaveLength(cachedHits);
        expect((await socket('read', { id: chips.id })).text).toContain(
          'Partitioned session retained',
        );
        const before = hits.length;
        expect((await socket('read', { id: first.id })).text).toContain(
          'Allowed redirect document',
        );
        expect(hits).toHaveLength(before);
        const outputs = [
          await socket('log'),
          await socket('read', { id: first.id }),
          await mcpRead(chips.id),
        ];
        for (const output of outputs)
          expect(JSON.stringify(output)).not.toMatch(
            /application\/x-[a-f0-9]{32}|sourceUrls|documentEpoch|private\.test|middle\.pdf|final\.pdf/,
          );
        expect(hits.some((hit) => hit.method === 'OPTIONS')).toBe(false);
        expect(
          hits
            .filter((hit) => hit.url.startsWith('/cached/final.pdf'))
            .every((hit) => hit.cookie.includes('session-proof=retained')),
        ).toBe(true);
        await privacy({ denylist: ['private.test'] });
        expect(await socket('read', { id: first.id })).toMatchObject({
          ok: false,
          error: { code: 'DENIED' },
        });
      });
    } finally {
      await first.page.close();
      await chips.page.close();
    }
  });

  test('isolates concurrent distinct and same-URL reads without mixing capture provenance', async () => {
    const a = await pageAt('/stream-concurrent/start.pdf');
    const b = await pageAt('/stream-concurrent/start.pdf');
    const c = await pageAt('/stream-distinct/start.pdf');
    try {
      await unchanged(async () => {
        const pending = Promise.all([a, b, c].map(({ id }) => socket('read', { id })));
        await expect.poll(() => held.length).toBe(3);
        const distraction = a.page.evaluate(async () =>
          (await fetch(location.href, { credentials: 'include' })).text(),
        );
        await expect.poll(() => held.length).toBe(4);
        held.forEach((release) => release());
        for (const result of await pending) expect(result).toMatchObject({ ok: true });
        expect(await distraction).toContain('Allowed redirect document');
        expect(
          new Set(
            hits
              .filter(
                (hit) =>
                  hit.url.endsWith('/start.pdf') &&
                  hit.method === 'GET' &&
                  hit.accept.startsWith('*/*, application/x-'),
              )
              .map((hit) => hit.accept),
          ).size,
        ).toBe(3);
      });
    } finally {
      await a.page.close();
      await b.page.close();
      await c.page.close();
    }
  });

  test('retains the existing worker fallback for a verified page CORS failure', async () => {
    const { page, id } = await pageAt('/worker-verified/start.pdf');
    try {
      await unchanged(async () => {
        const result = await socket('read', { id });
        expect(result).toMatchObject({ ok: true });
        expect(result.text).toContain('Allowed redirect document');
        expect(
          hits.filter(
            (hit) =>
              hit.url === '/worker-verified/start.pdf' &&
              hit.accept.startsWith('*/*, application/x-'),
          ),
        ).toHaveLength(2);
      });
    } finally {
      await page.close();
    }
  });

  for (const state of ['denylist', 'pause']) {
    test(`discards a streamed document after live ${state} invalidation`, async () => {
      const { page, id } = await pageAt(`/stream-${state}/start.pdf`);
      try {
        await unchanged(async () => {
          const pending = socket('read', { id });
          await expect.poll(() => held.length).toBeGreaterThan(0);
          await privacy(state === 'denylist' ? { denylist: ['private.test'] } : { paused: true });
          if (state === 'pause') await privacy({ paused: false });
          const result = await pending;
          expect(result).toMatchObject({
            ok: false,
            error: { code: state === 'denylist' ? 'DENIED' : 'PAUSED' },
          });
          expect(JSON.stringify(result)).not.toContain('Allowed redirect document');
        });
      } finally {
        held.forEach((release) => release());
        await page.close();
      }
    });
  }

  for (const fault of [
    'missing-marker',
    'ambiguous',
    'drop-middle-send',
    'wrong-document',
    'duplicate-response',
    'duplicate-complete',
  ]) {
    test(`fails closed on private event delivery fault ${fault}`, async () => {
      const { page, id } = await pageAt(`/fault-${fault}/start.pdf`);
      try {
        await (
          await worker()
        ).evaluate((fault) => {
          (globalThis as any).redirectDeliveryFault = fault;
          (globalThis as any).redirectDeliveredFaults = [];
        }, fault);
        await unchanged(async () => {
          const result = await socket('read', { id });
          expect(result).toMatchObject({ ok: false, error: { code: 'UNREADABLE' } });
          expect(JSON.stringify(result)).not.toMatch(
            /Allowed redirect document|application\/x-[a-f0-9]{32}/,
          );
          const delivered = await (
            await worker()
          ).evaluate(() => (globalThis as any).redirectDeliveredFaults);
          expect(delivered).toContain(fault);
        });
      } finally {
        await page.close();
      }
    });
  }

  test('rejects excessive hops and trace bytes without releasing document text', async () => {
    const loop = await pageAt('/loop/0.pdf');
    const large = await pageAt(`/large/start.pdf?q=${'x'.repeat(15_800)}`);
    try {
      await unchanged(async () => {
        for (const { id } of [loop, large]) {
          const result = await socket('read', { id });
          expect(result).toMatchObject({ ok: false, error: { code: 'UNREADABLE' } });
          expect(JSON.stringify(result)).not.toContain('Allowed redirect document');
        }
      });
    } finally {
      await loop.page.close();
      await large.page.close();
    }
  });

  test('releases the original deadline and operation slots after a stalled document', async () => {
    const stalled = await pageAt('/stall.pdf');
    const healthy = await pageAt('/healthy.pdf');
    try {
      await unchanged(async () => {
        const started = Date.now();
        const result = await socket('read', { id: stalled.id });
        expect(result).toMatchObject({ ok: false, error: { code: 'UNREADABLE' } });
        expect(Date.now() - started).toBeLessThan(18_000);
        expect(await socket('read', { id: healthy.id })).toMatchObject({ ok: true });
      });
    } finally {
      held.forEach((release) => release());
      await stalled.page.close();
      await healthy.page.close();
    }
  });

  test('bounds concurrent tracked fetches and releases every completed operation slot', async () => {
    const pages: Array<{ page: Page; id: number }> = [];
    try {
      for (let index = 0; index < 17; index++) {
        const page = await context.newPage();
        await page.goto(url(`slot${index}.test`, `/slot/${index}.pdf`));
        pages.push({ page, id: await tabId(page) });
      }
      await unchanged(async () => {
        const pending = pages.slice(0, 16).map(({ id }) => socket('read', { id }));
        await expect.poll(() => held.length).toBe(16);
        expect(await socket('read', { id: pages[16]!.id })).toMatchObject({
          ok: false,
          error: { code: 'BAD_REQUEST' },
        });
        held.forEach((release) => release());
        for (const result of await Promise.all(pending)) expect(result).toMatchObject({ ok: true });
        const retry = socket('read', { id: pages[16]!.id });
        await expect.poll(() => held.length).toBe(17);
        held.at(-1)!();
        expect(await retry).toMatchObject({ ok: true });
      });
    } finally {
      held.forEach((release) => release());
      await Promise.all(pages.map(({ page }) => page.close()));
    }
  });

  test('keeps local PDF reads file-only when file URL access is enabled', async () => {
    const extensions = await context.newPage();
    await extensions.goto('chrome://extensions');
    await extensions.evaluate(
      (id) =>
        (chrome as any).developerPrivate.updateExtensionConfiguration({
          extensionId: id,
          fileAccess: true,
        }),
      extensionId,
    );
    await extensions.close();
    await expect
      .poll(async () =>
        (await worker()).evaluate(() => chrome.extension.isAllowedFileSchemeAccess()),
      )
      .toBe(true);
    const file = path.join(home, 'local.pdf');
    await writeFile(file, pdf('Local document retained'));
    const page = await context.newPage();
    await page.goto(pathToFileURL(file).toString());
    const id = await tabId(page);
    try {
      await unchanged(async () => {
        const before = hits.length;
        const result = await socket('read', { id });
        expect(result).toMatchObject({ ok: true });
        expect(result.text).toContain('Local document retained');
        expect(hits).toHaveLength(before);
      });
    } finally {
      await page.close();
    }
  });
});
