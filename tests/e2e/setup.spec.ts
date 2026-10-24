import { test, expect } from '@playwright/test';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const cli = path.resolve(import.meta.dirname, '../../dist/cli.js');

interface Install {
  root: string;
  home: string;
  hosts: string;
  run: (...args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;
}

async function withInstall(check: (install: Install) => Promise<void>) {
  const root = await mkdtemp('/tmp/cb-install-');
  const home = path.join(root, 'home');
  const hosts = path.join(root, 'native hosts');
  const bin = path.join(root, 'bin');
  await mkdir(bin);
  const env = {
    ...process.env,
    HOME: path.join(root, 'user'),
    COBROWSER_HOME: home,
    PATH: bin,
    FORCE_COLOR: undefined,
    NO_COLOR: undefined,
  };
  const run: Install['run'] = async (...args) => {
    try {
      const result = await exec(process.execPath, [cli, ...args], {
        env,
        cwd: root,
        timeout: 15_000,
      });
      return { ...result, code: 0 };
    } catch (error: any) {
      if (typeof error.code !== 'number') throw error;
      return { code: error.code, stdout: error.stdout || '', stderr: error.stderr || '' };
    }
  };
  try {
    await check({ root, home, hosts, run });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('doctor detects a missing installed extension even when the source build exists', async () => {
  await withInstall(async ({ home, hosts, run }) => {
    expect((await run('setup', '--browser', 'chrome', '--native-hosts-dir', hosts)).code).toBe(0);
    expect(JSON.parse((await run('doctor', '--json')).stdout).ok).toBe(true);
    await rm(path.join(home, 'extension'), { recursive: true });
    const result = await run('doctor', '--json');
    expect(result.code).toBe(1);
    expect(result.stdout).toContain('restore the extension files');
    expect(result.stdout).not.toContain('ok extension build is present');
  });
});

test('setup remembers custom browser directories and can repair them without another option', async () => {
  await withInstall(async ({ root, home, run }) => {
    for (const browser of ['chrome', 'opera']) {
      const hosts = path.join(root, `${browser} custom hosts`);
      expect((await run('setup', '--browser', browser, '--native-hosts-dir', hosts)).code).toBe(0);
      await rm(path.join(hosts, 'cobrowser.json'));
      await rm(path.join(home, 'hosts', browser));
      const broken = await run('doctor', '--json');
      expect(broken.stdout).toContain(`cobrowser setup --browser ${browser}`);
      const repaired = await run('setup', '--browser', browser);
      expect(repaired.code, repaired.stderr).toBe(0);
      const manifest = JSON.parse(await readFile(path.join(hosts, 'cobrowser.json'), 'utf8'));
      expect(manifest.path).toBe(path.join(home, 'hosts', browser));
      const config = JSON.parse(await readFile(path.join(home, 'config.json'), 'utf8'));
      expect(config.nativeHosts).toContainEqual({ browser, directory: hosts });
    }
    expect(JSON.parse((await run('doctor', '--json')).stdout).ok).toBe(true);
  });
});

test('doctor detects a launcher whose recorded Node executable is gone', async () => {
  await withInstall(async ({ root, home, hosts, run }) => {
    expect((await run('setup', '--browser', 'chrome', '--native-hosts-dir', hosts)).code).toBe(0);
    const launcher = path.join(home, 'hosts', 'chrome');
    const original = await readFile(launcher, 'utf8');
    const quotedNode = `'${process.execPath.replaceAll("'", "'\\''")}'`;
    await writeFile(launcher, original.replace(quotedNode, `'${root}/missing-node'`));
    const result = await run('doctor', '--json');
    expect(result.code).toBe(1);
    expect(result.stdout).toContain('recreate the chrome launcher');
    expect((await run('setup', '--browser', 'chrome')).code).toBe(0);
    expect(JSON.parse((await run('doctor', '--json')).stdout).ok).toBe(true);
  });
});

test('setup updates previously configured launchers when another browser is selected', async () => {
  await withInstall(async ({ root, home, hosts, run }) => {
    expect((await run('setup', '--browser', 'chrome', '--native-hosts-dir', hosts)).code).toBe(0);
    const version = (await run('--version')).stdout.trim();
    const runtime = path.join(home, 'runtime', version);
    const previousRuntime = path.join(home, 'runtime', '0.0.0');
    await cp(runtime, previousRuntime, { recursive: true });
    const launcher = path.join(home, 'hosts', 'chrome');
    await writeFile(launcher, (await readFile(launcher, 'utf8')).replace(runtime, previousRuntime));
    const result = await run(
      'setup',
      '--browser',
      'opera',
      '--native-hosts-dir',
      path.join(root, 'opera hosts'),
    );
    expect(result.code, result.stderr).toBe(0);
    expect(await readFile(launcher, 'utf8')).toContain(path.join(runtime, 'helper.js'));
    expect(JSON.parse((await run('doctor', '--json')).stdout).ok).toBe(true);
  });
});

test('installed runtime declares ESM without relying on Node syntax detection', async () => {
  await withInstall(async ({ home, hosts, run }) => {
    expect((await run('setup', '--browser', 'chrome', '--native-hosts-dir', hosts)).code).toBe(0);
    const version = (await run('--version')).stdout.trim();
    const runtime = path.join(home, 'runtime', version);
    const result = await exec(
      process.execPath,
      ['--no-experimental-detect-module', path.join(runtime, 'cli.js'), '--version'],
      { env: { ...process.env, FORCE_COLOR: undefined, NO_COLOR: undefined } },
    );
    expect(result.stdout.trim()).toBe(version);
    expect(result.stderr).toBe('');
  });
});

test('setup rejects shared native-host directories before changing working registrations', async () => {
  await withInstall(async ({ home, hosts, run }) => {
    expect((await run('setup', '--browser', 'chrome', '--native-hosts-dir', hosts)).code).toBe(0);
    const files = [
      path.join(home, 'config.json'),
      path.join(hosts, 'cobrowser.json'),
      path.join(home, 'hosts/chrome'),
    ];
    const before = await Promise.all(files.map((file) => readFile(file, 'utf8')));
    const result = await run('setup', '--browser', 'opera', '--native-hosts-dir', hosts);
    expect(result.code).toBe(1);
    expect(await Promise.all(files.map((file) => readFile(file, 'utf8')))).toEqual(before);
    expect(JSON.parse((await run('doctor', '--json')).stdout).ok).toBe(true);
  });
});

test('setup reloads only changed extension files while always restarting helpers', async () => {
  await withInstall(async ({ home, hosts, run }) => {
    expect((await run('setup', '--browser', 'chrome', '--native-hosts-dir', hosts)).code).toBe(0);
    await mkdir(path.join(home, 'run'));
    const restarts: unknown[] = [];
    const revision = /^\/\/ cobrowser-extension-build: ([a-f0-9]{64})\n/.exec(
      await readFile(path.join(home, 'extension/service-worker.js'), 'utf8'),
    )?.[1];
    expect(revision).toBeTruthy();
    let reportedRevision: string | undefined = revision;
    const server = createServer((request, response) => {
      let body = '';
      request.on('data', (chunk) => {
        body += chunk;
      });
      request.on('end', () => {
        if (request.url === '/v1/restart') restarts.push(JSON.parse(body));
        response.end(
          JSON.stringify({
            ok: true,
            ...(request.url === '/v1/status'
              ? { data: { connected: true, extensionRevision: reportedRevision } }
              : {}),
          }),
        );
      });
    });
    await new Promise<void>((resolve) =>
      server.listen(path.join(home, 'run/chrome.sock'), resolve),
    );
    try {
      expect((await run('setup', '--browser', 'chrome')).code).toBe(0);
      expect(restarts).toEqual([{ reloadExtension: false }]);
      reportedRevision = '0'.repeat(64);
      expect((await run('setup', '--browser', 'chrome')).code).toBe(0);
      expect(restarts.at(-1)).toEqual({ reloadExtension: true });
      reportedRevision = undefined;
      expect((await run('setup', '--browser', 'chrome')).code).toBe(0);
      expect(restarts.at(-1)).toEqual({ reloadExtension: true });
      reportedRevision = revision;
      expect((await run('setup', '--browser', 'chrome')).code).toBe(0);
      expect(restarts.at(-1)).toEqual({ reloadExtension: false });
      for (const file of ['service-worker.js', 'popup.html', 'options.js']) {
        const installed = path.join(home, 'extension', file);
        await writeFile(installed, `${await readFile(installed, 'utf8')}\n`);
        expect((await run('setup', '--browser', 'chrome')).code).toBe(0);
        expect(restarts.at(-1)).toEqual({ reloadExtension: true });
      }
      await rm(path.join(home, 'extension/options.html'));
      expect((await run('setup', '--browser', 'chrome')).code).toBe(0);
      expect(restarts.at(-1)).toEqual({ reloadExtension: true });
      expect((await run('setup', '--browser', 'chrome')).code).toBe(0);
      expect(restarts.at(-1)).toEqual({ reloadExtension: false });
      expect(restarts).toHaveLength(9);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
