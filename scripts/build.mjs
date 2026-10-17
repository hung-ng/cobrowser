import { build } from 'esbuild';
import { mkdir, cp, writeFile } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(new URL('..', import.meta.url).pathname);
const dist = path.join(root, 'dist');
await mkdir(path.join(dist, 'extension'), { recursive: true });
const common = {
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  sourcemap: false,
  logLevel: 'warning',
};
await build({
  ...common,
  entryPoints: [path.join(root, 'src/cli.ts')],
  outfile: path.join(dist, 'cli.js'),
  banner: { js: '#!/usr/bin/env node' },
});
await build({
  ...common,
  entryPoints: [path.join(root, 'src/helper.ts')],
  outfile: path.join(dist, 'helper.js'),
});
await build({
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2022',
  entryPoints: [path.join(root, 'src/extension/service-worker.ts')],
  outfile: path.join(dist, 'extension/service-worker.js'),
});
await build({
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2022',
  entryPoints: [path.join(root, 'src/extension/popup.ts')],
  outfile: path.join(dist, 'extension/popup.js'),
});
await build({
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2022',
  entryPoints: [path.join(root, 'src/extension/options.ts')],
  outfile: path.join(dist, 'extension/options.js'),
});
await cp(path.join(root, 'src/extension/popup.html'), path.join(dist, 'extension/popup.html'));
await cp(path.join(root, 'src/extension/options.html'), path.join(dist, 'extension/options.html'));
const manifest = {
  manifest_version: 3,
  name: 'cobrowser',
  version: '0.1.0',
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
  path.join(dist, 'extension/manifest.json'),
  `${JSON.stringify(manifest, null, 2)}\n`,
);
