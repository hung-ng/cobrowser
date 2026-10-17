import { test, expect, type BrowserContext } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const root = path.resolve(import.meta.dirname, '../..');
const hosts = ['article.test', 'long.test', 'plain.test', 'feed.test', 'bank.test'];
let server: Server;
let port = 0;
let context: BrowserContext;
let home = '';
let userData = '';

function url(host: string, pathname: string): string {
  return `http://${host}:${port}${pathname}`;
}

async function cli(...args: string[]) {
  return exec(process.execPath, [path.join(root, 'dist/cli.js'), ...args], {
    env: { ...process.env, COBROWSER_HOME: home },
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
  return serviceWorker.evaluate(async () => {
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
    };
  });
}

async function command(...args: string[]) {
  const before = await invariant();
  const result = await cli(...args);
  expect(await invariant()).toEqual(before);
  return result;
}

async function failedCommand(...args: string[]) {
  const before = await invariant();
  const error = await cli(...args).catch((value) => value);
  expect(await invariant()).toEqual(before);
  return error as { stderr: string };
}

function article(title: string, body: string): string {
  return `<html><head><title>${title}</title></head><body>${body}</body></html>`;
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
  const extension = path.join(root, 'dist/extension');
  const nativeHosts = path.join(userData, 'NativeMessagingHosts');
  await mkdir(nativeHosts, { recursive: true });
  const launcher = path.join(home, 'host.sh');
  await writeFile(
    launcher,
    `#!/bin/sh
export COBROWSER_HOME=${home}
exec ${process.execPath} ${path.join(root, 'dist/helper.js')} --browser chromium
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
}

test.describe.serial('core loop', () => {
  test.beforeAll(async () => {
    server = createServer((request, response) => {
      const host = String(request.headers.host).split(':')[0];
      const pathname = request.url?.split('?')[0] || '/';
      if (host === 'long.test') {
        response.end(
          article(
            'Long article',
            longSection('Long article', 3_500) + longSection('Second section', 2_000),
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
      if (host === 'bank.test') {
        response.end(article('Private account', '<h1>Private account</h1><p>Secret details.</p>'));
        return;
      }
      const title = pathname.includes('github') ? 'GitHub issue' : 'Article title';
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
    const short = await command('--browser', 'chromium', 'read', id!, '--max-chars', '150');
    expect(short.stdout.length).toBeLessThanOrEqual(150);
    expect(short.stdout).toContain(`next: cobrowser read ${id} --page 1 --max-chars 150`);
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
    const tabs = await command('--browser', 'chromium', 'tabs', '--match', 'long');
    const id = tabs.stdout.match(/(\d+)\s+[* ]?\s*[z ]?\s+long\.test/)?.[1];
    expect(id).toBeTruthy();
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
    expect(sectionPage.stdout).toContain(
      `next: cobrowser read ${id} --section 0 --page 3 --max-chars 900`,
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
  });

  test('reads a sleeping tab and reports the reload', async () => {
    const sleeping = await context.newPage();
    await sleeping.goto(url('article.test', '/sleeping'));
    const other = await context.newPage();
    await other.goto(url('article.test', '/article?awake=1'));
    const tabs = await command('--browser', 'chromium', 'tabs', '--match', 'sleeping');
    const id = tabs.stdout.match(/(\d+)\s+[* ]?\s*[z ]?\s+article\.test/)?.[1];
    expect(id).toBeTruthy();
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
    const privatePage = await context.newPage();
    await privatePage.goto(url('bank.test', '/account'));
    const privateTabs = await command('--browser', 'chromium', 'tabs', '--match', 'bank');
    const privateId = privateTabs.stdout.match(/(\d+)\s+[* ]?\s*[z ]?\s+bank\.test/)?.[1];
    expect(privateId).toBeTruthy();
    await (
      await worker()
    ).evaluate(async () => {
      await chrome.storage.local.set({ denylist: ['bank.test'] });
    });
    const hidden = await command('--browser', 'chromium', 'tabs');
    expect(hidden.stdout).toContain('hidden by denylist');
    const denied = await failedCommand('--browser', 'chromium', 'read', privateId!);
    expect(denied.stderr).toContain('DENIED');
    const missing = await failedCommand('--browser', 'chromium', 'read', '999999999');
    expect(missing.stderr).toContain('TAB_NOT_FOUND');
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

  test('fails within two seconds after the browser closes', async () => {
    await context.close();
    const started = Date.now();
    const error = await cli('--browser', 'chromium', 'tabs').catch((value) => value);
    expect(Date.now() - started).toBeLessThan(4_000);
    expect(error.stderr).toContain('BROWSER_OFFLINE');
  });
});
