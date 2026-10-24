import { test, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createServer, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const cli = path.resolve(import.meta.dirname, '../../dist/cli.js');
const clientUrl = pathToFileURL(path.resolve(import.meta.dirname, '../../dist/client.js')).href;
type Rpc = Record<string, any>;
interface Received {
  command: string;
  body: Rpc;
  response: ServerResponse;
  socket: Socket;
  closed: boolean;
}

async function fixture() {
  const home = await mkdtemp('/tmp/cb-mcp-');
  await mkdir(path.join(home, 'run'));
  const requests: Received[] = [];
  const server = createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      body += chunk;
    });
    request.on('error', () => undefined);
    request.on('end', () => {
      const received = {
        command: request.url?.split('/').at(-1) || '',
        body: JSON.parse(body),
        response,
        socket: request.socket,
        closed: false,
      };
      requests.push(received);
      response.on('close', () => {
        received.closed = true;
      });
      if (received.command !== 'read')
        response.end(JSON.stringify({ ok: true, text: 'Fast tab list.' }));
    });
  });
  server.listen(path.join(home, 'run/fixture.sock'));
  await once(server, 'listening');
  const child = spawn(process.execPath, [cli, '--browser', 'fixture', 'mcp'], {
    env: { ...process.env, COBROWSER_HOME: home, FORCE_COLOR: undefined, NO_COLOR: undefined },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const exited = once(child, 'exit');
  const messages: Rpc[] = [];
  const waiters = new Set<{
    match: (message: Rpc) => boolean;
    resolve: (message: Rpc) => void;
  }>();
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
    for (;;) {
      const end = stdout.indexOf('\n');
      if (end < 0) break;
      const line = stdout.slice(0, end);
      stdout = stdout.slice(end + 1);
      if (!line) continue;
      const message = JSON.parse(line) as Rpc;
      messages.push(message);
      for (const waiter of waiters) if (waiter.match(message)) waiter.resolve(message);
    }
  });
  const next = (match: (message: Rpc) => boolean, timeout = 1_500) => {
    const existing = messages.find(match);
    if (existing) return Promise.resolve(existing);
    return new Promise<Rpc>((resolve, reject) => {
      const timer = setTimeout(() => {
        waiters.delete(waiter);
        reject(new Error(`MCP did not respond in time: ${stderr}`));
      }, timeout);
      const waiter = {
        match,
        resolve: (message: Rpc) => {
          clearTimeout(timer);
          waiters.delete(waiter);
          resolve(message);
        },
      };
      waiters.add(waiter);
    });
  };
  const release = () => {
    for (const request of requests)
      if (!request.response.destroyed && !request.response.writableEnded)
        request.response.end(
          JSON.stringify({ ok: true, text: `Completed read ${request.body.id}.` }),
        );
  };
  return {
    home,
    child,
    exited,
    messages,
    requests,
    next,
    release,
    send: (request: Rpc) => child.stdin.write(`${JSON.stringify(request)}\n`),
    received: async (id: number) => {
      await expect
        .poll(() =>
          requests.some((request) => request.command === 'read' && request.body.id === id),
        )
        .toBe(true);
      return requests.find((request) => request.command === 'read' && request.body.id === id)!;
    },
    close: async () => {
      release();
      child.stdin.end();
      const timer = setTimeout(() => child.kill('SIGKILL'), 2_000);
      try {
        await exited;
      } finally {
        clearTimeout(timer);
      }
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeAllConnections();
      await closed;
      await rm(home, { recursive: true, force: true });
    },
  };
}

function tool(id: string | number, name: string, args: Rpc = {}): Rpc {
  return { jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } };
}

test('MCP answers health checks and independent tools while a read is stalled', async () => {
  const f = await fixture();
  try {
    f.send(tool(1, 'read_tab', { id: 1 }));
    await f.received(1);
    f.send({ jsonrpc: '2.0', id: 2, method: 'ping' });
    f.send({ jsonrpc: '2.0', id: 3, method: 'tools/list' });
    f.send(tool(4, 'list_tabs'));
    expect(await f.next((message) => message.id === 2)).toMatchObject({ result: {} });
    expect((await f.next((message) => message.id === 3)).result.tools).toHaveLength(7);
    expect((await f.next((message) => message.id === 4)).result.content[0].text).toBe(
      'Fast tab list.',
    );
    expect(f.messages.some((message) => message.id === 1)).toBe(false);
    f.release();
    expect((await f.next((message) => message.id === 1)).result.content[0].text).toBe(
      'Completed read 1.',
    );
  } finally {
    await f.close();
  }
});

test('client response deadlines also apply to a reused HTTP connection', async () => {
  const f = await fixture();
  try {
    const { CobrowserClient } = await import(clientUrl);
    const client = new CobrowserClient({
      home: f.home,
      browser: 'fixture',
      timeoutMs: 1_000,
      responseTimeoutMs: 80,
    });
    expect((await client.request('tabs')).ok).toBe(true);
    const started = performance.now();
    await expect(client.request('read', { id: 1 })).rejects.toMatchObject({ code: 'TIMEOUT' });
    expect(f.requests[0].socket).toBe(f.requests[1].socket);
    expect(performance.now() - started).toBeLessThan(600);
  } finally {
    await f.close();
  }
});

test('completed client requests do not retain error listeners on a reused connection', async () => {
  const f = await fixture();
  const warnings: Error[] = [];
  const onWarning = (warning: Error) => {
    if (warning.name === 'MaxListenersExceededWarning') warnings.push(warning);
  };
  process.on('warning', onWarning);
  try {
    const { CobrowserClient } = await import(clientUrl);
    const client = new CobrowserClient({ home: f.home, browser: 'fixture' });
    for (let index = 0; index < 20; index++) expect((await client.request('tabs')).ok).toBe(true);
    expect(f.requests.every((request) => request.socket === f.requests[0].socket)).toBe(true);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(warnings.map((warning) => warning.message)).toEqual([]);
  } finally {
    process.removeListener('warning', onWarning);
    await f.close();
  }
});

test('MCP cancellation closes its helper request and suppresses the response', async () => {
  const f = await fixture();
  try {
    f.send(tool('cancel-me', 'read_tab', { id: 1 }));
    const pending = await f.received(1);
    f.send({
      jsonrpc: '2.0',
      method: 'notifications/cancelled',
      params: { requestId: 'cancel-me', reason: 'No longer needed.' },
    });
    await expect.poll(() => pending.closed).toBe(true);
    f.send(tool('after-cancel', 'list_tabs'));
    expect((await f.next((message) => message.id === 'after-cancel')).result.content[0].text).toBe(
      'Fast tab list.',
    );
    expect(f.messages.some((message) => message.id === 'cancel-me')).toBe(false);
  } finally {
    await f.close();
  }
});

test('MCP keeps numeric and string request ids separate and rejects duplicates', async () => {
  const f = await fixture();
  try {
    f.send(tool(1, 'read_tab', { id: 1 }));
    f.send(tool('1', 'read_tab', { id: 2 }));
    const first = await f.received(1);
    const second = await f.received(2);
    f.send(tool(1, 'list_tabs', { maxChars: 100 }));
    const duplicate = await f.next((message) => message.id === 1 && message.error);
    expect(duplicate.error.code).toBe(-32600);
    expect(JSON.stringify(duplicate).length).toBeLessThanOrEqual(100);
    f.send({
      jsonrpc: '2.0',
      method: 'notifications/cancelled',
      params: { requestId: '1' },
    });
    await expect.poll(() => second.closed).toBe(true);
    expect(first.closed).toBe(false);
    f.release();
    expect(
      (await f.next((message) => message.id === 1 && message.result)).result.content[0].text,
    ).toBe('Completed read 1.');
    expect(f.messages.some((message) => message.id === '1')).toBe(false);
  } finally {
    await f.close();
  }
});

test('MCP bounds active tools while keeping ping and cancellation available', async () => {
  const f = await fixture();
  try {
    for (let id = 1; id <= 16; id++) f.send(tool(id, 'read_tab', { id }));
    await expect.poll(() => f.requests.length).toBe(16);
    f.send(tool(17, 'read_tab', { id: 17, maxChars: 100 }));
    const overloaded = await f.next((message) => message.id === 17);
    expect(overloaded.error.code).toBe(-32000);
    expect(JSON.stringify(overloaded).length).toBeLessThanOrEqual(100);
    expect(f.requests.length).toBe(16);
    f.send({ jsonrpc: '2.0', id: 18, method: 'ping' });
    expect(await f.next((message) => message.id === 18)).toMatchObject({ result: {} });
    f.send({
      jsonrpc: '2.0',
      method: 'notifications/cancelled',
      params: { requestId: 1 },
    });
    await expect.poll(() => f.requests[0].closed).toBe(true);
    f.send(tool(19, 'list_tabs'));
    expect((await f.next((message) => message.id === 19)).result.content[0].text).toBe(
      'Fast tab list.',
    );
  } finally {
    await f.close();
  }
});

test('MCP finishes active tools after its input ends', async () => {
  const f = await fixture();
  try {
    f.send(tool(1, 'read_tab', { id: 1 }));
    await f.received(1);
    f.child.stdin.end();
    f.release();
    expect((await f.next((message) => message.id === 1)).result.content[0].text).toBe(
      'Completed read 1.',
    );
    expect((await f.exited)[0]).toBe(0);
  } finally {
    await f.close();
  }
});

test('MCP cancels helper work when an output write detects a closed receiver', async () => {
  const f = await fixture();
  try {
    f.send(tool(1, 'read_tab', { id: 1 }));
    const pending = await f.received(1);
    f.child.stdout.destroy();
    f.send({ jsonrpc: '2.0', id: 2, method: 'ping' });
    await expect.poll(() => pending.closed).toBe(true);
    expect((await f.exited)[0]).toBe(0);
  } finally {
    await f.close();
  }
});

test('a cancelled client request never reaches the helper', async () => {
  const f = await fixture();
  try {
    const { CobrowserClient } = await import(clientUrl);
    const client = new CobrowserClient({ home: f.home, browser: 'fixture' });
    const controller = new AbortController();
    controller.abort();
    await expect(
      client.request('read', { id: 1 }, { signal: controller.signal }),
    ).rejects.toMatchObject({
      name: 'AbortError',
      code: 'CANCELLED',
    });
    expect(f.requests).toHaveLength(0);
  } finally {
    await f.close();
  }
});
