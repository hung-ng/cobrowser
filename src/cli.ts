import { CobrowserClient, liveBrowsers } from './client.js';
import { MAX_CHARS } from './shared/constants.js';
import { capText } from './shared/paging.js';

function takeFlag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const value = args[i + 1];
  args.splice(i, 2);
  return value;
}
function hasFlag(args: string[], name: string): boolean {
  const i = args.indexOf(name);
  if (i < 0) return false;
  args.splice(i, 1);
  return true;
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
    return JSON.stringify(minimal, null, 2).length <= maxChars
      ? JSON.stringify(minimal, null, 2)
      : JSON.stringify({ ok: Boolean(result?.ok) });
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
  return best || JSON.stringify({ ok: Boolean(result?.ok) });
}

function print(result: any, json: boolean, maxChars = MAX_CHARS) {
  if (json) {
    const output = jsonOutput(result, maxChars);
    process.stdout.write(output.length < maxChars ? `${output}\n` : output);
  } else if (result.ok) {
    const output = result.text || '';
    process.stdout.write(output.length < maxChars ? `${output}\n` : output);
  } else
    throw Object.assign(new Error(result.error?.message || 'The request failed. Try again.'), {
      code: result.error?.code,
    });
}

async function main() {
  const args = process.argv.slice(2);
  const json = hasFlag(args, '--json');
  const browser = takeFlag(args, '--browser');
  const maxChars = takeFlag(args, '--max-chars');
  const maxCharsValue = maxChars === undefined ? undefined : parseMaxChars(maxChars);
  const command = args.shift();
  if (command === 'browsers') {
    const browsers = await liveBrowsers();
    process.stdout.write(`${browsers.join('\n')}${browsers.length ? '\n' : ''}`);
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
    if (window) body.window = window === 'front' ? 'front' : Number(window);
    if (hasFlag(args, '--active')) body.active = true;
    const limit = takeFlag(args, '--limit');
    if (limit) body.limit = Number(limit);
    const offset = takeFlag(args, '--offset');
    if (offset) body.offset = Number(offset);
    if (maxCharsValue !== undefined) body.maxChars = maxCharsValue;
    print(
      await new CobrowserClient({ browser }).request('tabs', body),
      json,
      maxCharsValue ?? MAX_CHARS,
    );
    return;
  }
  if (command === 'read') {
    const id = Number(args.shift());
    if (!Number.isInteger(id))
      throw Object.assign(new Error('Usage: cobrowser read <id>.'), { code: 'BAD_REQUEST' });
    const body: Record<string, unknown> = { id };
    const section = takeFlag(args, '--section');
    if (section) body.section = Number(section);
    const page = takeFlag(args, '--page');
    if (page) body.page = Number(page);
    if (hasFlag(args, '--full')) body.full = true;
    if (hasFlag(args, '--links')) body.links = true;
    if (maxCharsValue !== undefined) body.maxChars = maxCharsValue;
    print(
      await new CobrowserClient({ browser }).request('read', body),
      json,
      maxCharsValue ?? MAX_CHARS,
    );
    return;
  }
  process.stdout.write('Usage: cobrowser tabs or cobrowser read <id>.\n');
}
function parseDuration(value: string): number {
  const match = /^(\d+(?:\.\d+)?)([smhd])$/.exec(value);
  if (!match)
    throw Object.assign(new Error('Use a duration such as 30m or 2h.'), { code: 'BAD_REQUEST' });
  const unit = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[
    match[2] as 's' | 'm' | 'h' | 'd'
  ];
  return Number(match[1]) * unit;
}
function parseMaxChars(value: string): number {
  const result = Number(value);
  if (!Number.isInteger(result) || result < 1)
    throw Object.assign(new Error('Use a positive character limit such as 20000.'), {
      code: 'BAD_REQUEST',
    });
  return result;
}
main().catch((error: any) => {
  process.stderr.write(`${error.code || 'ERROR'}: ${error.message}\n`);
  process.exitCode = 1;
});
