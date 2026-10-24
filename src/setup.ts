import { execFile } from 'node:child_process';
import fsp from 'node:fs/promises';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  inspectAgentRegistration,
  updateAgentRegistration,
  type AgentCommand,
} from './agent-registration.js';
import { readResponseBody } from './client.js';
import { InstallTransaction, physicalPath } from './install-transaction.js';
import { SETUP_LOCK_NAME, withSetupLock } from './setup-lock.js';
import { EXTENSION_ID, PROTOCOL_VERSION, PUBLIC_KEY, VERSION } from './shared/constants.js';
import { extensionBuildRevision } from './shared/extension-build.js';

const SKILL_MARKER = '.cobrowser-managed';
const SKILL_MARKER_CONTENT = 'cobrowser\n';
export const SUPPORTED_BROWSERS = [
  'arc',
  'chrome',
  'chromium',
  'brave',
  'edge',
  'vivaldi',
] as const;
export type SupportedBrowser = (typeof SUPPORTED_BROWSERS)[number];

interface NativeHostRecord {
  browser: string;
  directory: string;
}

export function isSimpleBrowserName(value: string): boolean {
  return /^[a-z0-9][a-z0-9._-]*$/i.test(value);
}

function userHome(): string {
  return path.resolve(process.env.HOME || os.homedir());
}

export function browserHostDirectory(
  browser: SupportedBrowser,
  homeDirectory = userHome(),
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform === 'darwin') {
    if (browser === 'arc')
      return path.join(
        homeDirectory,
        'Library/Application Support/Arc/User Data/NativeMessagingHosts',
      );
    const appDir = {
      chrome: 'Google/Chrome',
      chromium: 'Chromium',
      brave: 'BraveSoftware/Brave-Browser',
      edge: 'Microsoft Edge',
      vivaldi: 'Vivaldi',
    }[browser as Exclude<SupportedBrowser, 'arc'>];
    return path.join(homeDirectory, `Library/Application Support/${appDir}/NativeMessagingHosts`);
  }
  if (browser === 'arc') return path.join(homeDirectory, '.config/arc/NativeMessagingHosts');
  const configDir = {
    chrome: 'google-chrome',
    chromium: 'chromium',
    brave: 'BraveSoftware/Brave-Browser',
    edge: 'microsoft-edge',
    vivaldi: 'vivaldi',
  }[browser as Exclude<SupportedBrowser, 'arc'>];
  return path.join(homeDirectory, `.config/${configDir}/NativeMessagingHosts`);
}

export function detectBrowsers(): SupportedBrowser[] {
  const candidates = SUPPORTED_BROWSERS.filter((browser) => {
    if (process.platform === 'darwin') {
      const application =
        browser === 'arc'
          ? '/Applications/Arc.app'
          : browser === 'chrome'
            ? '/Applications/Google Chrome.app'
            : browser === 'chromium'
              ? '/Applications/Chromium.app'
              : browser === 'brave'
                ? '/Applications/Brave Browser.app'
                : browser === 'edge'
                  ? '/Applications/Microsoft Edge.app'
                  : '/Applications/Vivaldi.app';
      return fs.existsSync(application) || fs.existsSync(browserHostDirectory(browser));
    }
    if (browser === 'arc') return false;
    const executableNames = {
      chrome: ['google-chrome', 'google-chrome-stable', 'chrome'],
      chromium: ['chromium', 'chromium-browser'],
      brave: ['brave', 'brave-browser'],
      edge: ['microsoft-edge', 'microsoft-edge-stable'],
      vivaldi: ['vivaldi'],
    }[browser as Exclude<SupportedBrowser, 'arc'>];
    return fs.existsSync(browserHostDirectory(browser)) || commandExists(executableNames);
  });
  return candidates.length ? candidates : process.platform === 'darwin' ? ['arc'] : ['chromium'];
}

function home(): string {
  return path.resolve(process.env.COBROWSER_HOME || path.join(userHome(), '.cobrowser'));
}
function setupConfigPath(root: string): string {
  return path.join(root, 'config.json');
}

export function isCobrowserSkill(file: string): boolean {
  try {
    const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(
      fs.readFileSync(file, 'utf8'),
    )?.[1];
    return Boolean(frontmatter?.split(/\r?\n/).some((line) => line.trim() === 'name: cobrowser'));
  } catch {
    return false;
  }
}

function configuredNativeHostBrowsers(root: string): Set<string> {
  try {
    const parsed = JSON.parse(fs.readFileSync(setupConfigPath(root), 'utf8')) as {
      nativeHosts?: unknown;
      configuredBrowsers?: unknown;
    };
    const configured = new Set<string>();
    if (Array.isArray(parsed.configuredBrowsers))
      for (const browser of parsed.configuredBrowsers)
        if (typeof browser === 'string' && isSimpleBrowserName(browser))
          configured.add(browser.toLowerCase());
    if (!Array.isArray(parsed.nativeHosts)) return configured;
    for (const browser of parsed.nativeHosts.flatMap((value) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
      const browser = (value as { browser?: unknown }).browser;
      if (typeof browser !== 'string' || !isSimpleBrowserName(browser)) return [];
      const normalizedBrowser = browser.toLowerCase();
      if (!(SUPPORTED_BROWSERS as readonly string[]).includes(normalizedBrowser))
        return [normalizedBrowser];
      // Setup records built-in defaults too, so a custom directory identifies an explicit install.
      const directory = (value as { directory?: unknown }).directory;
      return typeof directory === 'string' &&
        path.resolve(directory) !== browserHostDirectory(normalizedBrowser as SupportedBrowser)
        ? [normalizedBrowser]
        : [];
    }))
      configured.add(browser);
    return configured;
  } catch {
    return new Set();
  }
}

async function writeFileAtomic(file: string, data: string, mode: number) {
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    await fsp.writeFile(temporary, data, { mode });
    await fsp.chmod(temporary, mode);
    await fsp.rename(temporary, file);
  } finally {
    await fsp.rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function replaceDirectory(source: string, target: string) {
  const previous = `${target}.previous-${process.pid}`;
  await fsp.rm(previous, { recursive: true, force: true });
  let hadTarget = false;
  try {
    await fsp.rename(target, previous);
    hadTarget = true;
  } catch (error) {
    if (!error || typeof error !== 'object' || (error as NodeJS.ErrnoException).code !== 'ENOENT')
      throw error;
  }
  try {
    await fsp.rename(source, target);
  } catch (error) {
    if (hadTarget) await fsp.rename(previous, target).catch(() => undefined);
    throw error;
  }
  await fsp.rm(previous, { recursive: true, force: true });
}

function nativeHostRecords(root: string): NativeHostRecord[] {
  const records = new Map<string, NativeHostRecord>();
  try {
    const parsed = JSON.parse(fs.readFileSync(setupConfigPath(root), 'utf8')) as {
      nativeHosts?: unknown;
    };
    if (Array.isArray(parsed.nativeHosts))
      for (const value of parsed.nativeHosts) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
        const browser = (value as { browser?: unknown }).browser;
        const directory = (value as { directory?: unknown }).directory;
        if (
          typeof browser === 'string' &&
          isSimpleBrowserName(browser) &&
          typeof directory === 'string' &&
          path.isAbsolute(directory)
        )
          records.set(browser.toLowerCase(), {
            browser: browser.toLowerCase(),
            directory,
          });
      }
  } catch {
    /* A missing or malformed config falls back to built-in browser paths. */
  }
  for (const browser of SUPPORTED_BROWSERS)
    if (!records.has(browser))
      records.set(browser, { browser, directory: browserHostDirectory(browser) });
  return [...records.values()];
}

function nativeHostConfig(records: NativeHostRecord[], configuredBrowsers: Set<string>): string {
  return `${JSON.stringify(
    { version: 1, nativeHosts: records, configuredBrowsers: [...configuredBrowsers].sort() },
    null,
    2,
  )}\n`;
}

function commandExists(names: string[]): boolean {
  const pathValue = process.env.PATH || '';
  return names.some((name) =>
    pathValue.split(path.delimiter).some((directory) => {
      try {
        return Boolean(directory) && (fs.statSync(path.join(directory, name)).mode & 0o111) !== 0;
      } catch {
        return false;
      }
    }),
  );
}
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
export function launcherScript(
  runtime: string,
  browser: string,
  nodePath = process.execPath,
): string {
  const root = path.dirname(path.dirname(runtime));
  return `#!/bin/sh\nexport COBROWSER_HOME=${shellQuote(root)}\nexec ${shellQuote(nodePath)} ${shellQuote(path.join(runtime, 'helper.js'))} --browser ${shellQuote(browser)}\n`;
}

export function launcherNodePath(
  value: unknown,
  runtime: string,
  browser: string,
): string | undefined {
  if (typeof value !== 'string') return undefined;
  const root = path.dirname(path.dirname(runtime));
  const helper = `${shellQuote(path.join(runtime, 'helper.js'))} --browser ${shellQuote(browser)}`;
  const lines = value.split('\n');
  if (lines.length !== 4 || lines[3] !== '') return undefined;
  const execLine = lines[2];
  const prefix = 'exec ';
  const suffix = ` ${helper}`;
  if (!execLine.startsWith(prefix) || !execLine.endsWith(suffix)) return undefined;
  const nodePath = execLine.slice(prefix.length, execLine.length - suffix.length);
  if (
    lines[0] !== '#!/bin/sh' ||
    lines[1] !== `export COBROWSER_HOME=${shellQuote(root)}` ||
    !/^'(?:[^']|'\\'')+'$/.test(nodePath)
  )
    return undefined;
  const decoded = nodePath.slice(1, -1).replaceAll("'\\''", "'");
  return path.isAbsolute(decoded) ? decoded : undefined;
}

export function isLauncherScript(value: unknown, runtime: string, browser: string): boolean {
  return launcherNodePath(value, runtime, browser) !== undefined;
}

export function nativeHostManifest(launcher: string) {
  return {
    name: 'cobrowser',
    description: 'cobrowser helper',
    path: launcher,
    type: 'stdio',
    allowed_origins: [`chrome-extension://${EXTENSION_ID}/`],
  };
}

export function isNativeHostManifest(value: unknown, launcher: string): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const manifest = value as {
    name?: unknown;
    type?: unknown;
    path?: unknown;
    allowed_origins?: unknown;
  };
  return (
    manifest.name === 'cobrowser' &&
    manifest.type === 'stdio' &&
    manifest.path === launcher &&
    Array.isArray(manifest.allowed_origins) &&
    manifest.allowed_origins.length === 1 &&
    manifest.allowed_origins[0] === `chrome-extension://${EXTENSION_ID}/`
  );
}
function sourceDist(): string {
  return path.dirname(fileURLToPath(import.meta.url));
}

async function validateBuildFiles(directory: string, files: string[]): Promise<void> {
  for (const file of files) {
    const target = path.join(directory, file);
    try {
      const stat = await fsp.stat(target);
      if (!stat.isFile() || stat.size === 0) throw new Error('Missing build asset.');
    } catch {
      throw new Error(
        `The cobrowser build is missing ${file}; reinstall cobrowser and run setup again.`,
      );
    }
    try {
      await fsp.access(target, fs.constants.R_OK);
    } catch {
      throw new Error(
        `The cobrowser build cannot read ${file}; check its permissions and run setup again.`,
      );
    }
  }
}

async function validateSourceBuild(directory: string): Promise<void> {
  await validateBuildFiles(directory, ['cli.js', 'client.js', 'helper.js']);
  await validateExtensionBuild(path.join(directory, 'extension'));
}

function validExtensionManifest(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const manifest = value as Record<string, any>;
  const permissions = ['tabs', 'scripting', 'nativeMessaging', 'storage', 'alarms', 'webRequest'];
  const sameStrings = (values: unknown, expected: string[]) =>
    Array.isArray(values) &&
    values.length === expected.length &&
    new Set(values).size === values.length &&
    values.every((item) => typeof item === 'string' && expected.includes(item));
  return (
    manifest.manifest_version === 3 &&
    manifest.name === 'cobrowser' &&
    manifest.version === VERSION &&
    manifest.key === PUBLIC_KEY &&
    manifest.incognito === 'not_allowed' &&
    sameStrings(manifest.permissions, permissions) &&
    sameStrings(manifest.host_permissions, ['<all_urls>']) &&
    (manifest.optional_permissions === undefined ||
      sameStrings(manifest.optional_permissions, [])) &&
    (manifest.optional_host_permissions === undefined ||
      sameStrings(manifest.optional_host_permissions, [])) &&
    manifest.background?.service_worker === 'service-worker.js' &&
    Object.keys(manifest.background).every((key) => key === 'service_worker') &&
    manifest.action?.default_popup === 'popup.html' &&
    manifest.options_page === 'options.html'
  );
}

async function validateExtensionBuild(directory: string): Promise<void> {
  await validateBuildFiles(directory, [
    'manifest.json',
    'service-worker.js',
    'popup.html',
    'popup.js',
    'options.html',
    'options.js',
  ]);
  try {
    const manifest = JSON.parse(await fsp.readFile(path.join(directory, 'manifest.json'), 'utf8'));
    if (!validExtensionManifest(manifest)) throw new Error('Invalid extension build.');
  } catch {
    throw new Error(
      'The cobrowser extension build is invalid; reinstall cobrowser and run setup again.',
    );
  }
}

async function sameDirectoryFiles(first: string, second: string): Promise<boolean> {
  try {
    const previous = await fsp.readdir(first, { withFileTypes: true });
    const current = await fsp.readdir(second, { withFileTypes: true });
    if (previous.length !== current.length) return false;
    const entries = new Map(previous.map((entry) => [entry.name, entry]));
    for (const entry of current) {
      const existing = entries.get(entry.name);
      if (!existing) return false;
      const left = path.join(first, entry.name);
      const right = path.join(second, entry.name);
      if (entry.isDirectory() && existing.isDirectory()) {
        if (!(await sameDirectoryFiles(left, right))) return false;
      } else if (entry.isFile() && existing.isFile()) {
        if (!(await fsp.readFile(left)).equals(await fsp.readFile(right))) return false;
      } else return false;
    }
    return true;
  } catch {
    return false;
  }
}

async function validateNativeHostDirectories(
  root: string,
  records: NativeHostRecord[],
): Promise<void> {
  const directories = new Map<string, string>();
  const lock = path.join(await physicalPath(root), SETUP_LOCK_NAME);
  for (const { browser, directory } of records) {
    let physical: string;
    try {
      const existing = await fsp.stat(directory).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
        return undefined;
      });
      if (existing && !existing.isDirectory()) throw new Error('Not a directory.');
      physical = await physicalPath(directory);
    } catch {
      throw new Error(
        `Could not prepare the ${browser} native-host directory at ${directory}; choose a writable directory and run setup again.`,
      );
    }
    if (physical === lock || physical.startsWith(`${lock}${path.sep}`))
      throw new Error(
        `The ${browser} native-host directory overlaps the setup lock; choose a directory outside ${lock} and run setup again.`,
      );
    const otherBrowser = directories.get(physical);
    if (otherBrowser)
      throw new Error(
        `The ${browser} and ${otherBrowser} native-host directories are the same; choose a separate directory for each browser and run setup again.`,
      );
    directories.set(physical, browser);
  }
}

export async function setup(
  browsers: string[],
  options: { nativeHostsDir?: string } = {},
): Promise<string[]> {
  browsers = [...new Set(browsers.map((browser) => browser.trim().toLowerCase()))];
  if (!browsers.length) throw new Error('Choose at least one browser.');
  const invalid = browsers.filter((browser) => !isSimpleBrowserName(browser));
  if (invalid.length) throw new Error(`Use simple browser names: ${invalid.join(', ')}.`);
  if (options.nativeHostsDir && browsers.length !== 1)
    throw new Error('Use --native-hosts-dir with one browser.');
  const root = home();
  return withSetupLock(root, () => installSetup(root, browsers, options));
}

async function installSetup(
  root: string,
  browsers: string[],
  options: { nativeHostsDir?: string },
): Promise<string[]> {
  const savedHosts = nativeHostRecords(root);
  const directories = new Map(savedHosts.map((record) => [record.browser, record.directory]));
  const unsupported = browsers.filter((browser) => !directories.has(browser));
  if (unsupported.length && !options.nativeHostsDir)
    throw Object.assign(
      new Error(`Use --native-hosts-dir to configure ${unsupported.join(', ')}.`),
      { code: 'BAD_REQUEST' },
    );
  if (process.platform !== 'darwin' && browsers.includes('arc'))
    throw new Error('Arc setup is supported only on macOS.');
  const nativeHostsDir = options.nativeHostsDir ? path.resolve(options.nativeHostsDir) : undefined;
  const requestedBrowsers = new Set(browsers);
  const configuredBrowsers = configuredNativeHostBrowsers(root);
  for (const browser of browsers) configuredBrowsers.add(browser);
  // All configured browsers load the same extension folder, so their helpers must upgrade together.
  browsers = [
    ...new Set(
      [...browsers, ...configuredBrowsers].filter(
        (browser) =>
          (requestedBrowsers.has(browser) || directories.has(browser)) &&
          (browser !== 'arc' || process.platform === 'darwin'),
      ),
    ),
  ];
  const longSocket = browsers.find(
    (browser) => Buffer.byteLength(path.join(root, 'run', `${browser}.sock`), 'utf8') >= 104,
  );
  if (longSocket)
    throw new Error(
      'The cobrowser home path is too long for a Unix socket. Set COBROWSER_HOME to a shorter path and try again.',
    );
  const runtimeRoot = path.join(root, 'runtime');
  const runtime = path.join(runtimeRoot, VERSION);
  const extension = path.join(root, 'extension');
  const nativeHosts = browsers.map((browser) => ({
    browser,
    directory:
      nativeHostsDir && requestedBrowsers.has(browser) ? nativeHostsDir : directories.get(browser)!,
  }));
  await validateSourceBuild(sourceDist());
  await validateNativeHostDirectories(root, nativeHosts);
  const mergedNativeHosts = new Map(savedHosts.map((record) => [record.browser, record] as const));
  for (const record of nativeHosts) mergedNativeHosts.set(record.browser, record);
  const config = setupConfigPath(root);
  const transaction = new InstallTransaction(root, [
    { path: runtime, kind: 'directory' },
    { path: extension, kind: 'directory' },
    ...nativeHosts.flatMap(({ browser, directory }) => [
      { path: path.join(root, 'hosts', browser), kind: 'file' as const },
      { path: path.join(directory, 'cobrowser.json'), kind: 'file' as const },
    ]),
    { path: config, kind: 'file' },
  ]);
  const messages: string[] = [];
  let reloadExtension = true;
  try {
    await transaction.prepare();
    const runtimeStaging = transaction.staged(runtime);
    try {
      await fsp.cp(sourceDist(), runtimeStaging, { recursive: true, force: true });
      await writeFileAtomic(
        path.join(runtimeStaging, 'package.json'),
        `${JSON.stringify({ private: true, type: 'module', version: VERSION })}\n`,
        0o600,
      );
      const sourceSkills = path.join(sourceDist(), '..', 'skills');
      if (fs.existsSync(sourceSkills))
        await fsp.cp(sourceSkills, path.join(runtimeStaging, 'skills'), {
          recursive: true,
          force: true,
        });
      await fsp.cp(path.join(runtimeStaging, 'extension'), transaction.staged(extension), {
        recursive: true,
        force: true,
      });
      for (const { browser, directory } of nativeHosts) {
        const launcher = path.join(root, 'hosts', browser);
        await writeFileAtomic(
          transaction.staged(launcher),
          launcherScript(runtime, browser),
          0o755,
        );
        await writeFileAtomic(
          transaction.staged(path.join(directory, 'cobrowser.json')),
          `${JSON.stringify(nativeHostManifest(launcher), null, 2)}\n`,
          0o644,
        );
      }
      await writeFileAtomic(
        transaction.staged(config),
        nativeHostConfig([...mergedNativeHosts.values()], configuredBrowsers),
        0o600,
      );
    } catch {
      throw new Error(
        'Could not prepare the cobrowser installation; check the source build and directory permissions, then run setup again.',
      );
    }
    await validateSourceBuild(runtimeStaging);
    await validateExtensionBuild(transaction.staged(extension));
    await validateNativeHostDirectories(root, nativeHosts);
    // A helper restart can keep open options and popup tabs when the worker files match.
    reloadExtension = !(await sameDirectoryFiles(extension, transaction.staged(extension)));
    await transaction.commit();
  } finally {
    messages.push(...(await transaction.cleanup()));
  }
  await fsp.chmod(root, 0o700).catch(() => undefined);
  messages.unshift(`runtime installed at ${runtime}`);
  await installSkill(messages);
  for (const browser of browsers) messages.push(`${browser} native host installed`);
  const revision = extensionBuildRevision(extension);
  for (const browser of browsers) {
    const status = !reloadExtension && revision ? await helperStatus(root, browser) : undefined;
    const needsReload =
      reloadExtension || !status?.connected || status.extensionRevision !== revision;
    if (await restartHelper(root, browser, needsReload))
      messages.push(`${browser} helper restart requested`);
  }
  await registerMcp('claude', runtime, messages);
  await registerMcp('codex', runtime, messages);
  messages.push(
    `MCP config for other clients:\n${JSON.stringify(
      {
        mcpServers: {
          cobrowser: {
            command: process.execPath,
            args: [path.join(runtime, 'cli.js'), 'mcp'],
            env: { COBROWSER_HOME: root },
          },
        },
      },
      null,
      2,
    )}`,
  );
  if (process.platform === 'darwin' && (await copyToClipboard(extension)))
    messages.push(`extension path copied to the clipboard: ${extension}`);
  messages.push(
    `load the extension once from ${extension}: open the browser extensions page, turn on Developer mode, choose Load unpacked, paste the path, and pin cobrowser`,
  );
  return messages;
}

async function copyToClipboard(value: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = execFile('pbcopy', [], { timeout: 2_000 }, (error) => resolve(!error));
    child.once('error', () => resolve(false));
    child.stdin?.end(`${value}\n`);
  });
}

async function restartHelper(
  root: string,
  browser: string,
  reloadExtension: boolean,
): Promise<boolean> {
  const socketPath = path.join(root, 'run', `${browser}.sock`);
  if (!fs.existsSync(socketPath)) return false;
  return new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(value);
    };
    const request = http.request(
      { socketPath, path: '/v1/restart', method: 'POST' },
      (response) => {
        response.resume();
        response.once('end', () => finish(response.statusCode === 200));
        response.once('aborted', () => finish(false));
        response.once('error', () => finish(false));
      },
    );
    timer = setTimeout(() => {
      request.destroy();
      finish(false);
    }, 2_000);
    request.once('error', () => finish(false));
    request.end(JSON.stringify({ reloadExtension }));
  });
}

async function helperStatus(
  root: string,
  browser: string,
): Promise<
  | {
      connected: boolean;
      version?: string;
      protocol?: number;
      extensionRevision?: string;
    }
  | undefined
> {
  const socketPath = path.join(root, 'run', `${browser}.sock`);
  if (!fs.existsSync(socketPath)) return undefined;
  return new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (
      value:
        | {
            connected: boolean;
            version?: string;
            protocol?: number;
            extensionRevision?: string;
          }
        | undefined,
    ) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(value);
    };
    const request = http.request({ socketPath, path: '/v1/status', method: 'POST' }, (response) => {
      void readResponseBody(response, 1_000_000).then(
        (body) => {
          try {
            const parsed = JSON.parse(body.toString('utf8')) as {
              ok?: boolean;
              data?: {
                connected?: boolean;
                version?: unknown;
                protocol?: unknown;
                extensionRevision?: unknown;
              };
            };
            finish(
              parsed.ok && parsed.data
                ? {
                    connected: Boolean(parsed.data.connected),
                    version:
                      typeof parsed.data.version === 'string' ? parsed.data.version : undefined,
                    protocol:
                      typeof parsed.data.protocol === 'number' &&
                      Number.isSafeInteger(parsed.data.protocol)
                        ? parsed.data.protocol
                        : undefined,
                    extensionRevision:
                      typeof parsed.data.extensionRevision === 'string' &&
                      /^[a-f0-9]{64}$/.test(parsed.data.extensionRevision)
                        ? parsed.data.extensionRevision
                        : undefined,
                  }
                : undefined,
            );
          } catch {
            finish(undefined);
          }
        },
        () => finish(undefined),
      );
    });
    timer = setTimeout(() => {
      request.destroy();
      finish(undefined);
    }, 2_000);
    request.once('error', () => finish(undefined));
    request.end('{}');
  });
}

async function installSkill(messages: string[]) {
  const packagedSource = path.join(sourceDist(), '..', 'skills', 'cobrowser');
  const bundledSource = path.join(sourceDist(), 'skills', 'cobrowser');
  const source = fs.existsSync(packagedSource) ? packagedSource : bundledSource;
  if (!fs.existsSync(source)) return;
  const canonicalRoot = path.join(userHome(), '.agents', 'skills');
  const canonical = path.join(canonicalRoot, 'cobrowser');
  try {
    await fsp.mkdir(canonicalRoot, { recursive: true });
    let existing: fs.Stats | undefined;
    try {
      existing = await fsp.lstat(canonical);
    } catch {
      existing = undefined;
    }
    let managed = false;
    if (existing?.isDirectory() && !existing.isSymbolicLink()) {
      try {
        managed =
          (await fsp.readFile(path.join(canonical, SKILL_MARKER), 'utf8')) === SKILL_MARKER_CONTENT;
      } catch {
        managed = false;
      }
    }
    if (existing && !managed) {
      messages.push(`left the existing skill at ${canonical}`);
    } else {
      const staging = path.join(canonicalRoot, `.cobrowser-staging-${VERSION}-${process.pid}`);
      await fsp.rm(staging, { recursive: true, force: true });
      try {
        await fsp.cp(source, staging, { recursive: true, force: true });
        await writeFileAtomic(path.join(staging, SKILL_MARKER), SKILL_MARKER_CONTENT, 0o600);
        await replaceDirectory(staging, canonical);
      } finally {
        await fsp.rm(staging, { recursive: true, force: true });
      }
      messages.push(`cobrowser skill installed in ${canonicalRoot}`);
    }
  } catch {
    return;
  }
  for (const agentRoot of [
    path.join(userHome(), '.claude', 'skills'),
    path.join(userHome(), '.codex', 'skills'),
  ]) {
    const target = path.join(agentRoot, 'cobrowser');
    try {
      await fsp.mkdir(agentRoot, { recursive: true });
      let existing: fs.Stats | undefined;
      try {
        existing = await fsp.lstat(target);
      } catch {
        existing = undefined;
      }
      if (existing) {
        if (existing.isSymbolicLink() && (await fsp.realpath(target)) === canonical)
          messages.push(`cobrowser skill already linked in ${agentRoot}`);
        else messages.push(`left the existing skill at ${target}`);
        continue;
      }
      await fsp.symlink(canonical, target, 'dir');
      messages.push(`cobrowser skill linked in ${agentRoot}`);
    } catch {
      /* A missing agent home should not prevent browser setup. */
    }
  }
}

async function registerMcp(command: AgentCommand, runtime: string, messages: string[]) {
  await updateAgentRegistration(command, runtime, messages);
}

export interface DoctorResult {
  ok: boolean;
  lines: string[];
}
export async function doctor(): Promise<DoctorResult> {
  const lines: string[] = [];
  let ok = true;
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  if (nodeMajor >= 20) lines.push(`ok Node ${process.versions.node}`);
  else {
    lines.push(`fix Node 20 or newer is required, found ${process.versions.node}`);
    ok = false;
  }
  const root = home();
  const runtime = path.join(root, 'runtime', VERSION);
  let runtimeReady = false;
  try {
    await validateBuildFiles(runtime, ['package.json']);
    await validateSourceBuild(runtime);
    const metadata = JSON.parse(fs.readFileSync(path.join(runtime, 'package.json'), 'utf8'));
    runtimeReady = metadata?.type === 'module' && metadata.version === VERSION;
  } catch {
    runtimeReady = false;
  }
  if (runtimeReady) lines.push(`ok runtime ${VERSION} is installed`);
  else {
    lines.push(`fix run cobrowser setup to install runtime ${VERSION}`);
    ok = false;
  }
  let nativeHostFound = false;
  const configuredBrowsers = configuredNativeHostBrowsers(root);
  for (const { browser, directory } of nativeHostRecords(root)) {
    const manifest = path.join(directory, 'cobrowser.json');
    const launcher = path.join(root, 'hosts', browser);
    if (!fs.existsSync(manifest)) {
      if (!fs.existsSync(launcher) && !configuredBrowsers.has(browser)) continue;
      nativeHostFound = true;
      lines.push(
        `fix reinstall the ${browser} native host with cobrowser setup --browser ${browser}`,
      );
      ok = false;
      continue;
    }
    nativeHostFound = true;
    let valid = false;
    try {
      const parsed = JSON.parse(fs.readFileSync(manifest, 'utf8')) as unknown;
      const launcherStat = fs.statSync(launcher);
      const launcherSource = fs.readFileSync(launcher, 'utf8');
      const nodePath = launcherNodePath(launcherSource, runtime, browser);
      if (nodePath) fs.accessSync(nodePath, fs.constants.X_OK);
      valid =
        isNativeHostManifest(parsed, launcher) &&
        launcherStat.isFile() &&
        (launcherStat.mode & 0o111) !== 0 &&
        nodePath !== undefined &&
        fs.statSync(nodePath).isFile();
    } catch {
      valid = false;
    }
    if (valid) lines.push(`ok ${browser} native host is installed`);
    else {
      lines.push(`fix recreate the ${browser} launcher with cobrowser setup --browser ${browser}`);
      ok = false;
    }
  }
  if (!nativeHostFound) {
    lines.push('fix run cobrowser setup --browser <browser> to install a native host');
    ok = false;
  }
  const extension = path.join(root, 'extension', 'manifest.json');
  let extensionReady = false;
  try {
    await validateExtensionBuild(path.dirname(extension));
    extensionReady = true;
  } catch {
    extensionReady = false;
  }
  let extensionVersion: string | undefined;
  let extensionKey: string | undefined;
  try {
    const parsed = JSON.parse(fs.readFileSync(extension, 'utf8')) as {
      version?: string;
      key?: string;
    };
    extensionVersion = parsed.version;
    extensionKey = parsed.key;
  } catch {
    extensionVersion = undefined;
    extensionKey = undefined;
  }
  if (extensionReady) lines.push(`ok extension build is present at ${path.dirname(extension)}`);
  else if (extensionVersion && extensionVersion !== VERSION) {
    lines.push(`fix run cobrowser setup to update the extension to version ${VERSION}`);
    ok = false;
  } else if (extensionKey && extensionKey !== PUBLIC_KEY) {
    lines.push('fix run cobrowser setup and reload the extension with its stable key');
    ok = false;
  } else {
    lines.push('fix run cobrowser setup to restore the extension files');
    ok = false;
  }
  const skill = path.join(userHome(), '.agents', 'skills', 'cobrowser', 'SKILL.md');
  if (isCobrowserSkill(skill)) lines.push('ok cobrowser agent skill is installed');
  else {
    lines.push('fix run cobrowser setup to install the agent skill');
    ok = false;
  }
  if (!(await checkMcpRegistration('claude', runtime, lines))) ok = false;
  if (!(await checkMcpRegistration('codex', runtime, lines))) ok = false;
  const run = path.join(root, 'run');
  try {
    const sockets = (await fsp.readdir(run)).filter(
      (file) => file.endsWith('.sock') && isSimpleBrowserName(file.slice(0, -5)),
    );
    if (!sockets.length) lines.push('info no helper is running, open a configured browser');
    else {
      for (const socket of sockets) {
        const browser = socket.slice(0, -5);
        try {
          const mode = fs.statSync(path.join(run, socket)).mode & 0o777;
          if (mode !== 0o600) {
            lines.push(`fix restrict ${browser} socket permissions to 600`);
            ok = false;
          }
        } catch {
          lines.push(`fix ${browser} helper socket could not be inspected`);
          ok = false;
        }
        const status = await helperStatus(root, browser);
        if (!status) {
          lines.push(`fix ${browser} helper did not answer a status check`);
          ok = false;
        } else if (status.version !== VERSION || status.protocol !== PROTOCOL_VERSION) {
          lines.push(`fix run cobrowser setup to update the ${browser} helper`);
          ok = false;
        } else if (status.connected) lines.push(`ok ${browser} helper and extension are connected`);
        else {
          lines.push(`fix open ${browser} and check the extension connection in its popup`);
          ok = false;
        }
      }
    }
  } catch {
    lines.push('info no helper is running, open a configured browser');
  }
  return { ok, lines };
}

async function checkMcpRegistration(
  command: AgentCommand,
  runtime: string,
  lines: string[],
): Promise<boolean> {
  return inspectAgentRegistration(command, runtime, lines);
}
