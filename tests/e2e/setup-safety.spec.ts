import { test, expect } from '@playwright/test';
import { execFile, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const project = path.resolve(import.meta.dirname, '../..');
const lockName = '.cb-setup-lock';
let sources: string;
let currentSource: string;
let nextSource: string;
let currentVersion: string;
let nextVersion: string;

test.beforeAll(async () => {
  sources = await mkdtemp('/tmp/cb-safe-source-');
  currentSource = path.join(sources, 'current');
  nextSource = path.join(sources, 'next');
  await mkdir(currentSource);
  for (const name of ['dist', 'skills', 'package.json'])
    await cp(path.join(project, name), path.join(currentSource, name), { recursive: true });
  const metadata = JSON.parse(await readFile(path.join(project, 'package.json'), 'utf8'));
  currentVersion = metadata.version;
  const parts = currentVersion.split('.');
  parts[2] = String(Number(parts[2]) + 1);
  nextVersion = parts.join('.');
  await mkdir(nextSource);
  for (const name of ['src', 'scripts', 'skills'])
    await cp(path.join(project, name), path.join(nextSource, name), { recursive: true });
  await writeFile(
    path.join(nextSource, 'package.json'),
    JSON.stringify({ ...metadata, version: nextVersion }),
  );
  await symlink(path.join(project, 'node_modules'), path.join(nextSource, 'node_modules'));
  await exec(process.execPath, ['scripts/build.mjs'], { cwd: nextSource, timeout: 30_000 });
});

test.afterAll(async () => {
  if (sources) await rm(sources, { recursive: true, force: true });
});

interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

interface RunningCommand {
  child: ChildProcess;
  done: Promise<CommandResult>;
}

interface CommandOptions {
  source?: string;
  preload?: string;
  home?: string;
}

interface Install {
  root: string;
  home: string;
  hosts: string;
  start: (args: string[], options?: CommandOptions) => RunningCommand;
  run: (args: string[], options?: CommandOptions) => Promise<CommandResult>;
}

async function withInstall(check: (install: Install) => Promise<void>) {
  const root = await mkdtemp('/tmp/cb-safe-');
  const home = path.join(root, 'home');
  const hosts = path.join(root, 'original native hosts');
  const bin = path.join(root, 'bin');
  await mkdir(bin);
  const children: RunningCommand[] = [];
  const env = {
    ...process.env,
    HOME: path.join(root, 'user'),
    COBROWSER_HOME: home,
    CLAUDE_CONFIG_DIR: path.join(root, 'claude'),
    CODEX_HOME: path.join(root, 'codex'),
    PATH: bin,
    NODE_OPTIONS: '',
    FORCE_COLOR: undefined,
    NO_COLOR: undefined,
  };
  const start: Install['start'] = (args, options = {}) => {
    let child: ChildProcess;
    const done = new Promise<CommandResult>((resolve) => {
      child = execFile(
        process.execPath,
        [
          ...(options.preload ? ['--import', options.preload] : []),
          path.join(options.source ?? currentSource, 'dist/cli.js'),
          ...args,
        ],
        {
          env: { ...env, COBROWSER_HOME: options.home ?? home },
          cwd: root,
          timeout: 40_000,
        },
        (error, stdout, stderr) =>
          resolve({
            code: error ? (typeof error.code === 'number' ? error.code : 1) : 0,
            stdout,
            stderr,
          }),
      );
    });
    const command = { child: child!, done };
    children.push(command);
    return command;
  };
  const run: Install['run'] = (args, options) => start(args, options).done;
  try {
    const installed = await run(['setup', '--browser', 'original', '--native-hosts-dir', hosts]);
    expect(installed.code, installed.stderr).toBe(0);
    await check({ root, home, hosts, start, run });
  } finally {
    for (const { child } of children)
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await Promise.all(children.map(({ done }) => done));
    await rm(root, { recursive: true, force: true });
  }
}

async function exists(file: string): Promise<boolean> {
  return Boolean(await lstat(file).catch(() => undefined));
}

async function waitFor(file: string) {
  await expect.poll(() => exists(file)).toBe(true);
}

async function preload(root: string, body: string): Promise<string> {
  const file = path.join(root, `${randomUUID()}.mjs`);
  await writeFile(file, `import fs from 'node:fs/promises';\n${body}\n`);
  return file;
}

async function pauseCopy(root: string, name: string, postCommit = false) {
  const ready = path.join(root, `${name}-ready`);
  const release = path.join(root, `${name}-release`);
  const file = await preload(
    root,
    `const original = fs.cp;
let paused = false;
fs.cp = async function(source, target, ...rest) {
  if (!paused && ${postCommit ? "String(source).endsWith('/skills/cobrowser')" : 'true'}) {
    paused = true;
    await fs.writeFile(${JSON.stringify(ready)}, 'ready');
    while (!(await fs.stat(${JSON.stringify(release)}).catch(() => undefined)))
      await new Promise(resolve => setTimeout(resolve, 10));
  }
  return original.call(this, source, target, ...rest);
};`,
  );
  return { file, ready, release };
}

function setupArgs(root: string, browser: string): string[] {
  return ['setup', '--browser', browser, '--native-hosts-dir', path.join(root, `${browser} hosts`)];
}

async function assertRegistrations(install: Install, browsers: string[], version: string) {
  const config = JSON.parse(await readFile(path.join(install.home, 'config.json'), 'utf8'));
  expect(config.configuredBrowsers).toEqual([...browsers].sort());
  for (const browser of browsers) {
    expect(config.nativeHosts).toContainEqual({
      browser,
      directory:
        browser === 'original' ? install.hosts : path.join(install.root, `${browser} hosts`),
    });
    expect(await readFile(path.join(install.home, 'hosts', browser), 'utf8')).toContain(
      `/runtime/${version}/helper.js`,
    );
  }
  expect(
    JSON.parse(await readFile(path.join(install.home, 'extension/manifest.json'), 'utf8')).version,
  ).toBe(version);
  expect(await exists(path.join(install.home, lockName))).toBe(false);
  expect((await readdir(install.home)).some((file) => file.startsWith('.cb-setup-waiter-'))).toBe(
    false,
  );
}

test('concurrent setup reads the registry after the preceding installation finishes', async () => {
  await withInstall(async (install) => {
    const owner = await pauseCopy(install.root, 'owner');
    const first = install.start(setupArgs(install.root, 'alpha'), { preload: owner.file });
    await waitFor(owner.ready);
    const second = install.start(setupArgs(install.root, 'beta'), { source: nextSource });
    await new Promise((resolve) => setTimeout(resolve, 150));
    await writeFile(owner.release, 'release');
    for (const result of await Promise.all([first.done, second.done]))
      expect(result.code, result.stderr).toBe(0);
    await assertRegistrations(install, ['original', 'alpha', 'beta'], nextVersion);
    expect(
      JSON.parse((await install.run(['doctor', '--json'], { source: nextSource })).stdout).ok,
    ).toBe(true);
  });
});

test('setup holds its lock through poststeps before another build can stage files', async () => {
  await withInstall(async (install) => {
    const owner = await pauseCopy(install.root, 'owner-post', true);
    const waiter = await pauseCopy(install.root, 'waiter');
    const first = install.start(setupArgs(install.root, 'alpha'), { preload: owner.file });
    await waitFor(owner.ready);
    const second = install.start(setupArgs(install.root, 'beta'), {
      source: nextSource,
      preload: waiter.file,
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(await exists(waiter.ready)).toBe(false);
    await writeFile(owner.release, 'release');
    await waitFor(waiter.ready);
    expect((await first.done).code).toBe(0);
    await writeFile(waiter.release, 'release');
    const result = await second.done;
    expect(result.code, result.stderr).toBe(0);
    await assertRegistrations(install, ['original', 'alpha', 'beta'], nextVersion);
  });
});

test('simultaneous waiters recover a dead owner without removing the replacement lock', async () => {
  await withInstall(async (install) => {
    const owner = await pauseCopy(install.root, 'dead-owner');
    const original = install.start(setupArgs(install.root, 'unfinished'), { preload: owner.file });
    await waitFor(owner.ready);
    original.child.kill('SIGKILL');
    await original.done;
    const lock = path.join(install.home, lockName);
    const [deadMarker] = await readdir(lock);
    const reclaimReady = path.join(install.root, 'reclaim-ready');
    const reclaimRelease = path.join(install.root, 'reclaim-release');
    const reclaim = await preload(
      install.root,
      `const original = fs.unlink;
let paused = false;
fs.unlink = async function(file) {
  if (!paused && String(file).endsWith(${JSON.stringify(`/${deadMarker}`)})) {
    paused = true;
    await fs.writeFile(${JSON.stringify(reclaimReady)}, 'ready');
    while (!(await fs.stat(${JSON.stringify(reclaimRelease)}).catch(() => undefined)))
      await new Promise(resolve => setTimeout(resolve, 10));
  }
  return original.call(this, file);
};`,
    );
    const first = install.start(setupArgs(install.root, 'alpha'), {
      preload: reclaim,
      source: nextSource,
    });
    await waitFor(reclaimReady);
    const replacement = await pauseCopy(install.root, 'replacement');
    const second = install.start(setupArgs(install.root, 'beta'), {
      preload: replacement.file,
      source: nextSource,
    });
    await waitFor(replacement.ready);
    const replacementMarkers = await readdir(lock);
    expect(replacementMarkers).not.toContain(deadMarker);
    await writeFile(reclaimRelease, 'release');
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(await readdir(lock)).toEqual(replacementMarkers);
    await writeFile(replacement.release, 'release');
    for (const result of await Promise.all([first.done, second.done]))
      expect(result.code, result.stderr).toBe(0);
    await assertRegistrations(install, ['original', 'alpha', 'beta'], nextVersion);
  });
});

test('a live owner times out with a repair action and keeps its lock', async () => {
  await withInstall(async (install) => {
    const owner = await pauseCopy(install.root, 'live-owner');
    const first = install.start(setupArgs(install.root, 'alpha'), { preload: owner.file });
    await waitFor(owner.ready);
    const lock = path.join(install.home, lockName);
    const markers = await readdir(lock);
    const registry = await readFile(path.join(install.home, 'config.json'), 'utf8');
    const clock = await preload(
      install.root,
      `import { performance } from 'node:perf_hooks';
const original = performance.now.bind(performance);
let reads = 0;
Object.defineProperty(performance, 'now', { value: () => original() + reads++ * 31_000 });`,
    );
    const result = await install.run(setupArgs(install.root, 'beta'), { preload: clock });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('Another cobrowser setup is still running');
    expect(result.stderr).toContain('wait for it to finish');
    expect(await readdir(lock)).toEqual(markers);
    expect(await readFile(path.join(install.home, 'config.json'), 'utf8')).toBe(registry);
    expect(() => process.kill(first.child.pid!, 0)).not.toThrow();
    await writeFile(owner.release, 'release');
    expect((await first.done).code).toBe(0);
    await assertRegistrations(install, ['original', 'alpha'], currentVersion);
  });
});

test('release leaves a replacement directory and its owner marker intact', async () => {
  await withInstall(async (install) => {
    const owner = await pauseCopy(install.root, 'replaced-owner');
    const first = install.start(setupArgs(install.root, 'alpha'), { preload: owner.file });
    await waitFor(owner.ready);
    const lock = path.join(install.home, lockName);
    await rename(lock, path.join(install.root, 'retired-lock'));
    const candidate = await mkdtemp(path.join(install.root, 'replacement-'));
    const marker = `owner-${process.pid}-${randomUUID()}`;
    await writeFile(path.join(candidate, marker), '');
    await rename(candidate, lock);
    const identity = await lstat(lock);
    await writeFile(owner.release, 'release');
    const result = await first.done;
    expect(result.code, result.stderr).toBe(0);
    expect(await readdir(lock)).toEqual([marker]);
    const after = await lstat(lock);
    expect([after.dev, after.ino]).toEqual([identity.dev, identity.ino]);
  });
});

test('a new owner can acquire between the old owner unlink and rmdir', async () => {
  await withInstall(async (install) => {
    const ready = path.join(install.root, 'release-ready');
    const release = path.join(install.root, 'release-continue');
    const fault = await preload(
      install.root,
      `const original = fs.rmdir;
let paused = false;
fs.rmdir = async function(directory, ...rest) {
  if (!paused && String(directory).endsWith('/${lockName}')) {
    paused = true;
    await fs.writeFile(${JSON.stringify(ready)}, 'ready');
    while (!(await fs.stat(${JSON.stringify(release)}).catch(() => undefined)))
      await new Promise(resolve => setTimeout(resolve, 10));
  }
  return original.call(this, directory, ...rest);
};`,
    );
    const first = install.start(setupArgs(install.root, 'alpha'), { preload: fault });
    await waitFor(ready);
    const lock = path.join(install.home, lockName);
    expect(await readdir(lock)).toEqual([]);
    const replacement = await pauseCopy(install.root, 'during-release');
    const second = install.start(setupArgs(install.root, 'beta'), {
      preload: replacement.file,
      source: nextSource,
    });
    await waitFor(replacement.ready);
    const markers = await readdir(lock);
    expect(markers).toHaveLength(1);
    await writeFile(release, 'release');
    const firstResult = await first.done;
    expect(firstResult.code, firstResult.stderr).toBe(0);
    expect(await readdir(lock)).toEqual(markers);
    await writeFile(replacement.release, 'release');
    const secondResult = await second.done;
    expect(secondResult.code, secondResult.stderr).toBe(0);
    await assertRegistrations(install, ['original', 'alpha', 'beta'], nextVersion);
  });
});

for (const kind of [
  'foreign file',
  'directory symlink',
  'marker symlink',
  'invalid pid',
  'unverifiable owner',
]) {
  test(`setup preserves ${kind} at the lock path`, async () => {
    await withInstall(async (install) => {
      const lock = path.join(install.home, lockName);
      const foreign = path.join(install.root, 'foreign');
      await mkdir(foreign);
      await writeFile(path.join(foreign, 'keep'), 'keep this file');
      const marker = `owner-${kind === 'invalid pid' ? '0' : process.pid}-${randomUUID()}`;
      if (kind === 'foreign file') await writeFile(lock, 'keep this lock path');
      else if (kind === 'directory symlink') await symlink(foreign, lock, 'dir');
      else {
        await mkdir(lock);
        if (kind === 'marker symlink')
          await symlink(path.join(foreign, 'keep'), path.join(lock, marker));
        else await writeFile(path.join(lock, marker), '');
      }
      const identity = await lstat(lock);
      const invalidCall = path.join(install.root, 'invalid-pid-called');
      const clock = await preload(
        install.root,
        `import { performance } from 'node:perf_hooks';
const original = performance.now.bind(performance);
let reads = 0;
Object.defineProperty(performance, 'now', { value: () => original() + reads++ * 31_000 });
const kill = process.kill;
process.kill = function(pid, signal) {
  if (!Number.isSafeInteger(pid) || pid <= 0)
    void fs.writeFile(${JSON.stringify(invalidCall)}, 'called');
  ${kind === 'unverifiable owner' ? "throw Object.assign(new Error('unverifiable'), { code: 'EPERM' });" : 'return kill.call(this, pid, signal);'}
};`,
      );
      const result = await install.run(setupArgs(install.root, 'alpha'), { preload: clock });
      expect(result.code).toBe(1);
      const after = await lstat(lock);
      expect([after.dev, after.ino]).toEqual([identity.dev, identity.ino]);
      expect(await readFile(path.join(foreign, 'keep'), 'utf8')).toBe('keep this file');
      expect(await exists(invalidCall)).toBe(false);
      if (kind === 'foreign file') expect(await readFile(lock, 'utf8')).toBe('keep this lock path');
      else if (kind !== 'directory symlink') expect(await readdir(lock)).toEqual([marker]);
    });
  });
}

test('physical home aliases wait on the same setup lock', async () => {
  await withInstall(async (install) => {
    const alias = path.join(install.root, 'alias');
    await symlink(install.home, alias, 'dir');
    const owner = await pauseCopy(install.root, 'alias-owner');
    const waiter = await pauseCopy(install.root, 'alias-waiter');
    const first = install.start(setupArgs(install.root, 'alpha'), { preload: owner.file });
    await waitFor(owner.ready);
    const second = install.start(setupArgs(install.root, 'beta'), {
      home: alias,
      preload: waiter.file,
      source: nextSource,
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(await exists(waiter.ready)).toBe(false);
    await writeFile(owner.release, 'release');
    await waitFor(waiter.ready);
    await writeFile(waiter.release, 'release');
    for (const result of await Promise.all([first.done, second.done]))
      expect(result.code, result.stderr).toBe(0);
    await assertRegistrations(install, ['original', 'alpha', 'beta'], nextVersion);
    expect(
      JSON.parse(
        (await install.run(['doctor', '--json'], { source: nextSource, home: alias })).stdout,
      ).ok,
    ).toBe(true);
  });
});

async function filesUnder(directory: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      for (const [name, digest] of Object.entries(await filesUnder(file)))
        files[path.join(entry.name, name)] = digest;
    } else if (entry.isFile()) {
      files[entry.name] = createHash('sha256')
        .update(await readFile(file))
        .digest('hex');
    }
  }
  return files;
}

for (const kind of ['lock directory', 'lock descendant', 'lock symlink']) {
  test(`setup rejects a native-host destination in the ${kind}`, async () => {
    await withInstall(async (install) => {
      const lock = path.join(install.home, lockName);
      let directory = kind === 'lock descendant' ? path.join(lock, 'hosts') : lock;
      if (kind === 'lock symlink') {
        directory = path.join(install.root, 'lock-alias');
        await symlink(lock, directory, 'dir');
      }
      const before = await filesUnder(install.home);
      const result = await install.run([
        'setup',
        '--browser',
        'alpha',
        '--native-hosts-dir',
        directory,
      ]);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('native-host directory overlaps the setup lock');
      expect(await filesUnder(install.home)).toEqual(before);
      expect(await exists(lock)).toBe(false);
      expect(JSON.parse((await install.run(['doctor', '--json'])).stdout).ok).toBe(true);
    });
  });
}

const corruptions: [string, (manifest: any) => void][] = [
  [
    'missing extension name',
    (manifest) => {
      delete manifest.name;
    },
  ],
  [
    'empty extension name',
    (manifest) => {
      manifest.name = '';
    },
  ],
  ...['tabs', 'scripting', 'nativeMessaging', 'storage', 'alarms', 'webRequest'].map(
    (permission): [string, (manifest: any) => void] => [
      `missing ${permission}`,
      (manifest) => {
        manifest.permissions = manifest.permissions.filter((value: string) => value !== permission);
      },
    ],
  ),
  [
    'debugger permission',
    (manifest) => {
      manifest.permissions.push('debugger');
    },
  ],
  [
    'unapproved permission',
    (manifest) => {
      manifest.permissions.push('downloads');
    },
  ],
  [
    'optional debugger permission',
    (manifest) => {
      manifest.optional_permissions = ['debugger'];
    },
  ],
  [
    'wrong manifest version',
    (manifest) => {
      manifest.manifest_version = 2;
    },
  ],
  [
    'incognito access',
    (manifest) => {
      manifest.incognito = 'spanning';
    },
  ],
  [
    'missing host permissions',
    (manifest) => {
      delete manifest.host_permissions;
    },
  ],
  [
    'wrong background worker',
    (manifest) => {
      manifest.background.service_worker = 'missing.js';
    },
  ],
  [
    'background page',
    (manifest) => {
      manifest.background.page = 'popup.html';
    },
  ],
  [
    'wrong stable key',
    (manifest) => {
      manifest.key = 'invalid';
    },
  ],
];

for (const [name, corrupt] of corruptions) {
  test(`setup rejects ${name} and doctor detects it in the installed extension`, async () => {
    await withInstall(async (install) => {
      const broken = path.join(install.root, 'broken-source');
      await cp(currentSource, broken, { recursive: true });
      const sourceManifest = path.join(broken, 'dist/extension/manifest.json');
      const manifest = JSON.parse(await readFile(sourceManifest, 'utf8'));
      corrupt(manifest);
      await writeFile(sourceManifest, JSON.stringify(manifest));
      const before = await filesUnder(install.home);
      const result = await install.run(['setup', '--browser', 'original'], { source: broken });
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('extension build is invalid');
      expect(await filesUnder(install.home)).toEqual(before);
      await writeFile(path.join(install.home, 'extension/manifest.json'), JSON.stringify(manifest));
      const doctor = await install.run(['doctor', '--json']);
      expect(doctor.code).toBe(1);
      expect(JSON.parse(doctor.stdout).ok).toBe(false);
      expect(doctor.stdout).toContain('fix run cobrowser setup');
      expect(doctor.stdout).not.toContain('ok extension build is present');
      expect((await install.run(['setup', '--browser', 'original'])).code).toBe(0);
      expect(JSON.parse((await install.run(['doctor', '--json'])).stdout).ok).toBe(true);
    });
  });
}

test('staged manifest validation rejects corruption before core replacement', async () => {
  await withInstall(async (install) => {
    const before = await filesUnder(install.home);
    const fault = await preload(
      install.root,
      `const original = fs.cp;
let changed = false;
fs.cp = async function(source, target, ...rest) {
  await original.call(this, source, target, ...rest);
  if (!changed) {
    changed = true;
    const file = String(target) + '/extension/manifest.json';
    const manifest = JSON.parse(await fs.readFile(file, 'utf8'));
    manifest.permissions = manifest.permissions.filter(value => value !== 'nativeMessaging');
    await fs.writeFile(file, JSON.stringify(manifest));
  }
};`,
    );
    const result = await install.run(['setup', '--browser', 'original'], { preload: fault });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('extension build is invalid');
    expect(await filesUnder(install.home)).toEqual(before);
    expect(JSON.parse((await install.run(['doctor', '--json'])).stdout).ok).toBe(true);
  });
});

test('doctor rejects empty required installed runtime files', async () => {
  await withInstall(async (install) => {
    for (const name of [
      'package.json',
      'cli.js',
      'client.js',
      'helper.js',
      'extension/options.js',
    ]) {
      const file = path.join(install.home, 'runtime', currentVersion, name);
      const original = await readFile(file);
      await writeFile(file, '');
      const result = await install.run(['doctor', '--json']);
      expect(result.code, name).toBe(1);
      expect(result.stdout).toContain(
        `fix run cobrowser setup to install runtime ${currentVersion}`,
      );
      expect(result.stdout).not.toContain(`ok runtime ${currentVersion} is installed`);
      await writeFile(file, original);
    }
    expect(JSON.parse((await install.run(['doctor', '--json'])).stdout).ok).toBe(true);
  });
});

test('doctor rejects empty required installed extension files', async () => {
  await withInstall(async (install) => {
    for (const name of [
      'manifest.json',
      'service-worker.js',
      'popup.html',
      'popup.js',
      'options.html',
      'options.js',
    ]) {
      const file = path.join(install.home, 'extension', name);
      const original = await readFile(file);
      await writeFile(file, '');
      const result = await install.run(['doctor', '--json']);
      expect(result.code, name).toBe(1);
      expect(result.stdout).toContain('fix run cobrowser setup to restore the extension files');
      expect(result.stdout).not.toContain('ok extension build is present');
      await writeFile(file, original);
    }
    expect(JSON.parse((await install.run(['doctor', '--json'])).stdout).ok).toBe(true);
  });
});

test('doctor rejects unreadable required assets and setup repairs them', async () => {
  test.skip(process.getuid?.() === 0, 'Root can read files without mode read bits.');
  await withInstall(async (install) => {
    for (const relative of [
      `runtime/${currentVersion}/helper.js`,
      `runtime/${currentVersion}/client.js`,
      'extension/service-worker.js',
      'extension/options.js',
    ]) {
      const file = path.join(install.home, relative);
      const original = await readFile(file);
      const mode = (await lstat(file)).mode & 0o777;
      try {
        await chmod(file, 0);
        const result = await install.run(['doctor', '--json']);
        expect(result.code, relative).toBe(1);
        expect(JSON.parse(result.stdout).ok).toBe(false);
        expect(result.stdout).toContain('fix run cobrowser setup');
        const repaired = await install.run(['setup', '--browser', 'original']);
        expect(repaired.code, repaired.stderr).toBe(0);
        expect(JSON.parse((await install.run(['doctor', '--json'])).stdout).ok).toBe(true);
      } finally {
        await chmod(file, mode);
      }
      expect(await readFile(file)).toEqual(original);
    }
    expect(JSON.parse((await install.run(['doctor', '--json'])).stdout).ok).toBe(true);
  });
});

test('doctor checks the manifest in the copied runtime too', async () => {
  await withInstall(async (install) => {
    const file = path.join(install.home, 'runtime', currentVersion, 'extension/manifest.json');
    const manifest = JSON.parse(await readFile(file, 'utf8'));
    manifest.permissions = manifest.permissions.filter(
      (value: string) => value !== 'nativeMessaging',
    );
    await writeFile(file, JSON.stringify(manifest));
    const result = await install.run(['doctor', '--json']);
    expect(result.code).toBe(1);
    expect(result.stdout).toContain(`fix run cobrowser setup to install runtime ${currentVersion}`);
    expect(result.stdout).toContain('ok extension build is present');
  });
});
