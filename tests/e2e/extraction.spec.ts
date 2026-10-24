import { test, expect, type BrowserContext, type Worker } from '@playwright/test';
import { execFile, spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, request, type Server } from 'node:http';
import path from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const root = path.resolve(import.meta.dirname, '../..');
const code = 'const message = `alpha\n\n\nomega`;\n\n\nconst literal = "[name](type) a_b *keep*";';
const ordinary = '<p>Ordinary context words.</p>'.repeat(30);
const exportedCode = [
  '# Root',
  '',
  'context '.repeat(1600),
  '',
  '- ```md',
  '  # literal heading',
  '  [list-code](type)',
  '  ```',
  '',
  '> ~~~md',
  '> [quoted-code](type)',
  '> ~~~',
  '>',
  '>     [indented-code](type)',
  '>',
  '> [prose link](https://example.test/source)',
  '',
  '## Actual',
  'Actual answer.',
  '',
  '# Other',
  'Other answer.',
].join('\n');
const quotedCode =
  '<pre><code>*literal* a_b\n&gt; *quoted* ~keep~</code></pre><p>Quoted <em>plain prose</em> remains.</p>';
const quoteFixtures = {
  quoted: `<blockquote>${quotedCode}</blockquote>`,
  nestedQuotes: `<blockquote><blockquote>${quotedCode}</blockquote></blockquote>`,
  listQuote: `<ul><li><blockquote>${quotedCode}</blockquote></li></ul>`,
  quoteList: `<blockquote><ul><li>${quotedCode}</li></ul></blockquote>`,
  nestedListQuote: `<ul><li><ul><li><blockquote>${quotedCode}</blockquote></li></ul></li></ul>`,
  quoteListQuote: `<blockquote><ul><li><blockquote>${quotedCode}</blockquote></li></ul></blockquote>`,
  listQuoteList: `<ol><li><blockquote><ul><li>${quotedCode}</li></ul></blockquote></li></ol>`,
};
const fixtures: Record<string, string> = {
  code: `<h1>Code sample</h1><pre><code>${code}</code></pre>${ordinary}`,
  search: `<h1>Literal punctuation</h1><p>Literal a_b and a*b.</p><p>Please <em>do not</em> enter.</p><p>Use <strong>bold and <em>nested</em></strong> labels.</p><p>Inline <code>a_b *keep* [name](type)</code> stays literal.</p>${ordinary}`,
  backticks:
    '<h1>Inline delimiters</h1><p>Use <code>x\\</code> here.</p><p>Keep <code>x\\*</code> literal.</p><p>Prose `<em>styled</em>` stays plain.</p><p>Escaped ` then <code>y\\</code> and <em>styled</em>.</p>' +
    ordinary,
  adjacentTicks: '<h1>Adjacent ticks</h1><p>`<code>[name](type)</code> remains.</p>' + ordinary,
  deleted: `<h1>Deleted prose</h1><p>Before <del>old</del> after.</p><p>Code <code>~literal~</code> remains.</p><p>Unpaired ~home and ~user.</p>${ordinary}`,
  ...Object.fromEntries(
    Object.entries(quoteFixtures).map(([name, html]) => [
      name,
      `<h1>Quoted code</h1>${html}${ordinary}`,
    ]),
  ),
  unicode: `<h1>Turkish notes</h1><p>${'İstanbul '.repeat(150)}NEEDLETARGET ${'tail '.repeat(50)}</p><p>${'🐈'.repeat(91)}SCALARMATCH${'🐈'.repeat(100)}</p><p>${'İstanbul '.repeat(150)}ΟΣ ${'tail '.repeat(50)}</p>${ordinary}`,
  sections:
    '<h1>Costs</h1><p>Plans.</p><h2>Monthly price</h2><p>$10</p><h2>Yearly price</h2><p>$100</p><h3>Cancellation is free</h3><p>Terms.</p><h1>Unselected sibling</h1><p>Other plan.</p>',
  outline: `<h1>Outline root</h1><p>Root intro.</p><h2>Outline child</h2><p>${'content '.repeat(1550)}</p><h1>Outline sibling</h1><p>Sibling only.</p>`,
  query:
    '<h1>Query controls</h1><div id="first" class="pick">First<br>line two<span hidden>Hidden extra</span></div><div id="empty" class="pick"><span style="display:none">Unavailable option</span></div><svg><text id="svg-text">Vector text</text></svg>',
};
type Seam = 'cli' | 'socket' | 'mcp';
const seams: Seam[] = ['cli', 'socket', 'mcp'];
let home = '';
let profile = '';
let context: BrowserContext;
let worker: Worker;
let server: Server;
const ids: Record<string, number> = {};

function raw(command: string, body: Record<string, unknown>): Promise<any> {
  return new Promise((resolve, reject) => {
    const req = request(
      { socketPath: path.join(home, 'run/chromium.sock'), path: `/v1/${command}`, method: 'POST' },
      (res) => {
        let output = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => (output += chunk));
        res.on('end', () => {
          try {
            resolve(JSON.parse(output));
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });
}

async function state() {
  const browser = await worker.evaluate(async () => ({
    tabs: (await chrome.tabs.query({}))
      .map(({ id, windowId, active, highlighted, url }) => ({
        id,
        windowId,
        active,
        highlighted,
        url,
      }))
      .sort((left, right) => left.id! - right.id!),
    focused: (await chrome.windows.getLastFocused({ windowTypes: ['normal'] })).id,
  }));
  const pages = await Promise.all(
    context
      .pages()
      .map((page) => page.evaluate(() => ({ url: location.href, x: scrollX, y: scrollY }))),
  );
  pages.sort((left, right) => left.url.localeCompare(right.url));
  return { browser, pages };
}

async function call(seam: Seam, command: string, params: Record<string, any>) {
  const before = await state();
  try {
    if (seam === 'socket') return await raw(command, params);
    const env = { ...process.env, COBROWSER_HOME: home };
    if (seam === 'cli') {
      const args = [command, String(params.id)];
      if (command === 'find') args.push(params.query);
      if (command === 'query') args.push(params.selector);
      for (const name of ['full', 'links', 'html']) if (params[name]) args.push(`--${name}`);
      for (const name of ['section', 'page', 'pageSize', 'maxChars', 'limit', 'offset'])
        if (params[name] !== undefined)
          args.push(
            `--${name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`,
            String(params[name]),
          );
      const result = await exec(
        process.execPath,
        [path.join(root, 'dist/cli.js'), '--browser', 'chromium', ...args, '--json'],
        { env },
      );
      return JSON.parse(result.stdout);
    }
    return await new Promise<any>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [path.join(root, 'dist/cli.js'), '--browser', 'chromium', 'mcp'],
        { env },
      );
      let output = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => (output += chunk));
      child.stderr.on('data', (chunk) => (stderr += chunk));
      child.on('error', reject);
      child.on('close', (code) => {
        if (code) return reject(new Error(stderr));
        try {
          const response = JSON.parse(output.trim());
          expect(response.error).toBeUndefined();
          expect(response.result.isError).not.toBe(true);
          resolve({
            ok: true,
            text: response.result.content[0].text,
            data: response.result.structuredContent?.data,
          });
        } catch (error) {
          reject(error);
        }
      });
      child.stdin.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: {
            name: { read: 'read_tab', find: 'find_in_tab', query: 'query_tab' }[command],
            arguments: params,
          },
        }) + '\n',
      );
    });
  } finally {
    expect(await state()).toEqual(before);
  }
}

function body(text: string): string {
  return text.slice(text.indexOf('\n\n') + 2);
}

test.describe('extraction correctness', () => {
  test.beforeAll(async () => {
    home = await mkdtemp('/tmp/cb-extract-');
    profile = await mkdtemp('/tmp/cb-extract-profile-');
    server = createServer((req, res) => {
      const name = req.url?.slice(1) || 'control';
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end(
        `<!doctype html><html><head><meta charset="utf-8"><title>Extraction ${name}</title></head><body>${fixtures[name] || '<p>Foreground control</p>'}<div style="height:2000px"></div></body></html>`,
      );
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const launcher = path.join(home, 'host.sh');
    await writeFile(
      launcher,
      `#!/bin/sh\nexport COBROWSER_HOME='${home}'\nexec '${process.execPath}' '${path.join(root, 'dist/helper.js')}' --browser chromium\n`,
    );
    await chmod(launcher, 0o755);
    await mkdir(path.join(profile, 'NativeMessagingHosts'), { recursive: true });
    await writeFile(
      path.join(profile, 'NativeMessagingHosts/cobrowser.json'),
      JSON.stringify({
        name: 'cobrowser',
        description: 'Extraction tests',
        path: launcher,
        type: 'stdio',
        allowed_origins: ['chrome-extension://laeencopealhcofijafpfkicblippbnp/'],
      }),
    );
    const extension = path.join(root, 'dist/extension');
    const { chromium } = await import('@playwright/test');
    context = await chromium.launchPersistentContext(profile, {
      channel: 'chromium',
      headless: process.env.HEADED !== '1',
      args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
    });
    await context.route('https://docs.google.com/document/d/markdown-review/**', async (route) => {
      const exporting = new URL(route.request().url()).pathname.endsWith('/export');
      await route.fulfill({
        contentType: exporting ? 'text/markdown' : 'text/html',
        body: exporting ? exportedCode : '<html><body>Exported code document.</body></html>',
      });
    });
    await expect
      .poll(() => context.serviceWorkers().find((item) => item.url().includes('service-worker')))
      .toBeTruthy();
    worker = context.serviceWorkers().find((item) => item.url().includes('service-worker'))!;
    const foreground = context.pages()[0];
    await foreground.goto(`${url}/control`);
    for (const name of Object.keys(fixtures)) {
      const page = await context.newPage();
      await page.goto(`${url}/${name}`);
      await page.evaluate(() => window.scrollTo(0, 75));
      ids[name] = await worker.evaluate(
        async (href) => (await chrome.tabs.query({ url: href }))[0].id!,
        page.url(),
      );
    }
    const exported = await context.newPage();
    await exported.goto('https://docs.google.com/document/d/markdown-review/edit');
    ids.exported = await worker.evaluate(
      async (href) => (await chrome.tabs.query({ url: href }))[0].id!,
      exported.url(),
    );
    await foreground.bringToFront();
    await foreground.evaluate(() => window.scrollTo(0, 125));
    await expect
      .poll(async () => {
        try {
          const before = await state();
          const result = await raw('status', {});
          expect(await state()).toEqual(before);
          return result.data?.connected;
        } catch {
          return false;
        }
      })
      .toBe(true);
  });

  test.afterAll(async () => {
    await context?.close();
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    if (home) await rm(home, { recursive: true, force: true });
    if (profile) await rm(profile, { recursive: true, force: true });
  });

  for (const seam of seams) {
    test(`${seam} preserves inline code next to an escaped prose tick`, async () => {
      const read = await call(seam, 'read', { id: ids.adjacentTicks, full: true });
      expect(read.text).toContain('[name](type)');
      const found = await call(seam, 'find', { id: ids.adjacentTicks, query: '[name](type)' });
      expect(found.data.matches).toEqual([{ line: '`[name](type) remains.', section: '1' }]);
    });

    test(`${seam} keeps exported code literal and section numbers consistent`, async () => {
      const outline = await call(seam, 'read', { id: ids.exported });
      expect(outline.text).toContain('1.1. Actual');
      expect(outline.text).not.toContain('literal heading');
      expect(outline.data.sections.map(({ number, title }: any) => ({ number, title }))).toEqual([
        { number: '1', title: 'Root' },
        { number: '1.1', title: 'Actual' },
        { number: '2', title: 'Other' },
      ]);
      const read = await call(seam, 'read', { id: ids.exported, section: '1' });
      expect(read.text).toContain('  # literal heading');
      expect(read.text).toContain('> prose link');
      expect(read.text).not.toContain('https://example.test/source');
      expect(read.text).not.toContain('Other answer.');
      for (const literal of ['[list-code](type)', '[quoted-code](type)', '[indented-code](type)']) {
        expect(read.text).toContain(literal);
        const found = await call(seam, 'find', { id: ids.exported, query: literal });
        expect(found.data.matches).toEqual([{ line: literal, section: '1' }]);
      }
      const found = await call(seam, 'find', { id: ids.exported, query: 'Actual answer.' });
      expect(found.data.matches).toEqual([{ line: 'Actual answer.', section: '1.1' }]);
      const selected = await call(seam, 'read', { id: ids.exported, section: '1.1' });
      expect(selected.text).toContain('## Actual\nActual answer.');
      expect(selected.text).not.toContain('literal heading');
      expect(selected.text).not.toContain('Other answer.');
    });

    test(`${seam} preserves code whitespace and literal Markdown`, async () => {
      for (const links of [false, true]) {
        const result = await call(seam, 'read', { id: ids.code, full: true, links });
        expect(result.ok).toBe(true);
        expect(body(result.text)).toContain(`\n${code}\n`);
      }
    });

    test(`${seam} searches rendered prose and literal code`, async () => {
      for (const query of [
        'a_b',
        'a*b',
        'Please do not enter.',
        'bold and nested',
        'a_b *keep* [name](type)',
      ]) {
        const result = await call(seam, 'find', { id: ids.search, query });
        expect(result.ok).toBe(true);
        expect(result.data.matches.length).toBeGreaterThan(0);
        expect(
          result.data.matches.some((match: { line: string }) => match.line.includes(query)),
        ).toBe(true);
      }
      const missing = await call(seam, 'find', { id: ids.search, query: 'absent phrase' });
      expect(missing.data.matches).toEqual([]);
    });

    test(`${seam} keeps Unicode matches and scalar boundaries in excerpts`, async () => {
      for (const [query, expected] of [
        ['NEEDLETARGET', 'NEEDLETARGET'],
        ['SCALARMATCH', 'SCALARMATCH'],
        ['ος', 'ΟΣ'],
        ['i\u0307', 'İ'],
      ]) {
        const result = await call(seam, 'find', { id: ids.unicode, query });
        expect(result.ok).toBe(true);
        const line = result.data.matches[0].line;
        expect(line).toContain(expected);
        expect(line.length).toBeLessThanOrEqual(200);
        expect(line).not.toMatch(/[\ud800-\udfff]/u);
      }
    });

    test(`${seam} finds inline code with trailing backslashes and escaped prose ticks`, async () => {
      const candidate = await call(seam, 'find', { id: ids.backticks, query: 'x\\' });
      expect(
        candidate.data.matches.some((match: { line: string }) => match.line === 'Use x\\ here.'),
      ).toBe(true);
      for (const query of [
        'x\\ here.',
        'x\\* literal.',
        '`styled` stays plain.',
        'y\\ and styled.',
      ]) {
        const result = await call(seam, 'find', { id: ids.backticks, query });
        expect(result.ok).toBe(true);
        expect(result.data.matches.length).toBeGreaterThan(0);
        expect(
          result.data.matches.some((match: { line: string }) => match.line.includes(query)),
        ).toBe(true);
      }
    });

    test(`${seam} preserves code in blockquote and list containers`, async () => {
      for (const name of Object.keys(quoteFixtures)) {
        const read = await call(seam, 'read', { id: ids[name], full: true });
        expect(read.text).toContain('*literal* a_b');
        for (const query of ['*literal* a_b', '> *quoted* ~keep~', 'Quoted plain prose remains.']) {
          const found = await call(seam, 'find', { id: ids[name], query });
          expect(found.data.matches.some((match: { line: string }) => match.line === query)).toBe(
            true,
          );
        }
        const altered = await call(seam, 'find', { id: ids[name], query: 'literal a_b' });
        expect(altered.data.matches).toEqual([]);
      }
    });

    test(`${seam} searches converter strikethrough while preserving code and literal tildes`, async () => {
      const read = await call(seam, 'read', { id: ids.deleted, full: true });
      expect(read.text).toContain('Before ~old~ after.');
      for (const query of [
        'Before old after.',
        'Code ~literal~ remains.',
        'Unpaired ~home and ~user.',
      ]) {
        const found = await call(seam, 'find', { id: ids.deleted, query });
        expect(found.data.matches.some((match: { line: string }) => match.line === query)).toBe(
          true,
        );
      }
    });

    test(`${seam} retains selected headings and excludes sibling sections`, async () => {
      const result = await call(seam, 'read', { id: ids.sections, full: true, section: '1' });
      expect(result.ok).toBe(true);
      expect(body(result.text)).toBe(
        '# Costs\n\nPlans.\n\n## Monthly price\n\n$10\n\n## Yearly price\n\n$100\n\n### Cancellation is free\n\nTerms.',
      );
      expect(result.data.sections.map((section: { number: string }) => section.number)).toEqual([
        '1',
        '1.1',
        '1.2',
        '1.2.1',
        '2',
      ]);
      const child = await call(seam, 'read', { id: ids.sections, full: true, section: '1.2' });
      expect(body(child.text)).toBe(
        '## Yearly price\n\n$100\n\n### Cancellation is free\n\nTerms.',
      );
      const found = await call(seam, 'find', { id: ids.sections, query: 'Cancellation is free' });
      expect(found.data.matches[0].section).toBe('1.2.1');
      const outline = await call(seam, 'read', { id: ids.outline });
      const heading = outline.data.sections.find(
        (section: { title: string }) => section.title === 'Outline child',
      );
      expect(outline.text).toContain(`${heading.number}. Outline child`);
      const selected = await call(seam, 'read', { id: ids.outline, section: heading.number });
      expect(body(selected.text)).toContain('## Outline child');
      expect(body(selected.text)).not.toContain('Sibling only.');
      const located = await call(seam, 'find', { id: ids.outline, query: 'Outline child' });
      expect(located.data.matches[0].section).toBe(heading.number);
    });

    test(`${seam} keeps empty rendered query text and SVG fallback`, async () => {
      const empty = await call(seam, 'query', { id: ids.query, selector: '#empty' });
      expect(empty.text).toBe('1. ');
      expect(empty.data.values).toEqual(['']);
      const ordered = await call(seam, 'query', { id: ids.query, selector: '#empty, #first' });
      expect(ordered.data.values).toEqual(['First\nline two', '']);
      const svg = await call(seam, 'query', { id: ids.query, selector: '#svg-text' });
      expect(svg.data.values).toEqual(['Vector text']);
      const html = await call(seam, 'query', { id: ids.query, selector: '#empty', html: true });
      expect(html.text).toContain('Unavailable option');
    });
  }
});
