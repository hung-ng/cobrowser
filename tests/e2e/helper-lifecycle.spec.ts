import { test, expect } from '@playwright/test';
import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import path from 'node:path';
import { promisify } from 'node:util';
import { encodeFrame } from '../../src/shared/native.js';

const exec = promisify(execFile);
const root = path.resolve(import.meta.dirname, '../..');
const version = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).version;
const firstRevision = 'a'.repeat(64);
const secondRevision = 'b'.repeat(64);
const thirdRevision = 'c'.repeat(64);

interface HelperProcess {
  child: ChildProcessWithoutNullStreams;
  closed: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

interface Lifecycle {
  home: string;
  socket: string;
  start: (revision: string, gate?: { path: string; mode: 'exists' | 'probe' }) => HelperProcess;
  ready: (revision: string) => Promise<void>;
  status: () => Promise<any>;
  checkCli: () => Promise<void>;
  gate: (name: string) => Promise<string>;
  release: (gate: string) => Promise<void>;
}

async function withLifecycle(check: (lifecycle: Lifecycle) => Promise<void>) {
  const home = await mkdtemp('/tmp/cb-lifecycle-');
  const socket = path.join(home, 'run/lifecycle.sock');
  const preload = path.join(home, 'gate.mjs');
  const children: HelperProcess[] = [];
  await writeFile(
    preload,
    `import fs from 'node:fs';
import net from 'node:net';
const exists = fs.existsSync;
const gate = process.env.COBROWSER_TEST_GATE;
const target = process.env.COBROWSER_TEST_SOCKET;
const wait = () => {
  fs.writeFileSync(gate + '.ready', '');
  const deadline = Date.now() + 15000;
  while (!exists(gate + '.release')) {
    if (Date.now() > deadline) throw new Error('The test did not release the startup gate.');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
};
if (process.env.COBROWSER_TEST_GATE_MODE === 'exists') {
  fs.existsSync = file => {
    const result = exists(file);
    if (file === target) wait();
    return result;
  };
} else {
  const connect = net.createConnection;
  net.createConnection = (...args) => {
    const socket = connect(...args);
    if (args[0] === target) socket.prependOnceListener('error', wait);
    return socket;
  };
}
`,
  );
  const status = () =>
    new Promise<any>((resolve, reject) => {
      const request = httpRequest(
        { socketPath: socket, path: '/v1/status', method: 'POST', agent: false },
        (response) => {
          let body = '';
          response.on('data', (chunk) => {
            body += String(chunk);
          });
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
      request.once('error', reject);
      request.setTimeout(1000, () => request.destroy(new Error('The helper did not respond.')));
      request.end('{}');
    });
  const lifecycle: Lifecycle = {
    home,
    socket,
    start(revision, gate) {
      const child = spawn(
        process.execPath,
        [
          ...(gate ? ['--import', preload] : []),
          path.join(root, 'dist/helper.js'),
          '--browser',
          'lifecycle',
        ],
        {
          env: {
            ...process.env,
            COBROWSER_HOME: home,
            ...(gate
              ? {
                  COBROWSER_TEST_GATE: gate.path,
                  COBROWSER_TEST_GATE_MODE: gate.mode,
                  COBROWSER_TEST_SOCKET: socket,
                }
              : {}),
          },
          stdio: ['pipe', 'pipe', 'pipe'],
        },
      );
      child.stdout.resume();
      child.stderr.resume();
      child.stdin.on('error', () => undefined);
      const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
        (resolve, reject) => {
          child.once('error', reject);
          child.once('close', (code, signal) => resolve({ code, signal }));
        },
      );
      const helper = { child, closed };
      children.push(helper);
      child.stdin.write(
        encodeFrame({
          event: 'hello',
          data: { version, protocol: 1, extensionRevision: revision },
        }),
      );
      return helper;
    },
    async ready(revision) {
      await expect
        .poll(async () => {
          try {
            return (await status()).data;
          } catch {
            return undefined;
          }
        })
        .toMatchObject({ connected: true, extensionRevision: revision });
    },
    status,
    async checkCli() {
      const result = await exec(
        process.execPath,
        [path.join(root, 'dist/cli.js'), 'browsers', '--json'],
        {
          env: { ...process.env, COBROWSER_HOME: home },
          timeout: 5000,
        },
      );
      expect(JSON.parse(result.stdout)).toEqual([
        { browser: 'lifecycle', running: true, connected: true },
      ]);
    },
    async gate(name) {
      const gate = path.join(home, name);
      return gate;
    },
    async release(gate) {
      await writeFile(`${gate}.release`, '');
    },
  };
  try {
    await check(lifecycle);
  } finally {
    for (const helper of children) {
      if (helper.child.exitCode === null && helper.child.signalCode === null)
        helper.child.kill('SIGKILL');
    }
    await Promise.all(children.map((helper) => helper.closed));
    await rm(home, { recursive: true, force: true });
  }
}

async function gateReady(gate: string) {
  await expect
    .poll(() =>
      stat(`${gate}.ready`).then(
        () => true,
        () => false,
      ),
    )
    .toBe(true);
}

test('a helper that loses a simultaneous bind leaves the winning socket reachable', async () => {
  await withLifecycle(async (lifecycle) => {
    const firstGate = await lifecycle.gate('first');
    const secondGate = await lifecycle.gate('second');
    lifecycle.start(firstRevision, { path: firstGate, mode: 'exists' });
    const loser = lifecycle.start(secondRevision, { path: secondGate, mode: 'exists' });
    await Promise.all([gateReady(firstGate), gateReady(secondGate)]);
    await lifecycle.release(firstGate);
    await lifecycle.ready(firstRevision);
    await lifecycle.release(secondGate);
    expect((await loser.closed).code).toBe(1);
    expect((await lifecycle.status()).data).toMatchObject({
      connected: true,
      extensionRevision: firstRevision,
    });
    await lifecycle.checkCli();
  });
});

for (const shutdown of ['stdin', 'SIGTERM'] as const) {
  test(`an old helper's ${shutdown} cleanup preserves a later replacement socket`, async () => {
    await withLifecycle(async (lifecycle) => {
      const original = lifecycle.start(firstRevision);
      await lifecycle.ready(firstRevision);
      await unlink(lifecycle.socket);
      lifecycle.start(secondRevision);
      await lifecycle.ready(secondRevision);
      if (shutdown === 'stdin') original.child.stdin.end();
      else original.child.kill(shutdown);
      await original.closed;
      expect((await lifecycle.status()).data).toMatchObject({
        connected: true,
        extensionRevision: secondRevision,
      });
      await lifecycle.checkCli();
    });
  });
}

test('a stale-socket probe preserves a live replacement created before its failure returns', async () => {
  await withLifecycle(async (lifecycle) => {
    const original = lifecycle.start(firstRevision);
    await lifecycle.ready(firstRevision);
    original.child.kill('SIGKILL');
    await original.closed;
    const gate = await lifecycle.gate('stale');
    const contender = lifecycle.start(secondRevision, { path: gate, mode: 'probe' });
    await gateReady(gate);
    await unlink(lifecycle.socket);
    lifecycle.start(thirdRevision);
    await lifecycle.ready(thirdRevision);
    await lifecycle.release(gate);
    await expect.poll(() => contender.child.exitCode).toBe(1);
    expect((await contender.closed).code).toBe(1);
    expect((await lifecycle.status()).data).toMatchObject({
      connected: true,
      extensionRevision: thirdRevision,
    });
    await lifecycle.checkCli();
  });
});

test('a replacement helper reclaims a stale socket and removes its own socket on shutdown', async () => {
  await withLifecycle(async (lifecycle) => {
    const original = lifecycle.start(firstRevision);
    await lifecycle.ready(firstRevision);
    original.child.kill('SIGKILL');
    await original.closed;
    const replacement = lifecycle.start(secondRevision);
    await lifecycle.ready(secondRevision);
    await lifecycle.checkCli();
    replacement.child.stdin.end();
    expect((await replacement.closed).code).toBe(0);
    expect(
      await stat(lifecycle.socket).then(
        () => true,
        () => false,
      ),
    ).toBe(false);
  });
});
