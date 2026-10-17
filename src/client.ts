import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

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

export function cobrowserHome(): string {
  return process.env.COBROWSER_HOME || path.join(os.homedir(), '.cobrowser');
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
  let names: string[];
  try {
    names = fs
      .readdirSync(path.join(home, 'run'))
      .filter((name) => name.endsWith('.sock'))
      .map((name) => name.slice(0, -5));
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

export class CobrowserClient {
  private readonly home: string;
  private readonly browser?: string;
  private readonly agent: string;
  private readonly connectTimeoutMs: number;
  private readonly responseTimeoutMs: number;
  constructor(options: ClientOptions = {}) {
    this.home = options.home || cobrowserHome();
    this.browser = options.browser;
    this.agent = options.agent || process.env.COBROWSER_AGENT || guessAgent();
    this.connectTimeoutMs = options.timeoutMs ?? 2_000;
    this.responseTimeoutMs = options.responseTimeoutMs ?? 30_000;
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
    return path.join(this.home, 'run', `${browser}.sock`);
  }
  async request(command: string, body: Record<string, unknown> = {}): Promise<ClientResponse> {
    const socketPath = await this.socketPath();
    return new Promise((resolve, reject) => {
      const request = http.request(
        {
          socketPath,
          path: `/v1/${command}`,
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-cobrowser-agent': this.agent },
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
          response.on('end', () => {
            try {
              resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as ClientResponse);
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
          });
        },
      );
      let connectTimer: NodeJS.Timeout | undefined = setTimeout(() => {
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
          request.setTimeout(this.responseTimeoutMs, () => {
            request.destroy(
              Object.assign(
                new Error(
                  'The browser helper did not reply. Check that the browser is responsive and try again.',
                ),
                { code: 'TIMEOUT' },
              ),
            );
          });
        };
        socket.once('connect', connectedOnce);
        socket.once('error', () => {
          if (connectTimer) clearTimeout(connectTimer);
          connectTimer = undefined;
        });
      });
      request.on('error', (error: any) => {
        if (connectTimer) clearTimeout(connectTimer);
        connectTimer = undefined;
        const code =
          error.code === 'TIMEOUT' || error.code === 'ETIMEDOUT' ? 'TIMEOUT' : 'BROWSER_OFFLINE';
        const message =
          code === 'TIMEOUT'
            ? 'The browser helper did not reply in time. Check that the browser is responsive and try again.'
            : 'The browser helper is offline. Open the browser and try again.';
        reject(Object.assign(new Error(message), { code }));
      });
      request.end(JSON.stringify(body));
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
