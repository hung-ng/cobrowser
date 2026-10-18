import { build } from 'esbuild';
import { existsSync, renameSync, rmSync } from 'node:fs';
import { chmod, mkdir, cp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const dist = path.join(root, 'dist');
const staging = path.join(root, `.cobrowser-dist-${process.pid}`);
const previous = path.join(root, `.cobrowser-dist-previous-${process.pid}`);
const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
process.once('exit', () => {
  rmSync(staging, { recursive: true, force: true });
  if (!existsSync(dist) && existsSync(previous)) {
    try {
      renameSync(previous, dist);
    } catch {
      /* A failed build must not hide a previous working output. */
    }
  }
  rmSync(previous, { recursive: true, force: true });
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
  define: { COBROWSER_VERSION: JSON.stringify(packageJson.version) },
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
  permissions: ['tabs', 'scripting', 'nativeMessaging', 'storage', 'alarms'],
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

let hadPrevious = false;
try {
  await rename(dist, previous);
  hadPrevious = true;
} catch (error) {
  if (!error || typeof error !== 'object' || error.code !== 'ENOENT') throw error;
}
try {
  await rename(staging, dist);
} catch (error) {
  if (hadPrevious) await rename(previous, dist).catch(() => undefined);
  throw error;
}
await rm(previous, { recursive: true, force: true });
