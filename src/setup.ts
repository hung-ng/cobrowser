import { execFile } from 'node:child_process';
import fsp from 'node:fs/promises';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { readResponseBody } from './client.js';
import { EXTENSION_ID, PROTOCOL_VERSION, PUBLIC_KEY, VERSION } from './shared/constants.js';

const exec = promisify(execFile);
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

async function writeNativeHostConfig(
  root: string,
  records: NativeHostRecord[],
  configuredBrowsers: Set<string>,
) {
  const file = setupConfigPath(root);
  await writeFileAtomic(
    file,
    `${JSON.stringify(
      { version: 1, nativeHosts: records, configuredBrowsers: [...configuredBrowsers].sort() },
      null,
      2,
    )}\n`,
    0o600,
  );
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

export function isLauncherScript(value: unknown, runtime: string, browser: string): boolean {
  if (typeof value !== 'string') return false;
  const root = path.dirname(path.dirname(runtime));
  const helper = `${shellQuote(path.join(runtime, 'helper.js'))} --browser ${shellQuote(browser)}`;
  const lines = value.split('\n');
  if (lines.length !== 4 || lines[3] !== '') return false;
  const execLine = lines[2];
  const prefix = 'exec ';
  const suffix = ` ${helper}`;
  if (!execLine.startsWith(prefix) || !execLine.endsWith(suffix)) return false;
  const nodePath = execLine.slice(prefix.length, execLine.length - suffix.length);
  return (
    lines[0] === '#!/bin/sh' &&
    lines[1] === `export COBROWSER_HOME=${shellQuote(root)}` &&
    /^'(?:[^']|'\\'')+'$/.test(nodePath)
  );
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
  const unsupported = browsers.filter(
    (browser) => !(SUPPORTED_BROWSERS as readonly string[]).includes(browser),
  );
  if (unsupported.length && !options.nativeHostsDir)
    throw new Error(`Unsupported browser: ${unsupported.join(', ')}.`);
  if (process.platform !== 'darwin' && browsers.includes('arc'))
    throw new Error('Arc setup is supported only on macOS.');
  const nativeHostsDir = options.nativeHostsDir ? path.resolve(options.nativeHostsDir) : undefined;
  const root = home();
  const configuredBrowsers = configuredNativeHostBrowsers(root);
  for (const browser of browsers) configuredBrowsers.add(browser);
  const longSocket = browsers.find(
    (browser) => Buffer.byteLength(path.join(root, 'run', `${browser}.sock`), 'utf8') >= 104,
  );
  if (longSocket)
    throw new Error(
      'The cobrowser home path is too long for a Unix socket. Set COBROWSER_HOME to a shorter path and try again.',
    );
  const runtimeRoot = path.join(root, 'runtime');
  const runtime = path.join(runtimeRoot, VERSION);
  const runtimeStaging = path.join(runtimeRoot, `.staging-${VERSION}-${process.pid}`);
  await fsp.mkdir(runtimeRoot, { recursive: true, mode: 0o700 });
  await fsp.rm(runtimeStaging, { recursive: true, force: true });
  try {
    await fsp.cp(sourceDist(), runtimeStaging, { recursive: true, force: true });
    const sourceSkills = path.join(sourceDist(), '..', 'skills');
    if (fs.existsSync(sourceSkills))
      await fsp.cp(sourceSkills, path.join(runtimeStaging, 'skills'), {
        recursive: true,
        force: true,
      });
    await replaceDirectory(runtimeStaging, runtime);
  } finally {
    await fsp.rm(runtimeStaging, { recursive: true, force: true });
  }
  const extension = path.join(root, 'extension');
  const extensionStaging = path.join(root, `.extension-staging-${VERSION}-${process.pid}`);
  await fsp.rm(extensionStaging, { recursive: true, force: true });
  try {
    await fsp.cp(path.join(runtime, 'extension'), extensionStaging, {
      recursive: true,
      force: true,
    });
    await replaceDirectory(extensionStaging, extension);
  } finally {
    await fsp.rm(extensionStaging, { recursive: true, force: true });
  }
  await fsp.chmod(root, 0o700).catch(() => undefined);
  const messages: string[] = [`runtime installed at ${runtime}`];
  await installSkill(messages);
  const nativeHosts = browsers.map((browser) => ({
    browser,
    directory:
      nativeHostsDir ??
      ((SUPPORTED_BROWSERS as readonly string[]).includes(browser)
        ? browserHostDirectory(browser as SupportedBrowser)
        : ''),
  }));
  for (const browser of browsers) {
    const hosts = path.join(root, 'hosts');
    const launcher = path.join(hosts, browser);
    await fsp.mkdir(hosts, { recursive: true, mode: 0o700 });
    await writeFileAtomic(launcher, launcherScript(runtime, browser), 0o755);
    const directory = nativeHosts.find((entry) => entry.browser === browser)?.directory
      ? nativeHosts.find((entry) => entry.browser === browser)!.directory
      : (SUPPORTED_BROWSERS as readonly string[]).includes(browser)
        ? browserHostDirectory(browser as SupportedBrowser)
        : undefined;
    if (!directory)
      throw new Error(
        `Unsupported browser ${browser}. Use --native-hosts-dir with a custom browser name.`,
      );
    try {
      await fsp.mkdir(directory, { recursive: true });
      await writeFileAtomic(
        path.join(directory, 'cobrowser.json'),
        `${JSON.stringify(nativeHostManifest(launcher), null, 2)}\n`,
        0o644,
      );
    } catch (error) {
      throw new Error(
        `Could not install the ${browser} native host at ${directory}; check permissions and run setup again.`,
      );
    }
    messages.push(`${browser} native host installed`);
  }
  const mergedNativeHosts = new Map(
    nativeHostRecords(root).map((record) => [record.browser, record] as const),
  );
  for (const record of nativeHosts) mergedNativeHosts.set(record.browser, record);
  await writeNativeHostConfig(root, [...mergedNativeHosts.values()], configuredBrowsers);
  for (const browser of browsers) {
    if (await restartHelper(root, browser)) messages.push(`${browser} helper restart requested`);
  }
  await registerMcp('claude', runtime, 'claude mcp add --scope user cobrowser --', messages);
  await registerMcp('codex', runtime, 'codex mcp add cobrowser --', messages);
  messages.push(
    `MCP config for other clients:\n${JSON.stringify(
      {
        mcpServers: {
          cobrowser: { command: process.execPath, args: [path.join(runtime, 'cli.js'), 'mcp'] },
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

async function restartHelper(root: string, browser: string): Promise<boolean> {
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
    request.end('{}');
  });
}

async function helperStatus(
  root: string,
  browser: string,
): Promise<{ connected: boolean; version?: string; protocol?: number } | undefined> {
  const socketPath = path.join(root, 'run', `${browser}.sock`);
  if (!fs.existsSync(socketPath)) return undefined;
  return new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (
      value: { connected: boolean; version?: string; protocol?: number } | undefined,
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
              data?: { connected?: boolean; version?: unknown; protocol?: unknown };
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

async function registerMcp(command: string, runtime: string, prefix: string, messages: string[]) {
  try {
    await exec(
      'sh',
      [
        '-c',
        `command -v ${command} >/dev/null 2>&1 && ${prefix} ${shellQuote(process.execPath)} ${shellQuote(path.join(runtime, 'cli.js'))} mcp`,
      ],
      { timeout: 10_000 },
    );
    messages.push(`${command} MCP registration updated`);
  } catch {
    /* Agent CLIs are optional. doctor explains how to add one later. */
  }
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
  const runtimeFiles = [
    path.join(runtime, 'cli.js'),
    path.join(runtime, 'client.js'),
    path.join(runtime, 'helper.js'),
    path.join(runtime, 'extension', 'manifest.json'),
    path.join(runtime, 'extension', 'service-worker.js'),
    path.join(runtime, 'extension', 'popup.html'),
    path.join(runtime, 'extension', 'popup.js'),
    path.join(runtime, 'extension', 'options.html'),
    path.join(runtime, 'extension', 'options.js'),
  ];
  const runtimeReady = runtimeFiles.every((file) => {
    try {
      return fs.statSync(file).isFile();
    } catch {
      return false;
    }
  });
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
      valid =
        isNativeHostManifest(parsed, launcher) &&
        launcherStat.isFile() &&
        (launcherStat.mode & 0o111) !== 0 &&
        isLauncherScript(launcherSource, runtime, browser);
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
  const installedExtension = path.join(root, 'extension', 'manifest.json');
  const sourceExtension = path.join(sourceDist(), 'extension', 'manifest.json');
  const extension = fs.existsSync(installedExtension) ? installedExtension : sourceExtension;
  const extensionFiles = [
    path.join(path.dirname(extension), 'manifest.json'),
    path.join(path.dirname(extension), 'service-worker.js'),
    path.join(path.dirname(extension), 'popup.html'),
    path.join(path.dirname(extension), 'popup.js'),
    path.join(path.dirname(extension), 'options.html'),
    path.join(path.dirname(extension), 'options.js'),
  ];
  const extensionReady = extensionFiles.every((file) => {
    try {
      return fs.statSync(file).isFile();
    } catch {
      return false;
    }
  });
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
  if (extensionVersion === VERSION && extensionKey === PUBLIC_KEY && extensionReady)
    lines.push(`ok extension build is present at ${path.dirname(extension)}`);
  else if (!extensionVersion) {
    lines.push('fix run npm run build before setup');
    ok = false;
  } else if (extensionVersion !== VERSION) {
    lines.push(`fix run cobrowser setup to update the extension to version ${VERSION}`);
    ok = false;
  } else if (!extensionReady) {
    lines.push('fix run cobrowser setup to restore the extension files');
    ok = false;
  } else {
    lines.push('fix run cobrowser setup and reload the extension with its stable key');
    ok = false;
  }
  const skill = path.join(userHome(), '.agents', 'skills', 'cobrowser', 'SKILL.md');
  if (isCobrowserSkill(skill)) lines.push('ok cobrowser agent skill is installed');
  else {
    lines.push('fix run cobrowser setup to install the agent skill');
    ok = false;
  }
  if (!(await checkMcpRegistration('claude', 'claude mcp list', lines))) ok = false;
  if (!(await checkMcpRegistration('codex', 'codex mcp list', lines))) ok = false;
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
  command: string,
  listCommand: string,
  lines: string[],
): Promise<boolean> {
  try {
    await exec('sh', ['-c', `command -v ${command} >/dev/null 2>&1`], { timeout: 2_000 });
  } catch {
    return true;
  }
  const [name, subcommand, action] = listCommand.split(' ');
  try {
    const result = await exec(name, [subcommand, action], { timeout: 5_000 });
    if (result.stdout.includes('cobrowser')) {
      lines.push(`ok ${command} MCP registration is present`);
      return true;
    }
    lines.push(`fix run cobrowser setup to register the ${command} MCP server`);
    return false;
  } catch {
    lines.push(`fix run cobrowser setup to register the ${command} MCP server`);
    return false;
  }
}
