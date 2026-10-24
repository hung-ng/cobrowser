import { test, expect, chromium, type BrowserContext, type Page } from '@playwright/test';
import { createServer, request as httpRequest, type Server } from 'node:http';
import { chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const root = path.resolve(import.meta.dirname, '../..');
const build = process.env.COBROWSER_TEST_BUILD || path.join(root, 'dist');
const extensionId = 'laeencopealhcofijafpfkicblippbnp';
let context: BrowserContext;
let server: Server;
let home = '';
let profile = '';
let port = 0;
let firstPage: Page;
let secondPage: Page;
let firstId: number;
let secondId: number;
let windowId: number;

interface CaptureFixture {
  armed: boolean;
  entered: boolean;
  captured: boolean;
  dataUrl: string;
  captureTab?: { id?: number; url?: string };
  checks: Array<{ id?: number; url?: string }>;
  activations: Array<{ tabId: number; windowId: number }>;
  forbidden: string[];
  start?: () => void;
  finish?: () => void;
  activate: (id: number) => Promise<void>;
  createWindow: (url: string) => Promise<chrome.windows.Window | undefined>;
  createTab: (windowId: number, url: string) => Promise<chrome.tabs.Tab>;
}

declare global {
  var screenshotFixture: CaptureFixture;
}

async function worker() {
  await expect
    .poll(() => context.serviceWorkers().find((item) => item.url().includes('service-worker')))
    .toBeTruthy();
  return context.serviceWorkers().find((item) => item.url().includes('service-worker'))!;
}

async function cli(...args: string[]) {
  return exec(
    process.execPath,
    [path.join(home, 'runtime/cli.js'), '--browser', 'chromium', ...args],
    {
      env: { ...process.env, COBROWSER_HOME: home },
    },
  );
}

async function socket() {
  return new Promise<Record<string, any>>((resolve, reject) => {
    const request = httpRequest(
      {
        socketPath: path.join(home, 'run/chromium.sock'),
        path: '/v1/screenshot',
        method: 'POST',
        headers: { 'content-type': 'application/json' },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        response.once('error', reject);
        response.once('end', () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    request.once('error', reject);
    request.end(JSON.stringify({ windowId, maxChars: 1_000_000 }));
  });
}

async function view() {
  const browser = await (
    await worker()
  ).evaluate(async () => ({
    focused: (await chrome.windows.getLastFocused({ windowTypes: ['normal'] })).id,
    tabs: (await chrome.tabs.query({}))
      .map((tab) => ({ id: tab.id, windowId: tab.windowId, active: tab.active, url: tab.url }))
      .sort((left, right) => left.id! - right.id!),
    forbidden: screenshotFixture.forbidden,
  }));
  const scroll = await Promise.all(
    context.pages().map(async (page) => ({
      url: page.url(),
      position: await page.evaluate(() => [scrollX, scrollY]),
    })),
  );
  return { browser, scroll };
}

async function activate(id: number) {
  await (await worker()).evaluate((tabId) => screenshotFixture.activate(tabId), id);
}

async function paint(page: Page) {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => {
          requestAnimationFrame(() => resolve());
        }),
      ),
  );
}

async function pixel(dataUrl: string) {
  return firstPage.evaluate(async (source) => {
    const image = new Image();
    image.src = source;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = image.width;
    canvas.height = image.height;
    const drawing = canvas.getContext('2d')!;
    drawing.drawImage(image, 0, 0);
    return [...drawing.getImageData(image.width / 2, image.height / 2, 1, 1).data];
  }, dataUrl);
}

async function arm() {
  await (
    await worker()
  ).evaluate(() => {
    Object.assign(screenshotFixture, {
      armed: true,
      entered: false,
      captured: false,
      dataUrl: '',
      captureTab: undefined,
      checks: [],
      activations: [],
      start: undefined,
      finish: undefined,
    });
  });
}

async function waitFor(stage: 'entered' | 'captured') {
  await expect
    .poll(async () => (await worker()).evaluate((key) => screenshotFixture[key], stage))
    .toBe(true);
}

async function release(stage: 'start' | 'finish') {
  await (await worker()).evaluate((key) => screenshotFixture[key]?.(), stage);
}

async function captured() {
  return (await worker()).evaluate(() => ({
    dataUrl: screenshotFixture.dataUrl,
    captureTab: screenshotFixture.captureTab,
    checks: screenshotFixture.checks,
    activations: screenshotFixture.activations,
  }));
}

async function nativeImages() {
  return readFile(path.join(home, 'images.jsonl'), 'utf8').catch(() => '');
}

// Record real extension-to-helper image frames without changing their contents.
const proxy = String.raw`
import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
const [helper, home] = process.argv.slice(2);
const child = spawn(process.execPath, [helper, '--browser', 'chromium'], { stdio: ['pipe', 'pipe', 'inherit'] });
let pending = Buffer.alloc(0);
process.stdin.on('data', (chunk) => {
  pending = Buffer.concat([pending, chunk]);
  while (pending.length >= 4 && pending.length >= 4 + pending.readUInt32LE(0)) {
    const size = 4 + pending.readUInt32LE(0);
    const frame = pending.subarray(0, size);
    pending = pending.subarray(size);
    const message = JSON.parse(frame.subarray(4).toString('utf8'));
    if (typeof message.result?.dataUrl === 'string')
      appendFileSync(path.join(home, 'images.jsonl'), JSON.stringify({
        hash: createHash('sha256').update(message.result.dataUrl).digest('hex'),
        tabId: message.result.tabId, url: message.result.url,
      }) + '\n');
    child.stdin.write(frame);
  }
});
child.stdout.pipe(process.stdout);
process.stdin.on('end', () => child.stdin.end());
child.on('exit', (code) => process.exit(code ?? 1));
`;

test.describe.serial('screenshot tab association', () => {
  test.beforeAll(async () => {
    home = await mkdtemp('/tmp/cob-shot-home-');
    profile = await mkdtemp('/tmp/cob-shot-profile-');
    server = createServer((request, response) => {
      const second = request.url === '/second';
      response.setHeader('content-type', 'text/html');
      response.end(
        `<html style="background:rgb(${second ? '221,17,51' : '17,187,85'})"><head><title>${second ? 'Second' : 'First'} capture fixture</title></head><body style="height:3000px;margin:0"><h1>${second ? 'Second' : 'First'} synthetic page</h1></body></html>`,
      );
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    port = typeof address === 'object' && address ? address.port : 0;
    await cp(build, path.join(home, 'runtime'), { recursive: true });
    await writeFile(path.join(home, 'runtime/package.json'), JSON.stringify({ type: 'module' }));
    await cp(path.join(home, 'runtime/extension'), path.join(home, 'extension'), {
      recursive: true,
    });
    await writeFile(path.join(home, 'proxy.mjs'), proxy);
    const launcher = path.join(home, 'host.sh');
    await writeFile(
      launcher,
      `#!/bin/sh\nexport COBROWSER_HOME=${home}\nexec ${process.execPath} ${path.join(home, 'proxy.mjs')} ${path.join(home, 'runtime/helper.js')} ${home}\n`,
    );
    await chmod(launcher, 0o755);
    await mkdir(path.join(profile, 'NativeMessagingHosts'), { recursive: true });
    await writeFile(
      path.join(profile, 'NativeMessagingHosts/cobrowser.json'),
      JSON.stringify({
        name: 'cobrowser',
        description: 'Synthetic screenshot fixture',
        path: launcher,
        type: 'stdio',
        allowed_origins: [`chrome-extension://${extensionId}/`],
      }),
    );
    const extension = path.join(home, 'extension');
    context = await chromium.launchPersistentContext(profile, {
      channel: 'chromium',
      headless: process.env.HEADED !== '1',
      viewport: { width: 640, height: 480 },
      args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
    });
    await (
      await worker()
    ).evaluate(() => {
      const update = chrome.tabs.update.bind(chrome.tabs);
      const createTab = chrome.tabs.create.bind(chrome.tabs);
      const createWindow = chrome.windows.create.bind(chrome.windows);
      const query = chrome.tabs.query.bind(chrome.tabs);
      const capture = chrome.tabs.captureVisibleTab.bind(chrome.tabs);
      let lastCapture = 0;
      const captureReal = async (target: number, options: chrome.extensionTypes.ImageDetails) => {
        // Chrome permits only two captures per second across these serial tests.
        const delay = Math.max(0, lastCapture + 600 - performance.now());
        if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
        lastCapture = performance.now();
        return capture(target, options);
      };
      const fixture: CaptureFixture = (globalThis.screenshotFixture = {
        armed: false,
        entered: false,
        captured: false,
        dataUrl: '',
        checks: [],
        activations: [],
        forbidden: [],
        activate: async (id) =>
          new Promise<void>((resolve, reject) => {
            const listener = (info: { tabId: number; windowId: number }) => {
              if (info.tabId !== id) return;
              chrome.tabs.onActivated.removeListener(listener);
              resolve();
            };
            chrome.tabs.onActivated.addListener(listener);
            void update(id, { active: true }).catch(reject);
          }),
        createWindow: (url) => createWindow({ url, focused: false }),
        createTab: (windowId, url) => createTab({ windowId, url, active: false }),
      });
      chrome.tabs.onActivated.addListener((info) => fixture.activations.push(info));
      const forbid = (name: string) => {
        fixture.forbidden.push(name);
        throw new Error(`Forbidden product call: ${name}`);
      };
      chrome.tabs.update = ((...args: unknown[]) => {
        if (args.some((value) => value && typeof value === 'object' && 'active' in value))
          forbid('tabs.update active');
        return (update as (...args: unknown[]) => unknown)(...args);
      }) as typeof chrome.tabs.update;
      chrome.tabs.create = (() => forbid('tabs.create')) as typeof chrome.tabs.create;
      chrome.tabs.move = (() => forbid('tabs.move')) as typeof chrome.tabs.move;
      chrome.tabs.highlight = (() => forbid('tabs.highlight')) as typeof chrome.tabs.highlight;
      const updateWindow = chrome.windows.update.bind(chrome.windows);
      chrome.windows.update = ((...args: unknown[]) => {
        if (args.some((value) => value && typeof value === 'object' && 'focused' in value))
          forbid('windows.update focused');
        return (updateWindow as (...args: unknown[]) => unknown)(...args);
      }) as typeof chrome.windows.update;
      chrome.tabs.query = (async (info: chrome.tabs.QueryInfo) => {
        const tabs = await query(info);
        if (fixture.armed && info.active) {
          fixture.checks.push(...tabs.map(({ id, url }) => ({ id, url })));
          if (!fixture.entered) {
            fixture.entered = true;
            await new Promise<void>((resolve) => {
              fixture.start = resolve;
            });
          }
        }
        return tabs;
      }) as typeof chrome.tabs.query;
      chrome.tabs.captureVisibleTab = (async (
        target: number,
        options: chrome.extensionTypes.ImageDetails,
      ) => {
        if (!fixture.armed) return captureReal(target, options);
        const [tab] = await query({ windowId: target, active: true });
        fixture.captureTab = { id: tab?.id, url: tab?.url };
        fixture.dataUrl = await captureReal(target, options);
        fixture.captured = true;
        await new Promise<void>((resolve) => {
          fixture.finish = resolve;
        });
        return fixture.dataUrl;
      }) as typeof chrome.tabs.captureVisibleTab;
      return chrome.storage.local.set({ denylist: [], paused: false });
    });
    firstPage = context.pages()[0]!;
    await firstPage.goto(`http://127.0.0.1:${port}/first`);
    secondPage = await context.newPage();
    await secondPage.goto(`http://127.0.0.1:${port}/second`);
    const tabs = await (await worker()).evaluate(() => chrome.tabs.query({}));
    firstId = tabs.find((tab) => tab.url === firstPage.url())!.id!;
    secondId = tabs.find((tab) => tab.url === secondPage.url())!.id!;
    windowId = tabs.find((tab) => tab.id === firstId)!.windowId;
    await activate(firstId);
    await paint(firstPage);
    await expect
      .poll(async () => (await cli('tabs').catch(() => ({ stdout: '' }))).stdout)
      .toContain('First capture fixture');
  });

  test.beforeEach(async () => {
    await (
      await worker()
    ).evaluate(() => {
      screenshotFixture.armed = false;
      return chrome.storage.local.set({ denylist: [], paused: false });
    });
    await writeFile(path.join(home, 'images.jsonl'), '');
  });

  test.afterEach(async () => {
    await release('start');
    await release('finish');
    await (
      await worker()
    ).evaluate(() => {
      screenshotFixture.armed = false;
    });
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

  for (const client of ['socket', 'cli']) {
    test(`rejects a changed target after a first-second-first switch through ${client}`, async ({}, testInfo) => {
      const before = await view();
      await arm();
      const output = path.join(home, 'changed.png');
      const pending =
        client === 'socket'
          ? socket()
          : cli('screenshot', '--window', String(windowId), '--out', output).then(
              (result) => ({ ok: true, ...result }),
              (error) => ({ ok: false, stderr: String(error.stderr) }),
            );
      await waitFor('entered');
      await activate(secondId);
      await paint(secondPage);
      await release('start');
      await waitFor('captured');
      await activate(firstId);
      await paint(firstPage);
      const image = await captured();
      expect(image.captureTab).toEqual({ id: secondId, url: secondPage.url() });
      expect(await pixel(image.dataUrl)).toEqual([221, 17, 51, 255]);
      await release('finish');
      const result = await pending;
      const witness = await captured();
      expect(witness.checks.length).toBeGreaterThanOrEqual(2);
      expect(witness.checks.every((tab) => tab.id === firstId && tab.url === firstPage.url())).toBe(
        true,
      );
      expect(witness.activations.map((info) => info.tabId)).toEqual([secondId, firstId]);
      expect(await view()).toEqual(before);
      const imageHash = createHash('sha256').update(image.dataUrl).digest('hex');
      const observed = await nativeImages();
      await testInfo.attach('capture-witness', {
        contentType: 'application/json',
        body: JSON.stringify(
          {
            client,
            captureTab: witness.captureTab,
            checks: witness.checks,
            activations: witness.activations,
            pixel: [221, 17, 51, 255],
            imageHash,
            nativeDelivered: observed.includes(imageHash),
            resultOk: result.ok,
            returnedTabId: 'data' in result ? result.data?.tabId : undefined,
            returnedPixel:
              'data' in result && result.data?.dataUrl
                ? await pixel(result.data.dataUrl)
                : undefined,
            outputExists: await readFile(output).then(
              () => true,
              () => false,
            ),
          },
          null,
          2,
        ),
      });
      expect(result.ok, `Second-tab image delivered: ${observed.includes(imageHash)}`).toBe(false);
      if (client === 'socket') expect(result).toMatchObject({ error: { code: 'TIMEOUT' } });
      else expect(result).toMatchObject({ stderr: expect.stringContaining('visible tab changed') });
      expect(observed).toBe('');
      expect(
        await readFile(output).then(
          () => true,
          () => false,
        ),
      ).toBe(false);
    });
  }

  test('returns the first tab image through socket and CLI without changing the view', async () => {
    const before = await view();
    const result = await socket();
    expect(result).toMatchObject({ ok: true, data: { tabId: firstId, windowId } });
    expect(await pixel(result.data.dataUrl)).toEqual([17, 187, 85, 255]);
    const output = path.join(home, 'first.png');
    const saved = await cli('screenshot', '--out', output);
    expect(saved.stdout.trim()).toBe(output);
    expect(
      await pixel(`data:image/png;base64,${(await readFile(output)).toString('base64')}`),
    ).toEqual([17, 187, 85, 255]);
    expect(await view()).toEqual(before);
  });

  test('keeps a screenshot valid when tabs switch in another window', async () => {
    const control = await worker();
    const other = await control.evaluate(
      (url) => screenshotFixture.createWindow(url),
      `http://127.0.0.1:${port}/other-first`,
    );
    const otherWindowId = other!.id!;
    const otherFirstId = other!.tabs![0]!.id!;
    try {
      const otherSecond = await control.evaluate(
        ({ id, url }) => screenshotFixture.createTab(id, url),
        { id: otherWindowId, url: `http://127.0.0.1:${port}/other-second` },
      );
      await expect
        .poll(() => context.pages().filter((page) => page.url().includes('/other-')).length)
        .toBe(2);
      const before = await view();
      await arm();
      const pending = socket();
      await waitFor('entered');
      await activate(otherSecond.id!);
      await release('start');
      await waitFor('captured');
      await activate(otherFirstId);
      await release('finish');
      const result = await pending;
      expect(result).toMatchObject({ ok: true, data: { tabId: firstId, windowId } });
      expect(await pixel(result.data.dataUrl)).toEqual([17, 187, 85, 255]);
      expect((await captured()).activations).toEqual([
        { tabId: otherSecond.id, windowId: otherWindowId },
        { tabId: otherFirstId, windowId: otherWindowId },
      ]);
      expect(await view()).toEqual(before);
    } finally {
      await control.evaluate((id) => chrome.windows.remove(id), otherWindowId);
    }
  });

  for (const change of ['pause', 'reload']) {
    test(`preserves the ${change} guard while a screenshot result is pending`, async () => {
      const before = await view();
      await arm();
      const pending = socket();
      await waitFor('entered');
      await release('start');
      await waitFor('captured');
      if (change === 'pause') {
        await (await worker()).evaluate(() => chrome.storage.local.set({ paused: true }));
        await (await worker()).evaluate(() => chrome.storage.local.set({ paused: false }));
      } else {
        await firstPage.reload();
        await paint(firstPage);
      }
      await release('finish');
      expect(await pending).toMatchObject({
        ok: false,
        error: { code: change === 'pause' ? 'PAUSED' : 'TIMEOUT' },
      });
      expect(await nativeImages()).toBe('');
      expect(await view()).toEqual(before);
    });
  }
});
