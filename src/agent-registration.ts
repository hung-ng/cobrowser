import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
export type AgentCommand = 'claude' | 'codex';
type JsonObject = Record<string, unknown>;

function object(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function json(source: string): JsonObject {
  const value: unknown = JSON.parse(source);
  if (!object(value)) throw new Error('Invalid agent config.');
  return value;
}

async function executable(command: AgentCommand): Promise<string | undefined> {
  for (const directory of (process.env.PATH || '').split(path.delimiter)) {
    if (!directory) continue;
    const file = path.resolve(directory, command);
    try {
      if ((await fs.stat(file)).isFile()) {
        await fs.access(file, 0o1);
        return file;
      }
    } catch {
      continue;
    }
  }
  return undefined;
}

function configFile(command: AgentCommand): string {
  const userHome = process.env.HOME || os.homedir();
  return command === 'claude'
    ? path.resolve(process.env.CLAUDE_CONFIG_DIR || userHome, '.claude.json')
    : path.resolve(process.env.CODEX_HOME || path.join(userHome, '.codex'), 'config.toml');
}

function matches(value: unknown, runtime: string, root: string): boolean {
  if (!object(value)) return false;
  const args = value.args;
  return (
    value.type === 'stdio' &&
    value.command === process.execPath &&
    Array.isArray(args) &&
    args.length === 2 &&
    args[0] === path.join(runtime, 'cli.js') &&
    args[1] === 'mcp' &&
    object(value.env) &&
    value.env.COBROWSER_HOME === root
  );
}

function claudeEntry(config: JsonObject): unknown {
  if (config.mcpServers !== undefined && !object(config.mcpServers))
    throw new Error('Invalid agent config.');
  return object(config.mcpServers) ? config.mcpServers.cobrowser : undefined;
}

async function codexEntry(file: string, env = process.env): Promise<JsonObject> {
  // A trusted project's config can override the user registration.
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'cobrowser-inspect-'));
  try {
    const result = await exec(file, ['mcp', 'get', 'cobrowser', '--json'], {
      env: {
        ...env,
        CODEX_HOME: path.resolve(env.CODEX_HOME || path.join(env.HOME || os.homedir(), '.codex')),
      },
      cwd,
      timeout: 5_000,
      maxBuffer: 1_000_000,
    });
    return json(result.stdout);
  } finally {
    await fs.rm(cwd, { recursive: true, force: true }).catch(() => undefined);
  }
}

function codexMatches(config: JsonObject, runtime: string, root: string): boolean {
  return (
    config.name === 'cobrowser' &&
    typeof config.enabled === 'boolean' &&
    matches(config.transport, runtime, root)
  );
}

function dottedKey(value: string): string[] {
  const parts: string[] = [];
  let rest = value.trim();
  while (rest) {
    const match = /^("(?:[^"\\]|\\.)*"|'[^']*'|[A-Za-z0-9_-]+)\s*(\.|$)/.exec(rest);
    if (!match) throw new Error('Unsupported agent config key.');
    const key = match[1];
    parts.push(
      key.startsWith('"')
        ? JSON.parse(
            key.replace(/\\(?:U[0-9a-fA-F]{8}|x[0-9a-fA-F]{2}|e|.)/g, (escape) => {
              if (escape[1] === 'U' || escape[1] === 'x')
                return JSON.stringify(String.fromCodePoint(parseInt(escape.slice(2), 16))).slice(
                  1,
                  -1,
                );
              return escape === '\\e' ? '\\u001b' : escape;
            }),
          )
        : key.startsWith("'")
          ? key.slice(1, -1)
          : key,
    );
    rest = rest.slice(match[0].length).trim();
  }
  return parts;
}

type Span = { start: number; end: number };
type Edit = Span & { value: string };

function tomlTokens(source: string, start = 0, end = source.length): Span[] {
  const tokens: Span[] = [];
  for (let index = start; index < end;) {
    const character = source[index];
    if (/\s/.test(character)) {
      index++;
      continue;
    }
    if (character === '#') {
      while (index < end && source[index] !== '\n') index++;
      continue;
    }
    const tokenStart = index++;
    if (character === '"' || character === "'") {
      const quote = source.startsWith(character.repeat(3), tokenStart)
        ? character.repeat(3)
        : character;
      index = tokenStart + quote.length;
      let closed = false;
      while (index < end) {
        if (character === '"' && source[index] === '\\') index += 2;
        else if (source.startsWith(quote, index)) {
          index += quote.length;
          if (quote.length === 3) while (index < end && source[index] === character) index++;
          closed = true;
          break;
        } else index++;
      }
      if (!closed) throw new Error('Unsupported agent config string.');
    } else if (!'[]{}=,.'.includes(character)) {
      while (index < end && !/[\s#'"\[\]{}=,.]/.test(source[index])) index++;
    }
    tokens.push({ start: tokenStart, end: index });
  }
  return tokens;
}

function tomlStatements(source: string): Span[] {
  const statements: Span[] = [];
  let start: number | undefined;
  let end = 0;
  let depth = 0;
  for (const token of tomlTokens(source)) {
    if (start !== undefined && depth === 0 && source.slice(end, token.start).includes('\n')) {
      statements.push({ start, end });
      start = undefined;
    }
    start ??= token.start;
    if ('[{'.includes(source[token.start])) depth++;
    else if (']}'.includes(source[token.start])) depth--;
    end = token.end;
  }
  if (depth !== 0) throw new Error('Unsupported agent config syntax.');
  if (start !== undefined) statements.push({ start, end });
  return statements;
}

function assignment(source: string, tokens: Span[]): { key: string[]; value: Span } {
  const equal = tokens.findIndex((token) => source[token.start] === '=');
  if (equal < 1 || equal === tokens.length - 1) throw new Error('Unsupported agent config syntax.');
  return {
    key: dottedKey(source.slice(tokens[0].start, tokens[equal].start)),
    value: { start: tokens[equal + 1].start, end: tokens.at(-1)!.end },
  };
}

// Codex validates syntax; source edits retain policies omitted from its JSON output.
function updateCodexSource(source: string, runtime: string, root: string): string {
  const edits: Edit[] = [];
  const found = new Set<string>();
  let table: string[] = [];
  type Anchor = { position: number; prefix: string; inline: boolean; populated?: boolean };
  let serverAnchor: Anchor | undefined;
  let envAnchor: Anchor | undefined;
  const remoteFields = ['url', 'bearer_token_env_var', 'http_headers', 'env_http_headers', 'oauth'];
  const at = (value: string[], expected: string[]) =>
    value.length === expected.length && value.every((part, index) => part === expected[index]);
  const desired: Record<string, string> = {
    command: JSON.stringify(process.execPath),
    args: JSON.stringify([path.join(runtime, 'cli.js'), 'mcp']),
    'env.COBROWSER_HOME': JSON.stringify(root),
  };
  const remote = (key: string[]) =>
    key[0] === 'mcp_servers' && key[1] === 'cobrowser' && remoteFields.includes(key[2]);
  const visit = (key: string[], value: Span): void => {
    if (key[0] !== 'mcp_servers' || (key.length > 1 && key[1] !== 'cobrowser')) return;
    const relative = key.slice(2).join('.');
    if (
      (key.length === 3 && ['command', 'args'].includes(key[2])) ||
      at(key, ['mcp_servers', 'cobrowser', 'env', 'COBROWSER_HOME'])
    ) {
      edits.push({ ...value, value: desired[relative] });
      found.add(relative);
      return;
    }
    if (key.length > 2 && !at(key, ['mcp_servers', 'cobrowser', 'env'])) return;
    const tokens = tomlTokens(source, value.start, value.end);
    if (source[tokens[0].start] !== '{' || source[tokens.at(-1)!.start] !== '}')
      throw new Error('Unsupported inline MCP registration.');
    const members: Array<{ key: string[]; value: Span; start: number; comma?: Span }> = [];
    let start = 1;
    let depth = 0;
    for (let index = 1; index < tokens.length - 1; index++) {
      const token = tokens[index];
      const character = source[token.start];
      if (character === ',' && depth === 0) {
        members.push({
          ...assignment(source, tokens.slice(start, index)),
          start: tokens[start].start,
          comma: token,
        });
        start = index + 1;
      } else if ('[{'.includes(character)) depth++;
      else if (']}'.includes(character)) depth--;
    }
    if (start < tokens.length - 1)
      members.push({ ...assignment(source, tokens.slice(start, -1)), start: tokens[start].start });
    const kept = members.filter((member) => !remote([...key, ...member.key]));
    for (const member of members) {
      if (remote([...key, ...member.key]))
        edits.push({ start: member.start, end: member.value.end, value: '' });
      else visit([...key, ...member.key], member.value);
      if (
        member.comma &&
        (!kept.includes(member) || (member !== members.at(-1) && member === kept.at(-1)))
      )
        edits.push({ ...member.comma, value: '' });
    }
    const anchor: Anchor = {
      position: kept.at(-1)?.value.end ?? tokens[0].end,
      prefix: '',
      inline: true,
      populated: kept.length > 0,
    };
    if (at(key, ['mcp_servers', 'cobrowser'])) serverAnchor = anchor;
    if (at(key, ['mcp_servers', 'cobrowser', 'env'])) envAnchor = anchor;
  };
  for (const span of tomlStatements(source)) {
    const statement = source.slice(span.start, span.end);
    const header = /^\[\[?((?:"(?:[^"\\]|\\.)*"|'[^']*'|[^\]"'])+)\]\]?/.exec(statement);
    if (header) {
      table = dottedKey(header[1]);
      if (remote(table)) {
        edits.push({ ...span, value: '' });
        continue;
      }
      const newline = source.indexOf('\n', span.end);
      const position = newline < 0 ? source.length : newline + 1;
      if (at(table, ['mcp_servers', 'cobrowser']))
        serverAnchor = { position, prefix: '', inline: false };
      if (at(table, ['mcp_servers', 'cobrowser', 'env']))
        envAnchor = { position, prefix: '', inline: false };
    } else {
      if (remote(table)) {
        edits.push({ ...span, value: '' });
        continue;
      }
      const entry = assignment(source, tomlTokens(source, span.start, span.end));
      const fullKey = [...table, ...entry.key];
      if (
        fullKey[0] === 'mcp_servers' &&
        fullKey[1] === 'cobrowser' &&
        fullKey.length > 2 &&
        table.length <= 2
      )
        serverAnchor ??= {
          position: span.start,
          prefix:
            ['mcp_servers', 'cobrowser']
              .slice(table.length)
              .map((part) => JSON.stringify(part))
              .join('.') + (table.length < 2 ? '.' : ''),
          inline: false,
        };
      if (remote(fullKey)) edits.push({ ...span, value: '' });
      else visit(fullKey, entry.value);
    }
  }
  if (!serverAnchor) throw new Error('Unsupported MCP registration layout.');
  const insertions = new Map<Anchor, string[]>();
  for (const [key, value] of Object.entries(desired)) {
    if (found.has(key)) continue;
    const anchor = key === 'env.COBROWSER_HOME' && envAnchor ? envAnchor : serverAnchor;
    const name = anchor === envAnchor ? 'COBROWSER_HOME' : key;
    const entries = insertions.get(anchor) ?? [];
    entries.push(`${anchor.prefix}${name} = ${value}`);
    insertions.set(anchor, entries);
  }
  for (const [anchor, entries] of insertions) {
    let value = anchor.inline
      ? `${anchor.populated ? ', ' : ' '}${entries.join(', ')}`
      : `${entries.join('\n')}\n`;
    if (!anchor.inline && anchor.position > 0 && source[anchor.position - 1] !== '\n')
      value = `\n${value}`;
    edits.push({ start: anchor.position, end: anchor.position, value });
  }
  for (const edit of edits.sort((left, right) => right.start - left.start || right.end - left.end))
    source = source.slice(0, edit.start) + edit.value + source.slice(edit.end);
  return source;
}

async function readOptional(file: string): Promise<string | undefined> {
  try {
    return await fs.readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

async function installConfig(file: string, original: string | undefined, updated: string) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.cobrowser-${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, updated, { mode: 0o600, flag: 'wx' });
    if ((await readOptional(file)) !== original)
      throw new Error('Agent config changed during setup.');
    await fs.rename(temporary, file);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
  }
}

export async function updateAgentRegistration(
  command: AgentCommand,
  runtime: string,
  messages: string[],
): Promise<void> {
  const file = await executable(command);
  if (!file) return;
  const root = path.dirname(path.dirname(runtime));
  let staging: string | undefined;
  try {
    const configuredFile = configFile(command);
    const target = await fs.realpath(configuredFile).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return configuredFile;
      throw error;
    });
    const original = await readOptional(target);
    const claude = command === 'claude' ? json(original ?? '{}') : undefined;
    const previous = claude ? claudeEntry(claude) : undefined;
    const codex = command === 'codex' ? await codexEntry(file).catch(() => undefined) : undefined;
    const current = claude
      ? matches(previous, runtime, root)
      : codex && codexMatches(codex, runtime, root);
    if (current) {
      messages.push(`${command} MCP registration is current`);
      return;
    }
    staging = await fs.mkdtemp(path.join(os.tmpdir(), 'cobrowser-mcp-'));
    const stagedFile = path.join(staging, path.basename(configuredFile));
    if (claude) {
      const servers = object(claude.mcpServers) ? { ...claude.mcpServers } : {};
      delete servers.cobrowser;
      await fs.writeFile(stagedFile, JSON.stringify({ ...claude, mcpServers: servers }), {
        mode: 0o600,
      });
    } else if (original !== undefined) {
      await fs.writeFile(
        stagedFile,
        codex ? updateCodexSource(original, runtime, root) : original,
        { mode: 0o600 },
      );
    }
    const env = {
      ...process.env,
      HOME: staging,
      CLAUDE_CONFIG_DIR: staging,
      CODEX_HOME: staging,
    };
    if (!codex)
      await exec(
        file,
        [
          'mcp',
          'add',
          ...(command === 'claude' ? ['--scope', 'user'] : []),
          'cobrowser',
          '--env',
          `COBROWSER_HOME=${root}`,
          '--',
          process.execPath,
          path.join(runtime, 'cli.js'),
          'mcp',
        ],
        { env, cwd: staging, timeout: 10_000, maxBuffer: 1_000_000 },
      );
    let updated = await fs.readFile(stagedFile, 'utf8');
    if (claude) {
      const entry = claudeEntry(json(updated));
      if (!matches(entry, runtime, root) || !object(entry))
        throw new Error('Invalid MCP registration.');
      const oldEnv = object(previous) && object(previous.env) ? previous.env : {};
      const servers = object(claude.mcpServers) ? claude.mcpServers : {};
      updated = `${JSON.stringify(
        {
          ...claude,
          mcpServers: {
            ...servers,
            cobrowser: { ...entry, env: { ...oldEnv, ...(entry.env as JsonObject) } },
          },
        },
        null,
        2,
      )}\n`;
    } else if (!codexMatches(await codexEntry(file, env), runtime, root)) {
      throw new Error('Invalid MCP registration.');
    }
    await installConfig(target, original, updated);
    messages.push(`${command} MCP registration updated`);
  } catch {
    messages.push(
      `Could not update the ${command} MCP registration; check its config and run cobrowser setup again.`,
    );
  } finally {
    if (staging) await fs.rm(staging, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function inspectAgentRegistration(
  command: AgentCommand,
  runtime: string,
  lines: string[],
): Promise<boolean> {
  const file = await executable(command);
  if (!file) return true;
  const root = path.dirname(path.dirname(runtime));
  try {
    const codex = command === 'codex' ? await codexEntry(file) : undefined;
    if (codex?.enabled === false) {
      lines.push(
        'fix enable the codex cobrowser MCP server in its config, then run cobrowser doctor again',
      );
      return false;
    }
    const valid =
      command === 'claude'
        ? matches(claudeEntry(json(await fs.readFile(configFile(command), 'utf8'))), runtime, root)
        : codex !== undefined && codexMatches(codex, runtime, root);
    if (valid) {
      lines.push(`ok ${command} MCP registration is current`);
      return true;
    }
  } catch {
    // CLI errors can include credentials, so doctor reports only the repair command.
  }
  lines.push(`fix run cobrowser setup to repair the ${command} MCP registration`);
  return false;
}
