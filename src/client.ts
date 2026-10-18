import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { normalizeErrorCode } from './shared/constants.js';
import { redactEmbeddedUrls } from './shared/url.js';

export interface ClientOptions {
  home?: string;
  browser?: string;
  agent?: string;
  timeoutMs?: number;
  responseTimeoutMs?: number;
}
export interface ClientResponse {
  ok: boolean;
  text?: string;
  data?: any;
  error?: { code: string; message: string };
}

const SIMPLE_NAME = /^[a-z0-9][a-z0-9._-]*$/i;
const MAX_CLIENT_REQUEST_BYTES = 1_000_000;
const MAX_CLIENT_RESPONSE_BYTES = 80 * 1024 * 1024;
const MAX_TIMER_MS = 2_147_483_647;

export function serializeClientRequest(value: unknown): string {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw Object.assign(new Error('The request body must be valid JSON.'), { code: 'BAD_REQUEST' });
  }
  if (typeof serialized !== 'string')
    throw Object.assign(new Error('The request body must be a JSON value.'), {
      code: 'BAD_REQUEST',
    });
  if (Buffer.byteLength(serialized, 'utf8') > MAX_CLIENT_REQUEST_BYTES)
    throw Object.assign(new Error('The request body is too large. Send a smaller command.'), {
      code: 'BAD_REQUEST',
    });
  return serialized;
}

export function readResponseBody(
  response: http.IncomingMessage,
  maxBytes = MAX_CLIENT_RESPONSE_BYTES,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const finish = (error?: Error, body?: Buffer) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve(body || Buffer.alloc(0));
    };
    const tooLarge = Object.assign(
      new Error('The browser helper returned a response that is too large.'),
      { code: 'BAD_REQUEST' },
    );
    const aborted = Object.assign(
      new Error('The browser helper closed the response before sending all data.'),
      { code: 'BROWSER_OFFLINE' },
    );
    response.on('error', (error) =>
      finish(error instanceof Error ? error : new Error(String(error))),
    );
    const declaredHeader = response.headers?.['content-length'];
    const declaredLength = Number(
      Array.isArray(declaredHeader) ? declaredHeader[0] : declaredHeader,
    );
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
      response.resume();
      finish(tooLarge);
      return;
    }
    response.on('data', (chunk) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.length;
      if (size > maxBytes) {
        response.resume();
        finish(tooLarge);
        return;
      }
      chunks.push(bytes);
    });
    response.on('end', () => finish(undefined, Buffer.concat(chunks)));
    response.once('aborted', () => {
      response.resume();
      finish(aborted);
    });
    response.once('close', () => {
      if (!response.complete) {
        response.resume();
        finish(aborted);
      }
    });
  });
}

function validateBrowserName(value: string): string {
  if (!SIMPLE_NAME.test(value))
    throw Object.assign(new Error('Use a simple browser name such as chrome or arc.'), {
      code: 'BAD_REQUEST',
    });
  return value.toLowerCase();
}

function cleanAgent(value: unknown): string {
  return (
    String(value ?? '')
      .replace(/[\u0000-\u001f\u007f]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 120) || 'cli'
  );
}

function cleanErrorMessage(value: unknown): string {
  return (
    redactEmbeddedUrls(
      String(value ?? 'The browser helper returned an error. Try again.')
        .replace(/[\u0000-\u001f\u007f]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim(),
    ).slice(0, 500) || 'The browser helper returned an error. Try again.'
  );
}

function timeoutValue(value: unknown, fallback: number, label: string): number {
  const result = value === undefined ? fallback : value;
  if (
    typeof result !== 'number' ||
    !Number.isSafeInteger(result) ||
    result < 1 ||
    result > MAX_TIMER_MS
  )
    throw Object.assign(new Error(`Use a whole number from 1 to ${MAX_TIMER_MS} for ${label}.`), {
      code: 'BAD_REQUEST',
    });
  return result;
}

export function parseClientResponse(value: unknown): ClientResponse {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    typeof (value as any).ok !== 'boolean'
  )
    throw new Error('The browser helper returned invalid data. Restart the browser and try again.');
  const parsed = value as ClientResponse;
  if (parsed.text !== undefined && typeof parsed.text !== 'string')
    throw new Error('The browser helper returned invalid data. Restart the browser and try again.');
  if (parsed.ok) return parsed;
  const error = parsed.error;
  return {
    ok: false,
    text: parsed.text,
    data: parsed.data,
    error: {
      code: normalizeErrorCode(error?.code, 'BAD_REQUEST'),
      message: cleanErrorMessage(error?.message),
    },
  };
}

export function cobrowserHome(): string {
  return path.resolve(process.env.COBROWSER_HOME || path.join(os.homedir(), '.cobrowser'));
}
async function socketIsLive(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection(socketPath);
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.setTimeout(100, () => finish(false));
  });
}

export async function liveBrowsers(home = cobrowserHome()): Promise<string[]> {
  home = path.resolve(home);
  let names: string[];
  try {
    names = fs
      .readdirSync(path.join(home, 'run'))
      .filter((name) => name.endsWith('.sock'))
      .map((name) => name.slice(0, -5))
      .filter((name) => SIMPLE_NAME.test(name));
  } catch {
    return [];
  }
  const live = await Promise.all(
    names.map(async (name) =>
      (await socketIsLive(path.join(home, 'run', `${name}.sock`))) ? name : undefined,
    ),
  );
  return live.filter((name): name is string => name !== undefined);
}

export async function browserStatuses(
  home = cobrowserHome(),
): Promise<Array<{ browser: string; running: boolean; connected?: boolean }>> {
  home = path.resolve(home);
  const configured = new Set<string>();
  try {
    for (const name of fs
      .readdirSync(path.join(home, 'hosts'))
      .filter((name) => !name.startsWith('.') && SIMPLE_NAME.test(name)))
      configured.add(name);
  } catch {
    /* setup has not run yet */
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8')) as {
      configuredBrowsers?: unknown;
    };
    if (Array.isArray(parsed.configuredBrowsers))
      for (const name of parsed.configuredBrowsers)
        if (typeof name === 'string' && SIMPLE_NAME.test(name)) configured.add(name.toLowerCase());
  } catch {
    /* Older setups do not have a browser registry. */
  }
  const live = await liveBrowsers(home);
  const names = [...new Set([...configured, ...live])].sort();
  const statuses = await Promise.all(
    names.map(async (browser) => {
      if (!live.includes(browser)) return { browser, running: false };
      return new Promise<{ browser: string; running: boolean; connected?: boolean }>((resolve) => {
        let settled = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const finish = (status: { browser: string; running: boolean; connected?: boolean }) => {
          if (settled) return;
          settled = true;
          if (timer) clearTimeout(timer);
          resolve(status);
        };
        const request = http.request(
          {
            socketPath: path.join(home, 'run', `${browser}.sock`),
            path: '/v1/status',
            method: 'POST',
          },
          (response) => {
            void readResponseBody(response, 1_000_000).then(
              (body) => {
                try {
                  const parsed = JSON.parse(body.toString('utf8')) as {
                    ok?: boolean;
                    data?: { connected?: boolean };
                  };
                  finish({
                    browser,
                    running: true,
                    connected: parsed.ok ? Boolean(parsed.data?.connected) : undefined,
                  });
                } catch {
                  finish({ browser, running: true });
                }
              },
              () => finish({ browser, running: true }),
            );
          },
        );
        timer = setTimeout(() => {
          request.destroy();
          finish({ browser, running: true });
        }, 500);
        request.once('error', () => finish({ browser, running: true }));
        request.end('{}');
      });
    }),
  );
  return statuses;
}

export class CobrowserClient {
  private readonly home: string;
  private readonly browser?: string;
  private readonly agent: string;
  private readonly connectTimeoutMs: number;
  private readonly responseTimeoutMs: number;
  constructor(options: ClientOptions = {}) {
    this.home = path.resolve(options.home || cobrowserHome());
    this.browser = options.browser === undefined ? undefined : validateBrowserName(options.browser);
    this.agent = cleanAgent(options.agent || process.env.COBROWSER_AGENT || guessAgent());
    this.connectTimeoutMs = timeoutValue(options.timeoutMs, 2_000, 'timeoutMs');
    this.responseTimeoutMs = timeoutValue(options.responseTimeoutMs, 30_000, 'responseTimeoutMs');
  }
  private async socketPath(): Promise<string> {
    const browsers = await liveBrowsers(this.home);
    const browser = this.browser || (browsers.length === 1 ? browsers[0] : undefined);
    if (!browser) {
      if (!browsers.length)
        throw Object.assign(
          new Error('No browser helper is running. Open your browser and try again.'),
          { code: 'BROWSER_OFFLINE' },
        );
      throw Object.assign(
        new Error(
          `Several browser helpers are running: ${browsers.join(', ')}. Use --browser <name>.`,
        ),
        { code: 'BAD_REQUEST' },
      );
    }
    const socketPath = path.join(this.home, 'run', `${browser}.sock`);
    if (Buffer.byteLength(socketPath, 'utf8') >= 104)
      throw Object.assign(
        new Error(
          'The cobrowser home path is too long for a Unix socket. Set COBROWSER_HOME to a shorter path and try again.',
        ),
        { code: 'BAD_REQUEST' },
      );
    return socketPath;
  }
  async request(command: string, body: Record<string, unknown> = {}): Promise<ClientResponse> {
    if (!/^[a-z][a-z0-9-]*$/i.test(command))
      throw Object.assign(new Error('Use a supported cobrowser command.'), { code: 'BAD_REQUEST' });
    const serializedBody = serializeClientRequest(body);
    const socketPath = await this.socketPath();
    return new Promise((resolve, reject) => {
      let connectTimer: NodeJS.Timeout | undefined;
      let responseTimer: NodeJS.Timeout | undefined;
      const clearTimers = () => {
        if (connectTimer) clearTimeout(connectTimer);
        if (responseTimer) clearTimeout(responseTimer);
        connectTimer = undefined;
        responseTimer = undefined;
      };
      const timeoutError = () =>
        Object.assign(
          new Error(
            'The browser helper did not reply in time. Check that the browser is responsive and try again.',
          ),
          { code: 'TIMEOUT' },
        );
      const request = http.request(
        {
          socketPath,
          path: `/v1/${command}`,
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(serializedBody),
            'x-cobrowser-agent': this.agent,
          },
        },
        (response) => {
          void readResponseBody(response).then(
            (body) => {
              if (responseTimer) clearTimeout(responseTimer);
              responseTimer = undefined;
              try {
                resolve(parseClientResponse(JSON.parse(body.toString('utf8'))));
              } catch {
                reject(
                  Object.assign(
                    new Error(
                      'The browser helper returned invalid data. Restart the browser and try again.',
                    ),
                    {
                      code: 'BAD_REQUEST',
                    },
                  ),
                );
              }
            },
            (error) => {
              if (responseTimer) clearTimeout(responseTimer);
              responseTimer = undefined;
              reject(error);
            },
          );
        },
      );
      connectTimer = setTimeout(() => {
        request.destroy(
          Object.assign(
            new Error('The browser helper did not connect. Open the browser and try again.'),
            { code: 'TIMEOUT' },
          ),
        );
      }, this.connectTimeoutMs);
      request.on('socket', (socket) => {
        const connectedOnce = () => {
          if (connectTimer) clearTimeout(connectTimer);
          connectTimer = undefined;
          responseTimer = setTimeout(() => request.destroy(timeoutError()), this.responseTimeoutMs);
          request.setTimeout(this.responseTimeoutMs, () => {
            request.destroy(timeoutError());
          });
        };
        socket.once('connect', connectedOnce);
        socket.once('error', () => {
          if (connectTimer) clearTimeout(connectTimer);
          connectTimer = undefined;
        });
      });
      request.on('error', (error: any) => {
        clearTimers();
        const code =
          error.code === 'TIMEOUT' || error.code === 'ETIMEDOUT' ? 'TIMEOUT' : 'BROWSER_OFFLINE';
        const message =
          code === 'TIMEOUT'
            ? 'The browser helper did not reply in time. Check that the browser is responsive and try again.'
            : 'The browser helper is offline. Open the browser and try again.';
        reject(Object.assign(new Error(message), { code }));
      });
      request.end(serializedBody);
    });
  }
}

// Codex sets these only for commands it runs. CODEX_HOME is often set globally, so it doesn't count.
// Check Codex first because a Codex session started from Claude Code still inherits CLAUDECODE.
const CODEX_COMMAND_VARS = ['CODEX_THREAD_ID', 'CODEX_TOOL_CALL_ID', 'CODEX_SANDBOX'];

export function guessAgent(env: NodeJS.ProcessEnv = process.env): string {
  if (CODEX_COMMAND_VARS.some((name) => env[name])) return 'codex';
  if (env.CLAUDECODE) return 'claude-code';
  return 'cli';
}
