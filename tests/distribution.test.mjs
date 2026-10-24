import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  access,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const root = fileURLToPath(new URL('..', import.meta.url));
const runtimeNode = process.env.COBROWSER_TEST_NODE || process.execPath;
const npmCli =
  process.env.npm_execpath ||
  path.resolve(path.dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js');

async function run(file, args, options = {}) {
  return exec(file, args, { timeout: 30_000, maxBuffer: 4 * 1024 * 1024, ...options });
}

async function waitFor(check) {
  const deadline = Date.now() + 5_000;
  for (;;) {
    try {
      return await check();
    } catch (error) {
      if (Date.now() >= deadline) throw error;
      await delay(20);
    }
  }
}

function frame(value) {
  const body = Buffer.from(JSON.stringify(value));
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length);
  return Buffer.concat([header, body]);
}

async function smokeRuntime(directory, prefix, version, env) {
  const installed = path.join(prefix, 'lib/node_modules/cobrowser');
  const cli = path.join(prefix, 'bin/cobrowser');
  assert.deepEqual(await readdir(path.join(prefix, 'lib/node_modules')), ['cobrowser']);
  await assert.rejects(access(path.join(installed, 'node_modules')));
  const runtimeEnv = {
    ...env,
    COBROWSER_HOME: path.join(directory, 'home'),
    NODE_PATH: '',
    PATH: `${path.dirname(runtimeNode)}${path.delimiter}${process.env.PATH || ''}`,
  };
  assert.equal((await run(cli, ['--version'], { env: runtimeEnv })).stdout.trim(), version);
  assert.match((await run(cli, ['--help'], { env: runtimeEnv })).stdout, /cobrowser read/);
  const isolatedBin = path.join(directory, 'isolated-bin');
  const user = path.join(directory, 'user');
  await mkdir(isolatedBin);
  await symlink(runtimeNode, path.join(isolatedBin, 'node'));
  const setupEnv = {
    ...runtimeEnv,
    HOME: user,
    CLAUDE_CONFIG_DIR: path.join(user, '.claude'),
    CODEX_HOME: path.join(user, '.codex'),
    PATH: isolatedBin,
  };
  await run(
    cli,
    ['setup', '--browser', 'smoke', '--native-hosts-dir', path.join(directory, 'native-hosts')],
    { env: setupEnv },
  );
  const runtime = path.join(runtimeEnv.COBROWSER_HOME, 'runtime', version);
  assert.equal(
    (
      await run(runtimeNode, [path.join(runtime, 'cli.js'), '--version'], { env: setupEnv })
    ).stdout.trim(),
    version,
  );

  const tab = {
    id: 7,
    windowId: 1,
    active: true,
    title: 'Packed install',
    url: 'https://example.test/article',
    status: 'complete',
    documentEpoch: 'distribution-document',
  };
  const paragraph = 'The installed helper converts this article without npm dependencies. '.repeat(
    8,
  );
  const html = `<html><head><title>Packed install</title></head><body><article>
    <h1>Packed install</h1><p>${paragraph}<strong>Portable content</strong>
    <a href="https://example.test/source">source link</a></p>
    <table><thead><tr><th>Name</th><th>Value</th></tr></thead>
    <tbody><tr><td>Bundle</td><td>Ready</td></tr></tbody></table>
    </article></body></html>`;
  const helper = spawn(runtimeNode, [path.join(runtime, 'helper.js'), '--browser', 'smoke'], {
    env: runtimeEnv,
    cwd: directory,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const exited = once(helper, 'exit');
  let stderr = '';
  let pending = Buffer.alloc(0);
  let hello;
  let protocolError;
  helper.stderr.on('data', (chunk) => (stderr += chunk));
  helper.stdout.on('data', (chunk) => {
    pending = Buffer.concat([pending, chunk]);
    try {
      while (pending.length >= 4) {
        const length = pending.readUInt32LE();
        assert.ok(length > 0 && length <= 1_000_000, 'Helper stdout must contain native frames.');
        if (pending.length < length + 4) break;
        const request = JSON.parse(pending.subarray(4, length + 4).toString('utf8'));
        pending = pending.subarray(length + 4);
        if (request.event === 'hello_ack') hello = request.data;
        if (request.id === undefined) continue;
        let result;
        if (request.method === 'guard') {
          const checked = new Map();
          for (const { id, documentEpoch } of [
            ...(request.params.access?.tabs ?? []),
            ...(request.params.tabs ?? []),
          ])
            checked.set(id, { id, documentEpoch });
          result = {
            pauseEpoch: 'distribution-smoke',
            access: { policyEpoch: 'distribution-policy', tabs: [...checked.values()] },
          };
        } else if (request.method === 'tab') result = tab;
        else if (request.method === 'tabs') result = { tabs: [tab], hidden: 0, frontWindowId: 1 };
        else if (request.method === 'read')
          result = {
            url: tab.url,
            title: tab.title,
            html,
            documentEpoch: tab.documentEpoch,
          };
        else throw new Error(`Unexpected native request: ${request.method}`);
        helper.stdin.write(frame({ id: request.id, ok: true, result }));
      }
    } catch (error) {
      protocolError = error;
      helper.kill();
    }
  });

  try {
    const extensionRevision = /^\/\/ cobrowser-extension-build: ([a-f0-9]{64})\n/.exec(
      await readFile(path.join(runtimeEnv.COBROWSER_HOME, 'extension/service-worker.js'), 'utf8'),
    )?.[1];
    assert.ok(extensionRevision);
    helper.stdin.write(
      frame({ event: 'hello', data: { version, protocol: 1, extensionRevision } }),
    );
    await waitFor(async () => {
      assert.equal(helper.exitCode, null, stderr);
      assert.equal(protocolError, undefined);
      assert.equal(hello?.version, version);
      await access(path.join(runtimeEnv.COBROWSER_HOME, 'run/smoke.sock'));
    });
    const clientUrl = pathToFileURL(path.join(runtime, 'client.js')).href;
    const clientProgram = `
      import { CobrowserClient } from ${JSON.stringify(clientUrl)};
      const client = new CobrowserClient({ browser: 'smoke' });
      console.log(JSON.stringify({
        status: await client.request('status'),
        reader: await client.request('read', { id: 7 }),
        full: await client.request('read', { id: 7, full: true, links: true }),
      }));
    `;
    const client = JSON.parse(
      (
        await run(runtimeNode, ['--input-type=module', '--eval', clientProgram], {
          env: runtimeEnv,
          cwd: directory,
        })
      ).stdout,
    );
    assert.equal(client.status.data.connected, true);
    for (const result of [client.reader, client.full]) {
      assert.equal(result.ok, true, JSON.stringify(result));
      assert.match(result.text, /The installed helper converts this article/);
      assert.match(result.text, /\*\*Portable content\*\*/);
    }
    assert.match(client.full.text, /\| Name \| Value \|/);
    assert.match(client.full.text, /\[source link\]\(https:\/\/example.test\/source\)/);
    const listed = JSON.parse(
      (await run(cli, ['tabs', '--browser', 'smoke', '--json'], { env: runtimeEnv })).stdout,
    );
    assert.equal(listed.ok, true, JSON.stringify(listed));
    assert.equal(listed.data.tabs[0].id, tab.id);
    const read = JSON.parse(
      (await run(cli, ['read', '7', '--browser', 'smoke', '--json'], { env: runtimeEnv })).stdout,
    );
    assert.equal(read.ok, true, JSON.stringify(read));
    assert.match(read.text, /The installed helper converts this article/);
    assert.equal(protocolError, undefined);
  } finally {
    helper.stdin.end();
    const timer = setTimeout(() => helper.kill('SIGKILL'), 2_000);
    timer.unref();
    try {
      await exited;
    } finally {
      clearTimeout(timer);
    }
  }
  assert.equal(helper.exitCode, 0, stderr);
  assert.equal(stderr, '');
  assert.equal(pending.length, 0, 'Helper stdout must end at a frame boundary.');
}

test('packed distribution and build recovery', { timeout: 60_000 }, async (t) => {
  const directory = await mkdtemp('/tmp/cobrowser-dist-');
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(path.join(directory, 'package.json'), '{"type":"commonjs"}\n');
  const source = path.join(directory, 'source');
  await mkdir(source);
  for (const name of ['package.json', 'scripts', 'src', 'skills', 'README.md', 'LICENSE'])
    await cp(path.join(root, name), path.join(source, name), { recursive: true });
  await symlink(path.join(root, 'node_modules'), path.join(source, 'node_modules'));
  const metadata = JSON.parse(await readFile(path.join(source, 'package.json'), 'utf8'));
  const env = {
    ...process.env,
    npm_config_cache: path.join(directory, 'cache'),
    npm_config_userconfig: path.join(directory, 'npmrc'),
    npm_config_globalconfig: path.join(directory, 'global-npmrc'),
    npm_config_offline: 'true',
    npm_config_audit: 'false',
    npm_config_fund: 'false',
    NODE_OPTIONS: '',
  };
  await writeFile(env.npm_config_userconfig, '');
  await writeFile(env.npm_config_globalconfig, '');
  const npm = (args) => run(process.execPath, [npmCli, ...args], { cwd: source, env });
  const build = (args = []) =>
    run(process.execPath, [...args, 'scripts/build.mjs'], { cwd: source, env });

  await t.test(
    'installs and runs bundled CLI, helper and client without npm runtime dependencies',
    async () => {
      const output = (await npm(['pack', '--json'])).stdout;
      const [packed] = JSON.parse(output.slice(output.indexOf('[\n')));
      const files = packed.files.map((file) => file.path).sort();
      assert.deepEqual(files, [
        'LICENSE',
        'README.md',
        'dist/THIRD_PARTY_NOTICES.txt',
        'dist/cli.js',
        'dist/client.js',
        'dist/extension/manifest.json',
        'dist/extension/options.html',
        'dist/extension/options.js',
        'dist/extension/popup.html',
        'dist/extension/popup.js',
        'dist/extension/service-worker.js',
        'dist/helper.js',
        'package.json',
        'skills/cobrowser/SKILL.md',
      ]);
      assert.equal(packed.files.find((file) => file.path === 'dist/cli.js').mode & 0o111, 0o111);
      const prefix = path.join(directory, 'prefix');
      await npm([
        'install',
        '--global',
        '--prefix',
        prefix,
        '--ignore-scripts',
        path.join(source, packed.filename),
      ]);
      const notices = await readFile(
        path.join(prefix, 'lib/node_modules/cobrowser/dist/THIRD_PARTY_NOTICES.txt'),
        'utf8',
      );
      for (const [dependency, license] of [
        ['@mozilla/readability', 'LICENSE.md'],
        ['linkedom', 'LICENSE'],
        ['turndown', 'LICENSE'],
        ['turndown-plugin-gfm', 'LICENSE'],
        ['@mixmark-io/domino', 'LICENSE'],
        ['css-select', 'LICENSE'],
        ['cssom', 'LICENSE.txt'],
        ['htmlparser2', 'LICENSE'],
        ['htmlparser2/node_modules/entities', 'LICENSE'],
        ['htmlparser2/node_modules/dom-serializer/node_modules/entities', 'LICENSE'],
        ['uhyphen', 'LICENSE'],
      ]) {
        const directory = path.join(root, 'node_modules', dependency);
        const metadata = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'));
        assert.ok(notices.includes(`${metadata.name}@${metadata.version}\n`), dependency);
        assert.ok(
          notices.includes(await readFile(path.join(directory, license), 'utf8')),
          `${dependency}/${license} must be preserved verbatim.`,
        );
      }
      for (const developmentTool of ['esbuild', 'prettier', 'vitest', '@playwright/test']) {
        const metadata = JSON.parse(
          await readFile(path.join(root, 'node_modules', developmentTool, 'package.json'), 'utf8'),
        );
        assert.equal(notices.includes(`${metadata.name}@${metadata.version}\n`), false);
      }
      assert.equal(notices.includes(root), false);
      assert.equal(notices.includes(directory), false);
      await build();
      assert.equal(
        await readFile(path.join(source, 'dist/THIRD_PARTY_NOTICES.txt'), 'utf8'),
        notices,
      );
      await rm(path.join(source, 'node_modules'));
      try {
        await smokeRuntime(directory, prefix, metadata.version, env);
      } finally {
        await symlink(path.join(root, 'node_modules'), path.join(source, 'node_modules'));
      }
    },
  );

  await t.test('keeps a working build when a source asset is missing', async () => {
    const cli = path.join(source, 'dist/cli.js');
    const previous = await readFile(cli);
    const asset = path.join(source, 'src/extension/popup.html');
    const contents = await readFile(asset);
    await rm(asset);
    try {
      await assert.rejects(build(), /popup\.html/);
      assert.deepEqual(await readFile(cli), previous);
      assert.equal((await run(runtimeNode, [cli, '--version'])).stdout.trim(), metadata.version);
      assert.equal(
        (await readdir(source)).some((name) => name.startsWith('.cobrowser-dist-')),
        false,
      );
    } finally {
      await writeFile(asset, contents);
    }
  });

  const fault = path.join(directory, 'rename-failure.mjs');
  await writeFile(
    fault,
    `import fs from 'node:fs';
     import fsp from 'node:fs/promises';
     import { syncBuiltinESMExports } from 'node:module';
     import path from 'node:path';
     const rename = fsp.rename;
     const renameSync = fs.renameSync;
     const denied = () => Object.assign(new Error('Injected rename failure'), { code: 'EACCES' });
     fsp.rename = async (from, to) => {
       const name = path.basename(from);
       if (path.basename(to) === 'dist' && name.startsWith('.cobrowser-dist-') &&
           (process.env.COBROWSER_TEST_ROLLBACK_FAILURE === '1' || !name.includes('previous')))
         throw denied();
       return rename(from, to);
     };
     fs.renameSync = (from, to) => {
       if (process.env.COBROWSER_TEST_ROLLBACK_FAILURE === '1' &&
           path.basename(from).startsWith('.cobrowser-dist-previous-')) throw denied();
       return renameSync(from, to);
     };
     syncBuiltinESMExports();\n`,
  );

  await t.test('restores the working build when installing its replacement fails', async () => {
    const cli = path.join(source, 'dist/cli.js');
    const previous = await readFile(cli);
    await assert.rejects(build(['--import', fault]), /Injected rename failure/);
    assert.deepEqual(await readFile(cli), previous);
    assert.equal((await run(runtimeNode, [cli, '--version'])).stdout.trim(), metadata.version);
    assert.equal(
      (await readdir(source)).some((name) => name.startsWith('.cobrowser-dist-')),
      false,
    );
  });

  await t.test(
    'retains a usable backup and reports its path when restoration also fails',
    async () => {
      const previous = await readFile(path.join(source, 'dist/cli.js'));
      await assert.rejects(
        run(process.execPath, ['--import', fault, 'scripts/build.mjs'], {
          cwd: source,
          env: { ...env, COBROWSER_TEST_ROLLBACK_FAILURE: '1' },
        }),
        (error) => {
          assert.match(error.stderr, /The previous build is at/);
          return true;
        },
      );
      const backups = (await readdir(source)).filter((name) => name.startsWith('.cobrowser-dist-'));
      assert.equal(backups.length, 1);
      assert.match(backups[0], /^\.cobrowser-dist-previous-/);
      const cli = path.join(source, backups[0], 'cli.js');
      assert.deepEqual(await readFile(cli), previous);
      assert.equal((await run(runtimeNode, [cli, '--version'])).stdout.trim(), metadata.version);
    },
  );
});
