import { test, expect, chromium, type BrowserContext, type Page } from '@playwright/test';
import { createServer, request as httpRequest, type Server } from 'node:http';
import { chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { execFile, spawn } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const root = path.resolve(import.meta.dirname, '../..');
const build = process.env.COBROWSER_TEST_BUILD || path.join(root, 'dist');
const protocols = ['cli', 'socket', 'mcp'] as const;
const scopes = ['light', 'open', 'closed', 'nested'] as const;
type Protocol = (typeof protocols)[number];
type Scope = (typeof scopes)[number];
type Kind = 'password' | 'text' | 'textarea' | 'editable';
let context: BrowserContext;
let server: Server;
let home = '';
let profile = '';
let target: Page;
let tabId = 0;

declare global {
  interface Window {
    selectionRoots: Record<Scope, Document | ShadowRoot>;
  }
  var passwordSelectionFixture: {
    hold: boolean;
    held: boolean;
    release?: () => void;
  };
}

const proxy = String.raw`
import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import path from 'node:path';
const [helper, home] = process.argv.slice(2);
const child = spawn(process.execPath, [helper, '--browser', 'chromium'], { stdio: ['pipe', 'pipe', 'inherit'] });
const methods = new Map();
function frames(stream, forward, observe) {
  let pending = Buffer.alloc(0);
  stream.on('data', chunk => {
    pending = Buffer.concat([pending, chunk]);
    while (pending.length >= 4 && pending.length >= 4 + pending.readUInt32LE(0)) {
      const size = 4 + pending.readUInt32LE(0);
      const frame = pending.subarray(0, size);
      pending = pending.subarray(size);
      observe(JSON.parse(frame.subarray(4).toString('utf8')));
      forward.write(frame);
    }
  });
}
frames(child.stdout, process.stdout, message => {
  if (message.id && message.method) methods.set(message.id, message.method);
});
frames(process.stdin, child.stdin, message => {
  appendFileSync(path.join(home, 'native.jsonl'), JSON.stringify({ method: methods.get(message.id), message }) + '\n');
  methods.delete(message.id);
});
process.stdin.on('end', () => child.stdin.end());
child.stdin.on('error', () => {});
child.on('exit', code => process.exit(code ?? 1));
`;

async function worker() {
  await expect
    .poll(() => context.serviceWorkers().find((item) => item.url().includes('service-worker')))
    .toBeTruthy();
  return context.serviceWorkers().find((item) => item.url().includes('service-worker'))!;
}

async function view() {
  const browser = await (
    await worker()
  ).evaluate(async () => ({
    focused: (await chrome.windows.getLastFocused({ windowTypes: ['normal'] })).id,
    tabs: (await chrome.tabs.query({}))
      .map(({ id, windowId, active, url }) => ({ id, windowId, active, url }))
      .sort((left, right) => left.id! - right.id!),
  }));
  const scroll = await Promise.all(
    context.pages().map(async (page) => ({
      url: page.url(),
      position: await page.evaluate(() => [scrollX, scrollY]),
    })),
  );
  return { browser, scroll };
}

async function nativeFrames(): Promise<Array<{ method?: string; message: Record<string, any> }>> {
  return (await readFile(path.join(home, 'native.jsonl'), 'utf8').catch(() => ''))
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function selection(protocol: Protocol) {
  const env = { ...process.env, COBROWSER_HOME: home };
  const cli = path.join(home, 'runtime/cli.js');
  if (protocol === 'cli') {
    const result = await exec(
      process.execPath,
      [cli, '--browser', 'chromium', 'selection', String(tabId), '--json'],
      { env },
    ).catch((error: { stdout: string }) => error);
    return JSON.parse(result.stdout);
  }
  if (protocol === 'mcp') {
    return new Promise<Record<string, any>>((resolve, reject) => {
      const child = spawn(process.execPath, [cli, '--browser', 'chromium', 'mcp'], { env });
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error('The synthetic MCP selection timed out.'));
      }, 10_000);
      let output = '';
      child.stdout.on('data', (chunk) => (output += String(chunk)));
      child.once('error', reject);
      child.once('close', () => {
        clearTimeout(timer);
        try {
          const response = JSON.parse(output.trim()).result;
          resolve({
            ok: !response.isError,
            text: response.content[0].text,
            error: response.isError ? { code: response.content[0].text.split(':')[0] } : undefined,
          });
        } catch (error) {
          reject(error);
        }
      });
      child.stdin.end(
        `${JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'get_selection', arguments: { id: tabId } },
        })}\n`,
      );
    });
  }
  return new Promise<Record<string, any>>((resolve, reject) => {
    const request = httpRequest(
      {
        socketPath: path.join(home, 'run/chromium.sock'),
        path: '/v1/selection',
        method: 'POST',
        headers: { 'content-type': 'application/json' },
      },
      (response) => {
        let output = '';
        response.on('data', (chunk) => (output += String(chunk)));
        response.once('error', reject);
        response.once('end', () => {
          try {
            resolve(JSON.parse(output));
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    request.once('error', reject);
    request.setTimeout(10_000, () => request.destroy(new Error('The synthetic socket timed out.')));
    request.end(JSON.stringify({ id: tabId }));
  });
}

async function prepare(scope: Scope, kind: Kind, blur: boolean) {
  return target.evaluate(
    ({ scope, kind, blur }) => {
      const element = window.selectionRoots[scope].querySelector<HTMLElement>(
        `[data-kind="${kind}"]`,
      )!;
      window.getSelection()!.removeAllRanges();
      element.focus({ preventScroll: true });
      let expected = '';
      if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
        element.setSelectionRange(2, element.value.length - 2);
        expected = element.value.slice(2, -2);
      } else {
        const range = document.createRange();
        range.setStart(element.firstChild!, 2);
        const end = element.querySelector('b')!.firstChild!;
        range.setEnd(end, end.textContent!.length - 1);
        window.getSelection()!.removeAllRanges();
        window.getSelection()!.addRange(range);
        expected = range.toString();
      }
      if (blur) element.blur();
      return expected;
    },
    { scope, kind, blur },
  );
}

async function check(protocol: Protocol, expected: string | undefined) {
  const before = await view();
  const nativeBefore = (await nativeFrames()).length;
  const result = await selection(protocol);
  expect(await view()).toEqual(before);
  const frames = (await nativeFrames()).slice(nativeBefore);
  const replies = frames.filter((frame) => frame.method === 'selection');
  expect(replies).toHaveLength(1);
  if (expected === undefined) {
    expect(result).toMatchObject({ ok: false, error: { code: 'DENIED' } });
    expect(replies[0]!.message).toMatchObject({ ok: false, error: { code: 'DENIED' } });
    expect(replies[0]!.message).not.toHaveProperty('result');
    expect(JSON.stringify(frames)).not.toContain('SYNTHETIC-PASSWORD');
    expect(JSON.stringify(frames)).not.toContain('•');
  } else {
    expect(result).toMatchObject({ ok: true, text: expected });
    expect(replies[0]!.message.result).toMatchObject({
      text: expected,
      documentEpoch: expect.any(String),
    });
  }
}

test.describe.serial('password selection privacy', () => {
  test.beforeAll(async () => {
    home = await mkdtemp('/tmp/cob-sel-home-');
    profile = await mkdtemp('/tmp/cob-sel-profile-');
    server = createServer((_request, response) => {
      response.setHeader('content-type', 'text/html; charset=utf-8');
      response.end(`<!doctype html><title>Synthetic selection fixture</title>
<body style="height:3000px"><p id="ordinary">Ordinary literal ••• text after a password selection.</p>
<section id="light"></section><div id="open"></div><div id="closed"></div><div id="nested"></div>
<script>
const controls = '<input data-kind="password" type="password" value="SYNTHETIC-PASSWORD-ONLY"><input data-kind="text" value="Ordinary live input selection"><textarea data-kind="textarea">Ordinary textarea selection</textarea><div data-kind="editable" contenteditable="true">Editable text <b>nested words</b></div>';
const light = document.querySelector('#light');light.innerHTML = controls;
const open = document.querySelector('#open').attachShadow({mode:'open'});open.innerHTML = controls;
const closed = document.querySelector('#closed').attachShadow({mode:'closed'});closed.innerHTML = controls;
const outer = document.querySelector('#nested').attachShadow({mode:'closed'});outer.innerHTML = '<div id="inner"></div>';
const nested = outer.querySelector('#inner').attachShadow({mode:'open'});nested.innerHTML = controls;
window.selectionRoots = {light,open,closed,nested};
</script></body>`);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
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
        description: 'Synthetic selection fixture',
        path: launcher,
        type: 'stdio',
        allowed_origins: ['chrome-extension://laeencopealhcofijafpfkicblippbnp/'],
      }),
    );
    const extension = path.join(home, 'extension');
    context = await chromium.launchPersistentContext(profile, {
      channel: 'chromium',
      headless: process.env.HEADED !== '1',
      args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
    });
    target = context.pages()[0]!;
    await target.goto(`http://127.0.0.1:${port}/selection`);
    await target.evaluate(() => scrollTo(0, 150));
    const foreground = await context.newPage();
    await foreground.goto(`http://127.0.0.1:${port}/foreground`);
    await foreground.evaluate(() => scrollTo(0, 300));
    tabId = await (
      await worker()
    ).evaluate(
      async (url) => (await chrome.tabs.query({})).find((tab) => tab.url === url)!.id!,
      target.url(),
    );
    await expect
      .poll(async () => (await nativeFrames()).some(({ message }) => message.event === 'hello'))
      .toBe(true);
  });

  test.afterAll(async () => {
    await context?.close();
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    if (home) await rm(home, { recursive: true, force: true });
    if (profile) await rm(profile, { recursive: true, force: true });
  });

  for (const scope of scopes) {
    for (const blur of [false, true]) {
      test(`denies ${scope} password selections${blur ? ' after blur' : ''} before native delivery`, async () => {
        await prepare(scope, 'password', blur);
        for (const protocol of protocols) await check(protocol, undefined);
      });
      for (const kind of ['text', 'textarea', 'editable'] as const) {
        test(`reads ${scope} ${kind} selections${blur ? ' after blur' : ''}`, async () => {
          const expected = await prepare(scope, kind, blur);
          for (const protocol of protocols) await check(protocol, expected);
        });
      }
    }
  }

  test('reads ordinary text after a retained password selection is replaced', async () => {
    await prepare('closed', 'password', true);
    const expected = await target.evaluate(() => {
      const range = document.createRange();
      range.selectNodeContents(document.querySelector('#ordinary')!);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
      return range.toString();
    });
    for (const protocol of protocols) await check(protocol, expected);
  });

  test('protects retained selections without the composed-range API', async () => {
    const toggle = async (enabled: boolean) =>
      (await worker()).evaluate(
        async ({ id, enabled }) =>
          chrome.scripting.executeScript({
            target: { tabId: id },
            func: (enabled: boolean) => {
              const saved = globalThis as typeof globalThis & {
                passwordSelectionComposedRanges?: Selection['getComposedRanges'];
              };
              if (!enabled)
                saved.passwordSelectionComposedRanges = Selection.prototype.getComposedRanges;
              Object.defineProperty(Selection.prototype, 'getComposedRanges', {
                value: enabled ? saved.passwordSelectionComposedRanges : undefined,
              });
            },
            args: [enabled],
          }),
        { id: tabId, enabled },
      );
    await toggle(false);
    try {
      for (const scope of scopes) {
        await prepare(scope, 'password', true);
        await check('socket', undefined);
        for (const kind of ['text', 'textarea', 'editable'] as const) {
          const expected = await prepare(scope, kind, true);
          await check('socket', expected);
        }
      }
    } finally {
      await toggle(true);
    }
  });

  test('keeps a captured password denied when focus changes before script delivery', async () => {
    await prepare('closed', 'password', false);
    const serviceWorker = await worker();
    await serviceWorker.evaluate(() => {
      const execute = chrome.scripting.executeScript.bind(chrome.scripting);
      globalThis.passwordSelectionFixture = { hold: true, held: false };
      chrome.scripting.executeScript = (async (
        options: chrome.scripting.ScriptInjection<any, any>,
      ) => {
        const results = await execute(options);
        const fixture = passwordSelectionFixture;
        if (fixture.hold && options.func?.toString().includes('maxChars')) {
          fixture.hold = false;
          fixture.held = true;
          await new Promise<void>((resolve) => (fixture.release = resolve));
        }
        return results;
      }) as typeof chrome.scripting.executeScript;
    });
    const before = await view();
    const nativeBefore = (await nativeFrames()).length;
    const pending = selection('socket');
    try {
      await expect
        .poll(() => serviceWorker.evaluate(() => passwordSelectionFixture.held))
        .toBe(true);
      await prepare('light', 'text', false);
    } finally {
      await serviceWorker.evaluate(() => passwordSelectionFixture.release?.());
    }
    expect(await pending).toMatchObject({ ok: false, error: { code: 'DENIED' } });
    expect(await view()).toEqual(before);
    const frames = (await nativeFrames()).slice(nativeBefore);
    const reply = frames.find(({ method }) => method === 'selection')!.message;
    expect(reply).toMatchObject({
      ok: false,
      error: { code: 'DENIED' },
    });
    expect(reply).not.toHaveProperty('result');
    expect(JSON.stringify(frames)).not.toContain('SYNTHETIC-PASSWORD');
    expect(JSON.stringify(frames)).not.toContain('•');
  });
});
