import fsp from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { CobrowserClient, browserStatuses } from './client.js';
import {
  MAX_CHARS,
  MAX_SCREENSHOT_CHARS,
  normalizeErrorCode,
  VERSION,
} from './shared/constants.js';
import { capText } from './shared/paging.js';
import { parseDuration as parseDurationValue } from './shared/duration.js';
import { redactEmbeddedUrls } from './shared/url.js';
import { runMcp } from './mcp.js';
import { isSectionNumber } from './shared/sections.js';
import {
  detectBrowsers,
  doctor,
  isSimpleBrowserName,
  setup,
  SUPPORTED_BROWSERS,
  type SupportedBrowser,
} from './setup.js';

let jsonRequested = false;
let jsonMaxChars = MAX_CHARS;

function takeFlag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const value = args[i + 1];
  if (!value || value.startsWith('--'))
    throw Object.assign(new Error(`Use ${name} with a value.`), { code: 'BAD_REQUEST' });
  args.splice(i, 2);
  return value;
}

function ensureNoArgs(args: string[]) {
  if (args.length)
    throw Object.assign(new Error(`Unknown argument: ${args[0]}.`), { code: 'BAD_REQUEST' });
}
function hasFlag(args: string[], name: string): boolean {
  const i = args.indexOf(name);
  if (i < 0) return false;
  args.splice(i, 1);
  return true;
}
function minimalJson(maxChars: number, array = false, ok?: boolean): string {
  const status = ok === undefined ? '' : JSON.stringify({ ok });
  if (status && status.length <= maxChars) return status;
  const empty = array ? '[]' : '{}';
  return empty.length <= maxChars ? empty : '0';
}
function jsonOutput(result: any, maxChars: number): string {
  const full = JSON.stringify(result, null, 2);
  if (full.length <= maxChars) return full;
  if (result?.data !== undefined) {
    const withoutData = { ...result };
    delete withoutData.data;
    const compact = JSON.stringify(withoutData, null, 2);
    if (compact.length <= maxChars) return compact;
    result = withoutData;
  }
  const text = typeof result?.text === 'string' ? result.text : '';
  if (!text) {
    const minimal = result?.error
      ? { ok: false, error: { code: result.error.code, message: '' } }
      : { ok: Boolean(result?.ok) };
    const pretty = JSON.stringify(minimal, null, 2);
    if (pretty.length <= maxChars) return pretty;
    const compact = JSON.stringify(minimal);
    return compact.length <= maxChars ? compact : minimalJson(maxChars, false, Boolean(result?.ok));
  }
  const textForCap = (value: string, cap: number) => {
    const continuation = /\n\n(next|more): (.+)$/.exec(value);
    if (!continuation) return value.slice(0, cap);
    return capText(value.slice(0, continuation.index), cap, continuation[2], continuation[1]).text;
  };
  let low = 0;
  let high = text.length;
  let best = '';
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = JSON.stringify({ ...result, text: textForCap(text, middle) }, null, 2);
    if (candidate.length <= maxChars) {
      best = candidate;
      low = middle + 1;
    } else high = middle - 1;
  }
  return best || minimalJson(maxChars, false, Boolean(result?.ok));
}

function boundedJson(value: unknown, maxChars: number): string {
  const stringify = (candidate: unknown) => JSON.stringify(candidate, null, 2);
  const full = stringify(value);
  if (full.length <= maxChars) return full;
  if (Array.isArray(value)) {
    const items: unknown[] = [];
    for (const item of value) {
      const candidate = [...items, item];
      if (stringify(candidate).length > maxChars) break;
      items.push(item);
    }
    const empty = stringify(items);
    return empty.length <= maxChars ? empty : minimalJson(maxChars, true);
  }
  if (value && typeof value === 'object') {
    const reduced = { ...(value as Record<string, unknown>) };
    for (const [key, item] of Object.entries(reduced)) {
      if (!Array.isArray(item)) continue;
      const kept: unknown[] = [];
      for (const entry of item) {
        const candidate = { ...reduced, [key]: [...kept, entry] };
        if (stringify(candidate).length > maxChars) break;
        kept.push(entry);
      }
      reduced[key] = kept;
    }
    if (stringify(reduced).length <= maxChars) return stringify(reduced);
    for (const key of Object.keys(reduced).reverse()) {
      delete reduced[key];
      if (stringify(reduced).length <= maxChars) return stringify(reduced);
    }
    return stringify({}).length <= maxChars
      ? stringify({})
      : minimalJson(
          maxChars,
          false,
          typeof (value as { ok?: unknown }).ok === 'boolean'
            ? (value as { ok: boolean }).ok
            : undefined,
        );
  }
  const empty = stringify(null);
  return empty.length <= maxChars ? empty : '0';
}

function safeTerminalText(value: string): string {
  return value.replace(/[\u0000-\u0008\u000b\u000c\r\u000e-\u001f\u007f]/g, ' ');
}

function writeBoundedText(value: string, maxChars: number) {
  const output = capText(safeTerminalText(value), maxChars).text;
  process.stdout.write(output.length < maxChars ? `${output}\n` : output);
}

function print(result: any, json: boolean, maxChars = MAX_CHARS) {
  if (json) {
    const output = jsonOutput(result, maxChars);
    process.stdout.write(output.length < maxChars ? `${output}\n` : output);
    if (!result.ok) process.exitCode = 1;
  } else if (result.ok) {
    const output = safeTerminalText(result.text || '');
    process.stdout.write(output.length < maxChars ? `${output}\n` : output);
  } else
    throw Object.assign(new Error(result.error?.message || 'The request failed. Try again.'), {
      code: result.error?.code,
    });
}

const USAGE = `cobrowser tabs [options]
cobrowser read <id...> [options]
cobrowser find <id> "text"
cobrowser query <id> "selector" [--html]
cobrowser selection [id]
cobrowser screenshot [--out path]
cobrowser log [--limit N]
cobrowser browsers
cobrowser setup [--browser name[,name...]] [--native-hosts-dir dir]
cobrowser doctor
cobrowser mcp

Global options: --browser name, --json, --max-chars N, --help, --version
`;

async function main() {
  const args = process.argv.slice(2);
  const json = hasFlag(args, '--json');
  jsonRequested = json;
  const help = hasFlag(args, '--help');
  const version = hasFlag(args, '--version');
  const browser = takeFlag(args, '--browser');
  const maxChars = takeFlag(args, '--max-chars');
  const maxCharsValue = maxChars === undefined ? undefined : parseMaxChars(maxChars);
  const outputMaxChars = maxCharsValue ?? MAX_CHARS;
  jsonMaxChars = maxCharsValue ?? MAX_CHARS;
  const command = args.shift();
  if (help) {
    writeBoundedText(USAGE, outputMaxChars);
    return;
  }
  if (version) {
    writeBoundedText(VERSION, outputMaxChars);
    return;
  }
  if (!command || command === 'help' || command === '--help') {
    writeBoundedText(USAGE, outputMaxChars);
    return;
  }
  if (command === 'version' || command === '--version') {
    writeBoundedText(VERSION, outputMaxChars);
    return;
  }
  if (command === 'browsers') {
    ensureNoArgs(args);
    const result = await browserStatuses();
    if (json) {
      const output = boundedJson(result, maxCharsValue ?? MAX_CHARS);
      process.stdout.write(output.length < (maxCharsValue ?? MAX_CHARS) ? `${output}\n` : output);
    } else if (!result.length)
      writeBoundedText(
        'No browser helpers are configured. Run cobrowser setup.',
        maxCharsValue ?? MAX_CHARS,
      );
    else
      writeBoundedText(
        result
          .map(
            (item) =>
              `${item.browser}\t${item.running ? 'running' : 'offline'}${item.connected === undefined ? '' : `\t${item.connected ? 'connected' : 'extension offline'}`}`,
          )
          .join('\n'),
        maxCharsValue ?? MAX_CHARS,
      );
    return;
  }
  if (command === 'mcp') {
    ensureNoArgs(args);
    await runMcp(browser);
    return;
  }
  if (command === 'setup') {
    const requested = browser || takeFlag(args, '--browser');
    const nativeHostsDir = takeFlag(args, '--native-hosts-dir');
    ensureNoArgs(args);
    const requestedNames = requested
      ? [
          ...new Set(
            requested
              .split(',')
              .map((name) => name.trim().toLowerCase())
              .filter(Boolean),
          ),
        ]
      : detectBrowsers();
    const invalid = requestedNames.filter((name) => !isSimpleBrowserName(name));
    if (invalid.length)
      throw Object.assign(new Error(`Use simple browser names: ${invalid.join(', ')}.`), {
        code: 'BAD_REQUEST',
      });
    if (nativeHostsDir && requestedNames.length !== 1)
      throw Object.assign(new Error('Use --native-hosts-dir with one browser.'), {
        code: 'BAD_REQUEST',
      });
    const unsupported = requestedNames.filter(
      (name) => !(SUPPORTED_BROWSERS as readonly string[]).includes(name),
    );
    if (unsupported.length && !nativeHostsDir)
      throw Object.assign(new Error(`Unsupported browser: ${unsupported.join(', ')}.`), {
        code: 'BAD_REQUEST',
      });
    const browsers = nativeHostsDir
      ? requestedNames
      : requestedNames.filter((name): name is SupportedBrowser =>
          (SUPPORTED_BROWSERS as readonly string[]).includes(name),
        );
    if (!browsers.length)
      throw Object.assign(new Error(`Use a supported browser: ${SUPPORTED_BROWSERS.join(', ')}.`), {
        code: 'BAD_REQUEST',
      });
    const lines = await setup(browsers, { nativeHostsDir });
    if (json) {
      const output = boundedJson({ ok: true, lines }, maxCharsValue ?? MAX_CHARS);
      process.stdout.write(output.length < (maxCharsValue ?? MAX_CHARS) ? `${output}\n` : output);
    } else writeBoundedText(lines.join('\n'), maxCharsValue ?? MAX_CHARS);
    return;
  }
  if (command === 'doctor') {
    ensureNoArgs(args);
    const result = await doctor();
    if (json) {
      const output = boundedJson(result, maxCharsValue ?? MAX_CHARS);
      process.stdout.write(output.length < (maxCharsValue ?? MAX_CHARS) ? `${output}\n` : output);
    } else writeBoundedText(result.lines.join('\n'), maxCharsValue ?? MAX_CHARS);
    if (!result.ok) process.exitCode = 1;
    return;
  }
  if (command === 'tabs') {
    const body: Record<string, unknown> = {};
    body.match = takeFlag(args, '--match');
    const since = takeFlag(args, '--since');
    if (since) {
      body.since = since;
      body.sinceMs = parseDuration(since);
    }
    const window = takeFlag(args, '--window');
    if (window) {
      if (window !== 'front' && (!Number.isSafeInteger(Number(window)) || Number(window) < 0))
        throw Object.assign(new Error('Use --window front or a numeric window id.'), {
          code: 'BAD_REQUEST',
        });
      body.window = window === 'front' ? 'front' : Number(window);
    }
    if (hasFlag(args, '--active')) body.active = true;
    const limit = takeFlag(args, '--limit');
    if (limit !== undefined) body.limit = parseIntegerFlag(limit, '--limit');
    const offset = takeFlag(args, '--offset');
    if (offset !== undefined) body.offset = parseIntegerFlag(offset, '--offset', 0);
    if (maxCharsValue !== undefined) body.maxChars = maxCharsValue;
    ensureNoArgs(args);
    print(
      await new CobrowserClient({ browser }).request('tabs', body),
      json,
      maxCharsValue ?? MAX_CHARS,
    );
    return;
  }
  if (command === 'read') {
    const ids: number[] = [];
    while (args.length && !args[0].startsWith('-')) ids.push(Number(args.shift()));
    if (!ids.length || ids.some((id) => !Number.isSafeInteger(id)))
      throw Object.assign(new Error('Usage: cobrowser read <id>.'), { code: 'BAD_REQUEST' });
    const body: Record<string, unknown> = ids.length === 1 ? { id: ids[0] } : { ids };
    const section = takeFlag(args, '--section');
    if (section !== undefined) {
      if (!isSectionNumber(section))
        throw Object.assign(new Error('Use a non-negative section number.'), {
          code: 'BAD_REQUEST',
        });
      body.section = section;
    }
    const page = takeFlag(args, '--page');
    if (page) body.page = parseIntegerFlag(page, '--page');
    if (hasFlag(args, '--full')) body.full = true;
    if (hasFlag(args, '--links')) body.links = true;
    if (maxCharsValue !== undefined) body.maxChars = maxCharsValue;
    ensureNoArgs(args);
    print(
      await new CobrowserClient({ browser }).request('read', body),
      json,
      maxCharsValue ?? MAX_CHARS,
    );
    return;
  }
  if (command === 'find') {
    const id = Number(args.shift());
    const unknown = args.find((value) => value.startsWith('--'));
    if (unknown)
      throw Object.assign(new Error(`Unknown argument: ${unknown}.`), { code: 'BAD_REQUEST' });
    const query = args.join(' ').trim();
    if (!Number.isSafeInteger(id) || !query)
      throw Object.assign(new Error('Usage: cobrowser find <id> "text".'), { code: 'BAD_REQUEST' });
    const body: Record<string, unknown> = { id, query };
    if (maxCharsValue !== undefined) body.maxChars = maxCharsValue;
    print(
      await new CobrowserClient({ browser }).request('find', body),
      json,
      maxCharsValue ?? MAX_CHARS,
    );
    return;
  }
  if (command === 'query') {
    const id = Number(args.shift());
    const selector = args.shift();
    if (!Number.isSafeInteger(id) || !selector)
      throw Object.assign(new Error('Usage: cobrowser query <id> "css selector".'), {
        code: 'BAD_REQUEST',
      });
    const body: Record<string, unknown> = { id, selector };
    if (hasFlag(args, '--html')) body.html = true;
    const limit = takeFlag(args, '--limit');
    if (limit !== undefined) body.limit = parseIntegerFlag(limit, '--limit');
    if (maxCharsValue !== undefined) body.maxChars = maxCharsValue;
    ensureNoArgs(args);
    print(
      await new CobrowserClient({ browser }).request('query', body),
      json,
      maxCharsValue ?? MAX_CHARS,
    );
    return;
  }
  if (command === 'selection') {
    const idText = args[0]?.startsWith('-') ? undefined : args.shift();
    const body: Record<string, unknown> = {};
    if (idText !== undefined) {
      const id = Number(idText);
      if (!Number.isSafeInteger(id))
        throw Object.assign(new Error('Usage: cobrowser selection [id].'), { code: 'BAD_REQUEST' });
      body.id = id;
    }
    if (maxCharsValue !== undefined) body.maxChars = maxCharsValue;
    ensureNoArgs(args);
    print(
      await new CobrowserClient({ browser }).request('selection', body),
      json,
      maxCharsValue ?? MAX_CHARS,
    );
    return;
  }
  if (command === 'screenshot') {
    const windowId = takeFlag(args, '--window');
    const out = takeFlag(args, '--out');
    const body: Record<string, unknown> = {};
    if (windowId !== undefined) {
      body.windowId = parseIntegerFlag(windowId, '--window', 0);
    }
    body.maxChars = MAX_SCREENSHOT_CHARS;
    ensureNoArgs(args);
    const result = await new CobrowserClient({ browser }).request('screenshot', body);
    if (!result.ok) return print(result, json, maxCharsValue ?? MAX_CHARS);
    const dataUrl = result.data?.dataUrl;
    const match = typeof dataUrl === 'string' && /^data:image\/png;base64,(.+)$/.exec(dataUrl);
    if (!match)
      throw Object.assign(new Error('The browser returned no PNG screenshot.'), {
        code: 'UNREADABLE',
      });
    const target = out || path.join(os.tmpdir(), `cobrowser-${randomUUID()}.png`);
    try {
      await fsp.writeFile(target, Buffer.from(match[1], 'base64'));
      await fsp.chmod(target, 0o600);
    } catch {
      throw Object.assign(new Error(`The screenshot could not be saved to ${target}.`), {
        code: 'BAD_REQUEST',
      });
    }
    if (json) {
      print(
        {
          ok: true,
          text: target,
          data: {
            path: target,
            windowId: result.data.windowId,
            tabId: result.data.tabId,
            title: result.data.title,
          },
        },
        true,
        maxCharsValue ?? MAX_CHARS,
      );
      return;
    }
    writeBoundedText(target, maxCharsValue ?? MAX_CHARS);
    return;
  }
  if (command === 'log') {
    const limit = takeFlag(args, '--limit');
    const body: Record<string, unknown> = {};
    if (limit !== undefined) body.limit = parseIntegerFlag(limit, '--limit');
    if (maxCharsValue !== undefined) body.maxChars = maxCharsValue;
    ensureNoArgs(args);
    print(
      await new CobrowserClient({ browser }).request('log', body),
      json,
      maxCharsValue ?? MAX_CHARS,
    );
    return;
  }
  throw Object.assign(
    new Error(
      'Usage: cobrowser tabs, read, find, query, selection, screenshot, log, browsers, setup, doctor, or mcp.',
    ),
    { code: 'BAD_REQUEST' },
  );
}
function parseDuration(value: string): number {
  try {
    return parseDurationValue(value);
  } catch (error) {
    throw Object.assign(error instanceof Error ? error : new Error(String(error)), {
      code: 'BAD_REQUEST',
    });
  }
}
function parseMaxChars(value: string): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 1)
    throw Object.assign(new Error('Use a positive character limit such as 20000.'), {
      code: 'BAD_REQUEST',
    });
  return result;
}

function parseIntegerFlag(value: string, name: string, minimum = 1): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < minimum)
    throw Object.assign(new Error(`Use a whole number of at least ${minimum} for ${name}.`), {
      code: 'BAD_REQUEST',
    });
  return result;
}
main().catch((error: any) => {
  const code = normalizeErrorCode(error?.code);
  const message = redactEmbeddedUrls(
    String(error?.message || 'The command failed.')
      .replace(/[\u0000-\u001f\u007f]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim(),
  ).slice(0, 500);
  if (jsonRequested) {
    const output = jsonOutput({ ok: false, error: { code, message } }, jsonMaxChars);
    process.stdout.write(output.length < jsonMaxChars ? `${output}\n` : output);
  } else {
    const output = capText(`${code}: ${message}`, jsonMaxChars).text;
    process.stderr.write(output.length < jsonMaxChars ? `${output}\n` : output);
  }
  process.exitCode = 1;
});
