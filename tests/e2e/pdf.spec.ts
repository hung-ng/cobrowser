import { test as base, expect } from '@playwright/test';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import path from 'node:path';
import { promisify } from 'node:util';
import { extensionBuildRevision } from '../../src/shared/extension-build.js';
import { PROTOCOL_VERSION, VERSION } from '../../src/shared/constants.js';
import {
  pdfFixture,
  pdfTextPage,
  type PdfOutlineFixture,
  type PdfPageFixture,
} from '../fixtures/pdf.js';

const exec = promisify(execFile);
const root = path.resolve(import.meta.dirname, '../..');

interface PdfHelper {
  add: (pages: PdfPageFixture[], outline?: PdfOutlineFixture[]) => number;
  cli: (...args: string[]) => Promise<string>;
  request: (command: string, params: Record<string, unknown>) => Promise<any>;
}

const test = base.extend<{ pdf: PdfHelper }>({
  pdf: async ({}, use) => {
    const home = await mkdtemp('/tmp/cb-pdf-');
    const env = {
      ...process.env,
      COBROWSER_HOME: home,
      FORCE_COLOR: undefined,
      NO_COLOR: undefined,
    };
    const child = spawn(process.execPath, [path.join(root, 'dist/helper.js'), '--browser', 'pdf'], {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const tabs = new Map<
      number,
      {
        id: number;
        windowId: number;
        active: boolean;
        title: string;
        url: string;
        status: string;
        documentEpoch: string;
      }
    >();
    const snapshots = new Map<number, unknown>();
    const methods: string[] = [];
    let pending = Buffer.alloc(0);
    let stderr = '';
    const frame = (message: unknown) => {
      const bytes = Buffer.from(JSON.stringify(message));
      const length = Buffer.alloc(4);
      length.writeUInt32LE(bytes.length);
      return Buffer.concat([length, bytes]);
    };
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.stdout.on('data', (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk]);
      while (pending.length >= 4) {
        const size = pending.readUInt32LE(0);
        if (pending.length < size + 4) break;
        const message = JSON.parse(pending.subarray(4, size + 4).toString('utf8'));
        pending = pending.subarray(size + 4);
        if (message.id === undefined) continue;
        methods.push(message.method);
        let result: unknown;
        if (message.method === 'guard') {
          const checked = new Map<number, { id: number; documentEpoch: string }>();
          for (const { id, documentEpoch } of [
            ...(message.params.access?.tabs ?? []),
            ...(message.params.tabs ?? []),
          ])
            checked.set(id, { id, documentEpoch });
          result = {
            pauseEpoch: 'pdf-fixture',
            access: {
              policyEpoch: 'pdf-fixture-policy',
              tabs: [...checked.values()],
            },
          };
        } else if (message.method === 'tab') result = tabs.get(message.params.id);
        else if (message.method === 'read') result = snapshots.get(message.params.id);
        else {
          child.stdin.write(
            frame({
              id: message.id,
              ok: false,
              error: {
                code: 'BAD_REQUEST',
                message: 'The fixture received an unexpected browser command.',
              },
            }),
          );
          continue;
        }
        child.stdin.write(frame({ id: message.id, ok: true, result }));
      }
    });
    child.stdin.write(
      frame({
        event: 'hello',
        data: {
          version: VERSION,
          protocol: PROTOCOL_VERSION,
          extensionRevision: extensionBuildRevision(path.join(root, 'dist/extension')),
        },
      }),
    );
    const request: PdfHelper['request'] = (command, params) =>
      new Promise((resolve, reject) => {
        const req = httpRequest(
          { socketPath: path.join(home, 'run/pdf.sock'), path: `/v1/${command}`, method: 'POST' },
          (response) => {
            let body = '';
            response.on('data', (chunk) => {
              body += String(chunk);
            });
            response.on('end', () => {
              try {
                resolve(JSON.parse(body));
              } catch (error) {
                reject(error);
              }
            });
          },
        );
        req.on('error', reject);
        req.setTimeout(10_000, () => req.destroy(new Error('The fixture helper did not respond.')));
        req.end(JSON.stringify(params));
      });
    const originalTabs: unknown[] = [];
    try {
      await expect
        .poll(async () => {
          try {
            return (await request('read', { id: 999 })).ok === false;
          } catch {
            return false;
          }
        })
        .toBe(true);
      await use({
        add(pages, outline = []) {
          const id = tabs.size + 1;
          const tab = {
            id,
            windowId: 1,
            active: false,
            title: `PDF ${id}`,
            url: `https://example.test/${id}.pdf`,
            status: 'complete',
            documentEpoch: `pdf-document-${id}`,
          };
          tabs.set(id, tab);
          originalTabs.push(structuredClone(tab));
          snapshots.set(id, {
            url: tab.url,
            title: tab.title,
            html: '',
            documentEpoch: tab.documentEpoch,
            special: { kind: 'pdf', base64: pdfFixture(pages, outline).toString('base64') },
          });
          return id;
        },
        async cli(...args) {
          return (
            await exec(
              process.execPath,
              [path.join(root, 'dist/cli.js'), '--browser', 'pdf', ...args],
              { env, timeout: 10_000 },
            )
          ).stdout;
        },
        request,
      });
      expect([...tabs.values()]).toEqual(originalTabs);
      expect(methods.every((method) => ['guard', 'tab', 'read'].includes(method))).toBe(true);
      expect(stderr).toBe('');
    } finally {
      child.stdin.end();
      const exited = once(child, 'exit');
      const timeout = setTimeout(() => child.kill('SIGKILL'), 5_000);
      await exited;
      clearTimeout(timeout);
      await rm(home, { recursive: true, force: true });
    }
  },
});

test('redacts PDF credentials through whole, physical-page, section and search reads', async ({
  pdf,
}) => {
  const id = pdf.add(
    [pdfTextPage('Read https://user:secret@example.test/private'), pdfTextPage('Second page')],
    [{ title: 'https://admin:password@example.test/title', page: 0 }],
  );
  const outputs = await Promise.all([
    pdf.cli('read', String(id), '--json'),
    pdf.cli('read', String(id), '--page', '1', '--json'),
    pdf.request('read', { id, page: 1 }),
    pdf.request('read', { id, section: '1' }),
    pdf.cli('find', String(id), 'private', '--json'),
  ]);
  for (const output of outputs) {
    const serialized = typeof output === 'string' ? output : JSON.stringify(output);
    for (const secret of ['user:', 'secret', 'admin:', 'password'])
      expect(serialized).not.toContain(secret);
    expect(serialized).toContain('https://example.test/private');
  }
});

test('preserves PDF text containing operator and object terminators', async ({ pdf }) => {
  const id = pdf.add([
    pdfTextPage('BETA report, BT and ET, endobj and endstream are literal text.'),
    pdfTextPage('METHODS and results'),
  ]);
  const first = await pdf.request('read', { id, page: 1 });
  expect(first.ok).toBe(true);
  expect(first.data.pages).toBe(2);
  expect(first.text).toContain('BETA report, BT and ET, endobj and endstream are literal text.');
  const second = await pdf.request('read', { id, page: 2 });
  expect(second.text).toContain('METHODS and results');
  expect(second.text).not.toContain('BETA report');
});

test('makes unoutlined physical pages readable as separate sections', async ({ pdf }) => {
  const id = pdf.add([pdfTextPage('Alpha '.repeat(800)), pdfTextPage('Beta '.repeat(800))]);
  const overview = JSON.parse(await pdf.cli('read', String(id), '--json'));
  expect(overview.data.pages).toBe(2);
  expect(overview.data.sections).toMatchObject([
    { number: '1', title: 'Page 1', words: 803 },
    { number: '2', title: 'Page 2', words: 803 },
  ]);
  expect(overview.text).toContain('1. Page 1 (803 words)');
  expect(overview.text).toContain('2. Page 2 (803 words)');
  const section = await pdf.request('read', { id, section: '1' });
  expect(section.ok).toBe(true);
  expect(section.text).toContain('Alpha');
  expect(section.text).not.toContain('Beta');
  const page = await pdf.request('read', { id, page: 2 });
  expect(page.text).toContain('Beta');
  expect(page.text).not.toContain('Alpha');
});

test('reads distinct XYZ bookmark bodies on one physical page', async ({ pdf }) => {
  const id = pdf.add(
    [{ streams: ['BT /F1 12 Tf 72 720 Td (First body) Tj 0 -300 Td (Second body) Tj ET'] }],
    [
      { title: 'First title', page: 0, top: 720 },
      { title: 'Second title', page: 0, top: 420, action: true },
    ],
  );
  const first = await pdf.request('read', { id, section: '1' });
  expect(first.text).toContain('First body');
  expect(first.text).not.toContain('Second body');
  const second = await pdf.request('read', { id, section: '2' });
  expect(second.text).toContain('Second body');
  expect(second.text).not.toContain('First body');
  const whole = await pdf.cli('read', String(id), '--page', '1');
  expect(whole.match(/First body/g)).toHaveLength(1);
  expect(whole.match(/Second body/g)).toHaveLength(1);
  const found = await pdf.request('find', { id, query: 'Second body' });
  expect(found.ok).toBe(true);
  expect(JSON.stringify(found.data)).toContain('"section":"2"');
});

test('keeps textless physical pages addressable with an extraction note', async ({ pdf }) => {
  const id = pdf.add([{ streams: [] }, { streams: [] }]);
  const overview = JSON.parse(await pdf.cli('read', String(id), '--json'));
  expect(overview.data.pages).toBe(2);
  expect(overview.data.note).toContain('2 of 2 PDF pages');
  for (const page of [1, 2]) {
    const result = await pdf.request('read', { id, page });
    expect(result.ok).toBe(true);
    expect(result.text).toContain(`# Page ${page}`);
    expect(result.text).toContain('PDF text could not be extracted from this page.');
  }
});

test('counts selected PDF section chunks without renumbering physical pages', async ({ pdf }) => {
  const body = 'Alpha '.repeat(20).trim();
  const id = pdf.add([pdfTextPage(body), pdfTextPage('Second page'), { streams: [] }]);
  const params = { id, full: true, pageSize: 30, maxChars: 10_000 };
  for (const page of [1, 2, 3]) {
    const result = await pdf.request('read', { ...params, page });
    expect(result.ok).toBe(true);
    expect(result.data.pages).toBe(3);
    expect(result.text).toContain(`# Page ${page}`);
    if (page === 1) expect(result.text).toContain(body);
  }
  const section = await pdf.request('read', { ...params, section: '1', page: 1 });
  expect(section.data.pages).toBe(5);
  const last = JSON.parse(
    await pdf.cli(
      'read',
      String(id),
      '--section',
      '1',
      '--page',
      '5',
      '--page-size',
      '30',
      '--json',
    ),
  );
  expect(last.ok).toBe(true);
  expect(last.data.pages).toBe(5);
  expect(last.text).not.toContain('next:');
  const past = await pdf.request('read', { ...params, section: '1', page: 6 });
  expect(past.error.code).toBe('BAD_REQUEST');
});
