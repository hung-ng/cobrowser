import { test, expect, chromium, type BrowserContext, type Page } from '@playwright/test';
import { createServer, request as httpRequest, type Server } from 'node:http';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const root = path.resolve(import.meta.dirname, '../..');
const extensionId = 'laeencopealhcofijafpfkicblippbnp';
let context: BrowserContext;
let home = '';
let profile = '';
let server: Server;
let port = 0;
let streamHits = 0;
let releases: Array<() => void> = [];
let holdBodies = true;
let articleVersion = 1;

const pdf = (text: string) =>
  `%PDF-1.4\n1 0 obj\n<<>>\nendobj\nstream\nBT (${text}) Tj ET\nendstream\n%%EOF`;
const url = (host: string, pathname: string) => `http://${host}:${port}${pathname}`;

async function worker() {
  await expect
    .poll(() => context.serviceWorkers().find((item) => item.url().includes('service-worker')))
    .toBeTruthy();
  return context.serviceWorkers().find((item) => item.url().includes('service-worker'))!;
}

async function setPrivacy(value: { denylist?: string[]; paused?: boolean }) {
  await (await worker()).evaluate((settings) => chrome.storage.local.set(settings), value);
}

async function tabId(page: Page) {
  return (await worker()).evaluate(
    async (href) => (await chrome.tabs.query({})).find((tab) => tab.url === href)!.id!,
    page.url(),
  );
}

async function invariant() {
  const browser = await (
    await worker()
  ).evaluate(async () => {
    const [tabs, focused] = await Promise.all([
      chrome.tabs.query({}),
      chrome.windows.getLastFocused({ windowTypes: ['normal'] }),
    ]);
    return {
      focused: focused.id,
      tabs: tabs
        .map((tab) => ({ id: tab.id, window: tab.windowId, active: tab.active, url: tab.url }))
        .sort((a, b) => a.id! - b.id!),
    };
  });
  const scroll = await Promise.all(
    context.pages().map(async (page) => ({
      url: page.url(),
      position: await page.evaluate(() => [scrollX, scrollY]).catch(() => null),
    })),
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

async function socket(command: string, body: Record<string, unknown>) {
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
    {
      env: { ...process.env, COBROWSER_HOME: home },
    },
  );
}

async function privatePage(pathname: string) {
  const page = await context.newPage();
  await page.goto(url('article.test', pathname));
  return { page, id: await tabId(page) };
}

// A private native proxy holds guards after the browser has already sent a snapshot.
const proxySource = `
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
const [helper, home] = process.argv.slice(2);
const child = spawn(process.execPath, [helper, '--browser', 'chromium'], { stdio: ['pipe', 'pipe', 'inherit'] });
const arm = path.join(home, 'privacy-arm');
const held = path.join(home, 'privacy-held');
const release = path.join(home, 'privacy-release');
let readId;
let fence;
let ready = false;
function frames(callback) {
  let pending = Buffer.alloc(0);
  return (chunk) => {
    pending = Buffer.concat([pending, chunk]);
    while (pending.length >= 4 && pending.length >= 4 + pending.readUInt32LE(0)) {
      const size = 4 + pending.readUInt32LE(0);
      const frame = pending.subarray(0, size);
      pending = pending.subarray(size);
      callback(JSON.parse(frame.subarray(4).toString('utf8')), frame);
    }
  };
}
let queue = Promise.resolve();
child.stdout.on('data', frames((message, frame) => {
  queue = queue.then(async () => {
    if (existsSync(arm) && message.method === (JSON.parse(await readFile(arm, 'utf8')).method || 'read')) {
      fence = JSON.parse(await readFile(arm, 'utf8'));
      readId = message.id;
      ready = false;
    }
    if (message.method === 'guard' && ready && fence) {
      if (fence.skipGuards > 0) fence.skipGuards--;
      else {
        await writeFile(held, 'held');
        while (!existsSync(release)) await new Promise((resolve) => setTimeout(resolve, 10));
        await Promise.all([arm, held, release].map((file) => rm(file, { force: true })));
        fence = undefined;
        ready = false;
      }
    }
    process.stdout.write(frame);
  });
}));
process.stdin.on('data', frames((message, frame) => {
  if (message.id === readId && message.ok) ready = true;
  child.stdin.write(frame);
}));
process.stdin.on('end', () => child.stdin.end());
child.on('exit', (code) => process.exit(code ?? 1));
`;

test.describe.serial('browser privacy', () => {
  test.beforeAll(async () => {
    home = await mkdtemp('/tmp/cobrowser-privacy-home-');
    profile = await mkdtemp('/tmp/cobrowser-privacy-profile-');
    server = createServer((request, response) => {
      const pathname = new URL(request.url || '/', 'http://fixture.test').pathname;
      const navigation =
        request.headers['sec-fetch-dest'] === 'document' ||
        request.headers.accept?.includes('text/html');
      if (!navigation && pathname.includes('redirect.pdf')) {
        const target = pathname.includes('stream-page')
          ? '/stream-page-source.pdf'
          : pathname.includes('stream')
            ? '/stream-source.pdf'
            : '/source.pdf';
        response.writeHead(302, {
          location: url('private.test', `${target}?signature=private-export-secret`),
        });
        response.end();
        return;
      }
      if (!navigation && pathname.endsWith('.pdf')) {
        response.setHeader('content-type', 'application/pdf');
        if (pathname.includes('stream-page')) {
          response.setHeader('access-control-allow-origin', url('article.test', ''));
          response.setHeader('access-control-allow-credentials', 'true');
        }
        if (holdBodies && pathname.includes('stream')) {
          streamHits++;
          response.flushHeaders();
          response.write('%PDF-1.4\n1 0 obj\n<<>>\nendobj\nstream\nBT ');
          releases.push(() => response.end('(Private streamed text) Tj ET\nendstream\n%%EOF'));
        } else {
          response.end(pdf('Private document text'));
        }
        return;
      }
      if (pathname === '/cached-document') {
        response.end(
          `<html><head><title>Cached document</title></head><body><h1>Cached document</h1><p>Document generation ${articleVersion}</p></body></html>`,
        );
        return;
      }
      response.end(
        '<html><head><title>Privacy fixture</title></head><body><h1>Privacy fixture</h1><p>Public article.</p></body></html>',
      );
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    port = typeof address === 'object' && address ? address.port : 0;
    await mkdir(path.join(home, 'extension'), { recursive: true });
    await writeFile(
      path.join(home, 'extension/manifest.json'),
      JSON.stringify({ version: '0.1.0' }),
    );
    await writeFile(path.join(home, 'native-proxy.mjs'), proxySource);
    const launcher = path.join(home, 'host.sh');
    await writeFile(
      launcher,
      `#!/bin/sh\nexport COBROWSER_HOME=${home}\nexec ${process.execPath} ${path.join(home, 'native-proxy.mjs')} ${path.join(root, 'dist/helper.js')} ${home}\n`,
    );
    await chmod(launcher, 0o755);
    await mkdir(path.join(profile, 'NativeMessagingHosts'), { recursive: true });
    await writeFile(
      path.join(profile, 'NativeMessagingHosts/cobrowser.json'),
      JSON.stringify({
        name: 'cobrowser',
        description: 'Privacy fixture',
        path: launcher,
        type: 'stdio',
        allowed_origins: [`chrome-extension://${extensionId}/`],
      }),
    );
    const extension = path.join(root, 'dist/extension');
    context = await chromium.launchPersistentContext(profile, {
      channel: 'chromium',
      headless: process.env.HEADED !== '1',
      args: [
        `--disable-extensions-except=${extension}`,
        `--load-extension=${extension}`,
        '--host-resolver-rules=MAP article.test 127.0.0.1,MAP private.test 127.0.0.1',
      ],
    });
    await (
      await worker()
    ).evaluate(() => {
      const scope = globalThis as typeof globalThis & { privacyBodyReads: number };
      scope.privacyBodyReads = 0;
      const reader = ReadableStreamDefaultReader.prototype;
      const read = reader.read;
      reader.read = function () {
        scope.privacyBodyReads++;
        return read.call(this);
      };
    });
    await context.pages()[0]!.goto(url('article.test', '/article'));
    await expect
      .poll(async () => (await cli('tabs').catch(() => ({ stdout: '' }))).stdout)
      .toContain('Privacy fixture');
  });

  test.beforeEach(async () => {
    streamHits = 0;
    releases = [];
    holdBodies = true;
    await (
      await worker()
    ).evaluate(() => {
      (globalThis as typeof globalThis & { privacyBodyReads: number }).privacyBodyReads = 0;
    });
    await setPrivacy({ denylist: [], paused: false });
  });

  test.afterEach(async () => {
    for (const release of releases) release();
    await writeFile(path.join(home, 'privacy-release'), 'release');
    await setPrivacy({ denylist: [], paused: false });
    await Promise.all(
      ['privacy-arm', 'privacy-held', 'privacy-release'].map((name) =>
        rm(path.join(home, name), { force: true }),
      ),
    );
  });

  test.afterAll(async () => {
    await context?.close();
    server?.closeAllConnections();
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    if (!process.env.KEEP_E2E)
      await Promise.all(
        [home, profile]
          .filter(Boolean)
          .map((directory) => rm(directory, { recursive: true, force: true })),
      );
  });

  for (const pageFetch of [false, true]) {
    test(`rejects a redirected destination denied while the ${pageFetch ? 'page' : 'worker'} reads its body`, async () => {
      const { page, id } = await privatePage(
        pageFetch ? '/stream-page-redirect.pdf' : '/stream-redirect.pdf',
      );
      try {
        await unchanged(async () => {
          const pending = socket('read', { id });
          await expect.poll(() => streamHits).toBe(pageFetch ? 1 : 2);
          if (!pageFetch)
            await expect
              .poll(async () =>
                (await worker()).evaluate(
                  () =>
                    (globalThis as typeof globalThis & { privacyBodyReads: number })
                      .privacyBodyReads,
                ),
              )
              .toBeGreaterThan(0);
          await setPrivacy({ denylist: ['private.test'] });
          holdBodies = false;
          for (const release of releases) release();
          const result = await pending;
          expect(result).toMatchObject({ ok: false, error: { code: 'DENIED' } });
          expect(JSON.stringify(result)).not.toContain('Private streamed text');
          expect(
            await readFile(path.join(home, 'logs/reads.jsonl'), 'utf8').catch(() => ''),
          ).not.toContain('source.pdf');
        });
      } finally {
        await page.close();
      }
    });
  }

  test('guards cached destination URLs for socket reads and CLI search without publishing provenance', async () => {
    const { page, id } = await privatePage('/cache-redirect.pdf');
    try {
      await unchanged(async () => {
        const first = await socket('read', { id });
        expect(first).toMatchObject({ ok: true });
        expect(first.text).toContain('Private document text');
        const log = await socket('log', {});
        for (const output of [first, log]) {
          expect(JSON.stringify(output)).not.toMatch(
            /sourceUrls|pauseEpoch|private\.test|private-export-secret|source\.pdf/,
          );
        }
        expect(await readFile(path.join(home, 'logs/reads.jsonl'), 'utf8')).not.toMatch(
          /private\.test|private-export-secret|sourceUrls/,
        );
        await setPrivacy({ denylist: ['private.test'] });
        expect(await socket('read', { id })).toMatchObject({
          ok: false,
          error: { code: 'DENIED' },
        });
        const failure = await cli('find', String(id), 'Private').catch((error) => error);
        expect(failure.stderr).toContain('DENIED');
        expect(failure.stdout).not.toContain('Private document text');
      });
    } finally {
      await page.close();
    }
  });

  test('discards a streamed document after pause turns on and off', async () => {
    const { page, id } = await privatePage('/stream.pdf');
    try {
      await unchanged(async () => {
        const pending = socket('read', { id });
        await expect.poll(() => streamHits).toBeGreaterThan(0);
        await setPrivacy({ paused: true });
        await setPrivacy({ paused: false });
        holdBodies = false;
        for (const release of releases) release();
        expect(await pending).toMatchObject({ ok: false, error: { code: 'PAUSED' } });
        expect(await socket('read', { id })).toMatchObject({ ok: true });
      });
    } finally {
      await page.close();
    }
  });

  for (const skipGuards of [0, 1]) {
    test(`remembers a transient pause before final guard ${skipGuards + 1}`, async () => {
      const { page, id } = await privatePage(`/boundary-${skipGuards}.pdf`);
      try {
        await writeFile(path.join(home, 'privacy-arm'), JSON.stringify({ skipGuards }));
        await unchanged(async () => {
          const pending = socket('read', { id });
          await expect
            .poll(() => readFile(path.join(home, 'privacy-held'), 'utf8').catch(() => ''))
            .toBe('held');
          await setPrivacy({ paused: true });
          await setPrivacy({ paused: false });
          await writeFile(path.join(home, 'privacy-release'), 'release');
          const result = await pending;
          expect(result).toMatchObject({ ok: false, error: { code: 'PAUSED' } });
          expect(JSON.stringify(result)).not.toContain('Private document text');
          expect(await socket('read', { id })).toMatchObject({ ok: true });
        });
      } finally {
        await page.close();
      }
    });
  }

  test('matches an encoded denylist path saved through the options page', async () => {
    const { page, id } = await privatePage('/private%20folder/note');
    const options = await context.newPage();
    try {
      await options.goto(`chrome-extension://${extensionId}/options.html`);
      await options.locator('#denylist').fill('article.test/private%20folder');
      await options.locator('#save').click();
      await expect(options.locator('#status')).toHaveText('Saved.');
      await options.reload();
      await expect(options.locator('#denylist')).toHaveValue('article.test/private%20folder');
      await unchanged(async () => {
        expect(await socket('read', { id })).toMatchObject({
          ok: false,
          error: { code: 'DENIED' },
        });
        expect(await socket('tabs', { match: 'private%20folder' })).toMatchObject({
          ok: true,
          data: { tabs: [] },
        });
      });
    } finally {
      await page.close();
      await options.close();
    }
  });

  for (const suffix of ['/%FF/note', '/%/note', '%2F%FF/note']) {
    test(`keeps an encoded denied prefix private with malformed suffix ${suffix}`, async () => {
      const { page, id } = await privatePage(`/private%20folder${suffix}`);
      try {
        await page.locator('p').evaluate((node) => {
          node.textContent = 'Malformedprivatecontent';
        });
        await setPrivacy({ denylist: ['article.test/private%20folder'] });
        await unchanged(async () => {
          expect(await socket('tabs', { match: 'private%20folder' })).toMatchObject({
            ok: true,
            data: { tabs: [] },
          });
          for (const command of ['read', 'query']) {
            const result = await socket(command, { id, selector: 'p' });
            expect(result).toMatchObject({ ok: false, error: { code: 'DENIED' } });
            expect(JSON.stringify(result)).not.toContain('Malformedprivatecontent');
          }
        });
      } finally {
        await page.close();
      }
    });
  }

  for (const change of ['denylist', 'same-url reload', 'unrelated reload']) {
    test(`rechecks earlier guard batches after ${change}`, async () => {
      const first = await privatePage('/batch-secret');
      const second = await privatePage('/batch-public');
      const unrelated = await privatePage('/batch-unrelated');
      try {
        await first.page.locator('p').evaluate((node) => {
          node.textContent = 'Batchprivatecontent';
        });
        await writeFile(
          path.join(home, 'privacy-arm'),
          JSON.stringify({ method: 'tab', skipGuards: 3 }),
        );
        await unchanged(async () => {
          const pending = socket('read', {
            ids: [first.id, ...Array(32).fill(second.id)],
            maxChars: 100_000,
          });
          await expect
            .poll(() => readFile(path.join(home, 'privacy-held'), 'utf8').catch(() => ''))
            .toBe('held');
          if (change === 'denylist') await setPrivacy({ denylist: ['article.test/batch-secret'] });
          else await (change === 'same-url reload' ? first.page : unrelated.page).reload();
          await writeFile(path.join(home, 'privacy-release'), 'release');
          const result = await pending;
          if (change === 'unrelated reload') {
            expect(result).toMatchObject({ ok: true });
            expect(result.text).toContain('Batchprivatecontent');
          } else {
            expect(result).toMatchObject({
              ok: false,
              error: { code: change === 'denylist' ? 'DENIED' : 'TIMEOUT' },
            });
            expect(JSON.stringify(result)).not.toContain('Batchprivatecontent');
          }
        });
      } finally {
        await first.page.close();
        await second.page.close();
        await unrelated.page.close();
      }
    });
  }

  test('keeps the cached snapshot generation through a same-URL reload before delivery', async () => {
    articleVersion = 1;
    const { page, id } = await privatePage('/cached-document');
    try {
      await unchanged(async () => {
        expect((await socket('read', { id })).text).toContain('Document generation 1');
        await writeFile(
          path.join(home, 'privacy-arm'),
          JSON.stringify({ method: 'tab', skipGuards: 1 }),
        );
        const pending = socket('read', { id });
        await expect
          .poll(() => readFile(path.join(home, 'privacy-held'), 'utf8').catch(() => ''))
          .toBe('held');
        articleVersion = 2;
        await page.reload();
        await writeFile(path.join(home, 'privacy-release'), 'release');
        const result = await pending;
        expect(result).toMatchObject({ ok: false, error: { code: 'TIMEOUT' } });
        expect(JSON.stringify(result)).not.toContain('Document generation 1');
        expect((await socket('read', { id })).text).toContain('Document generation 2');
      });
    } finally {
      await page.close();
    }
  });

  test('keeps many-tab guards with long URLs below the native frame limit', async () => {
    const first = await privatePage(`/long-guard-first#${'x'.repeat(16_300)}`);
    const second = await privatePage(`/long-guard-second#${'y'.repeat(16_300)}`);
    try {
      await unchanged(async () => {
        const result = await socket('read', {
          ids: [...Array(16).fill(first.id), ...Array(16).fill(second.id)],
          maxChars: 2_000_000,
        });
        expect(result).toMatchObject({ ok: true });
        expect(result.data).toHaveLength(32);
        expect(result.text).toContain('Public article.');
      });
    } finally {
      await first.page.close();
      await second.page.close();
    }
  });

  for (const command of ['tabs', 'query', 'selection', 'screenshot']) {
    test(`binds ${command} output to the captured document through a same-URL reload`, async () => {
      const { page, id } = await privatePage(`/identity-${command}`);
      try {
        await page.locator('p').evaluate((node) => {
          node.textContent = 'Capturedprivatecontent';
          const range = document.createRange();
          range.selectNodeContents(node);
          window.getSelection()?.removeAllRanges();
          window.getSelection()?.addRange(range);
        });
        await writeFile(
          path.join(home, 'privacy-arm'),
          JSON.stringify({ method: command, skipGuards: command === 'tabs' ? 0 : 1 }),
        );
        await unchanged(async () => {
          const pending = socket(
            command,
            command === 'query'
              ? { id, selector: 'p' }
              : command === 'selection'
                ? { id }
                : command === 'screenshot'
                  ? { maxChars: 1_000_000 }
                  : {},
          );
          await expect
            .poll(() => readFile(path.join(home, 'privacy-held'), 'utf8').catch(() => ''))
            .toBe('held');
          await page.reload();
          await writeFile(path.join(home, 'privacy-release'), 'release');
          const result = await pending;
          expect(result).toMatchObject({ ok: false, error: { code: 'TIMEOUT' } });
          expect(JSON.stringify(result)).not.toContain('Capturedprivatecontent');
        });
      } finally {
        await page.close();
      }
    });
  }
});
