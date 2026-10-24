import { test, expect } from '@playwright/test';
import { execFile } from 'node:child_process';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const cli = fileURLToPath(new URL('../../dist/cli.js', import.meta.url));
type Agent = 'claude' | 'codex';

function parseFixtureToml(source: string): Record<string, any> {
  const tokens = (
    source.match(
      /"""(?:\\[\s\S]|"(?!"")|[^"\\])*"{3,5}|'''(?:'(?!'')|[^'])*'{3,5}|"(?:[^"\\]|\\.)*"|'[^']*'|#[^\n]*|[+-]?\d+(?:\.\d+)?|[A-Za-z_-][A-Za-z0-9_-]*|[^\s]/g,
    ) ?? []
  ).filter((token) => !token.startsWith('#'));
  let index = 0;
  const string = (token: string) => {
    const triple = token.startsWith('"""') || token.startsWith("'''");
    let value = token.slice(triple ? 3 : 1, triple ? -3 : -1);
    if (triple) value = value.replace(/^\r?\n/, '');
    return token.startsWith("'")
      ? value
      : value.replace(/\\(?:\r?\n\s*|u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8}|.)/g, (escape) => {
          if (/^\\\r?\n/.test(escape)) return '';
          if (/^\\[uU]/.test(escape)) return String.fromCodePoint(parseInt(escape.slice(2), 16));
          return (
            (
              { '\\b': '\b', '\\t': '\t', '\\n': '\n', '\\f': '\f', '\\r': '\r' } as Record<
                string,
                string
              >
            )[escape] ?? escape.slice(1)
          );
        });
  };
  const key = (end: string): string[] => {
    const parts: string[] = [];
    while (tokens[index] !== end) {
      const token = tokens[index++];
      if (token === undefined) throw new Error('Invalid fixture TOML key.');
      if (token !== '.') parts.push(/^['"]/.test(token) ? string(token) : token);
    }
    index++;
    return parts;
  };
  const assign = (target: Record<string, any>, parts: string[], value: unknown) => {
    for (const part of parts.slice(0, -1)) target = target[part] ??= {};
    target[parts.at(-1)!] = value;
  };
  const value = (): any => {
    const token = tokens[index++];
    if (token === '{') {
      const result: Record<string, any> = {};
      while (tokens[index] !== '}') {
        const parts = key('=');
        assign(result, parts, value());
        if (tokens[index] === ',') index++;
      }
      index++;
      return result;
    }
    if (token === '[') {
      const result: any[] = [];
      while (tokens[index] !== ']') {
        result.push(value());
        if (tokens[index] === ',') index++;
      }
      index++;
      return result;
    }
    return /^['"]/.test(token) ? string(token) : JSON.parse(token);
  };
  const result: Record<string, any> = {};
  let table = result;
  while (index < tokens.length) {
    if (tokens[index] === '[') {
      index++;
      table = result;
      for (const part of key(']')) table = table[part] ??= {};
    } else {
      const parts = key('=');
      assign(table, parts, value());
    }
  }
  return result;
}

function fixtureToml(config: Record<string, any>, parts: string[] = []): string {
  let source = parts.length ? `[${parts.map((part) => JSON.stringify(part)).join('.')}]\n` : '';
  const objects: Array<[string, Record<string, any>]> = [];
  for (const [key, value] of Object.entries(config)) {
    if (value === undefined || value === null) continue;
    if (typeof value === 'object' && !Array.isArray(value)) objects.push([key, value]);
    else source += `${JSON.stringify(key)} = ${JSON.stringify(value)}\n`;
  }
  for (const [key, value] of objects) source += `\n${fixtureToml(value, [...parts, key])}`;
  return source;
}

function codexFixtureView(raw: Record<string, any>): Record<string, any> {
  const entry = raw.mcp_servers?.cobrowser;
  if (!entry) return raw;
  const { type = entry.url ? 'http' : 'stdio', command, args, env, ...settings } = entry;
  const transport = {
    type,
    ...(command === undefined ? {} : { command }),
    ...(args === undefined ? {} : { args }),
    ...(env === undefined ? {} : { env }),
  };
  return {
    ...raw,
    mcp_servers: {
      ...raw.mcp_servers,
      cobrowser: {
        ...settings,
        name: settings.name ?? 'cobrowser',
        enabled: settings.enabled !== false,
        transport,
      },
    },
  };
}

const fakeCli = `
const fs = require('node:fs');
const path = require('node:path');
${parseFixtureToml.toString()}
${fixtureToml.toString()}
${codexFixtureView.toString()}
const agent = path.basename(process.argv[1]);
const args = process.argv.slice(2);
const file = agent === 'claude'
  ? path.join(process.env.CLAUDE_CONFIG_DIR || process.env.HOME, '.claude.json')
  : path.join(process.env.CODEX_HOME || path.join(process.env.HOME, '.codex'), 'config.toml');
fs.appendFileSync(process.env.COBROWSER_TEST_MCP_LOG, JSON.stringify({ agent, args, file, cwd: process.cwd() }) + '\\n');
if (args[0] !== 'mcp') process.exit(2);
if (args[1] === 'list') {
  console.log('unrelated-cobrowser-backup: healthy');
  process.exit(0);
}
let config = fs.existsSync(file) ? (agent === 'claude' ? JSON.parse(fs.readFileSync(file, 'utf8')) : parseFixtureToml(fs.readFileSync(file, 'utf8'))) : {};
if (agent === 'codex') {
  const project = fs.realpathSync(process.cwd());
  const projectFile = path.join(project, '.codex', 'config.toml');
  if (config.projects?.[project]?.trust_level === 'trusted' && fs.existsSync(projectFile))
    config = { ...config, ...parseFixtureToml(fs.readFileSync(projectFile, 'utf8')) };
}
if (args[1] === 'get' && agent === 'codex' && args[2] === 'cobrowser' && args[3] === '--json') {
  if (path.resolve(process.env.CODEX_HOME) !== process.env.COBROWSER_TEST_MCP_LIVE_CODEX_HOME) {
    if (process.env.COBROWSER_TEST_MCP_FAIL === agent) {
      fs.writeFileSync(file, 'damaged = true');
      console.error('synthetic-secret-that-must-not-be-printed');
      process.exit(1);
    }
    if (process.env.COBROWSER_TEST_MCP_WRONG === agent) {
      console.log('{}');
      process.exit(0);
    }
  }
  const entry = codexFixtureView(config).mcp_servers?.cobrowser;
  if (!entry) process.exit(1);
  delete entry.default_tools_approval_mode;
  delete entry.tools;
  console.log(JSON.stringify(entry));
  process.exit(0);
}
if (args[1] !== 'add') process.exit(2);
if (process.env.COBROWSER_TEST_MCP_FAIL === agent) {
  fs.writeFileSync(file, '{"damaged":true}');
  console.error('synthetic-secret-that-must-not-be-printed');
  process.exit(1);
}
if (process.env.COBROWSER_TEST_MCP_WRONG === agent) {
  fs.writeFileSync(file, '{}');
  process.exit(0);
}
const separator = args.indexOf('--');
const command = args[separator + 1];
const commandArgs = args.slice(separator + 2);
const setting = args[args.indexOf('--env') + 1];
const equal = setting.indexOf('=');
const transport = { type: 'stdio', command, args: commandArgs, env: { [setting.slice(0, equal)]: setting.slice(equal + 1) } };
if (agent === 'claude') {
  if (config.mcpServers?.cobrowser) process.exit(1);
  config.mcpServers = { ...config.mcpServers, cobrowser: transport };
} else {
  config.mcp_servers = { ...config.mcp_servers, cobrowser: { name: 'cobrowser', enabled: true, ...transport } };
}
fs.writeFileSync(file, agent === 'claude' ? JSON.stringify(config) : fixtureToml(config));
`;

async function fixture(agents: Agent[] = ['claude', 'codex']) {
  const directory = await mkdtemp('/tmp/cobrowser-mcp-e2e-');
  const user = path.join(directory, 'user');
  const bin = path.join(directory, 'bin');
  const claudeDirectory = path.join(directory, 'claude');
  const codexDirectory = path.join(directory, 'codex');
  for (const target of [user, bin, claudeDirectory, codexDirectory])
    await mkdir(target, { recursive: true });
  const log = path.join(directory, 'calls.jsonl');
  await writeFile(log, '');
  for (const agent of agents) {
    const file = path.join(bin, agent);
    await writeFile(file, `#!${process.execPath}\n${fakeCli}`);
    await chmod(file, 0o755);
  }
  const home = path.join(directory, "browser 'home $literal");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: user,
    CLAUDE_CONFIG_DIR: claudeDirectory,
    CODEX_HOME: codexDirectory,
    COBROWSER_TEST_MCP_LIVE_CODEX_HOME: codexDirectory,
    COBROWSER_HOME: home,
    COBROWSER_TEST_MCP_LOG: log,
    COBROWSER_TEST_MCP_FAIL: undefined as string | undefined,
    COBROWSER_TEST_MCP_WRONG: undefined as string | undefined,
    PATH: bin,
    FORCE_COLOR: undefined,
    NO_COLOR: undefined,
  };
  const files = {
    claude: path.join(claudeDirectory, '.claude.json'),
    codex: path.join(codexDirectory, 'config.toml'),
  };
  const entry = () => ({
    type: 'stdio',
    command: process.execPath,
    args: [path.join(home, 'runtime', '0.1.0', 'cli.js'), 'mcp'],
    env: { COBROWSER_HOME: home },
  });
  const run = async (args: string[], cwd = directory) => {
    try {
      return await exec(process.execPath, [cli, ...args], { env, cwd, timeout: 20_000 });
    } catch (error) {
      const failed = error as { stdout?: string; stderr?: string; code?: unknown };
      if (typeof failed.stdout !== 'string') throw error;
      return { stdout: failed.stdout, stderr: failed.stderr ?? '' };
    }
  };
  return {
    directory,
    user,
    env,
    files,
    entry,
    setup: (cwd?: string) =>
      run(
        ['setup', '--browser', 'opera', '--native-hosts-dir', path.join(directory, 'hosts')],
        cwd,
      ),
    doctor: async (cwd?: string) =>
      JSON.parse((await run(['doctor', '--json'], cwd)).stdout) as { ok: boolean; lines: string[] },
    calls: async () =>
      (await readFile(log, 'utf8'))
        .trim()
        .split('\n')
        .filter(Boolean)
        .map(
          (line) => JSON.parse(line) as { agent: Agent; args: string[]; file: string; cwd: string },
        ),
    config: async (agent: Agent) =>
      agent === 'claude'
        ? JSON.parse(await readFile(files[agent], 'utf8'))
        : codexFixtureView(parseFixtureToml(await readFile(files[agent], 'utf8'))),
    save: (agent: Agent, config: Record<string, any>) => {
      if (agent === 'claude') return writeFile(files[agent], JSON.stringify(config));
      const servers = Object.fromEntries(
        Object.entries(config.mcp_servers ?? {}).map(([name, value]) => {
          const { transport, ...settings } = value as Record<string, any>;
          return [name, { ...settings, ...transport }];
        }),
      );
      return writeFile(files[agent], fixtureToml({ ...config, mcp_servers: servers }));
    },
    close: () => rm(directory, { recursive: true, force: true }),
  };
}

test('upgrades agent registrations in private configs and leaves reruns unchanged', async () => {
  const f = await fixture();
  try {
    const sentinel = '{"defaultConfig":"leave this alone"}';
    await writeFile(path.join(f.user, '.claude.json'), sentinel);
    const stale = {
      type: 'stdio',
      command: '/old/node',
      args: ['/old/cli.js', 'mcp'],
      env: { KEEP: 'custom' },
    };
    await f.save('claude', {
      custom: { retain: true },
      mcpServers: { unrelated: { url: 'https://example.invalid' }, cobrowser: stale },
    });
    await f.save('codex', {
      model: 'retain-model',
      mcp_servers: {
        unrelated: { url: 'https://example.invalid' },
        cobrowser: {
          name: 'cobrowser',
          enabled: true,
          transport: stale,
          enabled_tools: ['list_tabs', 'read_tab'],
          disabled_tools: ['screenshot'],
          required: true,
          default_tools_approval_mode: 'prompt',
          tools: { read_tab: { approval_mode: 'prompt' } },
        },
      },
    });
    const setup = await f.setup();
    expect(setup.stdout).toContain('claude MCP registration updated');
    expect(setup.stdout).toContain('codex MCP registration updated');
    expect(await f.config('claude')).toEqual({
      custom: { retain: true },
      mcpServers: {
        unrelated: { url: 'https://example.invalid' },
        cobrowser: { ...f.entry(), env: { KEEP: 'custom', ...f.entry().env } },
      },
    });
    expect(await f.config('codex')).toMatchObject({
      model: 'retain-model',
      mcp_servers: {
        unrelated: { url: 'https://example.invalid' },
        cobrowser: {
          name: 'cobrowser',
          enabled: true,
          transport: { ...f.entry(), env: { KEEP: 'custom', ...f.entry().env } },
          enabled_tools: ['list_tabs', 'read_tab'],
          disabled_tools: ['screenshot'],
          required: true,
          default_tools_approval_mode: 'prompt',
          tools: { read_tab: { approval_mode: 'prompt' } },
        },
      },
    });
    expect(await readFile(path.join(f.user, '.claude.json'), 'utf8')).toBe(sentinel);
    const mutations = (await f.calls()).filter((call) => call.args[1] === 'add');
    expect(mutations).toHaveLength(1);
    for (const call of mutations) {
      expect(call.file).not.toBe(f.files[call.agent]);
      expect(call.cwd).not.toBe(process.cwd());
    }
    const before = await Promise.all([
      readFile(f.files.claude, 'utf8'),
      readFile(f.files.codex, 'utf8'),
    ]);
    expect((await f.setup()).stdout).toContain('MCP registration is current');
    expect(
      await Promise.all([readFile(f.files.claude, 'utf8'), readFile(f.files.codex, 'utf8')]),
    ).toEqual(before);
    expect((await f.calls()).filter((call) => call.args[1] === 'add')).toHaveLength(1);
    const doctor = await f.doctor();
    expect(doctor.lines).toContain('ok claude MCP registration is current');
    expect(doctor.lines).toContain('ok codex MCP registration is current');
    expect(
      (await f.calls()).some(
        (call) => call.args[1] === 'list' || (call.agent === 'claude' && call.args[1] === 'get'),
      ),
    ).toBe(false);
  } finally {
    await f.close();
  }
});

test('doctor rejects misleading names and stale or disabled registrations', async () => {
  const f = await fixture();
  try {
    await f.setup();
    const repair = (agent: Agent) =>
      `fix run cobrowser setup to repair the ${agent} MCP registration`;
    await f.save('claude', { mcpServers: { 'unrelated-cobrowser-backup': f.entry() } });
    await f.save('codex', {
      mcp_servers: {
        cobrowser: { name: 'unrelated-cobrowser-backup', enabled: true, transport: f.entry() },
      },
    });
    expect((await f.doctor()).lines).toEqual(
      expect.arrayContaining([repair('claude'), repair('codex')]),
    );
    for (const entry of [
      { ...f.entry(), command: '/old/node' },
      { ...f.entry(), args: ['/old/cli.js', 'mcp'] },
      { ...f.entry(), args: [...f.entry().args, '--unexpected'] },
      { ...f.entry(), env: { COBROWSER_HOME: '/wrong/home' } },
      { ...f.entry(), env: {} },
      { ...f.entry(), type: 'http' },
    ]) {
      await f.save('claude', { mcpServers: { cobrowser: entry } });
      await f.save('codex', {
        mcp_servers: { cobrowser: { name: 'cobrowser', enabled: true, transport: entry } },
      });
      expect((await f.doctor()).lines).toEqual(
        expect.arrayContaining([repair('claude'), repair('codex')]),
      );
    }
    await f.save('claude', { mcpServers: { cobrowser: f.entry() } });
    await f.save('codex', {
      mcp_servers: { cobrowser: { name: 'cobrowser', enabled: false, transport: f.entry() } },
    });
    expect((await f.doctor()).lines).toContain(
      'fix enable the codex cobrowser MCP server in its config, then run cobrowser doctor again',
    );
    expect((await f.calls()).some((call) => call.args[1] === 'list')).toBe(false);
  } finally {
    await f.close();
  }
});

for (const agent of ['claude', 'codex'] as const) {
  test(`${agent} keeps the old config when an update fails after writing`, async () => {
    const f = await fixture([agent]);
    try {
      const original =
        agent === 'claude'
          ? {
              custom: 'retain',
              mcpServers: {
                cobrowser: { command: '/old/node', args: ['/old/cli.js', 'mcp'] },
                unrelated: { command: '/keep' },
              },
            }
          : {
              model: 'retain',
              mcp_servers: {
                cobrowser: {
                  name: 'cobrowser',
                  enabled: true,
                  transport: { type: 'stdio', command: '/old/node', args: ['/old/cli.js', 'mcp'] },
                },
                unrelated: { command: '/keep' },
              },
            };
      await f.save(agent, original);
      f.env.COBROWSER_TEST_MCP_FAIL = agent;
      const failed = await f.setup();
      expect(failed.stdout).toContain(`Could not update the ${agent} MCP registration`);
      expect(failed.stdout + failed.stderr).not.toContain(
        'synthetic-secret-that-must-not-be-printed',
      );
      expect(await f.config(agent)).toEqual(original);
      f.env.COBROWSER_TEST_MCP_FAIL = undefined;
      f.env.COBROWSER_TEST_MCP_WRONG = agent;
      expect((await f.setup()).stdout).toContain(`Could not update the ${agent} MCP registration`);
      expect(await f.config(agent)).toEqual(original);
      f.env.COBROWSER_TEST_MCP_WRONG = undefined;
      expect((await f.setup()).stdout).toContain(`${agent} MCP registration updated`);
      expect((await f.doctor()).lines).toContain(`ok ${agent} MCP registration is current`);
    } finally {
      await f.close();
    }
  });
}

test('updates a symlinked Claude config and preserves its link', async () => {
  const f = await fixture(['claude']);
  try {
    const target = path.join(f.directory, 'linked-config.json');
    await writeFile(target, JSON.stringify({ custom: true }));
    await symlink(target, f.files.claude);
    expect((await f.setup()).stdout).toContain('claude MCP registration updated');
    expect((await lstat(f.files.claude)).isSymbolicLink()).toBe(true);
    expect(JSON.parse(await readFile(target, 'utf8'))).toMatchObject({
      custom: true,
      mcpServers: { cobrowser: f.entry() },
    });
  } finally {
    await f.close();
  }
});

test('keeps Codex policy tables, comments and a disabled server during an upgrade', async () => {
  const f = await fixture(['codex']);
  try {
    const policy = `# Keep this comment.\n[mcp_servers."cobrowser"]\ncommand = "/old/node"\nargs = [\n  "/old/cli.js",\n  "mcp"\n]\nenabled = false\nenabled_tools = ["list_tabs"]\ndisabled_tools = ["screenshot"]\nrequired = true\ndefault_tools_approval_mode = "prompt"\nenv = { "KEEP" = "custom" }\n\n[mcp_servers."cobrowser".tools.read_tab]\napproval_mode = "prompt"\n`;
    await writeFile(f.files.codex, policy);
    expect((await f.setup()).stdout).toContain('codex MCP registration updated');
    const updated = await readFile(f.files.codex, 'utf8');
    for (const retained of [
      '# Keep this comment.',
      'enabled = false',
      'enabled_tools = ["list_tabs"]',
      'disabled_tools = ["screenshot"]',
      'required = true',
      'default_tools_approval_mode = "prompt"',
      '[mcp_servers."cobrowser".tools.read_tab]\napproval_mode = "prompt"',
    ])
      expect(updated).toContain(retained);
    expect(await f.config('codex')).toMatchObject({
      mcp_servers: {
        cobrowser: {
          enabled: false,
          transport: { ...f.entry(), env: { KEEP: 'custom', ...f.entry().env } },
        },
      },
    });
    expect((await f.setup()).stdout).toContain('codex MCP registration is current');
    expect((await f.doctor()).lines).toContain(
      'fix enable the codex cobrowser MCP server in its config, then run cobrowser doctor again',
    );
  } finally {
    await f.close();
  }
});

const inlineRegistrations = [
  {
    name: 'dotted server key',
    source: `# Keep the user's layout.
mcp_servers.'cobrowser' = { command = '/old/node', args = ['/old/cli.js', 'mcp'], enabled = false, required = true, default_tools_approval_mode = 'prompt', tools = { read_tab = { approval_mode = 'prompt' } }, env = { KEEP = 'custom' } } # Keep the server comment.
`,
    retained: [
      'enabled = false, required = true',
      "tools = { read_tab = { approval_mode = 'prompt' } }",
      '# Keep the server comment.',
    ],
  },
  {
    name: 'multiline server and environment',
    source: String.raw`[mcp_servers] # Keep the table comment.
"co\U00000062rowser" = {
  command = '''/old/node''', # Keep the command comment.
  args = [
    '/old/cli.js', # Old path.
    'mcp',
  ],
  enabled = false, # The user disabled this server.
  required = true,
  default_tools_approval_mode = 'prompt',
  tools = { 'read_tab' = { approval_mode = 'prompt' } },
  env = {
    'KEEP' = """
commas, braces } [ and # inside a string
keep the ending quote"""",
    'literal.key' = '''literal \\ value # comma, } ]''', # Keep this environment comment.
  },
} # Keep the server comment.
`,
    retained: [
      '[mcp_servers] # Keep the table comment.',
      '# Keep the command comment.',
      'enabled = false, # The user disabled this server.',
      "tools = { 'read_tab' = { approval_mode = 'prompt' } }",
      'commas, braces } [ and # inside a string\nkeep the ending quote""""',
      '# Keep this environment comment.',
      '# Keep the server comment.',
    ],
  },
  {
    name: 'inline server map',
    source: `model = 'retain-model'
mcp_servers = { unrelated = { command = '/keep', env = { KEEP = 'elsewhere' } }, 'cobrowser' = { command = '/old/node', enabled = false, env.KEEP = 'custom', required = true, default_tools_approval_mode = 'prompt', disabled_tools = ['screenshot'] } }
`,
    retained: [
      "unrelated = { command = '/keep', env = { KEEP = 'elsewhere' } }",
      "env.KEEP = 'custom'",
      "disabled_tools = ['screenshot']",
    ],
  },
  {
    name: 'empty inline environment',
    source: `[mcp_servers]
cobrowser = { command = '/old/node', env = {}, enabled = false, default_tools_approval_mode = 'prompt' }
`,
    retained: ["enabled = false, default_tools_approval_mode = 'prompt'"],
  },
];

for (const variant of inlineRegistrations) {
  test(`upgrades a Codex ${variant.name} and keeps its policy`, async () => {
    const f = await fixture(['codex']);
    try {
      await writeFile(f.files.codex, variant.source);
      const before = parseFixtureToml(variant.source);
      const old = before.mcp_servers.cobrowser;
      expect((await f.setup()).stdout).toContain('codex MCP registration updated');
      const updated = await readFile(f.files.codex, 'utf8');
      expect(parseFixtureToml(updated)).toEqual({
        ...before,
        mcp_servers: {
          ...before.mcp_servers,
          cobrowser: {
            ...old,
            command: f.entry().command,
            args: f.entry().args,
            env: { ...old.env, ...f.entry().env },
          },
        },
      });
      for (const retained of variant.retained) expect(updated).toContain(retained);
      expect((await f.calls()).some((call) => call.args[1] === 'add')).toBe(false);
      expect((await f.setup()).stdout).toContain('codex MCP registration is current');
      expect(await readFile(f.files.codex, 'utf8')).toBe(updated);
      expect((await f.doctor()).lines).toContain(
        'fix enable the codex cobrowser MCP server in its config, then run cobrowser doctor again',
      );
    } finally {
      await f.close();
    }
  });
}

for (const fields of [
  "url = 'https://example.invalid', bearer_token_env_var = 'TOKEN'",
  "url = 'https://example.invalid', enabled = false, http_headers = { Secret = 'retain-privately' }, oauth = { enabled = true }",
  "enabled = false, url = 'https://example.invalid', env_http_headers = { Secret = 'TOKEN' }",
]) {
  test(`repairs an inline Codex HTTP registration with ${fields.split(',').length} fields`, async () => {
    const f = await fixture(['codex']);
    try {
      await writeFile(
        f.files.codex,
        `mcp_servers.cobrowser = { ${fields} } # Keep this comment.\n`,
      );
      const result = await f.setup();
      expect(result.stdout).toContain('codex MCP registration updated');
      expect(result.stdout + result.stderr).not.toContain('retain-privately');
      const updated = await readFile(f.files.codex, 'utf8');
      expect(updated).toContain('# Keep this comment.');
      expect(parseFixtureToml(updated).mcp_servers.cobrowser).toEqual({
        ...(fields.includes('enabled = false') ? { enabled: false } : {}),
        command: f.entry().command,
        args: f.entry().args,
        env: f.entry().env,
      });
    } finally {
      await f.close();
    }
  });
}

test('keeps Codex environment table contents and trailing comments', async () => {
  const f = await fixture(['codex']);
  try {
    const source = `[mcp_servers.'cobrowser'] # Keep the server header.
command = '/old/node' # Keep the command comment.
args = [
  '/old/cli.js',
  'mcp',
]
enabled = false
[mcp_servers.'cobrowser'.env] # Keep the environment header.
'KEEP' = '''commas, brackets [ } # and
literal text'''
'OTHER' = """Keep the final quote""""
[mcp_servers.'cobrowser'.tools.read_tab]
approval_mode = 'prompt'
`;
    await writeFile(f.files.codex, source);
    expect((await f.setup()).stdout).toContain('codex MCP registration updated');
    const updated = await readFile(f.files.codex, 'utf8');
    expect(parseFixtureToml(updated).mcp_servers.cobrowser.env).toEqual({
      KEEP: 'commas, brackets [ } # and\nliteral text',
      OTHER: 'Keep the final quote"',
      ...f.entry().env,
    });
    for (const retained of [
      "[mcp_servers.'cobrowser'] # Keep the server header.",
      '# Keep the command comment.',
      "[mcp_servers.'cobrowser'.env] # Keep the environment header.",
      "'KEEP' = '''commas, brackets [ } # and\nliteral text'''",
      "[mcp_servers.'cobrowser'.tools.read_tab]\napproval_mode = 'prompt'",
    ])
      expect(updated).toContain(retained);
  } finally {
    await f.close();
  }
});

for (const variant of [
  {
    name: 'dotted fields',
    source:
      "mcp_servers.cobrowser.url = 'https://example.invalid'\nmcp_servers.cobrowser.http_headers = { Secret = 'retain-privately' }\n",
  },
  {
    name: 'HTTP policy tables',
    source:
      "[mcp_servers.cobrowser]\nurl = 'https://example.invalid'\nenabled = false\nrequired = true\n[mcp_servers.cobrowser.http_headers]\nSecret = 'retain-privately'\n[mcp_servers.cobrowser.tools.read_tab]\napproval_mode = 'prompt'\n",
  },
]) {
  test(`repairs Codex ${variant.name} without retaining HTTP credentials`, async () => {
    const f = await fixture(['codex']);
    try {
      await writeFile(f.files.codex, variant.source);
      const result = await f.setup();
      expect(result.stdout).toContain('codex MCP registration updated');
      expect(result.stdout + result.stderr).not.toContain('retain-privately');
      const updated = await readFile(f.files.codex, 'utf8');
      expect(updated).not.toContain('retain-privately');
      const {
        url: _url,
        http_headers: _headers,
        ...settings
      } = parseFixtureToml(variant.source).mcp_servers.cobrowser;
      expect(parseFixtureToml(updated).mcp_servers.cobrowser).toEqual({
        ...settings,
        command: f.entry().command,
        args: f.entry().args,
        env: f.entry().env,
      });
    } finally {
      await f.close();
    }
  });
}

test('inspects the user Codex registration outside a trusted project', async () => {
  const f = await fixture(['codex']);
  try {
    const project = path.join(f.directory, 'trusted-project');
    await mkdir(path.join(project, '.codex'), { recursive: true });
    const resolved = await realpath(project);
    const source = fixtureToml({ mcp_servers: { cobrowser: f.entry() } });
    const projectFile = path.join(project, '.codex', 'config.toml');
    await writeFile(projectFile, source);
    const stale = fixtureToml({
      projects: { [resolved]: { trust_level: 'trusted' } },
      mcp_servers: { cobrowser: { command: '/old/node' } },
    });
    await writeFile(f.files.codex, stale);
    f.env.CODEX_HOME = path.relative(project, path.dirname(f.files.codex));
    expect((await f.doctor(project)).lines).toContain(
      'fix run cobrowser setup to repair the codex MCP registration',
    );
    expect((await f.setup(project)).stdout).toContain('codex MCP registration updated');
    expect((await f.doctor(project)).lines).toContain('ok codex MCP registration is current');
    expect(await f.config('codex')).toMatchObject({
      projects: { [resolved]: { trust_level: 'trusted' } },
      mcp_servers: { cobrowser: { transport: f.entry() } },
    });
    expect(await readFile(projectFile, 'utf8')).toBe(source);
    const calls = await f.calls();
    expect(calls.filter((call) => call.args[1] === 'get').length).toBeGreaterThanOrEqual(4);
    expect(calls.every((call) => call.cwd !== resolved)).toBe(true);
    for (const call of calls.filter((call) => call.args[1] === 'get'))
      await expect(lstat(call.cwd)).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    await f.close();
  }
});

test('uses default agent config paths when overrides are absent', async () => {
  const f = await fixture();
  try {
    delete f.env.CLAUDE_CONFIG_DIR;
    delete f.env.CODEX_HOME;
    f.files.claude = path.join(f.user, '.claude.json');
    f.files.codex = path.join(f.user, '.codex', 'config.toml');
    f.env.COBROWSER_TEST_MCP_LIVE_CODEX_HOME = path.dirname(f.files.codex);
    const setup = await f.setup();
    expect(setup.stdout).toContain('claude MCP registration updated');
    expect(setup.stdout).toContain('codex MCP registration updated');
    expect((await f.doctor()).lines).toEqual(
      expect.arrayContaining([
        'ok claude MCP registration is current',
        'ok codex MCP registration is current',
      ]),
    );
  } finally {
    await f.close();
  }
});

test('missing agent CLIs do not prevent setup or doctor', async () => {
  const f = await fixture([]);
  try {
    const setup = await f.setup();
    expect(setup.stdout).toContain('runtime installed');
    expect(setup.stdout).not.toContain('Could not update');
    expect((await f.doctor()).lines.some((line) => /MCP registration/.test(line))).toBe(false);
  } finally {
    await f.close();
  }
});
