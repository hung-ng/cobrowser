import { test, expect, type BrowserContext } from '@playwright/test';
import { createServer, request as httpRequest, type Server } from 'node:http';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFile, spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const root = path.resolve(import.meta.dirname, '../..');
const extensionId = 'laeencopealhcofijafpfkicblippbnp';
const hosts = [
  'article.test',
  'credentials.test',
  'long.test',
  'plain.test',
  'feed.test',
  'bank.test',
  'temporary.test',
  'store.chromewebstore.google.com',
];
let server: Server;
let port = 0;
let context: BrowserContext;
let home = '';
let userData = '';
let cacheVersion = 1;
let reloadCloseRequests = 0;
let delayedRequests = 0;
let delayedRelease: (() => void) | undefined;

function url(host: string, pathname: string): string {
  return `http://${host}:${port}${pathname}`;
}

async function cli(...args: string[]) {
  return exec(process.execPath, [path.join(root, 'dist/cli.js'), ...args], {
    env: { ...process.env, COBROWSER_HOME: home, FORCE_COLOR: undefined, NO_COLOR: undefined },
  });
}

async function mcp(...requests: unknown[]) {
  return new Promise<Record<string, any>[]>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [path.join(root, 'dist/cli.js'), '--browser', 'chromium', 'mcp'],
      {
        env: { ...process.env, COBROWSER_HOME: home },
      },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code !== 0) {
        reject(new Error(stderr || `MCP exited with code ${code}.`));
        return;
      }
      try {
        resolve(
          stdout
            .trim()
            .split('\n')
            .filter(Boolean)
            .map((line) => JSON.parse(line)),
        );
      } catch (error) {
        reject(error);
      }
    });
    child.stdin.end(`${requests.map((request) => JSON.stringify(request)).join('\n')}\n`);
  });
}

async function worker() {
  await expect
    .poll(() => context.serviceWorkers().find((item) => item.url().includes('service-worker')))
    .toBeTruthy();
  return context.serviceWorkers().find((item) => item.url().includes('service-worker'))!;
}

async function invariant() {
  const serviceWorker = await worker();
  const browserState = await serviceWorker.evaluate(async () => {
    const windows = await chrome.windows.getAll({ windowTypes: ['normal'] });
    const activeTabs = await Promise.all(
      windows.map(async (window) => {
        const tabs = await chrome.tabs.query({ windowId: window.id });
        return [window.id, tabs.find((tab) => tab.active)?.id ?? null] as const;
      }),
    );
    const [allTabs, focused] = await Promise.all([
      chrome.tabs.query({}),
      chrome.windows.getLastFocused({ windowTypes: ['normal'] }),
    ]);
    return {
      activeTabs,
      focusedWindowId: focused.id ?? null,
      tabCount: allTabs.length,
      tabUrls: allTabs
        .map((tab) => [tab.id, tab.url || ''] as const)
        .sort((left, right) => (left[0] ?? 0) - (right[0] ?? 0)),
    };
  });
  const pages = await Promise.all(
    context.pages().map(async (page) => {
      const pageUrl = page.url();
      try {
        return await page.evaluate(() => ({
          url: location.href,
          scrollX: window.scrollX,
          scrollY: window.scrollY,
        }));
      } catch {
        return { url: pageUrl, scrollX: null, scrollY: null };
      }
    }),
  );
  return { ...browserState, pages };
}

type Invariant = Awaited<ReturnType<typeof invariant>>;

function expectInvariantUnchanged(before: Invariant, after: Invariant) {
  const { pages: beforePages, ...beforeBrowser } = before;
  const { pages: afterPages, ...afterBrowser } = after;
  expect(afterBrowser).toEqual(beforeBrowser);
  for (const beforePage of beforePages) {
    if (beforePage.scrollX === null || beforePage.scrollY === null) continue;
    const afterPage = afterPages.find((page) => page.url === beforePage.url);
    if (afterPage)
      expect(afterPage).toMatchObject({ scrollX: beforePage.scrollX, scrollY: beforePage.scrollY });
  }
}

async function command(...args: string[]) {
  const before = await invariant();
  const result = await cli(...args);
  expectInvariantUnchanged(before, await invariant());
  return result;
}

async function failedCommand(...args: string[]) {
  const before = await invariant();
  const error = await cli(...args).catch((value) => value);
  expectInvariantUnchanged(before, await invariant());
  return error as { stderr: string };
}

async function helperRequest(commandName: string, body: Record<string, unknown>) {
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    const request = httpRequest(
      {
        socketPath: path.join(home, 'run', 'chromium.sock'),
        path: `/v1/${commandName}`,
        method: 'POST',
        headers: { 'content-type': 'application/json' },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        response.on('end', () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>);
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

function article(title: string, body: string): string {
  return `<html><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`;
}

function longSection(title: string, words: number): string {
  return `<h1>${title}</h1>${Array.from(
    { length: words / 20 },
    (_, index) => `<p>${title} paragraph ${index} ${'word '.repeat(20)}</p>`,
  ).join('')}`;
}

async function launch() {
  home = await mkdtemp(path.join(tmpdir(), 'cobrowser-home-'));
  userData = await mkdtemp(path.join(tmpdir(), 'cobrowser-profile-'));
  await mkdir(path.join(home, 'extension'), { recursive: true });
  await writeFile(
    path.join(home, 'extension', 'manifest.json'),
    JSON.stringify({ version: '0.1.0' }),
  );
  const extension = path.join(root, 'dist/extension');
  const nativeHosts = path.join(userData, 'NativeMessagingHosts');
  await mkdir(nativeHosts, { recursive: true });
  const launcher = path.join(home, 'host.sh');
  await writeFile(
    launcher,
    `#!/bin/sh
export COBROWSER_HOME=${home}
exec ${process.execPath} ${path.join(root, 'tests/fixtures/native-guard-proxy.mjs')} ${path.join(root, 'dist/helper.js')} ${home}
`,
  );
  await chmod(launcher, 0o755);
  await writeFile(
    path.join(nativeHosts, 'cobrowser.json'),
    JSON.stringify({
      name: 'cobrowser',
      description: 'test',
      path: launcher,
      type: 'stdio',
      allowed_origins: ['chrome-extension://laeencopealhcofijafpfkicblippbnp/'],
    }),
  );
  context = await (
    await import('@playwright/test')
  ).chromium.launchPersistentContext(userData, {
    channel: 'chromium',
    headless: process.env.HEADED !== '1',
    args: [
      `--disable-extensions-except=${extension}`,
      `--load-extension=${extension}`,
      `--host-resolver-rules=MAP ${hosts.join(' 127.0.0.1,MAP ')} 127.0.0.1`,
    ],
  });
  const extensions = await context.newPage();
  await extensions.goto('chrome://extensions');
  const developerMode = extensions.locator('#devMode');
  if (!(await developerMode.evaluate((toggle: any) => toggle.checked))) await developerMode.click();
  await extensions.close();
}

test.describe.serial('core loop', () => {
  test.beforeAll(async () => {
    server = createServer({ maxHeaderSize: 64 * 1024 }, (request, response) => {
      const host = String(request.headers.host).split(':')[0];
      const pathname = request.url?.split('?')[0] || '/';
      if (pathname === '/redirect.pdf') {
        if (
          request.headers['sec-fetch-dest'] === 'document' ||
          request.headers.accept?.includes('text/html')
        ) {
          response.end(article('Redirect PDF', '<h1>Redirect PDF</h1>'));
        } else {
          response.writeHead(302, { location: url('bank.test', '/redirected.pdf') });
          response.end();
        }
        return;
      }
      if (pathname === '/redirected.pdf') {
        response.setHeader('content-type', 'application/pdf');
        response.end(
          '%PDF-1.4\n1 0 obj\n<<>>\nendobj\nstream\nBT (Denied PDF) Tj ET\nendstream\n%%EOF',
        );
        return;
      }
      if (pathname === '/paper.pdf') {
        response.setHeader('content-type', 'application/pdf');
        response.end(
          '%PDF-1.4\n1 0 obj\n<<>>\nendobj\nstream\nBT (Hello PDF) Tj ET\nendstream\n%%EOF',
        );
        return;
      }
      if (pathname === '/outlined.pdf') {
        response.setHeader('content-type', 'application/pdf');
        response.end(
          [
            '%PDF-1.4',
            '1 0 obj\n<< /Type /Catalog /Pages 2 0 R /Outlines 6 0 R >>\nendobj',
            '2 0 obj\n<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>\nendobj',
            '3 0 obj\n<< /Type /Page /Parent 2 0 R /Contents 5 0 R >>\nendobj',
            '4 0 obj\n<< /Type /Page /Parent 2 0 R /Contents 7 0 R >>\nendobj',
            '5 0 obj\n<< /Length 24 >>\nstream\nBT (First page) Tj ET\nendstream\nendobj',
            '7 0 obj\n<< /Length 25 >>\nstream\nBT (Second page) Tj ET\nendstream\nendobj',
            '6 0 obj\n<< /Type /Outlines /First 8 0 R >>\nendobj',
            '8 0 obj\n<< /Title (Chapter one) /Parent 6 0 R /Dest [3 0 R /Fit] /Next 9 0 R >>\nendobj',
            '9 0 obj\n<< /Title (Chapter two) /Parent 6 0 R /Dest [4 0 R /Fit] >>\nendobj',
          ].join('\n'),
        );
        return;
      }
      if (pathname === '/slow.pdf') {
        response.setHeader('content-type', 'application/pdf');
        response.flushHeaders();
        return;
      }
      if (pathname === '/stall') {
        response.setHeader('content-type', 'text/html');
        response.flushHeaders();
        return;
      }
      if (pathname === '/reload-close') {
        reloadCloseRequests += 1;
        if (reloadCloseRequests === 1) {
          response.end(article('Reload close', '<h1>Reload close</h1><p>Ready.</p>'));
        } else {
          response.setHeader('content-type', 'text/html');
          response.flushHeaders();
        }
        return;
      }
      if (pathname === '/delayed') {
        delayedRequests += 1;
        response.setHeader('content-type', 'text/html');
        response.flushHeaders();
        delayedRelease = () => {
          delayedRelease = undefined;
          response.end(
            article('Delayed page', '<h1>Delayed page</h1><p>Loaded after waiting.</p>'),
          );
        };
        return;
      }
      if (pathname === '/delayed-query') {
        delayedRequests += 1;
        response.setHeader('content-type', 'text/html');
        response.flushHeaders();
        delayedRelease = () => {
          delayedRelease = undefined;
          response.end(
            article('Delayed query', '<h1>Delayed query</h1><p>Query loaded after waiting.</p>'),
          );
        };
        return;
      }
      if (pathname === '/delayed-selection') {
        delayedRequests += 1;
        response.setHeader('content-type', 'text/html');
        response.flushHeaders();
        delayedRelease = () => {
          delayedRelease = undefined;
          response.end(
            article(
              'Delayed selection',
              '<p id="selected">Selected after waiting.</p><script>const node=document.querySelector("#selected");const range=document.createRange();range.selectNodeContents(node);const selection=window.getSelection();selection.removeAllRanges();selection.addRange(range);</script>',
            ),
          );
        };
        return;
      }
      if (pathname === '/delayed-pause') {
        delayedRequests += 1;
        response.setHeader('content-type', 'text/html');
        response.flushHeaders();
        delayedRelease = () => {
          delayedRelease = undefined;
          response.end(article('Delayed pause', '<h1>Delayed pause</h1><p>Private result.</p>'));
        };
        return;
      }
      if (pathname === '/delayed-abort') {
        delayedRequests += 1;
        response.setHeader('content-type', 'text/html');
        response.flushHeaders();
        delayedRelease = () => {
          delayedRelease = undefined;
          response.end(article('Delayed abort', '<h1>Delayed abort</h1><p>Read once.</p>'));
        };
        return;
      }
      if (pathname === '/guard-race') {
        response.end(article('Guard race', '<h1>Guard race</h1><p>Guard race source text.</p>'));
        return;
      }
      if (pathname === '/hierarchy') {
        response.end(
          article(
            'Nested headings',
            '<h1>Root</h1><h2>First</h2><h3>Child</h3><p>Deep text.</p><h2>Second</h2><p>Sibling answer.</p><pre><code># Code example\n## Code child</code></pre><h1>Next</h1><p>Final answer.</p>',
          ),
        );
        return;
      }
      if (pathname === '/escaped-pages') {
        response.end(
          article(
            'Escaped pages',
            Array.from(
              { length: 24 },
              (_, index) =>
                `<p>Row ${String(index).padStart(3, '0')} has "quoted text", backslashes \\path\\file and 🐈 Unicode.</p>`,
            ).join(''),
          ),
        );
        return;
      }
      if (host === 'long.test') {
        response.end(
          article(
            'Long article',
            '<nav>Navigation noise</nav><article>' +
              longSection('Long article', 3_500) +
              longSection('Second section', 2_000) +
              '</article>',
          ),
        );
        return;
      }
      if (host === 'plain.test') {
        response.end(article('Plain long page', 'plain '.repeat(12_000)));
        return;
      }
      if (host === 'feed.test') {
        response.end(article('Feed page', '<div role="feed"><p>Feed item one.</p></div>'));
        return;
      }
      if (host === 'credentials.test') {
        response.end(
          article(
            'https://user:pass@example.test/title',
            `<h1>Credential links</h1><p><a href="https://user:pass@example.test/private">private link</a></p>
            <p><a href="//user:relative-secret@relative.test/private">relative link</a></p>
            <p><a href="https://user:pa'ss@quoted.test/private">quoted link</a></p>`,
          ),
        );
        return;
      }
      if (host === 'bank.test') {
        response.end(article('Private account', '<h1>Private account</h1><p>Secret details.</p>'));
        return;
      }
      if (pathname === '/cache') {
        response.end(article('Cache page', `<p>Cache version ${cacheVersion}</p>`));
        return;
      }
      const title = pathname.includes('github')
        ? 'GitHub issue'
        : pathname.includes('second-window')
          ? 'Second window'
          : 'Article title';
      response.end(
        article(
          title,
          '<h1>Heading</h1><p>Hello from the fixture.</p><h2>Details</h2><p>Some details.</p>',
        ),
      );
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    port = typeof address === 'object' && address ? address.port : 0;
    await launch();
    await context.pages()[0]?.goto(url('article.test', '/article'));
    await expect
      .poll(
        async () => {
          try {
            return (await cli('--browser', 'chromium', 'tabs')).stdout;
          } catch {
            return '';
          }
        },
        { timeout: 10_000 },
      )
      .toContain('Article title');
  });

  test.afterAll(async () => {
    await context?.close();
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    if (!process.env.KEEP_E2E && home) await rm(home, { recursive: true, force: true });
    if (!process.env.KEEP_E2E && userData) await rm(userData, { recursive: true, force: true });
  });

  test('lists tabs and reads a whole page without changing focus', async () => {
    const second = await context.newPage();
    await second.goto(url('article.test', '/article?second=1'));
    const tabs = await command('--browser', 'chromium', 'tabs');
    const id = tabs.stdout.match(/(\d+)\s+[* ]\s*[z ]\s+article\.test/)?.[1];
    expect(id).toBeTruthy();
    const read = await command('--browser', 'chromium', 'read', id!);
    expect(read.stdout).toContain('Hello from the fixture');
    const short = await command('--browser', 'chromium', 'read', id!, '--max-chars', '100');
    expect(short.stdout.length).toBeLessThanOrEqual(100);
    expect(short.stdout).not.toContain('Hello from the fixture');
    let retried = short;
    for (
      let attempt = 0;
      attempt < 8 && !retried.stdout.includes('Hello from the fixture');
      attempt++
    ) {
      const next = /(?:next|more): cobrowser (.+)/.exec(retried.stdout)?.[1];
      expect(next).toBeTruthy();
      retried = await command(...next!.split(' '));
    }
    expect(retried.stdout).toContain('Hello from the fixture');
  });

  test('reports the extension as connected after the handshake', async () => {
    const browsers = await cli('browsers');
    expect(browsers.stdout).toContain('chromium\trunning\tconnected');
    const status = await helperRequest('status', {});
    expect(status).toMatchObject({ data: { extensionVersion: '0.1.0' } });
    const capped = await cli('browsers', '--json', '--max-chars', '20');
    expect(capped.stdout.length).toBeLessThanOrEqual(20);
    expect(JSON.parse(capped.stdout)).toEqual(expect.any(Array));
    const tiny = await cli('browsers', '--json', '--max-chars', '1');
    expect(tiny.stdout).toBe('0');
  });

  test('reconnects after an extension reload without changing browser state', async () => {
    const before = await invariant();
    const previous = await worker();
    const reloaded = context.waitForEvent('serviceworker', {
      predicate: (item) => item !== previous,
    });
    expect(await helperRequest('restart', {})).toMatchObject({ ok: true });
    const replacement = await reloaded;
    await expect
      .poll(
        () =>
          replacement.evaluate(async () => (await chrome.storage.local.get('connected')).connected),
        { timeout: 10_000 },
      )
      .toBe(true);
    await command('--browser', 'chromium', 'tabs');
    expectInvariantUnchanged(before, await invariant());
  });

  test('restarts the helper without closing the extension UI when a reload is unnecessary', async () => {
    const options = await context.newPage();
    await options.goto(`chrome-extension://${extensionId}/options.html`);
    try {
      const before = await invariant();
      const serviceWorker = await worker();
      const reconnected = serviceWorker
        .evaluate(
          () =>
            new Promise<string>((resolve) => {
              let disconnected = false;
              const listener = (
                changes: Record<string, chrome.storage.StorageChange>,
                area: string,
              ) => {
                if (area !== 'local' || !changes.connected) return;
                if (changes.connected.newValue === false) disconnected = true;
                if (disconnected && changes.connected.newValue === true) {
                  chrome.storage.onChanged.removeListener(listener);
                  resolve('connected');
                }
              };
              chrome.storage.onChanged.addListener(listener);
            }),
        )
        .then(
          (value) => ({ value }),
          (error) => ({ error: String(error) }),
        );
      await serviceWorker.evaluate(() => undefined);
      expect(await helperRequest('restart', { reloadExtension: false })).toMatchObject({
        ok: true,
      });
      expect(await reconnected).toEqual({ value: 'connected' });
      expect(context.serviceWorkers()).toContain(serviceWorker);
      expect(await options.title()).toBe('cobrowser options');
      expect(await invariant()).toEqual(before);
      expect(await helperRequest('restart', { reloadExtension: 'false' })).toMatchObject({
        ok: false,
        error: { code: 'BAD_REQUEST' },
      });
      expect((await cli('--browser', 'chromium', 'tabs')).stdout).toContain('Article title');
    } finally {
      await options.close();
    }
  });

  test('follows capped tab lists without skipping rows through any interface', async () => {
    const pages = [];
    try {
      for (let index = 0; index < 8; index++) {
        const page = await context.newPage();
        pages.push(page);
        await page.goto(url('article.test', `/capped-tabs-${index}`));
        await page.evaluate((number) => {
          document.title = `Capped tab ${number} with "quotes"`;
        }, index);
      }
      const all = JSON.parse(
        (await command('--browser', 'chromium', 'tabs', '--match', 'capped-tabs-', '--json'))
          .stdout,
      ).data.tabs;
      for (const transport of ['socket', 'json', 'mcp']) {
        const before = await invariant();
        const seen: number[] = [];
        let offset = 0;
        for (let attempt = 0; attempt < 10; attempt++) {
          const args = { match: 'capped-tabs-', offset, maxChars: 360 };
          let text: string;
          if (transport === 'socket') {
            const result = await helperRequest('tabs', args);
            expect(JSON.stringify(result).length).toBeLessThanOrEqual(360);
            text = String(result.text || '');
          } else if (transport === 'json') {
            const result = await command(
              '--browser',
              'chromium',
              'tabs',
              '--match',
              args.match,
              '--offset',
              String(offset),
              '--max-chars',
              '360',
              '--json',
            );
            expect(result.stdout.length).toBeLessThanOrEqual(360);
            text = JSON.parse(result.stdout).text;
          } else {
            const [result] = await mcp({
              jsonrpc: '2.0',
              id: attempt,
              method: 'tools/call',
              params: { name: 'list_tabs', arguments: args },
            });
            expect(JSON.stringify(result).length).toBeLessThanOrEqual(360);
            text = result.result.content[0].text;
          }
          const rows = [...text.matchAll(/^(\d+)\s+[*z ]+\s*article\.test/gm)].map((match) =>
            Number(match[1]),
          );
          expect(rows.length).toBeGreaterThan(0);
          seen.push(...rows);
          const next = /more: cobrowser tabs .*--offset (\d+)/.exec(text);
          if (!next) break;
          expect(Number(next[1])).toBe(offset + rows.length);
          offset = Number(next[1]);
        }
        expect(seen).toEqual(all.map((tab: { id: number }) => tab.id));
        expectInvariantUnchanged(before, await invariant());
      }
    } finally {
      for (const page of pages) await page.close();
    }
  });

  test('uses the same nested sections for outlines, reads and search', async () => {
    const page = await context.newPage();
    try {
      await page.goto(url('article.test', '/hierarchy'));
      const id = await (
        await worker()
      ).evaluate(
        async (pageUrl) => (await chrome.tabs.query({})).find((tab) => tab.url === pageUrl)!.id!,
        page.url(),
      );
      const before = await invariant();
      const result = await helperRequest('read', { id, full: true });
      expect(
        (result.data as any).sections.map((section: any) => [section.number, section.title]),
      ).toEqual([
        ['1', 'Root'],
        ['1.1', 'First'],
        ['1.1.1', 'Child'],
        ['1.2', 'Second'],
        ['2', 'Next'],
      ]);
      const section = await command(
        '--browser',
        'chromium',
        'read',
        String(id),
        '--section',
        '1.2',
        '--full',
      );
      expect(section.stdout).toContain('Sibling answer.');
      expect(section.stdout).toContain('# Code example');
      expect(section.stdout).not.toContain('Final answer.');
      const found = await command('--browser', 'chromium', 'find', String(id), 'Sibling answer');
      expect(found.stdout).toContain('[1.2]');
      expectInvariantUnchanged(before, await invariant());
    } finally {
      await page.close();
    }
  });

  test('preserves every page when switching between MCP, JSON and socket reads', async () => {
    const page = await context.newPage();
    try {
      await page.goto(url('article.test', '/escaped-pages'));
      const id = await (
        await worker()
      ).evaluate(
        async (pageUrl) => (await chrome.tabs.query({})).find((tab) => tab.url === pageUrl)!.id!,
        page.url(),
      );
      const before = await invariant();
      const complete = await helperRequest('read', { id, full: true });
      const bodyOf = (text: string) =>
        text
          .split(/\n\n(?:next|more): /)[0]
          .split('\n\n')
          .slice(1)
          .join('\n\n');
      const bodies: string[] = [];
      let args: Record<string, any> = { id, full: true, page: 1, maxChars: 700 };
      for (let index = 0; index < 40; index++) {
        let text: string;
        if (index % 3 === 0) {
          const [result] = await mcp({
            jsonrpc: '2.0',
            id: 'long request '.repeat(index + 1).slice(0, 240),
            method: 'tools/call',
            params: { name: 'read_tab', arguments: args },
          });
          expect(JSON.stringify(result).length).toBeLessThanOrEqual(args.maxChars);
          text = result.result.content[0].text;
        } else if (index % 3 === 1) {
          const result = await command(
            '--browser',
            'chromium',
            'read',
            String(id),
            '--full',
            '--page',
            String(args.page),
            '--page-size',
            String(args.pageSize),
            '--max-chars',
            String(args.maxChars),
            '--json',
          );
          expect(result.stdout.length).toBeLessThanOrEqual(args.maxChars);
          text = JSON.parse(result.stdout).text;
        } else {
          const result = await helperRequest('read', args);
          expect(JSON.stringify(result).length).toBeLessThanOrEqual(args.maxChars);
          text = String(result.text);
        }
        const next = /\n\n(next|more): (.+)$/.exec(text);
        if (next?.[1] !== 'more') bodies.push(bodyOf(text));
        if (!next) break;
        const value = (flag: string) => Number(new RegExp(`${flag} (\\d+)`).exec(next[2])?.[1]);
        args = {
          id,
          full: true,
          page: value('--page'),
          pageSize: value('--page-size'),
          maxChars: value('--max-chars'),
        };
        expect(Number.isSafeInteger(args.pageSize)).toBe(true);
        expect(index).toBeLessThan(39);
      }
      expect(bodies.join(' ').replace(/\s+/g, ' ').trim()).toBe(
        bodyOf(String(complete.text)).replace(/\s+/g, ' ').trim(),
      );
      expectInvariantUnchanged(before, await invariant());
    } finally {
      await page.close();
    }
  });

  test('keeps selected passwords inside the browser', async () => {
    const page = await context.newPage();
    try {
      await page.goto(url('article.test', '/password-selection'));
      await page.evaluate(() => {
        const input = document.createElement('input');
        input.type = 'password';
        input.value = 'private-selected-password';
        document.body.append(input);
        input.focus();
        input.select();
      });
      const id = await (
        await worker()
      ).evaluate(
        async (pageUrl) => (await chrome.tabs.query({})).find((tab) => tab.url === pageUrl)!.id!,
        page.url(),
      );
      const before = await invariant();
      const result = await helperRequest('selection', { id });
      expect(result).toMatchObject({ ok: false, error: { code: 'DENIED' } });
      expect(JSON.stringify(result)).not.toContain('private-selected-password');
      const [response] = await mcp({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'get_selection', arguments: { id } },
      });
      expect(response.result.isError).toBe(true);
      expectInvariantUnchanged(before, await invariant());
    } finally {
      await page.close();
    }
  });

  test('records Unicode agent names without invalid HTTP headers', async () => {
    const before = await invariant();
    const id = await (
      await worker()
    ).evaluate(
      async () =>
        (await chrome.tabs.query({})).find((tab) => tab.url?.includes('article.test'))!.id!,
    );
    for (const [name, expected] of [
      ['Trợ lý 🐈 50%', 'Trợ lý 🐈 50%'],
      [`${'a'.repeat(119)}🐈`, 'a'.repeat(119)],
      ['agent\ud800', 'agent'],
    ]) {
      const responses = await mcp(
        { jsonrpc: '2.0', id: 1, method: 'initialize', params: { clientInfo: { name } } },
        {
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: { name: 'read_tab', arguments: { id } },
        },
      );
      expect(responses[1].result.isError).toBeUndefined();
      const log = await helperRequest('log', { limit: 1 });
      expect((log.data as any[])[0].agent).toBe(expected);
    }
    expectInvariantUnchanged(before, await invariant());
  });

  test('reinstalls setup directories without leaving stale files', async () => {
    const rootDir = await mkdtemp(path.join(tmpdir(), 'cobrowser-setup-'));
    const setupHome = path.join(rootDir, 'home');
    const userHome = path.join(rootDir, 'user');
    const nativeHosts = path.join(rootDir, 'native-hosts');
    const emptyPath = path.join(rootDir, 'empty-path');
    const existingSkill = path.join(rootDir, 'existing-skill');
    const canonicalSkill = path.join(userHome, '.agents', 'skills', 'cobrowser');
    await mkdir(emptyPath, { recursive: true });
    await mkdir(path.dirname(canonicalSkill), { recursive: true });
    await mkdir(existingSkill, { recursive: true });
    const userSkill = '---\nname: cobrowser\n---\nuser-owned skill';
    await writeFile(path.join(existingSkill, 'SKILL.md'), userSkill);
    await symlink(existingSkill, canonicalSkill, 'dir');
    const setupEnv = {
      ...process.env,
      COBROWSER_HOME: setupHome,
      HOME: userHome,
      PATH: emptyPath,
      FORCE_COLOR: undefined,
      NO_COLOR: undefined,
    };
    const runSetup = () =>
      exec(
        process.execPath,
        [
          path.join(root, 'dist/cli.js'),
          'setup',
          '--browser',
          'opera',
          '--native-hosts-dir',
          nativeHosts,
        ],
        {
          env: setupEnv,
        },
      );
    try {
      await runSetup();
      const runtime = path.join(setupHome, 'runtime', '0.1.0');
      const extension = path.join(setupHome, 'extension');
      await writeFile(path.join(runtime, 'stale-runtime.txt'), 'stale');
      await writeFile(path.join(extension, 'stale-extension.txt'), 'stale');
      await runSetup();
      expect(existsSync(path.join(runtime, 'stale-runtime.txt'))).toBe(false);
      expect(existsSync(path.join(extension, 'stale-extension.txt'))).toBe(false);
      expect(existsSync(path.join(runtime, 'cli.js'))).toBe(true);
      expect(existsSync(path.join(runtime, 'client.js'))).toBe(true);
      expect(existsSync(path.join(runtime, 'extension', 'service-worker.js'))).toBe(true);
      expect(existsSync(path.join(extension, 'manifest.json'))).toBe(true);
      expect(existsSync(path.join(runtime, 'skills', 'cobrowser', 'SKILL.md'))).toBe(true);
      expect(existsSync(path.join(nativeHosts, 'cobrowser.json'))).toBe(true);
      expect((await lstat(canonicalSkill)).isSymbolicLink()).toBe(true);
      expect(await readlink(canonicalSkill)).toBe(existingSkill);
      expect(await readFile(path.join(existingSkill, 'SKILL.md'), 'utf8')).toBe(userSkill);
      const healthy = await exec(
        process.execPath,
        [path.join(root, 'dist/cli.js'), 'doctor', '--json'],
        { env: setupEnv },
      );
      expect(JSON.parse(healthy.stdout)).toMatchObject({ ok: true });
      await rm(path.join(extension, 'service-worker.js'));
      const brokenExtension = await exec(
        process.execPath,
        [path.join(root, 'dist/cli.js'), 'doctor', '--json'],
        { env: setupEnv },
      ).catch((error) => error);
      expect(brokenExtension.stdout).toContain('restore the extension files');
      await runSetup();
      await writeFile(path.join(setupHome, 'hosts', 'opera'), '#!/bin/sh\nexit 0\n');
      const brokenLauncher = await exec(
        process.execPath,
        [path.join(root, 'dist/cli.js'), 'doctor', '--json'],
        { env: setupEnv },
      ).catch((error) => error);
      expect(brokenLauncher.stdout).toContain('recreate the opera launcher');
      await runSetup();
      await rm(path.join(setupHome, 'hosts', 'opera'), { force: true });
      await rm(path.join(nativeHosts, 'cobrowser.json'), { force: true });
      const missingCustom = await exec(
        process.execPath,
        [path.join(root, 'dist/cli.js'), 'doctor', '--json'],
        { env: setupEnv },
      ).catch((error) => error);
      expect(missingCustom.stdout).toContain('reinstall the opera native host');
      const configuredStatus = await exec(
        process.execPath,
        [path.join(root, 'dist/cli.js'), 'browsers', '--json'],
        { env: setupEnv },
      );
      expect(JSON.parse(configuredStatus.stdout)).toEqual(
        expect.arrayContaining([{ browser: 'opera', running: false }]),
      );
      const runChromeSetup = () =>
        exec(process.execPath, [path.join(root, 'dist/cli.js'), 'setup', '--browser', 'chrome'], {
          env: setupEnv,
        });
      await runChromeSetup();
      const config = JSON.parse(await readFile(path.join(setupHome, 'config.json'), 'utf8')) as {
        configuredBrowsers?: unknown;
        nativeHosts?: Array<{ browser?: unknown; directory?: unknown }>;
      };
      expect(config.configuredBrowsers).toEqual(expect.arrayContaining(['chrome', 'opera']));
      const chromeDirectory = config.nativeHosts?.find(
        (entry) => entry.browser === 'chrome',
      )?.directory;
      expect(typeof chromeDirectory).toBe('string');
      await rm(path.join(setupHome, 'hosts', 'chrome'), { force: true });
      await rm(path.join(chromeDirectory as string, 'cobrowser.json'), { force: true });
      const missingBuiltIn = await exec(
        process.execPath,
        [path.join(root, 'dist/cli.js'), 'doctor', '--json'],
        { env: setupEnv },
      ).catch((error) => error);
      expect(missingBuiltIn.stdout).toContain('reinstall the chrome native host');
      await rm(path.join(runtime, 'extension', 'service-worker.js'));
      const broken = await exec(
        process.execPath,
        [path.join(root, 'dist/cli.js'), 'doctor', '--json'],
        {
          env: setupEnv,
        },
      ).catch((error) => error);
      expect(JSON.parse(broken.stdout)).toMatchObject({ ok: false });
      expect(broken.stdout).toContain('install runtime 0.1.0');
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  test('preserves a user-owned real skill directory', async () => {
    const rootDir = await mkdtemp(path.join(tmpdir(), 'cobrowser-skill-'));
    const setupHome = path.join(rootDir, 'home');
    const userHome = path.join(rootDir, 'user');
    const nativeHosts = path.join(rootDir, 'native-hosts');
    const emptyPath = path.join(rootDir, 'empty-path');
    const skill = path.join(userHome, '.agents', 'skills', 'cobrowser');
    await mkdir(emptyPath, { recursive: true });
    await mkdir(skill, { recursive: true });
    await writeFile(path.join(skill, 'SKILL.md'), 'user-owned skill');
    await writeFile(path.join(skill, 'notes.txt'), 'keep this file');
    const setupEnv = {
      ...process.env,
      COBROWSER_HOME: setupHome,
      HOME: userHome,
      PATH: emptyPath,
      FORCE_COLOR: undefined,
      NO_COLOR: undefined,
    };
    try {
      const result = await exec(
        process.execPath,
        [
          path.join(root, 'dist/cli.js'),
          'setup',
          '--browser',
          'opera',
          '--native-hosts-dir',
          nativeHosts,
        ],
        { env: setupEnv },
      );
      expect(result.stdout).toContain('left the existing skill');
      expect(await readFile(path.join(skill, 'SKILL.md'), 'utf8')).toBe('user-owned skill');
      expect(await readFile(path.join(skill, 'notes.txt'), 'utf8')).toBe('keep this file');
      expect(existsSync(path.join(skill, '.cobrowser-managed'))).toBe(false);
      const doctor = await exec(
        process.execPath,
        [path.join(root, 'dist/cli.js'), 'doctor', '--json'],
        { env: setupEnv },
      ).catch((error) => error);
      expect(doctor.stdout).toContain('install the agent skill');
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  test('keeps the browser choice in continuations when helpers are ambiguous', async () => {
    const extraSocket = path.join(home, 'run', 'other.sock');
    await writeFile(extraSocket, '');
    try {
      const tabs = await command('--browser', 'chromium', 'tabs', '--limit', '1');
      expect(tabs.stdout).toContain('more: cobrowser --browser chromium tabs --limit 1 --offset 1');
    } finally {
      await rm(extraSocket, { force: true });
    }
  });

  test('invalidates cached content after a same-url reload', async () => {
    cacheVersion = 1;
    const page = await context.newPage();
    await page.goto(url('article.test', '/cache'));
    const tabs = await command('--browser', 'chromium', 'tabs', '--match', 'cache');
    const id = tabs.stdout.match(/(\d+)\s+[* ]?\s*[z ]?\s+article\.test/)?.[1];
    expect(id).toBeTruthy();
    const first = await command('--browser', 'chromium', 'read', id!);
    expect(first.stdout).toContain('Cache version 1');
    cacheVersion = 2;
    await page.reload();
    const second = await command('--browser', 'chromium', 'read', id!);
    expect(second.stdout).toContain('Cache version 2');
  });

  test('evicts old converted pages from the bounded cache', async () => {
    const pages = [];
    try {
      for (let index = 0; index < 33; index++) {
        const page = await context.newPage();
        pages.push(page);
        await page.goto(url('article.test', `/cache-bound-${index}`));
      }
      const ids = await (
        await worker()
      ).evaluate(
        (paths) =>
          chrome.tabs.query({}).then((tabs) =>
            paths.map((pathname) => {
              const tab = tabs.find((candidate) => candidate.url?.endsWith(pathname));
              return tab?.id ?? -1;
            }),
          ),
        pages.map((page) => new URL(page.url()).pathname),
      );
      expect(ids.every((id) => id > 0)).toBe(true);
      const firstId = ids[0];
      const firstRead = await command(
        '--browser',
        'chromium',
        'read',
        ...ids.map(String),
        '--full',
      );
      expect(firstRead.stdout).toContain('Article title');
      await pages[0].evaluate(() => {
        document.body.innerHTML = '<h1>Evicted content</h1><p>The old cache entry is gone.</p>';
      });
      const reread = await command('--browser', 'chromium', 'read', String(firstId), '--full');
      expect(reread.stdout).toContain('Evicted content');
    } finally {
      await Promise.all(pages.map((page) => page.close()));
    }
  });

  test('keeps a background tab and its scroll position unchanged', async () => {
    const background = await context.newPage();
    await background.goto(url('long.test', '/background'));
    await background.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    const foreground = await context.newPage();
    await foreground.goto(url('article.test', '/foreground'));
    const beforeScroll = await background.evaluate(() => ({ scrollX, scrollY }));
    expect(beforeScroll.scrollY).toBeGreaterThan(0);
    const tabs = await command('--browser', 'chromium', 'tabs', '--match', 'background');
    const id = tabs.stdout.match(/(\d+)\s+[* ]?\s*[z ]?\s+long\.test/)?.[1];
    expect(id).toBeTruthy();
    const read = await command('--browser', 'chromium', 'read', id!);
    expect(read.stdout).toContain('Long article');
    await expect
      .poll(() => background.evaluate(() => ({ scrollX, scrollY })))
      .toEqual(beforeScroll);
  });

  test('lists tabs from multiple normal windows without changing focus', async () => {
    const createdWindowId = await (
      await worker()
    ).evaluate(
      async (targetUrl) => {
        const created = await chrome.windows.create({
          type: 'normal',
          focused: false,
          url: targetUrl,
        });
        return created?.id ?? -1;
      },
      url('article.test', '/second-window'),
    );
    expect(createdWindowId).toBeGreaterThan(0);
    try {
      await expect
        .poll(
          async () => {
            try {
              return (await cli('--browser', 'chromium', 'tabs', '--match', 'second-window'))
                .stdout;
            } catch {
              return '';
            }
          },
          { timeout: 10_000 },
        )
        .toContain('Second window');
      const tabs = await command('--browser', 'chromium', 'tabs', '--match', 'second-window');
      expect(tabs.stdout).toContain('Second window');
    } finally {
      await (
        await worker()
      ).evaluate((windowId) => chrome.windows.remove(windowId), createdWindowId);
    }
  });

  test('filters tabs and keeps newest opened first', async () => {
    const github = await context.newPage();
    await github.goto(url('article.test', '/github'));
    const newest = await context.newPage();
    await newest.goto(url('feed.test', '/feed'));
    const matched = await command('--browser', 'chromium', 'tabs', '--match', 'github');
    expect(matched.stdout).toContain('GitHub issue');
    const filteredPage = await command(
      '--browser',
      'chromium',
      'tabs',
      '--match',
      'article',
      '--limit',
      '1',
    );
    expect(filteredPage.stdout).toContain(
      'more: cobrowser tabs --match article --limit 1 --offset 1',
    );
    const recent = await command('--browser', 'chromium', 'tabs', '--since', '30m');
    expect(recent.stdout).toContain('feed.test');
    const front = await command('--browser', 'chromium', 'tabs', '--window', 'front');
    expect(front.stdout).toContain('feed.test');
    const active = await command('--browser', 'chromium', 'tabs', '--window', 'front', '--active');
    expect(active.stdout).toContain('feed.test');
    const limited = await command('--browser', 'chromium', 'tabs', '--limit', '1');
    expect(limited.stdout).toContain('more: cobrowser tabs --limit 1 --offset 1');
    const offset = await command('--browser', 'chromium', 'tabs', '--limit', '1', '--offset', '1');
    expect(offset.stdout).not.toContain('more: cobrowser tabs --offset 0');
    const ordered = await command('--browser', 'chromium', 'tabs', '--limit', '2');
    expect(ordered.stdout.indexOf('feed.test')).toBeLessThan(
      ordered.stdout.indexOf('article.test'),
    );
  });

  test('reads outlines, sections and pages', async () => {
    const page = await context.newPage();
    await page.goto(url('long.test', '/long'));
    const second = await context.newPage();
    await second.goto(url('long.test', '/long-second'));
    const tabs = await command('--browser', 'chromium', 'tabs', '--match', 'long', '--limit', '2');
    const ids = [...tabs.stdout.matchAll(/(\d+)\s+[* ]?\s*[z ]?\s+long\.test/g)].map(
      (match) => match[1],
    );
    const id = ids[1];
    const secondId = ids[0];
    expect(id).toBeTruthy();
    expect(secondId).toBeTruthy();
    const outline = await command('--browser', 'chromium', 'read', id!);
    expect(outline.stdout).toContain('next: cobrowser read');
    const section = await command('--browser', 'chromium', 'read', id!, '--section', '0');
    expect(section.stdout).toContain('Long article paragraph');
    const sectionPage = await command(
      '--browser',
      'chromium',
      'read',
      id!,
      '--section',
      '0',
      '--page',
      '2',
      '--max-chars',
      '900',
    );
    expect(sectionPage.stdout).toContain('Long article paragraph');
    expect(sectionPage.stdout.length).toBeLessThanOrEqual(900);
    expect(sectionPage.stdout).toMatch(
      new RegExp(
        `next: cobrowser read ${id} --section 0 --page 3 --page-size \\d+ --max-chars 900`,
      ),
    );
    const combined = await command(
      '--browser',
      'chromium',
      'read',
      id!,
      secondId!,
      '--section',
      '0',
      '--max-chars',
      '900',
    );
    expect(combined.stdout).toMatch(
      new RegExp(
        `next: cobrowser read ${id}(?: --section 0 --page 2 --page-size \\d+ --max-chars 900| ${secondId} --section 0 --max-chars 1800)`,
      ),
    );
    const pageOne = await command(
      '--browser',
      'chromium',
      'read',
      id!,
      '--page',
      '1',
      '--max-chars',
      '900',
    );
    expect(pageOne.stdout.length).toBeLessThanOrEqual(900);

    const rawFind = await helperRequest('find', {
      id: Number(id),
      query: 'Navigation noise',
      full: true,
      links: true,
    });
    expect(rawFind).toMatchObject({ ok: true, data: { matches: [] } });
  });

  test('reads a sleeping tab and reports the reload', async () => {
    const sleeping = await context.newPage();
    await sleeping.goto(url('article.test', '/sleeping'));
    const other = await context.newPage();
    await other.goto(url('article.test', '/article?awake=1'));
    const tabs = await command('--browser', 'chromium', 'tabs', '--match', 'sleeping');
    const id = tabs.stdout.match(/(\d+)\s+[* ]?\s*[z ]?\s+article\.test/)?.[1];
    expect(id).toBeTruthy();
    const firstRead = await command('--browser', 'chromium', 'read', id!);
    expect(firstRead.stdout).toContain('Hello from the fixture');
    const discardedId = await (
      await worker()
    ).evaluate(async (tabId: number) => {
      return (await chrome.tabs.discard(tabId))!.id!;
    }, Number(id));
    const read = await command('--browser', 'chromium', 'read', String(discardedId));
    expect(read.stdout).toContain('page was asleep and has been reloaded');
    const secondRead = await command('--browser', 'chromium', 'read', String(discardedId));
    expect(secondRead.stdout).not.toContain('page was asleep and has been reloaded');
  });

  test('waits for a loading navigation before reading', async () => {
    const loading = await context.newPage();
    const delayedUrl = url('article.test', '/delayed');
    try {
      await loading.goto(url('article.test', '/article?before-delayed=1'));
      await loading.goto(delayedUrl, { waitUntil: 'commit' });
      const foreground = await context.newPage();
      try {
        await foreground.goto(url('article.test', '/article?delayed=1'));
        const id = await (
          await worker()
        ).evaluate(async (href: string) => {
          return (await chrome.tabs.query({ url: href }))[0]?.id?.toString();
        }, delayedUrl);
        expect(id).toBeTruthy();
        const before = await invariant();
        const readPromise = cli('--browser', 'chromium', 'read', id!);
        await expect.poll(() => Boolean(delayedRelease), { timeout: 5_000 }).toBe(true);
        delayedRelease?.();
        const read = await readPromise;
        expect(read.stdout).toMatch(/## \d+ · article\.test · Delayed page/);
        expect(read.stdout).toContain('Loaded after waiting.');
        expectInvariantUnchanged(before, await invariant());
      } finally {
        await foreground.close();
      }
    } finally {
      delayedRelease?.();
      delayedRelease = undefined;
      await loading.close();
    }
  });

  test('waits for a loading navigation before querying', async () => {
    const loading = await context.newPage();
    const delayedUrl = url('article.test', '/delayed-query');
    delayedRequests = 0;
    try {
      await loading.goto(url('article.test', '/article?before-delayed-query=1'));
      await loading.goto(delayedUrl, { waitUntil: 'commit' });
      const foreground = await context.newPage();
      try {
        await foreground.goto(url('article.test', '/article?delayed-query=1'));
        const id = await (
          await worker()
        ).evaluate(async (href: string) => {
          return (await chrome.tabs.query({ url: href }))[0]?.id?.toString();
        }, delayedUrl);
        expect(id).toBeTruthy();
        const before = await invariant();
        const queryPromise = cli('--browser', 'chromium', 'query', id!, 'h1');
        await expect.poll(() => Boolean(delayedRelease), { timeout: 5_000 }).toBe(true);
        expect(delayedRequests).toBe(1);
        delayedRelease?.();
        const query = await queryPromise;
        expect(query.stdout).toContain('1. Delayed query');
        expectInvariantUnchanged(before, await invariant());
      } finally {
        await foreground.close();
      }
    } finally {
      delayedRelease?.();
      delayedRelease = undefined;
      await loading.close();
    }
  });

  test('waits for a loading navigation before reading selection', async () => {
    const loading = await context.newPage();
    const delayedUrl = url('article.test', '/delayed-selection');
    delayedRequests = 0;
    try {
      await loading.goto(url('article.test', '/article?before-delayed-selection=1'));
      await loading.goto(delayedUrl, { waitUntil: 'commit' });
      const foreground = await context.newPage();
      try {
        await foreground.goto(url('article.test', '/article?delayed-selection=1'));
        const id = await (
          await worker()
        ).evaluate(async (href: string) => {
          return (await chrome.tabs.query({ url: href }))[0]?.id?.toString();
        }, delayedUrl);
        expect(id).toBeTruthy();
        const before = await invariant();
        const selectionPromise = cli('--browser', 'chromium', 'selection', id!);
        await expect.poll(() => Boolean(delayedRelease), { timeout: 5_000 }).toBe(true);
        expect(delayedRequests).toBe(1);
        delayedRelease?.();
        const selection = await selectionPromise;
        expect(selection.stdout).toContain('Selected after waiting.');
        expectInvariantUnchanged(before, await invariant());
      } finally {
        await foreground.close();
      }
    } finally {
      delayedRelease?.();
      delayedRelease = undefined;
      await loading.close();
    }
  });

  test('returns immediately when a reloading tab closes', async () => {
    const stalled = await context.newPage();
    const stalledUrl = url('article.test', '/reload-close');
    await stalled.goto(stalledUrl);
    const other = await context.newPage();
    await other.goto(url('article.test', '/article?reload-close=1'));
    const id = await (
      await worker()
    ).evaluate(async (href: string) => {
      return (await chrome.tabs.query({ url: href }))[0]?.id?.toString();
    }, stalledUrl);
    expect(id).toBeTruthy();
    const discardedId = await (
      await worker()
    ).evaluate(async (tabId: number) => {
      return (await chrome.tabs.discard(tabId))?.id?.toString();
    }, Number(id));
    expect(discardedId).toBeTruthy();

    const readPromise = cli('--browser', 'chromium', 'read', discardedId!).catch((error) => error);
    await expect
      .poll(
        async () =>
          (await (
            await worker()
          ).evaluate(async (tabId: number) => {
            try {
              const tab = await chrome.tabs.get(tabId);
              return `${Boolean(tab.discarded)}:${tab.status || ''}`;
            } catch {
              return 'missing';
            }
          }, Number(discardedId))) || 'missing',
        { timeout: 5_000 },
      )
      .toMatch(/false:loading/);

    await (
      await worker()
    ).evaluate(async (tabId: number) => {
      await chrome.tabs.remove(tabId);
    }, Number(discardedId));
    await expect.poll(() => stalled.isClosed()).toBe(true);
    const afterClose = await invariant();
    const error = await readPromise;
    expect(error.code).not.toBe(0);
    expect(error.stderr).toContain('TAB_NOT_FOUND');
    expectInvariantUnchanged(afterClose, await invariant());
    await other.close();
  });

  test('waits for a stalled loading query before timing out', async () => {
    const stalled = await context.newPage();
    const stalledUrl = url('article.test', '/stall');
    try {
      await stalled.goto(stalledUrl, { waitUntil: 'commit' });
      const tabs = await command('--browser', 'chromium', 'tabs', '--match', 'stall');
      const id = tabs.stdout.match(/(\d+)\s+[* ]?\s*[z ]?\s+article\.test/)?.[1];
      expect(id).toBeTruthy();
      const started = Date.now();
      const error = await failedCommand('--browser', 'chromium', 'query', id!, 'h1');
      expect(Date.now() - started).toBeGreaterThan(10_000);
      expect(Date.now() - started).toBeLessThan(20_000);
      expect(error.stderr).toContain('TIMEOUT');
    } finally {
      await stalled.close();
    }
  });

  test('discards an in-flight read when pause is enabled', async () => {
    const loading = await context.newPage();
    const delayedUrl = url('article.test', '/delayed-pause');
    try {
      await loading.goto(delayedUrl, { waitUntil: 'commit' });
      const foreground = await context.newPage();
      try {
        await foreground.goto(url('article.test', '/article?delayed-pause=1'));
        const id = await (
          await worker()
        ).evaluate(async (href: string) => {
          return (await chrome.tabs.query({ url: href }))[0]?.id?.toString();
        }, delayedUrl);
        expect(id).toBeTruthy();
        const beforeLog = existsSync(path.join(home, 'logs', 'reads.jsonl'))
          ? await readFile(path.join(home, 'logs', 'reads.jsonl'), 'utf8')
          : '';
        const readPromise = cli('--browser', 'chromium', 'read', id!).catch((error) => error);
        await expect.poll(() => Boolean(delayedRelease), { timeout: 5_000 }).toBe(true);
        await (await worker()).evaluate(() => chrome.storage.local.set({ paused: true }));
        delayedRelease?.();
        const error = await readPromise;
        expect(error.code).not.toBe(0);
        expect(error.stderr).toContain('PAUSED');
        const afterLog = existsSync(path.join(home, 'logs', 'reads.jsonl'))
          ? await readFile(path.join(home, 'logs', 'reads.jsonl'), 'utf8')
          : '';
        expect(afterLog.slice(beforeLog.length)).not.toContain('delayed-pause');
        await (await worker()).evaluate(() => chrome.storage.local.set({ paused: false }));
      } finally {
        await foreground.close();
      }
    } finally {
      delayedRelease?.();
      delayedRelease = undefined;
      await (await worker()).evaluate(() => chrome.storage.local.set({ paused: false }));
      await loading.close();
    }
  });

  test('caps output and handles denied and missing tabs', async () => {
    const plain = await context.newPage();
    await plain.goto(url('plain.test', '/plain'));
    const tabs = await command('--browser', 'chromium', 'tabs', '--match', 'plain');
    const plainId = tabs.stdout.match(/(\d+)\s+[* ]?\s*[z ]?\s+plain\.test/)?.[1];
    expect(plainId).toBeTruthy();
    const capped = await command('--browser', 'chromium', 'read', plainId!, '--max-chars', '500');
    expect(capped.stdout.length).toBeLessThanOrEqual(500);
    const json = await command(
      '--browser',
      'chromium',
      'read',
      plainId!,
      '--json',
      '--max-chars',
      '500',
    );
    expect(json.stdout.length).toBeLessThanOrEqual(500);
    expect(json.stdout).not.toContain('"markdown"');
    const rawQuery = await helperRequest('query', {
      id: Number(plainId),
      selector: 'body',
      maxChars: 180,
    });
    expect(JSON.stringify(rawQuery).length).toBeLessThanOrEqual(180);
    expect(rawQuery.data).toBeUndefined();
    const oversizedSelector = await helperRequest('query', {
      id: Number(plainId),
      selector: 'a'.repeat(10_001),
    });
    expect(oversizedSelector).toMatchObject({
      ok: false,
      error: { code: 'BAD_REQUEST', message: 'Use a shorter selector.' },
    });
    const oversizedSearch = await helperRequest('find', {
      id: Number(plainId),
      query: 'a'.repeat(10_001),
    });
    expect(oversizedSearch).toMatchObject({
      ok: false,
      error: { code: 'BAD_REQUEST', message: 'Use a shorter query.' },
    });
    const oversizedMatch = await helperRequest('tabs', { match: 'a'.repeat(10_001) });
    expect(oversizedMatch).toMatchObject({
      ok: false,
      error: { code: 'BAD_REQUEST', message: 'Use a shorter match.' },
    });
    const directSince = await helperRequest('tabs', { since: '30m', limit: 1 });
    expect(directSince).toMatchObject({ ok: true, data: { tabs: expect.any(Array) } });
    const invalidSince = await helperRequest('tabs', { since: 'sometime' });
    expect(invalidSince).toMatchObject({
      ok: false,
      error: { code: 'BAD_REQUEST', message: 'Use a duration such as 30m or 2h.' },
    });
    const mismatchedSince = await helperRequest('tabs', { since: '30m', sinceMs: 1 });
    expect(mismatchedSince).toMatchObject({
      ok: false,
      error: { code: 'BAD_REQUEST', message: 'The since and sinceMs filters must agree.' },
    });
    const oversizedRead = await helperRequest('read', {
      ids: Array.from({ length: 201 }, () => Number(plainId)),
    });
    expect(oversizedRead).toMatchObject({
      ok: false,
      error: { code: 'BAD_REQUEST', message: 'Read at most 200 tabs at a time.' },
    });
    const oversizedSection = await helperRequest('read', {
      id: Number(plainId),
      section: '1'.repeat(257),
    });
    expect(oversizedSection).toMatchObject({
      ok: false,
      error: { code: 'BAD_REQUEST', message: 'Use a section number such as 2 or 2.1.' },
    });
    const invalidTabsLimit = await helperRequest('tabs', { limit: 0 });
    expect(invalidTabsLimit).toMatchObject({
      ok: false,
      error: { code: 'BAD_REQUEST', message: 'Use a whole number from 1 to 200 for limit.' },
    });
    const invalidQuerySelector = await helperRequest('query', {
      id: Number(plainId),
      selector: '   ',
    });
    expect(invalidQuerySelector).toMatchObject({
      ok: false,
      error: { code: 'BAD_REQUEST', message: 'A CSS selector is required.' },
    });
    const invalidFindCap = await helperRequest('find', {
      id: Number(plainId),
      query: 'plain',
      maxChars: 0,
    });
    expect(invalidFindCap).toMatchObject({
      ok: false,
      error: { code: 'BAD_REQUEST', message: 'Use a positive character limit such as 20000.' },
    });
    const invalidPageSize = await helperRequest('read', { id: Number(plainId), pageSize: 0 });
    expect(invalidPageSize).toMatchObject({ ok: false, error: { code: 'BAD_REQUEST' } });
    const privatePage = await context.newPage();
    await privatePage.goto(url('bank.test', '/account'));
    const privateTabs = await command('--browser', 'chromium', 'tabs', '--match', 'bank');
    const privateId = privateTabs.stdout.match(/(\d+)\s+[* ]?\s*[z ]?\s+bank\.test/)?.[1];
    expect(privateId).toBeTruthy();
    const historical = await context.newPage();
    await historical.goto(url('temporary.test', '/historical'));
    const historicalTabs = await command('--browser', 'chromium', 'tabs', '--match', 'temporary');
    const historicalId = historicalTabs.stdout.match(
      /(\d+)\s+[* ]?\s*[z ]?\s+temporary\.test/,
    )?.[1];
    expect(historicalId).toBeTruthy();
    await command('--browser', 'chromium', 'read', historicalId!);
    await (
      await worker()
    ).evaluate(async () => {
      await chrome.storage.local.set({ denylist: ['bank.test', 'temporary.test'] });
    });
    const hidden = await command('--browser', 'chromium', 'tabs');
    expect(hidden.stdout).toContain('hidden by denylist');
    expect(hidden.stdout).not.toContain('Private account');
    expect(hidden.stdout).not.toContain('bank.test');
    const deniedLog = await helperRequest('log', { limit: 200 });
    expect(deniedLog).toMatchObject({ ok: false, error: { code: 'DENIED' } });
    expect(JSON.stringify(deniedLog)).not.toContain('temporary.test');
    const denied = await failedCommand('--browser', 'chromium', 'read', privateId!);
    expect(denied.stderr).toContain('DENIED');
    const reads = await readFile(path.join(home, 'logs', 'reads.jsonl'), 'utf8');
    expect(reads).not.toContain('bank.test');
    expect(reads).not.toContain('Private account');
    const missing = await failedCommand('--browser', 'chromium', 'read', '999999999');
    expect(missing.stderr).toContain('TAB_NOT_FOUND');
    const cappedError = await cli(
      '--browser',
      'chromium',
      '--max-chars',
      '20',
      'read',
      'nope',
    ).catch((error) => error);
    expect(cappedError.code).not.toBe(0);
    expect(cappedError.stderr.length).toBeLessThanOrEqual(20);
    const cappedHelp = await cli('--max-chars', '20', '--help');
    expect(cappedHelp.stdout.length).toBeLessThanOrEqual(20);
    const cappedVersion = await cli('--max-chars', '2', '--version');
    expect(cappedVersion.stdout.length).toBeLessThanOrEqual(2);
    const jsonMissing = await cli('--browser', 'chromium', 'read', '999999999', '--json').catch(
      (error) => error,
    );
    expect(jsonMissing.code).not.toBe(0);
    expect(jsonMissing.stdout).toContain('TAB_NOT_FOUND');
    const jsonInvalid = await cli('--browser', 'chromium', '--json', 'read', 'nope').catch(
      (error) => error,
    );
    expect(jsonInvalid.code).not.toBe(0);
    expect(JSON.parse(jsonInvalid.stdout)).toMatchObject({
      ok: false,
      error: { code: 'BAD_REQUEST' },
    });
    const jsonCappedError = await cli(
      '--browser',
      'chromium',
      '--json',
      '--max-chars',
      '20',
      'read',
      'nope',
    ).catch((error) => error);
    expect(jsonCappedError.code).not.toBe(0);
    expect(jsonCappedError.stdout.length).toBeLessThanOrEqual(20);
    expect(JSON.parse(jsonCappedError.stdout)).toMatchObject({ ok: false });
    const jsonMinimalError = await cli(
      '--browser',
      'chromium',
      '--json',
      '--max-chars',
      '1',
      'read',
      'nope',
    ).catch((error) => error);
    expect(jsonMinimalError.code).not.toBe(0);
    expect(jsonMinimalError.stdout).toBe('0');
    const jsonCappedErrorCode = await cli(
      '--browser',
      'chromium',
      '--json',
      '--max-chars',
      '60',
      'read',
      'nope',
    ).catch((error) => error);
    expect(jsonCappedErrorCode.stdout.length).toBeLessThanOrEqual(60);
    expect(JSON.parse(jsonCappedErrorCode.stdout)).toMatchObject({
      ok: false,
      error: { code: 'BAD_REQUEST' },
    });
    const jsonHuge = await cli(
      '--browser',
      'chromium',
      '--json',
      'tabs',
      '--max-chars',
      '1e100',
    ).catch((error) => error);
    expect(jsonHuge.code).not.toBe(0);
    expect(JSON.parse(jsonHuge.stdout)).toMatchObject({
      ok: false,
      error: { code: 'BAD_REQUEST' },
    });
    await historical.close();
    await (await worker()).evaluate(() => chrome.storage.local.remove('denylist'));
  });

  test('discards an aborted socket request without delaying the helper', async () => {
    await new Promise<void>((resolve, reject) => {
      const request = httpRequest({
        socketPath: path.join(home, 'run', 'chromium.sock'),
        path: '/v1/tabs',
        method: 'POST',
        headers: { 'content-type': 'application/json' },
      });
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        if (error) reject(error);
        else resolve();
      };
      request.once('error', (error: NodeJS.ErrnoException) => {
        if (error.code === 'ECONNRESET' || error.code === 'EPIPE') finish();
        else finish(error);
      });
      request.once('close', () => finish());
      request.on('socket', (socket) => {
        socket.once('connect', () => {
          request.write('{"match":"unfinished');
          request.destroy();
        });
      });
    });
    const status = await helperRequest('status', {});
    expect(status).toMatchObject({ ok: true, data: { connected: true } });
  });

  test('stops a completed request after its response socket closes', async () => {
    const loading = await context.newPage();
    const delayedUrl = url('article.test', '/delayed-abort');
    try {
      await loading.goto(delayedUrl, { waitUntil: 'commit' });
      const tabs = await command('--browser', 'chromium', 'tabs', '--match', 'delayed-abort');
      const id = tabs.stdout.match(/(\d+)\s+[* ]?\s*[z ]?\s+article\.test/)?.[1];
      expect(id).toBeTruthy();
      const before = await invariant();
      const readsLog = path.join(home, 'logs', 'reads.jsonl');
      const beforeLog = existsSync(readsLog) ? await readFile(readsLog, 'utf8') : '';
      const aborted = new Promise<void>((resolve, reject) => {
        const request = httpRequest({
          socketPath: path.join(home, 'run', 'chromium.sock'),
          path: '/v1/read',
          method: 'POST',
          headers: { 'content-type': 'application/json' },
        });
        let settled = false;
        const finish = (error?: Error) => {
          if (settled) return;
          settled = true;
          if (error) reject(error);
          else resolve();
        };
        request.once('error', (error: NodeJS.ErrnoException) => {
          if (error.code === 'ECONNRESET' || error.code === 'EPIPE') finish();
          else finish(error);
        });
        request.once('close', () => finish());
        request.end(JSON.stringify({ id: Number(id) }));
        void expect
          .poll(() => Boolean(delayedRelease), { timeout: 5_000 })
          .toBe(true)
          .then(() => request.destroy(), finish);
      });
      await aborted;
      delayedRelease?.();
      delayedRelease = undefined;
      const second = await helperRequest('read', { id: Number(id), maxChars: 1_000 });
      expect(second).toMatchObject({ ok: true });
      const afterLog = existsSync(readsLog) ? await readFile(readsLog, 'utf8') : '';
      const count = (value: string) =>
        value.slice(beforeLog.length).split('delayed-abort').length - 1;
      expect(count(afterLog)).toBe(1);
      expectInvariantUnchanged(before, await invariant());
    } finally {
      delayedRelease?.();
      delayedRelease = undefined;
      await loading.close();
    }
  });

  test('keeps a shared read alive for another client after the first disconnects', async () => {
    const loading = await context.newPage();
    const delayedUrl = url('article.test', '/delayed-abort?shared=1');
    try {
      await loading.goto(delayedUrl, { waitUntil: 'commit' });
      const tabs = await command('--browser', 'chromium', 'tabs', '--match', 'shared=1');
      const id = tabs.stdout.match(/(\d+)\s+[* ]?\s*[z ]?\s+article\.test/)?.[1];
      expect(id).toBeTruthy();
      const first = new Promise<void>((resolve, reject) => {
        const request = httpRequest({
          socketPath: path.join(home, 'run', 'chromium.sock'),
          path: '/v1/read',
          method: 'POST',
          headers: { 'content-type': 'application/json' },
        });
        let settled = false;
        const finish = (error?: Error) => {
          if (settled) return;
          settled = true;
          if (error) reject(error);
          else resolve();
        };
        request.once('error', (error: NodeJS.ErrnoException) => {
          if (error.code === 'ECONNRESET' || error.code === 'EPIPE') finish();
          else finish(error);
        });
        request.once('close', () => finish());
        request.end(JSON.stringify({ id: Number(id) }));
        void expect
          .poll(() => Boolean(delayedRelease), { timeout: 5_000 })
          .toBe(true)
          .then(() => request.destroy(), finish);
      });
      await expect.poll(() => Boolean(delayedRelease), { timeout: 5_000 }).toBe(true);
      const second = helperRequest('read', { id: Number(id), full: true, maxChars: 1_000 });
      await new Promise<void>((resolve) => setImmediate(resolve));
      delayedRelease?.();
      delayedRelease = undefined;
      await first;
      expect(await second).toMatchObject({ ok: true });
    } finally {
      delayedRelease?.();
      delayedRelease = undefined;
      await loading.close();
    }
  });

  test('rechecks the current tab before delivering a guarded result', async () => {
    const page = await context.newPage();
    const arm = path.join(home, 'guard-arm');
    const held = path.join(home, 'guard-held');
    const release = path.join(home, 'guard-release');
    let pending: Promise<{ code?: number | string; stdout: string; stderr: string }> | undefined;
    try {
      const source = url('article.test', '/guard-race');
      const destination = url('bank.test', '/account');
      await page.goto(source);
      const tabs = await command('--browser', 'chromium', 'tabs', '--match', 'guard-race');
      const id = tabs.stdout.match(/(\d+)\s+[* ]?\s*[z ]?\s+article\.test/)?.[1];
      expect(id).toBeTruthy();
      await writeFile(arm, JSON.stringify({ tabId: Number(id) }));
      const before = await invariant();
      pending = cli('--browser', 'chromium', 'read', id!).catch((value) => value);
      await expect.poll(() => readFile(held, 'utf8').catch(() => '')).toBe('held');
      expectInvariantUnchanged(before, await invariant());
      await page.goto(destination);
      const navigated = await invariant();
      expectInvariantUnchanged(
        {
          ...before,
          tabUrls: before.tabUrls.map(
            ([tabId, href]) => [tabId, tabId === Number(id) ? destination : href] as const,
          ),
          pages: before.pages.filter((entry) => entry.url !== source),
        },
        navigated,
      );
      await writeFile(release, 'release');
      const error = await pending;
      expect(error.code).toEqual(expect.any(Number));
      expect(error.code).not.toBe(0);
      expect(error.stderr).toMatch(/TIMEOUT|DENIED/);
      expect(error.stdout).toBe('');
      expectInvariantUnchanged(navigated, await invariant());
    } finally {
      await writeFile(release, 'release');
      await pending;
      await Promise.all([arm, held, release].map((file) => rm(file, { force: true })));
      await page.close();
    }
  });

  test('times out a client response that keeps trickling bytes', async () => {
    const timeoutHome = await mkdtemp(path.join(tmpdir(), 'cobrowser-trickle-'));
    const run = path.join(timeoutHome, 'run');
    await mkdir(run);
    const socket = path.join(run, 'chrome.sock');
    const trickleServer = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.write('{"ok":true,"text":"');
      let count = 0;
      const timer = setInterval(() => {
        response.write('x');
        count++;
        if (count === 20) {
          clearInterval(timer);
          response.end('"}');
        }
      }, 10);
      response.once('close', () => clearInterval(timer));
    });
    try {
      await new Promise<void>((resolve, reject) => {
        trickleServer.once('error', reject);
        trickleServer.listen(socket, resolve);
      });
      const script = `
        import { CobrowserClient } from ${JSON.stringify(path.join(root, 'dist/client.js'))};
        try {
          await new CobrowserClient({ browser: 'chrome', timeoutMs: 500, responseTimeoutMs: 50 }).request('tabs');
          process.exitCode = 1;
        } catch (error) {
          process.stdout.write(String(error?.code || error));
          process.exitCode = error?.code === 'TIMEOUT' ? 0 : 1;
        }
      `;
      const result = await exec(process.execPath, ['--input-type=module', '-e', script], {
        env: { ...process.env, COBROWSER_HOME: timeoutHome },
      });
      expect(result.stdout).toBe('TIMEOUT');
    } finally {
      await new Promise<void>((resolve) => trickleServer.close(() => resolve()));
      await rm(timeoutHome, { recursive: true, force: true });
    }
  });

  test('shows pages for a long page without headings', async () => {
    const page = await context.newPage();
    await page.goto(url('plain.test', '/plain-no-headings'));
    const tabs = await command('--browser', 'chromium', 'tabs', '--match', 'plain');
    const id = tabs.stdout.match(/(\d+)\s+[* ]?\s*[z ]?\s+plain\.test/)?.[1];
    expect(id).toBeTruthy();
    const outline = await command('--browser', 'chromium', 'read', id!, '--max-chars', '800');
    expect(outline.stdout).toMatch(/\d+ pages/);
    expect(outline.stdout).toContain(`next: cobrowser read ${id} --page 1`);
  });

  test('stops a multi-tab read when the shared cap is reached', async () => {
    const first = await context.newPage();
    const second = await context.newPage();
    await first.goto(url('long.test', '/multi-first'));
    await second.goto(url('article.test', '/multi-second'));
    const firstTabs = await command('--browser', 'chromium', 'tabs', '--match', 'multi-first');
    const firstId = firstTabs.stdout.match(/(\d+)\s+[* ]?\s*[z ]?\s+long\.test/)?.[1];
    const secondTabs = await command('--browser', 'chromium', 'tabs', '--match', 'multi-second');
    const secondId = secondTabs.stdout.match(/(\d+)\s+[* ]?\s*[z ]?\s+article\.test/)?.[1];
    expect(firstId).toBeTruthy();
    expect(secondId).toBeTruthy();
    const readsLog = path.join(home, 'logs', 'reads.jsonl');
    const before = existsSync(readsLog) ? (await readFile(readsLog, 'utf8')).trim() : '';
    const result = await command(
      '--browser',
      'chromium',
      'read',
      firstId!,
      secondId!,
      '--max-chars',
      '500',
    );
    expect(result.stdout).toContain(`next: cobrowser read ${firstId}`);
    expect(result.stdout).toContain(`also: cobrowser read ${secondId}`);
    const after = (await readFile(readsLog, 'utf8')).trim();
    const newEntries = after
      .slice(before.length)
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    expect(newEntries.map((entry) => entry.tabId)).toEqual([Number(firstId)]);
  });

  test('searches, queries, reads selections and captures the visible tab', async () => {
    const page = await context.newPage();
    await page.goto(url('article.test', '/surface'));
    const tabs = await command('--browser', 'chromium', 'tabs', '--match', 'surface');
    const id = tabs.stdout.match(/(\d+)\s+[* ]?\s*[z ]?\s+article\.test/)?.[1];
    expect(id).toBeTruthy();
    const found = await command('--browser', 'chromium', 'find', id!, 'details');
    expect(found.stdout).toContain('Some details.');
    const queried = await command('--browser', 'chromium', 'query', id!, 'h2');
    expect(queried.stdout).toContain('Details');
    const tinyTabs = await command(
      '--browser',
      'chromium',
      'tabs',
      '--match',
      'surface',
      '--max-chars',
      '10',
    );
    expect(tinyTabs.stdout).not.toContain('next:');
    await page.evaluate(() => {
      const node = document.querySelector('h1')!;
      const range = document.createRange();
      range.selectNodeContents(node);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
    });
    const selected = await command('--browser', 'chromium', 'selection', id!);
    expect(selected.stdout).toContain('Heading');
    const multi = await command('--browser', 'chromium', 'read', id!, id!);
    expect(multi.stdout).toContain('Hello from the fixture');
    const multiCapped = await command(
      '--browser',
      'chromium',
      'read',
      id!,
      id!,
      '--links',
      '--max-chars',
      '180',
    );
    const pending = [multiCapped.stdout];
    let reconstructed = '';
    for (let attempt = 0; pending.length && attempt < 32; attempt++) {
      const output = pending.shift()!;
      reconstructed += output.replace(/(?:next|more|also): cobrowser [^\n]+/g, '');
      for (const match of output.matchAll(/(?:next|more|also): cobrowser ([^\n]+)/g)) {
        expect(match[1]).toContain('--links');
        pending.push((await command(...match[1].split(' '))).stdout);
      }
    }
    expect(pending).toHaveLength(0);
    expect(reconstructed.match(/Hello from the fixture/g)).toHaveLength(2);
    const screenshot = await command(
      '--browser',
      'chromium',
      'screenshot',
      '--out',
      path.join(home, 'surface.png'),
    );
    expect(screenshot.stdout.trim()).toBe(path.join(home, 'surface.png'));
    const screenshotFile = await stat(path.join(home, 'surface.png'));
    expect(screenshotFile.size).toBeGreaterThan(100);
    expect(screenshotFile.mode & 0o777).toBe(0o600);
    const cappedScreenshot = await helperRequest('screenshot', { maxChars: 100 });
    expect(JSON.stringify(cappedScreenshot).length).toBeLessThanOrEqual(100);
    expect(cappedScreenshot).toMatchObject({ ok: true });
    expect((cappedScreenshot.data as { dataUrl?: unknown } | undefined)?.dataUrl).toBeUndefined();
    expect(cappedScreenshot.text).toContain('response cap');
    const recentLog = await command('--browser', 'chromium', 'log', '--limit', '1');
    expect(recentLog.stdout).toContain('screenshot');
    expect(recentLog.stdout).toContain('chromium');
    const readsLog = path.join(home, 'logs', 'reads.jsonl');
    await writeFile(
      readsLog,
      `${JSON.stringify({
        time: '2026-01-01T00:00:00.000Z\nforged',
        browser: 'chromium',
        agent: 'test-agent',
        command: 'read',
        tabId: 1,
        url: 'https://user:pass@example.test/private',
        chars: 12,
        secret: 'do-not-return',
        nested: { secret: 'do-not-return' },
      })}\n`,
      { flag: 'a' },
    );
    const sanitizedLog = await command('--browser', 'chromium', 'log', '--limit', '1', '--json');
    const sanitizedLogData = JSON.parse(sanitizedLog.stdout);
    expect(sanitizedLogData.data).toEqual([
      {
        time: '2026-01-01T00:00:00.000Z forged',
        browser: 'chromium',
        agent: 'test-agent',
        command: 'read',
        tabId: 1,
        url: 'https://example.test/private',
        chars: 12,
      },
    ]);
    expect(sanitizedLog.stdout).not.toContain('do-not-return');
    expect(sanitizedLog.stdout).not.toContain('user:pass');
    await writeFile(readsLog, 'x'.repeat(5_000_001));
    await command('--browser', 'chromium', 'read', id!, '--max-chars', '100');
    expect(existsSync(`${readsLog}.1`)).toBe(true);
    expect((await stat(readsLog)).size).toBeLessThan(2_000);
    await (await worker()).evaluate(() => chrome.storage.local.set({ paused: true }));
    const pausedTabs = await failedCommand('--browser', 'chromium', 'tabs');
    expect(pausedTabs.stderr).toContain('PAUSED');
    const pausedMcp = await mcp({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'list_tabs', arguments: { maxChars: 100 } },
    });
    expect(JSON.stringify(pausedMcp[0]).length).toBeLessThanOrEqual(100);
    const pausedRead = await failedCommand('--browser', 'chromium', 'read', id!);
    expect(pausedRead.stderr).toContain('PAUSED');
    await (await worker()).evaluate(() => chrome.storage.local.set({ paused: false }));
  });

  test('redacts credentials from returned page content', async () => {
    const page = await context.newPage();
    await page.goto(url('credentials.test', '/links'));
    const tabs = await command('--browser', 'chromium', 'tabs', '--match', 'credential');
    const id = tabs.stdout.match(/(\d+)\s+[* ]?\s*[z ]?\s+credentials\.test/)?.[1];
    expect(id).toBeTruthy();
    const read = await command('--browser', 'chromium', 'read', id!, '--links');
    expect(read.stdout).toContain('https://example.test/private');
    expect(read.stdout).not.toContain('user:pass');
    expect(read.stdout).toContain('//relative.test/private');
    expect(read.stdout).toContain('https://quoted.test/private');
    expect(read.stdout).not.toContain('relative-secret');
    expect(read.stdout).not.toContain("pa'ss");
    const queried = await command('--browser', 'chromium', 'query', id!, 'a', '--html');
    expect(queried.stdout).toContain('https://example.test/private');
    expect(queried.stdout).not.toContain('user:pass');
    expect(queried.stdout).toContain('//relative.test/private');
    expect(queried.stdout).toContain('https://quoted.test/private');
    expect(queried.stdout).not.toContain('relative-secret');
    expect(queried.stdout).not.toContain("pa'ss");
  });

  test('guards a tab with credentials and a long URL without redacting its identity', async () => {
    const page = await context.newPage();
    try {
      const pathname = '/credential-guard';
      await page.goto(
        `http://user:pass@credentials.test:${port}${pathname}?q=${'x'.repeat(20_000)}`,
      );
      const id = await (
        await worker()
      ).evaluate(
        (targetPath) =>
          chrome.tabs.query({}).then((tabs) => {
            const tab = tabs.find(
              (candidate) => new URL(candidate.url || '').pathname === targetPath,
            );
            return tab?.id;
          }),
        pathname,
      );
      expect(id).toBeTruthy();
      const read = await command('--browser', 'chromium', 'read', String(id));
      expect(read.stdout).toContain('private link');
      expect(read.stdout).not.toContain('user:pass');
    } finally {
      await page.close();
    }
  });

  test('reports unreadable browser pages without changing focus', async () => {
    const page = await context.newPage();
    await page.goto('about:blank');
    const tabs = await command('--browser', 'chromium', 'tabs', '--match', 'about:blank');
    const id = tabs.stdout.match(/(\d+)\s+[* ]?\s*[z ]?\s+about:blank/)?.[1];
    expect(id).toBeTruthy();
    const error = await failedCommand('--browser', 'chromium', 'read', id!);
    expect(error.stderr).toContain('UNREADABLE');

    const store = await context.newPage();
    await store.goto(url('store.chromewebstore.google.com', '/webstore/detail/example'));
    const storeTabs = await command(
      '--browser',
      'chromium',
      'tabs',
      '--match',
      'store.chromewebstore.google.com',
    );
    const storeId = storeTabs.stdout.match(/(\d+)\s+[* ]?\s*[z ]?\s+store\.chromewebsto/)?.[1];
    expect(storeId).toBeTruthy();
    const storeError = await failedCommand('--browser', 'chromium', 'read', storeId!);
    expect(storeError.stderr).toContain('UNREADABLE');
  });

  test('reads a PDF through the browser session', async () => {
    const page = await context.newPage();
    await page.goto(url('article.test', '/paper.pdf'));
    const tabs = await command('--browser', 'chromium', 'tabs', '--match', 'paper.pdf');
    const id = tabs.stdout.match(/(\d+)\s+[* ]?\s*[z ]?\s+article\.test/)?.[1];
    expect(id).toBeTruthy();
    const read = await command('--browser', 'chromium', 'read', id!);
    expect(read.stdout).toContain('Hello PDF');
  });

  test('blocks a special-document redirect into a denied host', async () => {
    const page = await context.newPage();
    try {
      await page.goto(url('article.test', '/redirect.pdf'));
      const tabs = await command('--browser', 'chromium', 'tabs', '--match', 'redirect.pdf');
      const id = tabs.stdout.match(/(\d+)\s+[* ]?\s*[z ]?\s+article\.test/)?.[1];
      expect(id, tabs.stdout).toBeTruthy();
      await (await worker()).evaluate(() => chrome.storage.local.set({ denylist: ['bank.test'] }));
      const error = await failedCommand('--browser', 'chromium', 'read', id!);
      expect(error.stderr).toContain('DENIED');
    } finally {
      await (await worker()).evaluate(() => chrome.storage.local.remove('denylist'));
      await page.close();
    }
  });

  test('falls back to the Google Docs text export when Markdown is empty', async () => {
    await context.route('https://docs.google.com/**', async (route) => {
      const requestUrl = route.request().url();
      if (requestUrl.includes('format=md')) {
        await route.fulfill({ status: 200, contentType: 'text/markdown', body: '' });
        return;
      }
      if (requestUrl.includes('format=txt')) {
        await route.fulfill({
          status: 200,
          contentType: 'text/plain',
          body: 'Fallback text export content.',
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: article('Google document', '<h1>Google document</h1><p>Loading document.</p>'),
      });
    });
    const page = await context.newPage();
    try {
      await page.goto('https://docs.google.com/document/d/fallback/edit');
      const tabs = await command('--browser', 'chromium', 'tabs', '--match', 'docs.google.com');
      const id = tabs.stdout.match(/(\d+)\s+[* ]?\s*[z ]?\s+docs\.google\.com/)?.[1];
      expect(id).toBeTruthy();
      const read = await command('--browser', 'chromium', 'read', id!);
      expect(read.stdout).toContain('Fallback text export content.');
    } finally {
      await page.close();
      await context.unroute('https://docs.google.com/**');
    }
  });

  test('cancels a failed Google Docs export before trying text fallback', async () => {
    await context.route('https://docs.google.com/**', async (route) => {
      const requestUrl = route.request().url();
      if (requestUrl.includes('format=md')) {
        await route.fulfill({ status: 503, contentType: 'text/plain', body: 'temporary failure' });
        return;
      }
      if (requestUrl.includes('format=txt')) {
        await route.fulfill({
          status: 200,
          contentType: 'text/plain',
          body: 'Fallback after failed Markdown export.',
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: article('Failed export document', '<h1>Failed export document</h1>'),
      });
    });
    const page = await context.newPage();
    try {
      await page.goto('https://docs.google.com/document/d/failed-export/edit');
      const tabs = await command('--browser', 'chromium', 'tabs', '--match', 'failed export');
      const id = tabs.stdout.match(/(\d+)\s+[* ]?\s*[z ]?\s+docs\.google\.com/)?.[1];
      expect(id).toBeTruthy();
      const read = await command('--browser', 'chromium', 'read', id!);
      expect(read.stdout).toContain('Fallback after failed Markdown export.');
    } finally {
      await page.close();
      await context.unroute('https://docs.google.com/**');
    }
  });

  test('keeps outlined PDF pages addressable through the helper', async () => {
    const page = await context.newPage();
    await page.goto(url('article.test', '/outlined.pdf'));
    const tabs = await command('--browser', 'chromium', 'tabs', '--match', 'outlined.pdf');
    const id = tabs.stdout.match(/(\d+)\s+[* ]?\s*[z ]?\s+article\.test/)?.[1];
    expect(id).toBeTruthy();
    const metadata = await command('--browser', 'chromium', 'read', id!, '--json');
    expect(JSON.parse(metadata.stdout)).toMatchObject({ data: { pages: 2 } });
    expect(metadata.stdout).toContain('Chapter one');
    const secondPage = await command('--browser', 'chromium', 'read', id!, '--page', '2');
    expect(secondPage.stdout).toContain('Second page');
  });

  test('times out a stalled special-document fetch', async () => {
    const page = await context.newPage();
    try {
      await page.goto(url('article.test', '/slow.pdf'), { waitUntil: 'commit' });
      const tabs = await command('--browser', 'chromium', 'tabs', '--match', 'slow');
      const id = tabs.stdout.match(/(\d+)\s+[* ]?\s*[z ]?\s+article\.test/)?.[1];
      expect(id).toBeTruthy();
      const started = Date.now();
      const error = await failedCommand('--browser', 'chromium', 'read', id!);
      expect(Date.now() - started).toBeLessThan(20_000);
      expect(error.stderr).toContain('UNREADABLE');
    } finally {
      await page.close();
    }
  });

  test('serves MCP initialization, tools and tab reads over stdio', async () => {
    const responses = (
      await mcp(
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: { clientInfo: { name: 'playwright' } },
        },
        { jsonrpc: '2.0', id: 2, method: 'tools/list' },
        {
          jsonrpc: '2.0',
          id: 3,
          method: 'tools/call',
          params: { name: 'list_tabs', arguments: { match: 'article' } },
        },
        {
          jsonrpc: '2.0',
          id: 4,
          method: 'tools/call',
          params: { name: 'screenshot', arguments: { maxChars: 100_000 } },
        },
        {
          jsonrpc: '2.0',
          id: 5,
          method: 'tools/call',
          params: { name: 'list_tabs', arguments: { match: 'article', maxChars: 100 } },
        },
        {
          jsonrpc: '2.0',
          id: 6,
          method: 'tools/call',
          params: { name: 'screenshot', arguments: { maxChars: 1_000 } },
        },
      )
    ).sort((left, right) => left.id - right.id);
    expect(responses[0]).toMatchObject({
      id: 1,
      result: { serverInfo: { name: 'cobrowser' }, capabilities: { tools: {} } },
    });
    expect(responses[1].result.tools.map((tool: { name: string }) => tool.name)).toEqual(
      expect.arrayContaining(['list_tabs', 'read_tab', 'screenshot']),
    );
    const listTabsTool = responses[1].result.tools.find(
      (tool: { name: string }) => tool.name === 'list_tabs',
    );
    expect(listTabsTool.inputSchema).toMatchObject({
      additionalProperties: false,
      properties: { maxChars: { type: 'integer', minimum: 100 } },
    });
    const queryTool = responses[1].result.tools.find(
      (tool: { name: string }) => tool.name === 'query_tab',
    );
    expect(queryTool.inputSchema.properties.limit).toMatchObject({
      type: 'integer',
      minimum: 1,
      maximum: 100,
    });
    expect(responses[2]).toMatchObject({ id: 3, result: { content: [{ type: 'text' }] } });
    expect(responses[2].result.content[0].text).toContain('Article title');
    expect(responses[2].result.structuredContent).toMatchObject({
      data: { tabs: expect.any(Array) },
    });
    expect(responses[3]).toMatchObject({
      id: 4,
      result: {
        content: [{ type: 'image', mimeType: 'image/png' }],
        structuredContent: { data: { tabId: expect.any(Number) } },
      },
    });
    expect(JSON.stringify(responses[4]).length).toBeLessThanOrEqual(100);
    expect(JSON.stringify(responses[5]).length).toBeLessThanOrEqual(1_000);
    expect(responses[5]).toMatchObject({
      id: 6,
      result: { content: [{ type: 'text', text: expect.stringContaining('larger maxChars') }] },
    });
    const longIdSuccess = (
      await mcp({
        jsonrpc: '2.0',
        id: 'y'.repeat(256),
        method: 'tools/call',
        params: { name: 'list_tabs', arguments: { maxChars: 100 } },
      })
    )[0];
    expect(JSON.stringify(longIdSuccess).length).toBeLessThanOrEqual(100);
    expect(longIdSuccess).toMatchObject({ id: null, result: { content: [{ type: 'text' }] } });
    const longIdError = (
      await mcp({
        jsonrpc: '2.0',
        id: 'z'.repeat(256),
        method: 'tools/call',
        params: { name: 'list_tabs', arguments: { match: 42, maxChars: 100 } },
      })
    )[0];
    expect(JSON.stringify(longIdError).length).toBeLessThanOrEqual(100);
    expect(longIdError).toMatchObject({ id: null, error: { code: -32602 } });
    const fractionalSection = (
      await mcp({
        jsonrpc: '2.0',
        id: 16,
        method: 'tools/call',
        params: { name: 'read_tab', arguments: { id: 1, section: 2.1 } },
      })
    )[0];
    expect(fractionalSection).toMatchObject({
      id: 16,
      error: { code: -32602, message: 'MCP tool argument section has an invalid value.' },
    });
  });

  test('returns a JSON-RPC error for a non-object MCP request', async () => {
    const responses = await mcp(
      null,
      { jsonrpc: '1.0', id: 1, method: 'ping' },
      { jsonrpc: '2.0', id: { invalid: true }, method: 'ping' },
      {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'list_tabs', arguments: { match: 42 } },
      },
      {
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: { name: 'list_tabs', arguments: [] },
      },
      {
        jsonrpc: '2.0',
        id: 5,
        method: 'tools/call',
        params: { name: 'list_tabs', arguments: { unsupported: true } },
      },
      {
        jsonrpc: '2.0',
        id: 6,
        method: 'tools/call',
        params: { name: 'list_tabs', arguments: { limit: 0 } },
      },
      {
        jsonrpc: '2.0',
        id: 7,
        method: 'tools/call',
        params: { name: 'list_tabs', arguments: { toString: 'forbidden' } },
      },
      {
        jsonrpc: '2.0',
        id: 8,
        method: 'tools/call',
        params: { name: 'read_tab', arguments: {} },
      },
      {
        jsonrpc: '2.0',
        id: 9,
        method: 'tools/call',
        params: { name: 'list_tabs', arguments: { since: '0s' } },
      },
      {
        jsonrpc: '2.0',
        id: 10,
        method: 'tools/call',
        params: { name: 'list_tabs', arguments: { window: 'back' } },
      },
      {
        jsonrpc: '2.0',
        id: 11,
        method: 'tools/call',
        params: { name: 'find_in_tab', arguments: { id: 1, query: '   ' } },
      },
      {
        jsonrpc: '2.0',
        id: 12,
        method: 'tools/call',
        params: { name: 'read_tab', arguments: { id: 1, section: -1 } },
      },
      {
        jsonrpc: '2.0',
        id: 13,
        method: 'tools/call',
        params: { name: 'list_tabs', arguments: { limit: 0, maxChars: 100 } },
      },
      {
        jsonrpc: '2.0',
        id: 14,
        method: 'tools/call',
        params: { name: 'list_tabs', arguments: { maxChars: 1 } },
      },
      { jsonrpc: '2.0', id: 'x'.repeat(257), method: 'ping' },
    );
    expect(responses[0]).toMatchObject({
      jsonrpc: '2.0',
      error: { code: -32600, message: 'MCP input must be a JSON object.' },
    });
    expect(responses[1]).toMatchObject({
      id: 1,
      error: { code: -32600, message: 'MCP jsonrpc must be "2.0".' },
    });
    expect(responses[2]).toMatchObject({
      id: null,
      error: { code: -32600, message: 'MCP request id must be a string, number, or null.' },
    });
    expect(responses[3]).toMatchObject({
      id: 3,
      error: { code: -32602, message: 'MCP tool argument match has an invalid type.' },
    });
    expect(responses[4]).toMatchObject({
      id: 4,
      error: { code: -32602, message: 'MCP tool arguments must be an object.' },
    });
    expect(responses[5]).toMatchObject({
      id: 5,
      error: { code: -32602, message: 'MCP tool argument is not supported: unsupported.' },
    });
    expect(responses[6]).toMatchObject({
      id: 6,
      error: { code: -32602, message: 'MCP tool argument limit is below the allowed minimum.' },
    });
    expect(responses[7]).toMatchObject({
      id: 7,
      error: { code: -32602, message: 'MCP tool argument is not supported: toString.' },
    });
    expect(responses[8]).toMatchObject({
      id: 8,
      error: { code: -32602, message: 'MCP tool argument requires exactly one of id or ids.' },
    });
    expect(responses[9]).toMatchObject({
      id: 9,
      error: { code: -32602, message: 'MCP tool argument since has an invalid duration.' },
    });
    expect(responses[10]).toMatchObject({
      id: 10,
      error: { code: -32602, message: 'MCP tool argument window has an invalid value.' },
    });
    expect(responses[11]).toMatchObject({
      id: 11,
      error: { code: -32602, message: 'MCP tool argument query has an invalid format.' },
    });
    expect(responses[12]).toMatchObject({
      id: 12,
      error: { code: -32602, message: 'MCP tool argument section has an invalid value.' },
    });
    expect(JSON.stringify(responses[13]).length).toBeLessThanOrEqual(100);
    expect(responses[13]).toMatchObject({ id: 13, error: { code: -32602 } });
    expect(responses[14]).toMatchObject({
      id: 14,
      error: { code: -32602, message: 'MCP tool argument maxChars is below the allowed minimum.' },
    });
    expect(responses[15]).toMatchObject({
      id: null,
      error: { code: -32600, message: 'MCP request id is too long.' },
    });
  });

  test('controls pause and the denylist through the extension pages', async () => {
    const popup = await context.newPage();
    const options = await context.newPage();
    try {
      await (
        await worker()
      ).evaluate(() =>
        chrome.storage.local.set({
          recentReads: [
            { command: 'screenshot', tabId: 1, url: 'https://user:pass@example.test/private' },
          ],
        }),
      );
      await popup.goto(`chrome-extension://${extensionId}/popup.html`);
      await expect(popup.locator('#status')).toContainText('helper connection is ready');
      await expect
        .poll(
          async () =>
            (await (await worker()).evaluate(() => chrome.storage.local.get('connected')))
              .connected,
        )
        .toBe(true);
      await expect(popup.locator('#recent')).toContainText('screenshot');
      await expect(popup.locator('#recent')).toContainText('https://example.test/private');
      await expect(popup.locator('#recent')).not.toContainText('user:pass');
      const articleTabs = await command('--browser', 'chromium', 'tabs', '--match', 'article.test');
      const articleId = articleTabs.stdout.match(/(\d+)\s+[* ]?\s*[z ]?\s+article\.test/)?.[1];
      expect(articleId).toBeTruthy();
      await (
        await worker()
      ).evaluate(() =>
        chrome.storage.local.set({
          recentReads: [
            { command: '\nold', time: '\n', url: 'x'.repeat(100_000) },
            'invalid entry',
          ],
        }),
      );
      await command('--browser', 'chromium', 'read', articleId!);
      await expect
        .poll(async () => {
          const state = await (
            await worker()
          ).evaluate(() => chrome.storage.local.get('recentReads'));
          return JSON.stringify(state.recentReads || []);
        })
        .toContain('old');
      const normalizedReads = await (
        await worker()
      ).evaluate(() => chrome.storage.local.get('recentReads'));
      expect(JSON.stringify(normalizedReads.recentReads)).not.toContain('x'.repeat(10_000));
      expect(normalizedReads.recentReads).toHaveLength(2);
      const pause = popup.locator('#paused');
      await pause.check();
      await expect
        .poll(
          async () =>
            (await (await worker()).evaluate(() => chrome.storage.local.get('paused'))).paused,
        )
        .toBe(true);
      await pause.uncheck();
      await (await worker()).evaluate(() => chrome.storage.local.set({ paused: 'false' }));
      expect((await command('--browser', 'chromium', 'tabs')).stdout).toContain('Article title');
      await (await worker()).evaluate(() => chrome.storage.local.set({ paused: false }));

      await options.goto(`chrome-extension://${extensionId}/options.html`);
      const denylist = options.locator('#denylist');
      await expect(denylist).toHaveAttribute('maxlength', '524544');
      await expect(denylist).toHaveValue(/paypal\.com/);
      await (
        await worker()
      ).evaluate(() => chrome.storage.local.set({ denylist: ['article.test', null, 42] }));
      await options.reload();
      await expect(denylist).toHaveValue('article.test');
      await denylist.fill('article.test');
      await options.locator('#save').click();
      await expect(options.locator('#status')).toHaveText('Saved.');
      await expect
        .poll(
          async () =>
            (await (await worker()).evaluate(() => chrome.storage.local.get('denylist'))).denylist,
        )
        .toEqual(['article.test']);
      await denylist.fill(`${'a'.repeat(2_049)}\narticle.test`);
      await options.locator('#save').click();
      await expect(options.locator('#status')).toHaveText('Saved. Ignored 1 invalid line.');
      await expect
        .poll(
          async () =>
            (await (await worker()).evaluate(() => chrome.storage.local.get('denylist'))).denylist,
        )
        .toEqual(['article.test']);
      await denylist.fill(
        [...Array.from({ length: 256 }, () => 'https://invalid.test'), 'article.test'].join('\n'),
      );
      await options.locator('#save').click();
      await expect(options.locator('#status')).toHaveText(
        'No valid entries in the first 256 lines. Defaults restored. Ignored 1 entries after the first 256.',
      );
      await expect
        .poll(
          async () =>
            (await (await worker()).evaluate(() => chrome.storage.local.get('denylist'))).denylist,
        )
        .toContain('paypal.com');
      await denylist.fill('https://invalid.test');
      await options.locator('#save').click();
      await expect(options.locator('#status')).toHaveText('No valid entries. Defaults restored.');
      await expect
        .poll(
          async () =>
            (await (await worker()).evaluate(() => chrome.storage.local.get('denylist'))).denylist,
        )
        .toContain('paypal.com');
      await denylist.fill('*.ARTICLE.TEST/\narticle.test\nhttps://invalid.test');
      await options.locator('#save').click();
      await expect(options.locator('#status')).toHaveText('Saved. Ignored 1 invalid line.');
      await expect
        .poll(
          async () =>
            (await (await worker()).evaluate(() => chrome.storage.local.get('denylist'))).denylist,
        )
        .toEqual(['article.test']);
      await options.locator('#restore').click();
      await expect
        .poll(
          async () =>
            (await (await worker()).evaluate(() => chrome.storage.local.get('denylist'))).denylist,
        )
        .toContain('paypal.com');
      await options.locator('#save').click();
      await expect(denylist).toHaveValue(/paypal\.com/);
    } finally {
      await popup.close();
      await options.close();
    }
  });

  test('removes a helper socket when the helper receives a termination signal', async () => {
    const signalHome = await mkdtemp(path.join(tmpdir(), 'cobrowser-signal-'));
    const child = spawn(
      process.execPath,
      [path.join(root, 'dist/helper.js'), '--browser', 'signal-test'],
      {
        env: { ...process.env, COBROWSER_HOME: signalHome },
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    const socket = path.join(signalHome, 'run', 'signal-test.sock');
    try {
      await expect.poll(() => existsSync(socket), { timeout: 5_000 }).toBe(true);
      child.kill('SIGTERM');
      await new Promise<void>((resolve, reject) => {
        child.once('error', reject);
        child.once('close', () => resolve());
      });
      expect(existsSync(socket)).toBe(false);
    } finally {
      if (child.exitCode === null) child.kill('SIGKILL');
      await rm(signalHome, { recursive: true, force: true });
    }
  });

  test('fails within two seconds after the browser closes', async () => {
    expect(existsSync(path.join(home, 'run', 'chromium.sock'))).toBe(true);
    await context.close();
    await expect
      .poll(() => existsSync(path.join(home, 'run', 'chromium.sock')), { timeout: 5_000 })
      .toBe(false);
    const started = Date.now();
    const error = await cli('--browser', 'chromium', 'tabs').catch((value) => value);
    expect(Date.now() - started).toBeLessThan(4_000);
    expect(error.stderr).toContain('BROWSER_OFFLINE');
  });
});
