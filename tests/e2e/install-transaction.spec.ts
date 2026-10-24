import { test, expect } from '@playwright/test';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import http from 'node:http';
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const project = path.resolve(import.meta.dirname, '../..');
let sources: string;
let previousSource: string;
let currentSource: string;
let previousVersion: string;
let currentVersion: string;

test.beforeAll(async () => {
  sources = await mkdtemp('/tmp/cb-setup-source-');
  previousSource = path.join(sources, 'previous');
  currentSource = path.join(sources, 'current');
  for (const source of [previousSource, currentSource]) {
    await mkdir(source);
    for (const name of ['src', 'scripts', 'skills', 'package.json'])
      await cp(path.join(project, name), path.join(source, name), { recursive: true });
    await symlink(path.join(project, 'node_modules'), path.join(source, 'node_modules'));
  }
  const metadata = JSON.parse(await readFile(path.join(previousSource, 'package.json'), 'utf8'));
  previousVersion = metadata.version;
  const parts = previousVersion.split('.');
  parts[2] = String(Number(parts[2]) + 1);
  currentVersion = parts.join('.');
  await writeFile(
    path.join(currentSource, 'package.json'),
    JSON.stringify({ ...metadata, version: currentVersion }),
  );
  for (const source of [previousSource, currentSource])
    await exec(process.execPath, ['scripts/build.mjs'], { cwd: source, timeout: 30_000 });
});

test.afterAll(async () => {
  if (sources) await rm(sources, { recursive: true, force: true });
});

interface Install {
  root: string;
  home: string;
  operaHosts: string;
  run: (
    source: string,
    args: string[],
    preload?: string,
  ) => Promise<{ code: number; stdout: string; stderr: string }>;
}

async function withInstall(check: (install: Install) => Promise<void>) {
  const root = await mkdtemp('/tmp/cb-txn-');
  const home = path.join(root, 'home');
  const operaHosts = path.join(root, 'opera native hosts');
  const bin = path.join(root, 'bin');
  await mkdir(bin);
  const env = {
    ...process.env,
    HOME: path.join(root, 'user'),
    COBROWSER_HOME: home,
    PATH: bin,
    NODE_OPTIONS: '',
    FORCE_COLOR: undefined,
    NO_COLOR: undefined,
  };
  const run: Install['run'] = async (source, args, preload) => {
    try {
      const result = await exec(
        process.execPath,
        [...(preload ? ['--import', preload] : []), path.join(source, 'dist/cli.js'), ...args],
        { env, cwd: root, timeout: 15_000 },
      );
      return { ...result, code: 0 };
    } catch (error: any) {
      if (typeof error.code !== 'number') throw error;
      return { code: error.code, stdout: error.stdout || '', stderr: error.stderr || '' };
    }
  };
  try {
    const installed = await run(previousSource, [
      'setup',
      '--browser',
      'opera',
      '--native-hosts-dir',
      operaHosts,
    ]);
    expect(installed.code, installed.stderr).toBe(0);
    expect(JSON.parse((await run(previousSource, ['doctor', '--json'])).stdout).ok).toBe(true);
    await check({ root, home, operaHosts, run });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function filesUnder(directory: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      for (const [relative, contents] of Object.entries(await filesUnder(file)))
        files[path.join(entry.name, relative)] = contents;
    } else {
      const digest = createHash('sha256')
        .update(await readFile(file))
        .digest('hex');
      files[entry.name] = `${(await lstat(file)).mode & 0o777}:${digest}`;
    }
  }
  return files;
}

test('a failed upgrade leaves the working browser and extension unchanged', async () => {
  await withInstall(async ({ root, home, operaHosts, run }) => {
    const before = await filesUnder(home);
    const nativeHost = await readFile(path.join(operaHosts, 'cobrowser.json'), 'utf8');
    const invalidHosts = path.join(root, 'regular file');
    await writeFile(invalidHosts, 'keep this file');
    const result = await run(currentSource, [
      'setup',
      '--browser',
      'chrome',
      '--native-hosts-dir',
      invalidHosts,
    ]);
    expect(result.code).toBe(1);
    expect(await filesUnder(home)).toEqual(before);
    expect(await readFile(path.join(operaHosts, 'cobrowser.json'), 'utf8')).toBe(nativeHost);
    expect(await readFile(invalidHosts, 'utf8')).toBe('keep this file');
    expect(JSON.parse((await run(previousSource, ['doctor', '--json'])).stdout).ok).toBe(true);
  });
});

test('an incomplete source build cannot replace a healthy installation', async () => {
  await withInstall(async ({ root, home, run }) => {
    const brokenSource = path.join(root, 'incomplete source');
    await cp(previousSource, brokenSource, { recursive: true, verbatimSymlinks: true });
    await rm(path.join(brokenSource, 'dist/extension/service-worker.js'));
    const before = await filesUnder(home);
    const result = await run(brokenSource, ['setup', '--browser', 'opera']);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('service-worker.js');
    expect(await filesUnder(home)).toEqual(before);
    expect(JSON.parse((await run(previousSource, ['doctor', '--json'])).stdout).ok).toBe(true);
  });
});

test('a missing runtime bundle cannot replace a healthy installation', async () => {
  await withInstall(async ({ root, home, run }) => {
    const brokenSource = path.join(root, 'incomplete runtime');
    await cp(currentSource, brokenSource, { recursive: true, verbatimSymlinks: true });
    await rm(path.join(brokenSource, 'dist/helper.js'));
    const before = await filesUnder(home);
    const result = await run(brokenSource, ['setup', '--browser', 'opera']);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('helper.js');
    expect(await filesUnder(home)).toEqual(before);
  });
});

test('native-host directory symlink aliases cannot share one manifest', async () => {
  await withInstall(async ({ root, home, operaHosts, run }) => {
    const alias = path.join(root, 'native hosts alias');
    await symlink(operaHosts, alias, 'dir');
    const before = await filesUnder(home);
    const nativeHost = await readFile(path.join(operaHosts, 'cobrowser.json'), 'utf8');
    const result = await run(currentSource, [
      'setup',
      '--browser',
      'chrome',
      '--native-hosts-dir',
      alias,
    ]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('native-host');
    expect(await filesUnder(home)).toEqual(before);
    expect(await readFile(path.join(operaHosts, 'cobrowser.json'), 'utf8')).toBe(nativeHost);
  });
});

async function installFault(root: string, target: string, failRollback = false): Promise<string> {
  const preload = path.join(root, 'install-fault.mjs');
  await writeFile(
    preload,
    `import fsp from 'node:fs/promises';
     import { syncBuiltinESMExports } from 'node:module';
     const rename = fsp.rename;
     const target = ${JSON.stringify(target)};
     let failed = false;
     fsp.rename = async (from, to) => {
       if (to === target && (!failed || ${failRollback})) {
         failed = true;
         throw Object.assign(new Error('synthetic-private-failure'), { code: 'EACCES' });
       }
       return rename(from, to);
     };
     syncBuiltinESMExports();\n`,
  );
  return preload;
}

test('a late config replacement failure rolls back all browser files', async () => {
  await withInstall(async ({ root, home, operaHosts, run }) => {
    const before = await filesUnder(home);
    const nativeHost = await readFile(path.join(operaHosts, 'cobrowser.json'), 'utf8');
    const chromeHosts = path.join(root, 'chrome hosts');
    const preload = await installFault(root, path.join(home, 'config.json'));
    const result = await run(
      currentSource,
      ['setup', '--browser', 'chrome', '--native-hosts-dir', chromeHosts],
      preload,
    );
    expect(result.code).toBe(1);
    expect(result.stderr).not.toContain('synthetic-private-failure');
    expect(await filesUnder(home)).toEqual(before);
    expect(await readFile(path.join(operaHosts, 'cobrowser.json'), 'utf8')).toBe(nativeHost);
    expect(await readdir(chromeHosts)).toEqual([]);
    expect(JSON.parse((await run(previousSource, ['doctor', '--json'])).stdout).ok).toBe(true);
  });
});

test('failed rollback retains the previous file and reports recovery instructions', async () => {
  await withInstall(async ({ root, home, run }) => {
    const original = await readFile(path.join(home, 'config.json'), 'utf8');
    const preload = await installFault(root, path.join(home, 'config.json'), true);
    const result = await run(currentSource, ['setup', '--browser', 'opera'], preload);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('restore');
    expect(result.stderr).not.toContain('synthetic-private-failure');
    const files = await filesUnder(home);
    const recovery = Object.keys(files).find((file) => file.endsWith('recovery.json'));
    expect(recovery).toBeDefined();
    const recoveryFile = path.join(home, recovery!);
    expect(result.stderr).toContain(recoveryFile);
    const journal = JSON.parse(await readFile(recoveryFile, 'utf8'));
    const config = journal.files.find((file: { target: string }) =>
      file.target.endsWith('/config.json'),
    );
    expect(await readFile(config.backup, 'utf8')).toBe(original);
    expect(
      JSON.parse(await readFile(path.join(home, 'extension/manifest.json'), 'utf8')).version,
    ).toBe(previousVersion);
    expect(await readFile(path.join(home, 'hosts/opera'), 'utf8')).toContain(previousVersion);
  });
});

test('failed runtime restoration retains a runnable copy of the previous runtime', async () => {
  await withInstall(async ({ root, home, run }) => {
    const runtime = path.join(home, 'runtime', previousVersion);
    const original = await filesUnder(runtime);
    const preload = await installFault(root, runtime, true);
    const result = await run(previousSource, ['setup', '--browser', 'opera'], preload);
    expect(result.code).toBe(1);
    const files = await filesUnder(home);
    const recovery = Object.keys(files).find((file) => file.endsWith('recovery.json'));
    expect(recovery).toBeDefined();
    const recoveryFile = path.join(home, recovery!);
    expect(result.stderr).toContain(recoveryFile);
    const journal = JSON.parse(await readFile(recoveryFile, 'utf8'));
    const backup = journal.files.find((file: { target: string }) => file.target === runtime).backup;
    expect(await filesUnder(backup)).toEqual(original);
    const launched = await exec(process.execPath, [
      '--no-experimental-detect-module',
      path.join(backup, 'cli.js'),
      '--version',
    ]);
    expect(launched.stdout.trim()).toBe(previousVersion);
  });
});

for (const target of ['launcher', 'native manifest', 'config']) {
  test(`a directory at the ${target} path cannot replace working files`, async () => {
    await withInstall(async ({ home, operaHosts, run }) => {
      const file =
        target === 'launcher'
          ? path.join(home, 'hosts/opera')
          : target === 'native manifest'
            ? path.join(operaHosts, 'cobrowser.json')
            : path.join(home, 'config.json');
      await rm(file);
      await mkdir(file);
      await writeFile(path.join(file, 'keep'), 'keep this directory');
      const before = await filesUnder(home);
      const result = await run(currentSource, [
        'setup',
        '--browser',
        'opera',
        '--native-hosts-dir',
        operaHosts,
      ]);
      expect(result.code).toBe(1);
      expect(await filesUnder(home)).toEqual(before);
      expect(await readFile(path.join(file, 'keep'), 'utf8')).toBe('keep this directory');
    });
  });
}

test('a failed core install never restarts helpers or invokes agent registration', async () => {
  await withInstall(async ({ root, home, run }) => {
    const marker = path.join(root, 'agent-called');
    await writeFile(
      path.join(root, 'bin/claude'),
      `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)}, 'called');\n`,
      { mode: 0o755 },
    );
    await mkdir(path.join(home, 'run'));
    let restarts = 0;
    const server = http.createServer((request, response) => {
      if (request.url === '/v1/restart') restarts++;
      response.end('{}');
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(path.join(home, 'run/opera.sock'), resolve);
    });
    try {
      const preload = await installFault(root, path.join(home, 'config.json'));
      const result = await run(currentSource, ['setup', '--browser', 'opera'], preload);
      expect(result.code).toBe(1);
      expect(restarts).toBe(0);
      expect(await lstat(marker).catch(() => undefined)).toBeUndefined();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

test('a successful upgrade updates every configured browser and keeps ESM metadata', async () => {
  await withInstall(async ({ root, home, operaHosts, run }) => {
    const chromeHosts = path.join(root, 'chrome native hosts');
    const result = await run(currentSource, [
      'setup',
      '--browser',
      'chrome',
      '--native-hosts-dir',
      chromeHosts,
    ]);
    expect(result.code, result.stderr).toBe(0);
    for (const [browser, directory] of [
      ['chrome', chromeHosts],
      ['opera', operaHosts],
    ]) {
      const launcher = path.join(home, 'hosts', browser);
      expect(await readFile(launcher, 'utf8')).toContain(`/runtime/${currentVersion}/helper.js`);
      expect(JSON.parse(await readFile(path.join(directory, 'cobrowser.json'), 'utf8')).path).toBe(
        launcher,
      );
    }
    const runtime = path.join(home, 'runtime', currentVersion);
    expect(JSON.parse(await readFile(path.join(runtime, 'package.json'), 'utf8'))).toEqual({
      private: true,
      type: 'module',
      version: currentVersion,
    });
    expect(JSON.parse((await run(currentSource, ['doctor', '--json'])).stdout).ok).toBe(true);
    expect(await lstat(path.join(home, 'runtime', previousVersion))).toBeDefined();
    expect(Object.keys(await filesUnder(home)).some((file) => file.includes('.cb-'))).toBe(false);
  });
});
