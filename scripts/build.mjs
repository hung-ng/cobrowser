import { build as esbuild } from 'esbuild';
import { existsSync, renameSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { chmod, mkdir, cp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const dist = path.join(root, 'dist');
const staging = path.join(root, `.cobrowser-dist-${process.pid}`);
const previous = path.join(root, `.cobrowser-dist-previous-${process.pid}`);
const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const bundledInputs = new Set();
const extensionRevisionPlaceholder = '__COBROWSER_EXTENSION_REVISION__';

async function build(options) {
  const result = await esbuild({ ...options, absWorkingDir: root, metafile: true });
  for (const output of Object.values(result.metafile.outputs))
    for (const [input, details] of Object.entries(output.inputs))
      if (details.bytesInOutput > 0) bundledInputs.add(path.resolve(root, input));
}

async function writeThirdPartyNotices() {
  const packages = new Set();
  const marker = `${path.sep}node_modules${path.sep}`;
  for (const input of bundledInputs) {
    const index = input.lastIndexOf(marker);
    if (index < 0) continue;
    const parts = input.slice(index + marker.length).split(path.sep);
    const nameLength = parts[0].startsWith('@') ? 2 : 1;
    packages.add(path.join(input.slice(0, index + marker.length), ...parts.slice(0, nameLength)));
  }
  const notices = new Set();
  for (const directory of packages) {
    const metadata = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'));
    const name = `${metadata.name}@${metadata.version}`;
    const files = (await readdir(directory, { withFileTypes: true }))
      .filter(
        (entry) =>
          entry.isFile() &&
          /^(?:licen[cs]es?|notices?|copying|copyright)(?:[._-].*)?$/i.test(entry.name),
      )
      .map((entry) => entry.name)
      .sort();
    if (!files.length)
      throw new Error(
        `${name} has no installed license or notice file; restore its source notices and build again.`,
      );
    const texts = [];
    for (const file of files)
      texts.push(`File: ${file}\n\n${await readFile(path.join(directory, file), 'utf8')}`);
    notices.add(`${name}\n${'='.repeat(72)}\n\n${texts.join('\n\n')}`);
  }
  await writeFile(
    path.join(staging, 'THIRD_PARTY_NOTICES.txt'),
    `Third-party notices\n\nLicense and notice files from packages included in the bundles.\n\n${[...notices].sort().join('\n\n')}\n`,
  );
}

let installed = false;
process.once('exit', () => {
  try {
    rmSync(staging, { recursive: true, force: true });
  } catch {
    /* Cleanup must not prevent recovery of the previous build. */
  }
  if (!installed && existsSync(previous)) {
    try {
      renameSync(previous, dist);
    } catch {
      process.stderr.write(
        `The previous build is at ${previous}; restore it to dist before trying again.\n`,
      );
    }
    return;
  }
  try {
    rmSync(previous, { recursive: true, force: true });
  } catch {
    /* A leftover backup must not break a working build. */
  }
});
await rm(staging, { recursive: true, force: true });
await rm(previous, { recursive: true, force: true }).catch(() => undefined);
await mkdir(path.join(staging, 'extension'), { recursive: true });
const common = {
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  sourcemap: false,
  logLevel: 'warning',
  define: { COBROWSER_VERSION: JSON.stringify(packageJson.version) },
};
await build({
  ...common,
  entryPoints: [path.join(root, 'src/cli.ts')],
  outfile: path.join(staging, 'cli.js'),
  banner: { js: '#!/usr/bin/env node' },
});
await build({
  ...common,
  entryPoints: [path.join(root, 'src/helper.ts')],
  outfile: path.join(staging, 'helper.js'),
});
await build({
  ...common,
  entryPoints: [path.join(root, 'src/client.ts')],
  outfile: path.join(staging, 'client.js'),
});
await chmod(path.join(staging, 'cli.js'), 0o755);
await build({
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2022',
  entryPoints: [path.join(root, 'src/extension/service-worker.ts')],
  outfile: path.join(staging, 'extension/service-worker.js'),
  define: {
    COBROWSER_VERSION: JSON.stringify(packageJson.version),
    COBROWSER_EXTENSION_REVISION: JSON.stringify(extensionRevisionPlaceholder),
  },
});
await build({
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2022',
  entryPoints: [path.join(root, 'src/extension/popup.ts')],
  outfile: path.join(staging, 'extension/popup.js'),
  define: { COBROWSER_VERSION: JSON.stringify(packageJson.version) },
});
await build({
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2022',
  entryPoints: [path.join(root, 'src/extension/options.ts')],
  outfile: path.join(staging, 'extension/options.js'),
  define: { COBROWSER_VERSION: JSON.stringify(packageJson.version) },
});
await cp(path.join(root, 'src/extension/popup.html'), path.join(staging, 'extension/popup.html'));
await cp(
  path.join(root, 'src/extension/options.html'),
  path.join(staging, 'extension/options.html'),
);
const manifest = {
  manifest_version: 3,
  name: 'cobrowser',
  version: packageJson.version,
  description: 'Read browser tabs without changing what you see.',
  permissions: ['tabs', 'scripting', 'nativeMessaging', 'storage', 'alarms', 'webRequest'],
  host_permissions: ['<all_urls>'],
  incognito: 'not_allowed',
  background: { service_worker: 'service-worker.js' },
  action: { default_popup: 'popup.html' },
  options_page: 'options.html',
  key: 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAqJWdWibzQIzXo5xcHmV8EbYE9e3c59mkXh1kMTp1p9AEqoQKoHKdD5mlsdTrGYsDNHEpd0CVD5t4TK09AsygqOxJwIuSDp1AdsbIMB674jgqbfYUZZaQ/dIBbQDcQOdOUqtHguDng4Gscxp5nSeVlIlx1xkrlGVwIrE5cKPM/RmRSDLSg7+eYl2tVkd+EUqiyElg54E7aLHTt8eer+SxicTYVVfF/cqwuhG+wQlWdXI+zy6PUWOzFEiqNkxEEvITBGKHvWbt6Y+4EXm7h9t9y8gxtneRd68U3g9zjseusSYy7nABRFNwWKusbBzm9lNCNlz0LG9EfNs3iJRGTxaZNwIDAQAB',
};
await writeFile(
  path.join(staging, 'extension/manifest.json'),
  `${JSON.stringify(manifest, null, 2)}\n`,
);
const extensionDirectory = path.join(staging, 'extension');
const extensionHash = createHash('sha256');
for (const name of (await readdir(extensionDirectory)).sort()) {
  const contents = await readFile(path.join(extensionDirectory, name));
  extensionHash.update(`${name}\0${contents.length}\0`).update(contents);
}
const extensionRevision = extensionHash.digest('hex');
const workerPath = path.join(extensionDirectory, 'service-worker.js');
const worker = await readFile(workerPath, 'utf8');
if (!worker.includes(extensionRevisionPlaceholder))
  throw new Error(
    'The extension build has no revision marker; restore the worker source and build again.',
  );
await writeFile(
  workerPath,
  `// cobrowser-extension-build: ${extensionRevision}\n${worker.replaceAll(extensionRevisionPlaceholder, extensionRevision)}`,
);
await writeThirdPartyNotices();

let hadPrevious = false;
try {
  await rename(dist, previous);
  hadPrevious = true;
} catch (error) {
  if (!error || typeof error !== 'object' || error.code !== 'ENOENT') throw error;
}
try {
  await rename(staging, dist);
  installed = true;
} catch (error) {
  if (hadPrevious) await rename(previous, dist).catch(() => undefined);
  throw error;
}
await rm(previous, { recursive: true, force: true });
