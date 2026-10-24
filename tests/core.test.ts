import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { deflateRawSync, deflateSync } from 'node:zlib';
import { PassThrough, Readable } from 'node:stream';
import path from 'node:path';
import {
  browserStatuses,
  cobrowserHome,
  CobrowserClient,
  guessAgent,
  liveBrowsers,
  parseClientResponse,
  readResponseBody,
  serializeClientRequest,
} from '../src/client.js';
import {
  DEFAULT_DENYLIST,
  MAX_DENYLIST_ENTRIES,
  matchesDenylist,
  normalizeDenylist,
  normalizeDenylistPattern,
} from '../src/shared/denylist.js';
import { filterTabs } from '../src/shared/filters.js';
import { shellCommandArg } from '../src/shared/command.js';
import { NativeFrameDecoder, encodeFrame } from '../src/shared/native.js';
import { capResponse, capText, splitPages } from '../src/shared/paging.js';
import { convertSnapshot, convertSpecialSnapshot } from '../src/shared/read.js';
import {
  buildSectionTree,
  flattenSections,
  isSectionNumber,
  MAX_SECTION_NUMBER_CHARS,
} from '../src/shared/sections.js';
import { findInMarkdown } from '../src/shared/search.js';
import { googleExportUrl, isPdfUrl, specialKind } from '../src/shared/special.js';
import { normalizeOpenTimes } from '../src/shared/open-times.js';
import { redactEmbeddedUrls, redactUrl } from '../src/shared/url.js';
import {
  browserHostDirectory,
  isSimpleBrowserName,
  isCobrowserSkill,
  isNativeHostManifest,
  isLauncherScript,
  launcherScript,
  launcherNodePath,
  nativeHostManifest,
} from '../src/setup.js';
import { normalizeErrorCode, VERSION } from '../src/shared/constants.js';
import { MAX_RPC_LINE_BYTES, readMcpLines } from '../src/mcp.js';

describe('filters', () => {
  const tabs = [
    {
      id: 1,
      windowId: 1,
      active: false,
      title: 'GitHub issue',
      url: 'https://github.com/a',
      openedAt: 10,
      lastAccessed: 10,
    },
    {
      id: 2,
      windowId: 1,
      active: true,
      title: 'Docs',
      url: 'https://docs.test',
      lastAccessed: 20,
    },
    {
      id: 3,
      windowId: 2,
      active: true,
      title: 'Recent GitHub',
      url: 'https://github.com/b',
      openedAt: 25,
      lastAccessed: 30,
    },
  ];

  it('matches every search word and sorts newest opens first', () => {
    const result = filterTabs(tabs, { match: 'github issue', now: 30 });

    expect(result.map((tab) => tab.id)).toEqual([1]);
  });

  it('treats tabs without open times as older than a since filter', () => {
    const result = filterTabs(tabs, { sinceMs: 15, now: 30 });

    expect(result.map((tab) => tab.id)).toEqual([3]);
  });

  it('filters the front window and active tabs', () => {
    const result = filterTabs(tabs, { window: 'front', active: true }, 2);

    expect(result.map((tab) => tab.id)).toEqual([3]);
  });

  it('keeps offset pagination stable after sorting', () => {
    const result = filterTabs(
      [
        { ...tabs[0], openedAt: 10 },
        { ...tabs[1], openedAt: 20 },
        { ...tabs[2], openedAt: 30 },
      ],
      {},
    );

    expect(result.slice(1, 3).map((tab) => tab.id)).toEqual([2, 1]);
  });
});

describe('sections', () => {
  it('preserves multi-digit dotted section labels', () => {
    expect(isSectionNumber('1.10')).toBe(true);
    expect(isSectionNumber('0')).toBe(true);
    expect(isSectionNumber('1.')).toBe(false);
    expect(isSectionNumber('-1')).toBe(false);
    expect(isSectionNumber(Number.NaN)).toBe(false);
    expect(isSectionNumber('1'.repeat(MAX_SECTION_NUMBER_CHARS + 1))).toBe(false);
  });

  it('creates section zero for preamble text', () => {
    const sections = flattenSections(buildSectionTree('Preamble\n\n# One\nText'));

    expect(sections[0]).toMatchObject({ number: '0', title: 'Introduction' });
  });

  it('numbers a skipped h1 to h3 level as a child', () => {
    const sections = flattenSections(buildSectionTree('# One\n## Two\n### Three'));

    expect(sections.map((section) => section.number)).toEqual(['1', '1.1', '1.1.1']);
  });

  it('gives duplicate titles distinct numbers', () => {
    const sections = flattenSections(buildSectionTree('# Same\ntext\n# Same\nmore'));

    expect(sections.map((section) => [section.number, section.title])).toEqual([
      ['1', 'Same'],
      ['2', 'Same'],
    ]);
  });
});

describe('paging', () => {
  it('splits at paragraph breaks', () => {
    expect(splitPages('aaaa\n\nbbbb', 4)).toEqual(['aaaa', 'bbbb']);
  });

  it('keeps a long paragraph within the page cap', () => {
    expect(splitPages('abcdefghij', 4)).toEqual(['abcd', 'efgh', 'ij']);
  });

  it('clamps an invalid page cap instead of looping', () => {
    expect(splitPages('abc', 0)).toEqual(['a', 'b', 'c']);
  });

  it('adds a continuation command without exceeding the cap', () => {
    const result = capText('a'.repeat(100), 80, 'cobrowser read 1 --section 2 --page 3', 'next');

    expect(result.truncated).toBe(true);
    expect(result.text).toContain('next: cobrowser read 1 --section 2 --page 3');
    expect(result.text.length).toBeLessThanOrEqual(80);
  });

  it('caps structured responses after dropping oversized metadata', () => {
    const result = capResponse(
      {
        ok: true,
        text: `${'content '.repeat(200)}\n\nnext: cobrowser read 1 --page 2`,
        data: { values: ['x'.repeat(10_000)] },
      },
      180,
    );

    expect(JSON.stringify(result).length).toBeLessThanOrEqual(180);
    expect(result.data).toBeUndefined();
    expect(result.text).toContain('next: cobrowser read 1 --page 2');

    const shortPrefix = capResponse(
      {
        ok: true,
        text: `${'header '.repeat(23)}\n\nnext: cobrowser read 1 --page 2`,
        data: { values: ['x'.repeat(10_000)] },
      },
      180,
    );
    expect(shortPrefix.text).toContain('next: cobrowser read 1 --page 2');

    const tiny = capResponse(
      { ok: true, text: 'body\n\nnext: cobrowser read 1 --page 2', data: { value: 'large' } },
      20,
    );
    expect(JSON.stringify(tiny).length).toBeLessThanOrEqual(20);
    expect(tiny).toEqual({ ok: true });

    const protocolOnly = capResponse(
      { ok: true, text: '\n\nmore: cobrowser tabs --offset 1', data: { tabs: [] } },
      10,
    );
    expect(protocolOnly).toEqual({ ok: true });

    const error = capResponse(
      { ok: false, error: { code: 'BAD_REQUEST', message: 'x'.repeat(1_000) } },
      180,
    );
    expect(JSON.stringify(error).length).toBeLessThanOrEqual(180);
    expect(error).toMatchObject({ ok: false, error: { code: 'BAD_REQUEST' } });
    expect((error.error as { message?: string }).message?.length).toBeLessThan(1_000);
  });
});

describe('continuation commands', () => {
  it('shell-quotes arguments that contain metacharacters', () => {
    expect(shellCommandArg('plain-value')).toBe('plain-value');
    expect(shellCommandArg('$(touch /tmp/cobrowser-pwned)')).toBe(
      "'$(touch /tmp/cobrowser-pwned)'",
    );
    expect(shellCommandArg("it's")).toBe("'it'\\''s'");
    expect(shellCommandArg('line\nseparator')).toBe("'line separator'");
  });
});

describe('error codes', () => {
  it('keeps protocol codes printable and bounded', () => {
    expect(normalizeErrorCode('TAB_NOT_FOUND')).toBe('TAB_NOT_FOUND');
    expect(normalizeErrorCode('BAD\nCODE')).toBe('ERROR');
    expect(normalizeErrorCode('bad-code')).toBe('ERROR');
    expect(normalizeErrorCode(undefined, 'BAD_REQUEST')).toBe('BAD_REQUEST');
    expect(normalizeErrorCode(undefined, 'bad\ncode')).toBe('ERROR');
  });
});

describe('denylist', () => {
  it('canonicalizes individual patterns before storing them', () => {
    expect(normalizeDenylistPattern(' *.BANK.TEST/ ')).toBe('bank.test');
    expect(normalizeDenylistPattern('https://bank.test')).toBeUndefined();
  });

  it('falls back to defaults for malformed non-empty storage', () => {
    expect(normalizeDenylist([null, 42])).toEqual(DEFAULT_DENYLIST);
    expect(normalizeDenylist([])).toEqual([]);
    expect(normalizeDenylist(['bank.test', null])).toEqual(['bank.test']);
    expect(normalizeDenylist([' *.BANK.TEST/ ', 'https://unsafe.test', 'bad value', '*'])).toEqual([
      'bank.test',
    ]);
    expect(normalizeDenylist(['*'])).toEqual(DEFAULT_DENYLIST);
    expect(normalizeDenylist([`long.test/${'x'.repeat(2_048)}`])).toEqual(DEFAULT_DENYLIST);
    expect(
      normalizeDenylist(
        Array.from({ length: MAX_DENYLIST_ENTRIES + 1 }, (_, i) => `site${i}.test`),
      ),
    ).toHaveLength(MAX_DENYLIST_ENTRIES);
  });

  it('matches subdomains and path prefixes', () => {
    expect(matchesDenylist('https://mail.google.com/x', ['google.com'])).toBe(true);
    expect(matchesDenylist('https://mail.google.com./x', ['google.com'])).toBe(true);
    expect(matchesDenylist('https://icloud.com/mail/inbox', ['icloud.com/mail'])).toBe(true);
    expect(matchesDenylist('https://icloud.com/mail%2Finbox', ['icloud.com/mail'])).toBe(true);
    expect(matchesDenylist('https://icloud.com/photos', ['icloud.com/mail'])).toBe(false);
  });
});

describe('native framing', () => {
  it('rejects values that cannot be encoded as JSON', () => {
    expect(() => encodeFrame(undefined)).toThrow('JSON-serializable');
  });

  it('decodes several frames from one chunk', () => {
    const decoder = new NativeFrameDecoder();
    const first = encodeFrame({ id: 1, ok: true });
    const second = encodeFrame({ id: 2, ok: false });

    expect(decoder.push(Buffer.concat([first, second]))).toEqual([
      { id: 1, ok: true },
      { id: 2, ok: false },
    ]);
  });

  it('handles a frame split across chunks', () => {
    const decoder = new NativeFrameDecoder();
    const frame = encodeFrame({ id: 3, ok: true });

    expect(decoder.push(frame.subarray(0, 2))).toEqual([]);
    expect(decoder.push(frame.subarray(2))).toEqual([{ id: 3, ok: true }]);
  });
});

describe('agent names', () => {
  it('uses the Claude Code name', () => {
    expect(guessAgent({ CLAUDECODE: '1' })).toBe('claude-code');
  });

  it('uses the Codex name for variables Codex sets on its commands', () => {
    expect(guessAgent({ CODEX_THREAD_ID: 'abc' })).toBe('codex');
    expect(guessAgent({ CODEX_THREAD_ID: 'abc', CLAUDECODE: '1' })).toBe('codex');
  });

  it('ignores CODEX_HOME because people set it globally', () => {
    expect(guessAgent({ CODEX_HOME: '/tmp/codex' })).toBe('cli');
  });

  it('falls back to cli', () => {
    expect(guessAgent({})).toBe('cli');
  });
});

describe('open times', () => {
  it('keeps only finite timestamps keyed by tab ids', () => {
    expect(
      normalizeOpenTimes({
        '12': 100,
        '00012': 200,
        '0': 0,
        bad: 200,
        '13': '300',
        '14': Number.NaN,
        '15': 1e100,
      }),
    ).toEqual({ '0': 0, '12': 200 });
    expect(normalizeOpenTimes(['12'])).toEqual({});
  });
});

describe('socket discovery', () => {
  it('resolves a relative configured home before using it', () => {
    const previous = process.env.COBROWSER_HOME;
    try {
      process.env.COBROWSER_HOME = 'relative-cobrowser-home';
      expect(cobrowserHome()).toBe(path.resolve('relative-cobrowser-home'));
    } finally {
      if (previous === undefined) delete process.env.COBROWSER_HOME;
      else process.env.COBROWSER_HOME = previous;
    }
  });

  it('reports configured helpers that are not running', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'cobrowser-status-'));
    try {
      await mkdir(path.join(home, 'hosts'));
      await writeFile(path.join(home, 'hosts', 'chromium'), '');
      await writeFile(path.join(home, 'hosts', 'bad name'), '');
      expect(await browserStatuses(home)).toEqual([{ browser: 'chromium', running: false }]);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('keeps registry browsers visible when their launcher is missing', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'cobrowser-registry-status-'));
    try {
      await writeFile(
        path.join(home, 'config.json'),
        JSON.stringify({ configuredBrowsers: ['opera', 'bad name', 42] }),
      );
      expect(await browserStatuses(home)).toEqual([{ browser: 'opera', running: false }]);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('rejects browser names that could escape the run directory', () => {
    expect(() => new CobrowserClient({ browser: '../other' })).toThrow('simple browser name');
  });

  it('rejects timeout values outside the Node timer range', () => {
    expect(() => new CobrowserClient({ timeoutMs: 0 })).toThrow('timeoutMs');
    expect(() => new CobrowserClient({ responseTimeoutMs: Number.POSITIVE_INFINITY })).toThrow(
      'responseTimeoutMs',
    );
    expect(() => new CobrowserClient({ timeoutMs: 2_147_483_648 })).toThrow('timeoutMs');
  });

  it('canonicalizes browser names before finding their socket', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'cobrowser-browser-name-'));
    try {
      await expect(
        new CobrowserClient({ home, browser: 'Chrome' }).request('tabs'),
      ).rejects.toMatchObject({
        code: 'BROWSER_OFFLINE',
      });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('rejects command paths before looking for a browser socket', async () => {
    await expect(
      new CobrowserClient({ browser: 'chrome' }).request('../tabs'),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('ignores stale socket files', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'cobrowser-client-'));
    const run = path.join(home, 'run');
    await mkdir(run);
    await writeFile(path.join(run, 'stale.sock'), '');
    try {
      expect(await liveBrowsers(home)).toEqual([]);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('rejects a socket path that cannot work on macOS', async () => {
    const home = `/tmp/${'cobrowser-home-'.padEnd(90, 'x')}`;
    await expect(
      new CobrowserClient({ home, browser: 'chrome' }).request('tabs'),
    ).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    const unicodeHome = `/tmp/${'é'.repeat(45)}`;
    await expect(
      new CobrowserClient({ home: unicodeHome, browser: 'chrome' }).request('tabs'),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });
});

describe('client response limits', () => {
  it('rejects an oversized helper response before buffering it all', async () => {
    const response = new PassThrough();
    const body = readResponseBody(response as unknown as import('node:http').IncomingMessage, 4);
    response.end('12345');

    await expect(body).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('rejects a response whose declared size already exceeds the cap', async () => {
    const response = Object.assign(new PassThrough(), { headers: { 'content-length': '5' } });
    const body = readResponseBody(response as unknown as import('node:http').IncomingMessage, 4);
    response.end('1234');

    await expect(body).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('handles duplicate content-length headers safely', async () => {
    const response = Object.assign(new PassThrough(), {
      headers: { 'content-length': ['5', '5'] },
    });
    const body = readResponseBody(response as unknown as import('node:http').IncomingMessage, 4);
    response.end('1234');

    await expect(body).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('handles a late response error after rejecting an oversized response', async () => {
    const response = Object.assign(new PassThrough(), { headers: { 'content-length': '5' } });
    const body = readResponseBody(response as unknown as import('node:http').IncomingMessage, 4);
    response.emit('error', new Error('late response failure'));

    await expect(body).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('fails promptly when the helper aborts a response', async () => {
    const response = new PassThrough();
    const body = readResponseBody(response as unknown as import('node:http').IncomingMessage);
    response.emit('aborted');

    await expect(body).rejects.toMatchObject({ code: 'BROWSER_OFFLINE' });
  });

  it('fails promptly when the helper closes a response before its body completes', async () => {
    const response = new PassThrough();
    const body = readResponseBody(response as unknown as import('node:http').IncomingMessage);
    response.emit('close');

    await expect(body).rejects.toMatchObject({ code: 'BROWSER_OFFLINE' });
  });
});

describe('client request limits', () => {
  it('serializes bounded JSON request bodies before opening a socket', () => {
    expect(serializeClientRequest({ query: 'hello' })).toBe('{"query":"hello"}');
    expect(() => serializeClientRequest({ query: 'x'.repeat(1_000_001) })).toThrow(
      'request body is too large',
    );
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => serializeClientRequest(circular)).toThrow('request body must be valid JSON');
  });
});

describe('client response validation', () => {
  it('rejects a successful response whose text is not a string', async () => {
    expect(() => parseClientResponse({ ok: true, text: { invalid: true } })).toThrow(
      'invalid data',
    );
  });

  it('bounds and cleans helper error messages', () => {
    const result = parseClientResponse({
      ok: false,
      error: {
        code: 'BAD_REQUEST',
        message: `bad https://user:pass@example.test/private\n${'x'.repeat(600)}`,
      },
    });
    expect(result.error?.message).toContain('https://example.test/private');
    expect(result.error?.message).not.toContain('user:pass');
    expect(result.error?.message.length).toBeLessThanOrEqual(500);

    const edge = parseClientResponse({
      ok: false,
      error: {
        code: 'BAD_REQUEST',
        message: `${'x'.repeat(490)}https://user:pass@example.test/private`,
      },
    });
    expect(edge.error?.message).not.toContain('user:pass');
  });
});

describe('MCP input limits', () => {
  it('discards an oversized line and resumes at the next request', async () => {
    const lines = readMcpLines(
      Readable.from([
        Buffer.alloc(MAX_RPC_LINE_BYTES + 1, 0x61),
        Buffer.from('\n{"jsonrpc":"2.0","id":1,"method":"ping"}\n'),
      ]),
    );
    const result = [];
    for await (const item of lines) result.push(item);
    expect(result).toEqual([
      { tooLarge: true },
      { tooLarge: false, line: '{"jsonrpc":"2.0","id":1,"method":"ping"}' },
    ]);
  });
});

describe('page conversion', () => {
  const snapshot = {
    url: 'https://bsky.app/post/1',
    title: 'Post',
    html: `<html><body><nav>Navigation</nav><article><h1>Post</h1><p>${'main '.repeat(100)}</p></article></body></html>`,
  };

  it('marks supported feed hosts', () => {
    expect(convertSnapshot(snapshot).note).toBe('more may load on scroll');
  });

  it('supports full-body conversion', () => {
    expect(convertSnapshot(snapshot).markdown).not.toContain('Navigation');
    expect(convertSnapshot(snapshot, true).markdown).toContain('Navigation');
  });

  it('suggests a screenshot for a canvas page with little text', () => {
    expect(
      convertSnapshot({
        url: 'https://figma.com/file/1',
        title: 'Canvas',
        html: '<html><body><canvas></canvas></body></html>',
        canvas: true,
      }).note,
    ).toContain('try screenshot');
  });

  it('removes terminal control bytes from page text', () => {
    expect(
      convertSnapshot({
        url: 'https://example.test/control',
        title: 'Control',
        html: '<html><body><p>safe\u001b[31m text</p><img alt="bad\u001b[32m" src="/x" /></body></html>',
      }).markdown,
    ).not.toContain('\u001b');
  });
});

describe('search and special documents', () => {
  it('returns matches with their section number and a bounded line', () => {
    const matches = findInMarkdown('# One\nhello world\n## Two\nworld again', 'WORLD');
    expect(matches).toEqual([
      { section: '1', line: 'hello world' },
      { section: '1.1', line: 'world again' },
    ]);
    const long = findInMarkdown(`# One\n${'a'.repeat(180)}needle${'b'.repeat(180)}`, 'needle');
    expect(long[0].line).toContain('needle');
    expect(long[0].line.length).toBeLessThanOrEqual(200);
  });

  it('maps Google URLs to session export URLs', () => {
    expect(googleExportUrl('https://docs.google.com/spreadsheets/d/abc/edit#gid=42')).toMatchObject(
      {
        kind: 'google-sheet',
        url: 'https://docs.google.com/spreadsheets/d/abc/export?format=csv&gid=42',
      },
    );
    expect(googleExportUrl('https://docs.google.com/document/d/abc/edit')?.kind).toBe('google-doc');
    expect(googleExportUrl('https://docs.google.com/presentation/d/abc/edit')?.kind).toBe(
      'google-slide',
    );
    expect(isPdfUrl('https://example.test/paper.PDF')).toBe(true);
    expect(isPdfUrl('https://example.test/viewer', 'application/pdf; charset=binary')).toBe(true);
    expect(isPdfUrl('https://example.test/viewer', ' application/pdf ; charset=binary')).toBe(true);
    expect(specialKind('https://example.test/viewer', 'application/pdf')).toBe('pdf');
  });

  it('extracts simple PDF text and turns CSV exports into a table', () => {
    const pdf = Buffer.from(
      'BT (Hello PDF) Tj (Oct\\101) Tj (Line\\\nBreak) Tj (Nested (PDF)) Tj <4> Tj [<FEFF00480069>] TJ ET',
      'latin1',
    ).toString('base64');
    expect(
      convertSpecialSnapshot({
        url: 'https://example.test/paper.pdf',
        title: 'Paper',
        html: '',
        special: { kind: 'pdf', base64: pdf },
      }).markdown,
    ).toContain('Hello PDF');
    expect(
      convertSpecialSnapshot({
        url: 'https://example.test/paper.pdf',
        title: 'Paper',
        html: '',
        special: { kind: 'pdf', base64: pdf },
      }).markdown,
    ).toContain('OctA');
    expect(
      convertSpecialSnapshot({
        url: 'https://example.test/paper.pdf',
        title: 'Paper',
        html: '',
        special: { kind: 'pdf', base64: pdf },
      }).markdown,
    ).toContain('LineBreak');
    expect(
      convertSpecialSnapshot({
        url: 'https://example.test/paper.pdf',
        title: 'Paper',
        html: '',
        special: { kind: 'pdf', base64: pdf },
      }).markdown,
    ).toContain('Nested (PDF)');
    expect(
      convertSpecialSnapshot({
        url: 'https://example.test/paper.pdf',
        title: 'Paper',
        html: '',
        special: { kind: 'pdf', base64: pdf },
      }).markdown,
    ).toContain('@');
    expect(
      convertSpecialSnapshot({
        url: 'https://example.test/paper.pdf',
        title: 'Paper',
        html: '',
        special: { kind: 'pdf', base64: pdf },
      }).markdown,
    ).toContain('Hi');
    const outlinedPdf = Buffer.from(
      [
        '1 0 obj\n<< /Type /Catalog /Pages 2 0 R /Outlines 6 0 R >>\nendobj',
        '2 0 obj\n<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>\nendobj',
        '3 0 obj\n<< /Type /Page /Parent 2 0 R /Contents 5 0 R >>\nendobj',
        '4 0 obj\n<< /Type /Page /Parent 2 0 R /Contents 7 0 R >>\nendobj',
        '5 0 obj\n<< /Length 24 >>\nstream\nBT (First page) Tj ET\nendstream\nendobj',
        '7 0 obj\n<< /Length 25 >>\nstream\nBT (Second page) Tj ET\nendstream\nendobj',
        '6 0 obj\n<< /Type /Outlines /First 8 0 R >>\nendobj',
        '8 0 obj\n<< /Title (Chapter one) /Parent 6 0 R /Dest [3 0 R /Fit] /Next 9 0 R >>\nendobj',
        '9 0 obj\n<< /Title (Chapter two) /Parent 6 0 R /Dest [4 0 R /Fit] >>\nendobj',
      ].join('\n'),
      'latin1',
    ).toString('base64');
    const outlined = convertSpecialSnapshot({
      url: 'https://example.test/outlined.pdf',
      title: 'Outlined PDF',
      html: '',
      special: { kind: 'pdf', base64: outlinedPdf },
    });
    expect(outlined.markdown).toContain('# Chapter one\n\nFirst page');
    expect(outlined.markdown).toContain('# Chapter two\n\nSecond page');
    expect(outlined.pages).toEqual(['# Chapter one\n\nFirst page', '# Chapter two\n\nSecond page']);
    expect(outlined.pagesAreDocumentPages).toBe(true);
    expect(flattenSections(outlined.sections).map((section) => section.title)).toEqual([
      'Chapter one',
      'Chapter two',
    ]);
    expect(
      convertSpecialSnapshot({
        url: 'https://docs.google.com/spreadsheets/d/a/edit',
        title: 'Sheet',
        html: '',
        special: { kind: 'google-sheet', text: 'Name,Score\nAda,10' },
      }).markdown,
    ).toContain('| Ada | 10 |');
    expect(
      convertSpecialSnapshot({
        url: 'https://docs.google.com/spreadsheets/d/a/edit',
        title: 'BOM sheet',
        html: '',
        special: { kind: 'google-sheet', text: '\uFEFFName,Score\nAda,10' },
      }).markdown,
    ).toMatch(/^\| Name \| Score \|/);
    expect(
      convertSpecialSnapshot({
        url: 'https://docs.google.com/spreadsheets/d/a/edit',
        title: 'Empty sheet',
        html: '',
        special: { kind: 'google-sheet', text: ' \n' },
      }).markdown,
    ).toBe('The exported document was empty.');
    const compressed = deflateRawSync(Buffer.from('BT (Compressed PDF) Tj ET', 'latin1')).toString(
      'latin1',
    );
    const compressedPdf = Buffer.from(
      `%PDF-1.4\n1 0 obj\n<< /Filter /FlateDecode >>\nstream\n${compressed}\nendstream\nendobj`,
      'latin1',
    ).toString('base64');
    expect(
      convertSpecialSnapshot({
        url: 'https://example.test/compressed.pdf',
        title: 'PDF',
        html: '',
        special: { kind: 'pdf', base64: compressedPdf },
      }).markdown,
    ).toContain('Compressed PDF');
    const zlibCompressed = deflateSync(Buffer.from('BT <00480069> Tj ET', 'latin1')).toString(
      'latin1',
    );
    const zlibPdf = Buffer.from(
      `%PDF-1.4\n1 0 obj\n<< /Filter /FlateDecode >>\nstream\n${zlibCompressed}\nendstream\nendobj`,
      'latin1',
    ).toString('base64');
    expect(
      convertSpecialSnapshot({
        url: 'https://example.test/zlib.pdf',
        title: 'PDF',
        html: '',
        special: { kind: 'pdf', base64: zlibPdf },
      }).markdown,
    ).toContain('Hi');
    const oversizedStream = deflateRawSync(
      Buffer.from(`${'x'.repeat(8 * 1024 * 1024)}BT (Too large) Tj ET`, 'latin1'),
    ).toString('latin1');
    const oversizedPdf = Buffer.from(
      `%PDF-1.4\n1 0 obj\n<< /Filter /FlateDecode >>\nstream\n${oversizedStream}\nendstream\nendobj`,
      'latin1',
    ).toString('base64');
    expect(
      convertSpecialSnapshot({
        url: 'https://example.test/oversized.pdf',
        title: 'PDF',
        html: '',
        special: { kind: 'pdf', base64: oversizedPdf },
      }).markdown,
    ).toContain('PDF text could not be extracted');
    expect(() =>
      convertSpecialSnapshot({
        url: 'https://example.test/deep.pdf',
        title: 'Deep PDF',
        html: '',
        special: {
          kind: 'pdf',
          base64: Buffer.from(`${'['.repeat(200)}<4869> Tj${']'.repeat(200)}`, 'latin1').toString(
            'base64',
          ),
        },
      }),
    ).not.toThrow();
  });
});

describe('setup files', () => {
  it('recovers an absolute Node path with spaces and quotes from a managed launcher', () => {
    const runtime = '/tmp/cobrowser/runtime/0.1.0';
    const nodePath = "/tmp/Node versions/it's node";
    expect(launcherNodePath(launcherScript(runtime, 'arc', nodePath), runtime, 'arc')).toBe(
      nodePath,
    );
    expect(isLauncherScript(launcherScript(runtime, 'arc', 'node'), runtime, 'arc')).toBe(false);
  });
  it('accepts custom browser names without path separators', () => {
    expect(isSimpleBrowserName('opera')).toBe(true);
    expect(isSimpleBrowserName('my.browser-1')).toBe(true);
    expect(isSimpleBrowserName('../other')).toBe(false);
  });

  it('keeps the source handshake version available in tests', () => {
    const packageVersion = (
      JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
        version: string;
      }
    ).version;
    expect(VERSION).toBe(packageVersion);
  });

  it('validates cobrowser skill frontmatter with either line ending', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'cobrowser-skill-test-'));
    const file = path.join(directory, 'SKILL.md');
    try {
      await writeFile(file, '---\r\nname: cobrowser\r\n---\r\ncontent');
      expect(isCobrowserSkill(file)).toBe(true);
      await writeFile(file, 'user-owned content');
      expect(isCobrowserSkill(file)).toBe(false);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('generates stable native host files for both desktop layouts', () => {
    expect(browserHostDirectory('chrome', '/home/test', 'darwin')).toBe(
      '/home/test/Library/Application Support/Google/Chrome/NativeMessagingHosts',
    );
    expect(browserHostDirectory('brave', '/home/test', 'linux')).toBe(
      '/home/test/.config/BraveSoftware/Brave-Browser/NativeMessagingHosts',
    );
    const launcher = launcherScript('/tmp/cobrowser/runtime/0.1.0', 'arc', '/usr/bin/node');
    expect(launcher).toContain("export COBROWSER_HOME='/tmp/cobrowser'");
    expect(launcher).toContain("exec '/usr/bin/node'");
    expect(isLauncherScript(launcher, '/tmp/cobrowser/runtime/0.1.0', 'arc')).toBe(true);
    expect(isLauncherScript(launcher, '/tmp/cobrowser/runtime/0.1.0', 'chrome')).toBe(false);
    expect(
      isLauncherScript(
        launcher.replace('\nexec ', '\nrm -rf /tmp\nexec '),
        '/tmp/cobrowser/runtime/0.1.0',
        'arc',
      ),
    ).toBe(false);
    expect(nativeHostManifest('/tmp/cobrowser/hosts/arc')).toMatchObject({
      name: 'cobrowser',
      path: '/tmp/cobrowser/hosts/arc',
      type: 'stdio',
    });
  });

  it('validates the native host contract before checking the launcher file', () => {
    const launcher = '/tmp/cobrowser/hosts/chromium';
    expect(isNativeHostManifest(nativeHostManifest(launcher), launcher)).toBe(true);
    expect(
      isNativeHostManifest({ ...nativeHostManifest(launcher), type: 'browser' }, launcher),
    ).toBe(false);
    expect(
      isNativeHostManifest(
        { ...nativeHostManifest(launcher), allowed_origins: ['chrome-extension://other/'] },
        launcher,
      ),
    ).toBe(false);
    expect(
      isNativeHostManifest(
        {
          ...nativeHostManifest(launcher),
          allowed_origins: [
            nativeHostManifest(launcher).allowed_origins[0],
            'chrome-extension://other/',
          ],
        },
        launcher,
      ),
    ).toBe(false);
    expect(isNativeHostManifest(nativeHostManifest('/tmp/other'), launcher)).toBe(false);
  });
});

describe('URL redaction', () => {
  it('removes basic-auth credentials while preserving ordinary URLs', () => {
    expect(redactUrl('https://user:pass@example.test/private?q=1')).toBe(
      'https://example.test/private?q=1',
    );
    expect(redactUrl('https://example.test/private?q=1')).toBe('https://example.test/private?q=1');
    expect(redactUrl('not a URL')).toBe('not a URL');
  });

  it('removes credentials from URLs embedded in returned text', () => {
    expect(
      redactEmbeddedUrls(
        'See https://user:pass@example.test/private and https://example.test/public.',
      ),
    ).toBe('See https://example.test/private and https://example.test/public.');
  });
});
