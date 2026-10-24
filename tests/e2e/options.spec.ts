import { test, expect, chromium, type BrowserContext, type Page } from '@playwright/test';
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, request as httpRequest, type Server } from 'node:http';
import path from 'node:path';
import { promisify } from 'node:util';
import { DEFAULT_DENYLIST } from '../../src/shared/denylist.js';

const exec = promisify(execFile);
const root = path.resolve(import.meta.dirname, '../..');
const extensionId = 'laeencopealhcofijafpfkicblippbnp';
const optionsUrl = `chrome-extension://${extensionId}/options.html`;
const unverifiedSave =
  'The save completed, but the current denylist could not be verified; try Save again.';
let context: BrowserContext;
let home = '';
let profile = '';
let server: Server;
let port = 0;
let first: Page;
let second: Page;
let article: Page;

async function launch(native: boolean) {
  const home = await mkdtemp('/tmp/cob-options-home-');
  const profile = await mkdtemp('/tmp/cob-options-profile-');
  try {
    if (native) {
      await mkdir(path.join(home, 'extension'));
      await writeFile(
        path.join(home, 'extension/manifest.json'),
        JSON.stringify({ version: '0.1.0' }),
      );
      const host = path.join(home, 'host.sh');
      await writeFile(
        host,
        `#!/bin/sh\nexport COBROWSER_HOME='${home}'\nexec '${process.execPath}' '${path.join(root, 'dist/helper.js')}' --browser chromium\n`,
      );
      await chmod(host, 0o755);
      await mkdir(path.join(profile, 'NativeMessagingHosts'));
      await writeFile(
        path.join(profile, 'NativeMessagingHosts/cobrowser.json'),
        JSON.stringify({
          name: 'cobrowser',
          description: 'Private options regression',
          path: host,
          type: 'stdio',
          allowed_origins: [`chrome-extension://${extensionId}/`],
        }),
      );
    }
    const extension = path.join(root, 'dist/extension');
    const context = await chromium.launchPersistentContext(profile, {
      channel: 'chromium',
      headless: true,
      args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
    });
    return { context, home, profile };
  } catch (error) {
    await Promise.all(
      [home, profile].map((directory) => rm(directory, { recursive: true, force: true })),
    );
    throw error;
  }
}

async function worker() {
  await expect
    .poll(() => context.serviceWorkers().find((item) => item.url().includes('service-worker')))
    .toBeTruthy();
  return context.serviceWorkers().find((item) => item.url().includes('service-worker'))!;
}

async function patterns() {
  return (await (await worker()).evaluate(() => chrome.storage.local.get('denylist')))
    .denylist as string[];
}

async function initialize(patterns: string[]) {
  await (
    await worker()
  ).evaluate((denylist) => chrome.storage.local.set({ denylist, paused: false }), patterns);
  await Promise.all(
    [first, second].map(async (page) => {
      await page.reload();
      await expect(page.locator('#denylist')).toBeEnabled();
      await expect(page.locator('#denylist')).toHaveValue(patterns.join('\n'));
    }),
  );
}

async function save(page: Page, draft: string) {
  await page.locator('#denylist').fill(draft);
  await page.locator('#save').click();
  await expect(page.locator('#status')).toHaveText(/^(Saved\.|No valid entries\.)/);
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
      position: await page.evaluate(() => [scrollX, scrollY]),
    })),
  );
  return { browser, scroll };
}

async function unchanged<T>(action: () => Promise<T>) {
  const before = await invariant();
  try {
    return await action();
  } finally {
    expect(await invariant()).toEqual(before);
  }
}

async function cli(...args: string[]) {
  return unchanged(async () => {
    try {
      const result = await exec(
        process.execPath,
        [path.join(root, 'dist/cli.js'), '--browser', 'chromium', ...args],
        { env: { ...process.env, COBROWSER_HOME: home } },
      );
      return { code: 0, ...result };
    } catch (error) {
      const result = error as { code: number; stdout: string; stderr: string };
      return { code: result.code, stdout: result.stdout, stderr: result.stderr };
    }
  });
}

async function readSocket(id: number) {
  return unchanged(
    () =>
      new Promise<Record<string, any>>((resolve, reject) => {
        const request = httpRequest(
          { socketPath: path.join(home, 'run/chromium.sock'), path: '/v1/read', method: 'POST' },
          (response) => {
            let body = '';
            response.on('data', (chunk) => (body += String(chunk)));
            response.on('error', reject);
            response.on('end', () => {
              try {
                resolve(JSON.parse(body));
              } catch (error) {
                reject(error);
              }
            });
          },
        );
        request.on('error', reject);
        request.end(JSON.stringify({ ids: [id], maxChars: 2000 }));
      }),
  );
}

async function articleId() {
  return (await worker()).evaluate(
    async (url) => (await chrome.tabs.query({})).find((tab) => tab.url === url)!.id!,
    article.url(),
  );
}

async function holdReply(page: Page) {
  await page.evaluate(() => {
    const send = chrome.runtime.sendMessage.bind(chrome.runtime);
    const fixture = {
      held: false,
      changes: 0,
      release: undefined as (() => void) | undefined,
      send,
    };
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes.denylist) fixture.changes++;
    });
    (globalThis as any).__optionsReply = fixture;
    chrome.runtime.sendMessage = (async (message: unknown) => {
      const response = await send(message);
      if ((message as any)?.type === 'cobrowser:denylist' && !fixture.held) {
        fixture.held = true;
        await new Promise<void>((resolve) => (fixture.release = resolve));
      }
      return response;
    }) as typeof chrome.runtime.sendMessage;
  });
}

async function replyHeld(page: Page) {
  await expect.poll(() => page.evaluate(() => (globalThis as any).__optionsReply?.held)).toBe(true);
  await expect
    .poll(() => page.evaluate(() => (globalThis as any).__optionsReply?.changes))
    .toBeGreaterThan(0);
}

async function releaseReply(page: Page) {
  await page.evaluate(() => (globalThis as any).__optionsReply.release());
}

async function failNextRefresh(page: Page, failures = 1) {
  await page.evaluate((failures) => {
    const get = chrome.storage.local.get.bind(chrome.storage.local);
    const fixture = { calls: 0, restore: () => (chrome.storage.local.get = get) };
    (globalThis as any).__optionsRefresh = fixture;
    chrome.storage.local.get = ((...args: Parameters<typeof get>) => {
      fixture.calls++;
      return fixture.calls <= failures
        ? Promise.reject(new Error('Synthetic storage refresh failure.'))
        : get(...args);
    }) as typeof chrome.storage.local.get;
  }, failures);
}

async function holdWorkerWrite() {
  await (
    await worker()
  ).evaluate(() => {
    const set = chrome.storage.local.set.bind(chrome.storage.local);
    const fixture = { held: false, release: undefined as (() => void) | undefined, set };
    (globalThis as any).__optionsWrite = fixture;
    chrome.storage.local.set = (async (items: Record<string, unknown>) => {
      if ('denylist' in items && !fixture.held) {
        fixture.held = true;
        await new Promise<void>((resolve) => (fixture.release = resolve));
      }
      await set(items);
    }) as typeof chrome.storage.local.set;
  });
}

async function writeHeld() {
  await expect
    .poll(async () => (await worker()).evaluate(() => (globalThis as any).__optionsWrite?.held))
    .toBe(true);
}

async function releaseWrite() {
  await (await worker()).evaluate(() => (globalThis as any).__optionsWrite.release());
}

test.describe.serial('options saves', () => {
  test.beforeAll(async () => {
    server = createServer((_request, response) => {
      response.setHeader('content-type', 'text/html');
      response.end(
        `<title>Private local article</title><main><h1>Local article</h1><p>PRIVATE_FIXTURE_CONTENT</p>${'<p>Synthetic local paragraph.</p>'.repeat(150)}</main>`,
      );
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as { port: number }).port;
    ({ context, home, profile } = await launch(true));
    await expect
      .poll(
        async () =>
          (await (await worker()).evaluate(() => chrome.storage.local.get('connected'))).connected,
      )
      .toBe(true);
    article = await context.newPage();
    await article.goto(`http://127.0.0.1:${port}/private`);
    await article.evaluate(() => scrollTo(0, 180));
  });
  test.beforeEach(async () => {
    first = await context.newPage();
    second = await context.newPage();
    await Promise.all([first.goto(optionsUrl), second.goto(optionsUrl)]);
    await initialize(['localhost/seed']);
  });
  test.afterEach(async () => {
    await (
      await worker()
    ).evaluate(() => {
      const fixture = (globalThis as any).__optionsWrite;
      if (fixture) {
        fixture.release?.();
        chrome.storage.local.set = fixture.set;
        if (fixture.listener) chrome.runtime.onMessage.removeListener(fixture.listener);
        delete (globalThis as any).__optionsWrite;
      }
    });
    for (const page of [first, second]) {
      if (!page || page.isClosed()) continue;
      await page.evaluate(() => (globalThis as any).__optionsReply?.release?.());
      await page.close();
    }
  });
  test.afterAll(async () => {
    await context?.close();
    await Promise.all(
      [home, profile]
        .filter(Boolean)
        .map((directory) => rm(directory, { recursive: true, force: true })),
    );
    await new Promise<void>((resolve) => server?.close(() => resolve()));
  });

  test('keeps a newly denied page denied when the older options page saves', async ({}, info) => {
    await save(first, 'localhost/seed\n127.0.0.1/private');
    const id = await articleId();
    const before = await cli('read', String(id), '--json');
    expect(before.stdout + before.stderr).toContain('DENIED');
    await second.locator('#save').click();
    await expect(second.locator('#status')).toHaveText('Saved.');
    const after = await cli('read', String(id), '--json');
    const socket = await readSocket(id);
    await first.screenshot({ path: info.outputPath('first-options.png') });
    await second.screenshot({ path: info.outputPath('second-options.png') });
    await writeFile(
      info.outputPath('evidence.json'),
      JSON.stringify(
        {
          after,
          socket,
          first: await first.locator('body').ariaSnapshot(),
          second: await second.locator('body').ariaSnapshot(),
        },
        null,
        2,
      ),
    );
    expect(after.stdout + after.stderr).toContain('DENIED');
    expect(socket.error?.code).toBe('DENIED');
    await expect(first.locator('#denylist')).toHaveValue('localhost/seed\n127.0.0.1/private');
    await expect(second.locator('#denylist')).toHaveValue('localhost/seed\n127.0.0.1/private');
  });

  test('serializes distinct additions from two dirty options pages', async () => {
    await first.locator('#denylist').fill('localhost/seed\nlocalhost/first');
    await second.locator('#denylist').fill('localhost/seed\n127.0.0.1/private');
    await holdWorkerWrite();
    await first.locator('#save').click();
    await writeHeld();
    await second.locator('#save').click();
    await releaseWrite();
    await expect.poll(patterns).toEqual(['localhost/seed', 'localhost/first', '127.0.0.1/private']);
    await expect(first.locator('#denylist')).toHaveValue(
      'localhost/seed\nlocalhost/first\n127.0.0.1/private',
    );
    await expect(second.locator('#denylist')).toHaveValue(
      'localhost/seed\nlocalhost/first\n127.0.0.1/private',
    );
    expect((await readSocket(await articleId())).error?.code).toBe('DENIED');
  });

  test('updates clean editors and preserves dirty drafts and unseen removals', async () => {
    await initialize(['localhost/seed', 'localhost/remove']);
    await second.locator('#denylist').fill('localhost/seed\nlocalhost/remove\nlocalhost/draft');
    await save(first, 'localhost/seed\n127.0.0.1/private');
    await expect(second.locator('#denylist')).toHaveValue(
      'localhost/seed\nlocalhost/remove\nlocalhost/draft',
    );
    await expect(second.locator('#status')).toContainText('Unsaved changes.');
    await second.locator('#save').click();
    await expect.poll(patterns).toEqual(['localhost/seed', '127.0.0.1/private', 'localhost/draft']);
    await expect(second.locator('#denylist')).toHaveValue(
      'localhost/seed\n127.0.0.1/private\nlocalhost/draft',
    );
    await expect(first.locator('#denylist')).toHaveValue(
      'localhost/seed\n127.0.0.1/private\nlocalhost/draft',
    );
    await expect(first.locator('#status')).toHaveText('Denylist updated.');
  });

  for (const readd of [false, true]) {
    test(`preserves unseen rules when a pending draft removes${readd ? ' and re-adds' : ''} its submitted rule`, async () => {
      await first.locator('#denylist').fill('localhost/seed\nlocalhost/own');
      await save(second, 'localhost/seed\n127.0.0.1/private');
      await holdReply(first);
      await first.locator('#save').click();
      await replyHeld(first);
      await expect(second.locator('#denylist')).toHaveValue(
        'localhost/seed\n127.0.0.1/private\nlocalhost/own',
      );
      await first.locator('#denylist').fill('localhost/seed');
      await first.locator('#save').click();
      if (readd) {
        await first.locator('#denylist').fill('localhost/seed\nlocalhost/own');
        await first.locator('#save').click();
      }
      await releaseReply(first);
      const final = ['localhost/seed', '127.0.0.1/private', ...(readd ? ['localhost/own'] : [])];
      await expect.poll(patterns).toEqual(final);
      await expect(first.locator('#denylist')).toHaveValue(final.join('\n'));
      await expect(first.locator('#status')).toHaveText('Saved. Newer changes kept.');
      expect((await readSocket(await articleId())).error?.code).toBe('DENIED');
    });
  }

  test('keeps a newer unsaved draft after its own storage event and reply', async () => {
    await first.locator('#denylist').fill('localhost/seed\nlocalhost/own');
    await holdReply(first);
    await first.locator('#save').click();
    await replyHeld(first);
    await expect(second.locator('#denylist')).toHaveValue('localhost/seed\nlocalhost/own');
    await first.locator('#denylist').fill('localhost/seed\nlocalhost/new-draft');
    await save(second, 'localhost/seed\nlocalhost/own\n127.0.0.1/private');
    await releaseReply(first);
    await expect(first.locator('#status')).toContainText('You have unsaved changes.');
    await expect(first.locator('#denylist')).toHaveValue('localhost/seed\nlocalhost/new-draft');
    await first.locator('#save').click();
    await expect
      .poll(patterns)
      .toEqual(['localhost/seed', '127.0.0.1/private', 'localhost/new-draft']);
  });

  for (const removed of [true, false]) {
    test(`keeps a newer observed ${removed ? 'removal' : 'addition'} when a held save reply cannot refresh storage`, async ({}, info) => {
      const base = ['localhost/seed', ...(removed ? ['127.0.0.1/private'] : [])];
      await initialize(base);
      await holdReply(first);
      await first.locator('#denylist').fill([...base, 'localhost/own'].join('\n'));
      await first.locator('#save').click();
      await replyHeld(first);
      const saved = ['localhost/seed', 'localhost/own', ...(removed ? [] : ['127.0.0.1/private'])];
      await save(second, saved.join('\n'));
      await expect
        .poll(() => first.evaluate(() => (globalThis as any).__optionsReply.changes))
        .toBe(2);
      await failNextRefresh(first);
      await releaseReply(first);
      await expect(first.locator('#status')).toHaveText('Saved.');
      await expect
        .poll(() => first.evaluate(() => (globalThis as any).__optionsRefresh.calls))
        .toBe(2);
      const before = await invariant();
      const cliResponse = await cli('read', String(await articleId()), '--json');
      const socketResponse = await readSocket(await articleId());
      const after = await invariant();
      const draft = await first.locator('#denylist').inputValue();
      const stored = await patterns();
      await first.screenshot({ path: info.outputPath('first-options.png') });
      await second.screenshot({ path: info.outputPath('second-options.png') });
      await writeFile(
        info.outputPath('evidence.json'),
        JSON.stringify(
          {
            draft,
            stored,
            snapshot: await first.locator('body').ariaSnapshot(),
            cli: cliResponse,
            socket: socketResponse,
            before,
            after,
          },
          null,
          2,
        ),
      );
      expect(after).toEqual(before);
      expect(stored).toEqual(saved);
      if (removed) {
        expect(cliResponse.code).toBe(0);
        expect(socketResponse.ok).toBe(true);
      } else {
        expect(cliResponse.stdout + cliResponse.stderr).toContain('DENIED');
        expect(socketResponse.error?.code).toBe('DENIED');
      }
      expect(draft).toBe(saved.join('\n'));
      await first.locator('#save').click();
      await expect(first.locator('#status')).toHaveText('Saved.');
      expect(await patterns()).toEqual(saved);
    });
  }

  for (const persistent of [false, true]) {
    test(`verifies saved rules without a delivered event${persistent ? ' after reporting persistent read failure' : ' after a transient read failure'}`, async () => {
      await first.addInitScript(() => {
        const addListener = chrome.storage.onChanged.addListener.bind(chrome.storage.onChanged);
        const deferred: Array<() => void> = [];
        (globalThis as any).__optionsChanges = deferred;
        chrome.storage.onChanged.addListener = (listener) =>
          addListener((changes, area) => {
            if (area === 'local' && changes.denylist) deferred.push(() => listener(changes, area));
            else listener(changes, area);
          });
      });
      await first.reload();
      await expect(first.locator('#denylist')).toBeEnabled();
      await expect(first.locator('#denylist')).toHaveValue('localhost/seed');
      await failNextRefresh(first, persistent ? 99 : 1);
      await first.locator('#denylist').fill('localhost/seed\n127.0.0.1/private');
      await first.locator('#save').click();
      await expect(first.locator('#status')).toHaveText(persistent ? unverifiedSave : 'Saved.');
      await expect
        .poll(() => first.evaluate(() => (globalThis as any).__optionsChanges.length))
        .toBeGreaterThan(0);
      expect(await first.evaluate(() => (globalThis as any).__optionsRefresh.calls)).toBe(
        persistent ? 3 : 2,
      );
      await expect(first.locator('#denylist')).toHaveValue('localhost/seed\n127.0.0.1/private');
      expect(await patterns()).toEqual(['localhost/seed', '127.0.0.1/private']);
      const response = await cli('read', String(await articleId()), '--json');
      expect(response.stdout + response.stderr).toContain('DENIED');
      expect((await readSocket(await articleId())).error?.code).toBe('DENIED');
      if (persistent) {
        await first.evaluate(() => (globalThis as any).__optionsRefresh.restore());
        await first.locator('#save').click();
        await expect(first.locator('#status')).toHaveText('Saved.');
      }
      await first.evaluate(() => {
        for (const deliver of (globalThis as any).__optionsChanges) deliver();
      });
    });
  }

  test('verifies its own write after observing an earlier queued write event', async ({}, info) => {
    await initialize(['localhost/seed', '127.0.0.1/private']);
    await first.addInitScript(() => {
      const addListener = chrome.storage.onChanged.addListener.bind(chrome.storage.onChanged);
      const fixture = {
        deferred: [] as Array<() => void>,
        observed: [] as string[][],
      };
      (globalThis as any).__optionsMixedEvents = fixture;
      chrome.storage.onChanged.addListener = (listener) =>
        addListener((changes, area) => {
          if (area === 'local' && changes.denylist) {
            const next = changes.denylist.newValue as string[];
            if (next.includes('localhost/other') && !next.includes('127.0.0.1/private')) {
              fixture.deferred.push(() => listener(changes, area));
              return;
            }
            fixture.observed.push(next);
          }
          listener(changes, area);
        });
    });
    await first.reload();
    await expect(first.locator('#denylist')).toBeEnabled();
    await first.locator('#denylist').fill('localhost/seed');
    await second.locator('#denylist').fill('localhost/seed\n127.0.0.1/private\nlocalhost/other');
    await holdWorkerWrite();
    await (
      await worker()
    ).evaluate(() => {
      const fixture = (globalThis as any).__optionsWrite;
      fixture.received = false;
      fixture.listener = (message: any) => {
        if (message?.type === 'cobrowser:denylist' && message.draft === 'localhost/seed')
          fixture.received = true;
        return false;
      };
      chrome.runtime.onMessage.addListener(fixture.listener);
    });
    await second.locator('#save').click();
    await writeHeld();
    await failNextRefresh(first);
    await first.locator('#save').click();
    await expect
      .poll(async () =>
        (await worker()).evaluate(() => (globalThis as any).__optionsWrite.received),
      )
      .toBe(true);
    await releaseWrite();
    await expect(first.locator('#status')).toHaveText('Saved. Newer changes kept.');
    await expect
      .poll(() => first.evaluate(() => (globalThis as any).__optionsMixedEvents.deferred.length))
      .toBe(1);
    expect(await first.evaluate(() => (globalThis as any).__optionsMixedEvents.observed)).toEqual([
      ['localhost/seed', '127.0.0.1/private', 'localhost/other'],
    ]);
    const before = await invariant();
    const cliResponse = await cli('read', String(await articleId()), '--json');
    const socketResponse = await readSocket(await articleId());
    const after = await invariant();
    const draft = await first.locator('#denylist').inputValue();
    const stored = await patterns();
    await first.screenshot({ path: info.outputPath('first-options.png') });
    await writeFile(
      info.outputPath('evidence.json'),
      JSON.stringify(
        {
          draft,
          stored,
          snapshot: await first.locator('body').ariaSnapshot(),
          cli: cliResponse,
          socket: socketResponse,
          before,
          after,
        },
        null,
        2,
      ),
    );
    expect(after).toEqual(before);
    expect(cliResponse.code).toBe(0);
    expect(socketResponse.ok).toBe(true);
    expect(stored).toEqual(['localhost/seed', 'localhost/other']);
    expect(draft).toBe(stored.join('\n'));
    await first.evaluate(() => {
      for (const deliver of (globalThis as any).__optionsMixedEvents.deferred) deliver();
    });
    await expect(first.locator('#denylist')).toHaveValue('localhost/seed\nlocalhost/other');
  });

  test('retries a captured newer snapshot when an older event arrives before it returns', async ({}, info) => {
    await first.addInitScript(() => {
      const addListener = chrome.storage.onChanged.addListener.bind(chrome.storage.onChanged);
      const deferred: Array<{ patterns: string[]; deliver: () => void }> = [];
      (globalThis as any).__optionsOlderEvents = deferred;
      chrome.storage.onChanged.addListener = (listener) =>
        addListener((changes, area) => {
          if (area === 'local' && changes.denylist)
            deferred.push({
              patterns: changes.denylist.newValue as string[],
              deliver: () => listener(changes, area),
            });
          else listener(changes, area);
        });
    });
    await first.reload();
    await expect(first.locator('#denylist')).toBeEnabled();
    await holdReply(first);
    await first.locator('#denylist').fill('localhost/seed\nlocalhost/own');
    await first.locator('#save').click();
    await expect
      .poll(() => first.evaluate(() => (globalThis as any).__optionsReply.held))
      .toBe(true);
    await save(second, 'localhost/seed\nlocalhost/own\n127.0.0.1/private');
    await first.evaluate(() => {
      const get = chrome.storage.local.get.bind(chrome.storage.local);
      const fixture = {
        calls: 0,
        snapshot: undefined as any,
        release: undefined as (() => void) | undefined,
      };
      (globalThis as any).__optionsHeldRead = fixture;
      chrome.storage.local.get = (async (...args: Parameters<typeof get>) => {
        fixture.calls++;
        const snapshot = await get(...args);
        if (fixture.calls === 1) {
          fixture.snapshot = snapshot;
          await new Promise<void>((resolve) => (fixture.release = resolve));
        }
        return snapshot;
      }) as typeof chrome.storage.local.get;
    });
    await releaseReply(first);
    await expect
      .poll(() => first.evaluate(() => Boolean((globalThis as any).__optionsHeldRead.release)))
      .toBe(true);
    expect(
      await first.evaluate(() => (globalThis as any).__optionsHeldRead.snapshot.denylist),
    ).toEqual(['localhost/seed', 'localhost/own', '127.0.0.1/private']);
    await first.evaluate(() => {
      const events = (globalThis as any).__optionsOlderEvents as Array<{
        patterns: string[];
        deliver: () => void;
      }>;
      for (const event of events)
        if (!event.patterns.includes('127.0.0.1/private')) event.deliver();
      (globalThis as any).__optionsHeldRead.release();
    });
    await expect(first.locator('#status')).toHaveText('Saved.');
    const draft = await first.locator('#denylist').inputValue();
    const stored = await patterns();
    const calls = await first.evaluate(() => (globalThis as any).__optionsHeldRead.calls);
    const cliResponse = await cli('read', String(await articleId()), '--json');
    const socketResponse = await readSocket(await articleId());
    await first.screenshot({ path: info.outputPath('first-options.png') });
    await writeFile(
      info.outputPath('evidence.json'),
      JSON.stringify(
        {
          draft,
          stored,
          calls,
          snapshot: await first.locator('body').ariaSnapshot(),
          cli: cliResponse,
          socket: socketResponse,
        },
        null,
        2,
      ),
    );
    expect(draft).toBe(stored.join('\n'));
    expect(calls).toBe(2);
    expect(cliResponse.stdout + cliResponse.stderr).toContain('DENIED');
    expect(socketResponse.error?.code).toBe('DENIED');
  });

  test('keeps queued remove and re-add intent plus newer typing when verification stays unavailable', async () => {
    await first.locator('#denylist').fill('localhost/seed\nlocalhost/own');
    await save(second, 'localhost/seed\n127.0.0.1/private');
    await holdReply(first);
    await first.locator('#save').click();
    await replyHeld(first);
    await first.locator('#denylist').fill('localhost/seed');
    await first.locator('#save').click();
    await first.locator('#denylist').fill('localhost/seed\nlocalhost/own');
    await first.locator('#save').click();
    await first.locator('#denylist').fill('localhost/seed\nlocalhost/new-draft');
    await failNextRefresh(first, 99);
    await releaseReply(first);
    await expect
      .poll(() => first.evaluate(() => (globalThis as any).__optionsRefresh.calls))
      .toBe(9);
    await expect(first.locator('#status')).toHaveText(
      `${unverifiedSave} You have unsaved changes.`,
    );
    await expect(first.locator('#denylist')).toHaveValue('localhost/seed\nlocalhost/new-draft');
    expect(await patterns()).toEqual(['localhost/seed', '127.0.0.1/private', 'localhost/own']);
    expect((await readSocket(await articleId())).error?.code).toBe('DENIED');
    await first.evaluate(() => (globalThis as any).__optionsRefresh.restore());
    await first.locator('#save').click();
    await expect(first.locator('#status')).toHaveText('Saved. Newer changes kept.');
    await expect(first.locator('#denylist')).toHaveValue(
      'localhost/seed\n127.0.0.1/private\nlocalhost/new-draft',
    );
    expect(await patterns()).toEqual([
      'localhost/seed',
      '127.0.0.1/private',
      'localhost/new-draft',
    ]);
  });

  test('reports an unverified list after an acknowledged exact defaults reset', async () => {
    await initialize(['127.0.0.1/private', 'localhost/custom']);
    await failNextRefresh(first, 99);
    await first.locator('#restore').click();
    await expect(first.locator('#status')).toHaveText(unverifiedSave);
    expect(await first.evaluate(() => (globalThis as any).__optionsRefresh.calls)).toBe(3);
    expect(await patterns()).toEqual(DEFAULT_DENYLIST);
    const response = await cli('read', String(await articleId()), '--json');
    expect(response.code).toBe(0);
    expect((await readSocket(await articleId())).ok).toBe(true);
    await first.evaluate(() => (globalThis as any).__optionsRefresh.restore());
    await first.locator('#save').click();
    await expect(first.locator('#status')).toHaveText('Saved.');
    await expect(first.locator('#denylist')).toHaveValue(DEFAULT_DENYLIST.join('\n'));
  });

  test('repeated queued saves cannot remove an unseen merged rule', async () => {
    await first.locator('#denylist').fill('localhost/seed\nlocalhost/own');
    await save(second, 'localhost/seed\n127.0.0.1/private');
    await holdReply(first);
    await first.locator('#save').click();
    await replyHeld(first);
    await first.locator('#save').click();
    await releaseReply(first);
    await expect(first.locator('#status')).toHaveText('Saved. Newer changes kept.');
    await expect.poll(patterns).toEqual(['localhost/seed', '127.0.0.1/private', 'localhost/own']);
  });

  test('applies an exact defaults reset after a queued save', async () => {
    await first.locator('#denylist').fill('localhost/seed\nlocalhost/custom');
    await holdWorkerWrite();
    await first.locator('#save').click();
    await writeHeld();
    await second.locator('#restore').click();
    await releaseWrite();
    await expect(second.locator('#status')).toHaveText('Defaults restored.');
    await expect.poll(patterns).toEqual(DEFAULT_DENYLIST);
    await expect(first.locator('#denylist')).toHaveValue(DEFAULT_DENYLIST.join('\n'));
  });

  test('applies a queued dirty save after an exact defaults reset', async () => {
    await second.locator('#denylist').fill('localhost/seed\nlocalhost/custom');
    await holdWorkerWrite();
    await first.locator('#restore').click();
    await writeHeld();
    await second.locator('#save').click();
    await releaseWrite();
    await expect(second.locator('#status')).toHaveText('Saved. Newer changes kept.');
    await expect.poll(patterns).toEqual([...DEFAULT_DENYLIST, 'localhost/custom']);
  });

  test('normalizes the displayed saved list and retains ordinary editor reordering', async () => {
    await save(first, '*.LOCALHOST/first/\nlocalhost/seed\nlocalhost/first\nhttps://invalid.test');
    await expect(first.locator('#denylist')).toHaveValue('localhost/first\nlocalhost/seed');
    await expect(first.locator('#status')).toHaveText('Saved. Ignored 1 invalid line.');
    await save(first, 'localhost/seed\nlocalhost/first');
    await expect.poll(patterns).toEqual(['localhost/seed', 'localhost/first']);
    await first.locator('#denylist').fill('localhost/first\nlocalhost/seed');
    await (
      await worker()
    ).evaluate(() => chrome.storage.local.set({ denylist: ['localhost/first', 'localhost/seed'] }));
    await save(first, 'localhost/seed\nlocalhost/first');
    await expect.poll(patterns).toEqual(['localhost/seed', 'localhost/first']);
    await save(first, 'https://invalid.test');
    await expect(first.locator('#status')).toHaveText('No valid entries. Defaults restored.');
    await expect(first.locator('#denylist')).toHaveValue(DEFAULT_DENYLIST.join('\n'));
    await save(first, '');
    await expect(first.locator('#denylist')).toHaveValue('');
    expect(await patterns()).toEqual([]);
  });

  test('rejects an over-capacity merge without dropping saved rules and permits retry', async () => {
    const base = ['127.0.0.1/private', ...Array.from({ length: 253 }, (_, i) => `host${i}.test`)];
    await initialize(base);
    await first.locator('#denylist').fill([...base, 'localhost/first'].join('\n'));
    const concurrent = [...base, 'localhost/second', 'localhost/third'];
    await save(second, concurrent.join('\n'));
    await first.locator('#save').click();
    await expect(first.locator('#status')).toHaveText(
      'The combined denylist exceeds 256 entries; remove some patterns and save again.',
    );
    expect(await patterns()).toEqual(concurrent);
    const denied = await cli('read', String(await articleId()), '--json');
    expect(denied.stdout + denied.stderr).toContain('DENIED');
    await save(
      first,
      [...base.filter((pattern) => pattern !== 'host0.test'), 'localhost/first'].join('\n'),
    );
    expect(await patterns()).toEqual([
      ...concurrent.filter((pattern) => pattern !== 'host0.test'),
      'localhost/first',
    ]);
  });

  test('merges an invalid-only fallback without undoing unseen additions or removals', async () => {
    await initialize(['localhost/seed', ...DEFAULT_DENYLIST]);
    await first.locator('#denylist').fill('https://invalid.test');
    const concurrent = [
      ...DEFAULT_DENYLIST.filter((pattern) => pattern !== 'paypal.com'),
      '127.0.0.1/private',
    ];
    await save(second, concurrent.join('\n'));
    await first.locator('#save').click();
    await expect(first.locator('#status')).toHaveText(
      'No valid entries. Default entries merged with saved changes.',
    );
    expect(await patterns()).toEqual(concurrent);
    await expect(first.locator('#denylist')).toHaveValue(concurrent.join('\n'));
    expect((await readSocket(await articleId())).error?.code).toBe('DENIED');
  });

  test('keeps unseen rules when an older dirty draft clears its own list', async () => {
    await first.locator('#denylist').fill('');
    await save(second, 'localhost/seed\n127.0.0.1/private');
    await first.locator('#save').click();
    await expect(first.locator('#status')).toHaveText('Saved. Newer changes kept.');
    expect(await patterns()).toEqual(['127.0.0.1/private']);
    await expect(first.locator('#denylist')).toHaveValue('127.0.0.1/private');
    expect((await readSocket(await articleId())).error?.code).toBe('DENIED');
  });

  test('reports a real storage failure, retains policy, and accepts a later save', async () => {
    await initialize(['127.0.0.1/private']);
    await first.evaluate(async () => {
      const bytes = await chrome.storage.local.getBytesInUse(null);
      await chrome.storage.local.set({
        optionsQuota: 'x'.repeat(
          chrome.storage.local.QUOTA_BYTES - bytes - 'optionsQuota'.length - 24,
        ),
      });
    });
    try {
      await first.locator('#denylist').fill('127.0.0.1/private\nlocalhost/' + 'a'.repeat(1500));
      await first.locator('#save').click();
      await expect(first.locator('#status')).toHaveText('Could not save the denylist. Try again.');
      expect(await patterns()).toEqual(['127.0.0.1/private']);
      expect((await readSocket(await articleId())).error?.code).toBe('DENIED');
    } finally {
      await first.evaluate(() => chrome.storage.local.remove('optionsQuota'));
    }
    await first.locator('#save').click();
    await expect(first.locator('#status')).toHaveText('Saved.');
    expect((await patterns()).length).toBe(2);
  });

  test('rejects malformed or oversized messages and non-options senders', async () => {
    const replies = await first.evaluate(async () => {
      const send = (body: unknown) => chrome.runtime.sendMessage(body);
      const type = 'cobrowser:denylist';
      return Promise.all([
        send({ type, action: 'save', baseline: [], draft: 'x'.repeat(524_545) }),
        send({ type, action: 'save', baseline: Array(257).fill('localhost'), draft: '' }),
        send({ type, action: 'save', baseline: ['https://invalid.test'], draft: '' }),
        send({ type, action: 'restore', draft: '' }),
      ]);
    });
    expect(replies.every((reply) => reply.ok === false)).toBe(true);
    const popup = await context.newPage();
    try {
      await popup.goto(`chrome-extension://${extensionId}/popup.html`);
      const reply = await popup.evaluate(() =>
        chrome.runtime
          .sendMessage({ type: 'cobrowser:denylist', action: 'restore' })
          .catch(() => undefined),
      );
      expect(reply?.ok).not.toBe(true);
      expect(await patterns()).toEqual(['localhost/seed']);
    } finally {
      await popup.close();
    }
    await save(first, '127.0.0.1/private');
    expect(await patterns()).toEqual(['127.0.0.1/private']);
  });

  test('keeps a storage change that arrives before the initial read resolves', async () => {
    const delayed = await context.newPage();
    try {
      await delayed.addInitScript(() => {
        const get = chrome.storage.local.get.bind(chrome.storage.local);
        const fixture = {
          held: false,
          changed: false,
          release: undefined as (() => void) | undefined,
        };
        chrome.storage.onChanged.addListener((changes, area) => {
          if (area === 'local' && changes.denylist) fixture.changed = true;
        });
        (globalThis as any).__optionsInitial = fixture;
        chrome.storage.local.get = (async (...args: Parameters<typeof get>) => {
          const snapshot = await get(...args);
          if (!fixture.held) {
            fixture.held = true;
            await new Promise<void>((resolve) => (fixture.release = resolve));
          }
          return snapshot;
        }) as typeof chrome.storage.local.get;
      });
      await delayed.goto(optionsUrl);
      await expect
        .poll(() => delayed.evaluate(() => (globalThis as any).__optionsInitial.held))
        .toBe(true);
      await save(second, 'localhost/seed\n127.0.0.1/private');
      await expect
        .poll(() => delayed.evaluate(() => (globalThis as any).__optionsInitial.changed))
        .toBe(true);
      await delayed.evaluate(() => (globalThis as any).__optionsInitial.release());
      await expect(delayed.locator('#denylist')).toHaveValue('localhost/seed\n127.0.0.1/private');
      await expect(delayed.locator('#denylist')).toBeEnabled();
    } finally {
      await delayed.close();
    }
  });

  test('saves and synchronizes options while no native helper is installed', async () => {
    const isolated = await launch(false);
    try {
      const a = await isolated.context.newPage();
      const b = await isolated.context.newPage();
      await Promise.all([a.goto(optionsUrl), b.goto(optionsUrl)]);
      await expect(a.locator('#denylist')).toBeEnabled();
      await expect(b.locator('#denylist')).toBeEnabled();
      await save(a, 'localhost/first');
      await expect(b.locator('#denylist')).toHaveValue('localhost/first');
      await save(b, 'localhost/first\nlocalhost/second');
      await expect(a.locator('#denylist')).toHaveValue('localhost/first\nlocalhost/second');
      const state = await a.evaluate(() => chrome.storage.local.get(['connected', 'denylist']));
      expect(state.connected).not.toBe(true);
      expect(state.denylist).toEqual(['localhost/first', 'localhost/second']);
    } finally {
      await isolated.context.close();
      await Promise.all(
        [isolated.home, isolated.profile].map((directory) =>
          rm(directory, { recursive: true, force: true }),
        ),
      );
    }
  });
});
