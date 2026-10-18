import { CobrowserClient } from './client.js';
import {
  MAX_CHARS,
  MAX_SCREENSHOT_CHARS,
  normalizeErrorCode,
  VERSION,
} from './shared/constants.js';
import { MAX_SECTION_NUMBER_CHARS } from './shared/sections.js';
import { parseDuration } from './shared/duration.js';
import { capText } from './shared/paging.js';
import { redactEmbeddedUrls } from './shared/url.js';

interface RpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: any;
}

interface JsonSchema {
  type?: string | string[];
  enum?: unknown[];
  oneOf?: JsonSchema[];
  required?: string[];
  additionalProperties?: boolean;
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
}

function validRequestId(value: unknown): value is string | number | null | undefined {
  return (
    value === undefined ||
    value === null ||
    typeof value === 'string' ||
    (typeof value === 'number' && Number.isFinite(value))
  );
}

const idSchema = { type: 'integer', minimum: 0 };
const MIN_MCP_RESPONSE_CHARS = 100;
const maxCharsSchema = {
  type: 'integer',
  minimum: MIN_MCP_RESPONSE_CHARS,
  maximum: Number.MAX_SAFE_INTEGER,
};
const sinceSchema = { type: 'string', pattern: '^\\d+(?:\\.\\d+)?[smhd]$' };

function schemaTypeMatches(value: unknown, type: string): boolean {
  if (type === 'object')
    return Boolean(value && typeof value === 'object' && !Array.isArray(value));
  if (type === 'array') return Array.isArray(value);
  if (type === 'integer') return typeof value === 'number' && Number.isSafeInteger(value);
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
  if (type === 'string') return typeof value === 'string';
  if (type === 'boolean') return typeof value === 'boolean';
  if (type === 'null') return value === null;
  return true;
}

function schemaError(value: unknown, schema: JsonSchema, path: string): string | undefined {
  if (schema.oneOf && !schema.oneOf.some((candidate) => !schemaError(value, candidate, path)))
    return `MCP tool argument ${path} has an invalid value.`;
  if (schema.enum && !schema.enum.some((candidate) => Object.is(candidate, value)))
    return `MCP tool argument ${path} has an invalid value.`;
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((type) => schemaTypeMatches(value, type)))
      return `MCP tool argument ${path} has an invalid type.`;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return `MCP tool argument ${path} has an invalid number.`;
    if (schema.minimum !== undefined && value < schema.minimum)
      return `MCP tool argument ${path} is below the allowed minimum.`;
    if (schema.maximum !== undefined && value > schema.maximum)
      return `MCP tool argument ${path} is above the allowed maximum.`;
  }
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength)
      return `MCP tool argument ${path} is too short.`;
    if (schema.maxLength !== undefined && value.length > schema.maxLength)
      return `MCP tool argument ${path} is too long.`;
    if (schema.pattern && !new RegExp(schema.pattern).test(value))
      return `MCP tool argument ${path} has an invalid format.`;
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems)
      return `MCP tool argument ${path} has too few items.`;
    if (schema.maxItems !== undefined && value.length > schema.maxItems)
      return `MCP tool argument ${path} has too many items.`;
    if (schema.items)
      for (let index = 0; index < value.length; index++) {
        const error = schemaError(value[index], schema.items, `${path}[${index}]`);
        if (error) return error;
      }
  }
  if (schemaTypeMatches(value, 'object')) {
    const record = value as Record<string, unknown>;
    for (const required of schema.required || [])
      if (!Object.prototype.hasOwnProperty.call(record, required))
        return `MCP tool argument ${required} is required.`;
    const properties = schema.properties || {};
    if (schema.additionalProperties === false)
      for (const key of Object.keys(record))
        if (!Object.prototype.hasOwnProperty.call(properties, key))
          return `MCP tool argument is not supported: ${key}.`;
    for (const [key, property] of Object.entries(properties)) {
      if (!Object.prototype.hasOwnProperty.call(record, key)) continue;
      const error = schemaError(record[key], property, key);
      if (error) return error;
    }
  }
  return undefined;
}

const tools = [
  {
    name: 'list_tabs',
    description: 'List readable tabs in the user browser.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        match: { type: 'string', maxLength: 10_000 },
        since: sinceSchema,
        window: {
          oneOf: [
            { type: 'string', enum: ['front'] },
            { type: 'integer', minimum: 0 },
          ],
        },
        active: { type: 'boolean' },
        limit: { type: 'integer', minimum: 1, maximum: 200 },
        offset: { type: 'integer', minimum: 0 },
        maxChars: maxCharsSchema,
      },
    },
  },
  {
    name: 'read_tab',
    description: 'Read one or more browser tabs as Markdown.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: idSchema,
        ids: { type: 'array', items: idSchema, minItems: 1, maxItems: 200 },
        section: {
          oneOf: [
            {
              type: 'string',
              maxLength: MAX_SECTION_NUMBER_CHARS,
              pattern: '^(?:0|[1-9]\\d*)(?:\\.(?:0|[1-9]\\d*))*$',
            },
            { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
          ],
        },
        page: { type: 'integer', minimum: 1 },
        full: { type: 'boolean' },
        links: { type: 'boolean' },
        maxChars: maxCharsSchema,
      },
    },
  },
  {
    name: 'find_in_tab',
    description: 'Find a phrase in the readable content of a tab.',
    inputSchema: {
      type: 'object',
      required: ['id', 'query'],
      additionalProperties: false,
      properties: {
        id: idSchema,
        query: { type: 'string', minLength: 1, pattern: '\\S', maxLength: 10_000 },
        maxChars: maxCharsSchema,
      },
    },
  },
  {
    name: 'query_tab',
    description: 'Read matching elements from a tab with a CSS selector.',
    inputSchema: {
      type: 'object',
      required: ['id', 'selector'],
      additionalProperties: false,
      properties: {
        id: idSchema,
        selector: { type: 'string', minLength: 1, pattern: '\\S', maxLength: 10_000 },
        html: { type: 'boolean' },
        limit: { type: 'integer', minimum: 1, maximum: 100 },
        maxChars: maxCharsSchema,
      },
    },
  },
  {
    name: 'get_selection',
    description: 'Read the text selected in a tab.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: { id: idSchema, maxChars: maxCharsSchema },
    },
  },
  {
    name: 'screenshot',
    description: 'Capture the currently visible tab in a browser window.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: { windowId: idSchema, maxChars: maxCharsSchema },
    },
  },
  {
    name: 'read_log',
    description: 'Show recent cobrowser reads.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        limit: { type: 'integer', minimum: 1, maximum: 200 },
        maxChars: maxCharsSchema,
      },
    },
  },
];

function validateToolArguments(
  name: string,
  definition: (typeof tools)[number],
  args: Record<string, unknown>,
) {
  const invalid = schemaError(args, definition.inputSchema as unknown as JsonSchema, 'arguments');
  if (invalid) throw Object.assign(new Error(invalid), { rpcCode: -32602 });
  if (name === 'read_tab' && (args.id === undefined) === (args.ids === undefined))
    throw Object.assign(new Error('MCP tool argument requires exactly one of id or ids.'), {
      rpcCode: -32602,
    });
}

export const MAX_RPC_LINE_BYTES = 1_000_000;
export const MAX_RPC_ID_CHARS = 256;

export interface McpLine {
  line?: string;
  tooLarge: boolean;
}

export async function* readMcpLines(input: AsyncIterable<Buffer>): AsyncGenerator<McpLine> {
  let parts: Buffer[] = [];
  let size = 0;
  let discarding = false;
  for await (const chunk of input) {
    let start = 0;
    while (start <= chunk.length) {
      const newline = chunk.indexOf(0x0a, start);
      const end = newline < 0 ? chunk.length : newline;
      const piece = chunk.subarray(start, end);
      if (!discarding) {
        if (size + piece.length > MAX_RPC_LINE_BYTES) {
          discarding = true;
          parts = [];
          size = 0;
        } else if (piece.length) {
          parts.push(piece);
          size += piece.length;
        }
      }
      if (newline < 0) break;
      if (discarding) yield { tooLarge: true };
      else
        yield {
          tooLarge: false,
          line: Buffer.concat(parts).toString('utf8').replace(/\r$/, ''),
        };
      parts = [];
      size = 0;
      discarding = false;
      start = newline + 1;
      if (start === chunk.length) break;
    }
  }
  if (discarding) yield { tooLarge: true };
  else if (size)
    yield { tooLarge: false, line: Buffer.concat(parts).toString('utf8').replace(/\r$/, '') };
}

function cleanErrorMessage(value: unknown, fallback: string): string {
  return redactEmbeddedUrls(
    String(value ?? fallback)
      .replace(/[\u0000-\u001f\u007f]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim(),
  ).slice(0, 500);
}

function response(id: string | number | null | undefined, result: unknown) {
  return JSON.stringify({ jsonrpc: '2.0', id: id ?? null, result });
}

function failure(id: string | number | null | undefined, message: string, code = -32000) {
  return JSON.stringify({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
}

function boundedResponseId(
  id: string | number | null | undefined,
  maxChars: number,
  make: (candidate: string | number | null | undefined) => string,
): string | number | null | undefined {
  return make(id).length <= maxChars ? id : null;
}

function boundedTextResponse(
  text: string,
  maxChars: number,
  make: (text: string) => string,
  cap = (value: string, limit: number) => value.slice(0, limit),
): string {
  const full = make(text);
  if (full.length <= maxChars) return full;
  let low = 0;
  let high = text.length;
  let best = make('');
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = make(cap(text, middle));
    if (candidate.length <= maxChars) {
      best = candidate;
      low = middle + 1;
    } else high = middle - 1;
  }
  return best;
}

function boundedFailure(
  id: string | number | null | undefined,
  message: string,
  code: number,
  maxChars: number,
): string {
  const responseId = boundedResponseId(id, maxChars, (candidate) => failure(candidate, '', code));
  return boundedTextResponse(message, maxChars, (text) => failure(responseId, text, code));
}

function continuationCappedText(text: string, maxChars: number): string {
  const continuation = /\n\n(next|more): ([^\n]+)$/.exec(text);
  if (!continuation) return text.slice(0, maxChars);
  return capText(text.slice(0, continuation.index), maxChars, continuation[2], continuation[1])
    .text;
}

function boundedToolResponse(
  id: string | number | null | undefined,
  result: any,
  maxChars: number,
): string {
  const text = typeof result.text === 'string' ? result.text : '';
  const responseId = boundedResponseId(id, maxChars, (candidate) =>
    response(candidate, { content: [{ type: 'text', text: '' }] }),
  );
  const withData = (value: string) =>
    response(responseId, {
      content: [{ type: 'text', text: value }],
      structuredContent: { data: result.data ?? null },
    });
  const withoutData = (value: string) =>
    response(responseId, { content: [{ type: 'text', text: value }] });
  const full = withData(text);
  if (full.length <= maxChars) return full;
  const noData = withoutData(text);
  if (noData.length <= maxChars) return noData;

  return boundedTextResponse(text, maxChars, withoutData, continuationCappedText);
}

function boundedToolErrorResponse(
  id: string | number | null | undefined,
  message: string,
  maxChars: number,
): string {
  const responseId = boundedResponseId(id, maxChars, (candidate) =>
    response(candidate, { isError: true, content: [{ type: 'text', text: '' }] }),
  );
  return boundedTextResponse(message, maxChars, (text) =>
    response(responseId, { isError: true, content: [{ type: 'text', text }] }),
  );
}

function requestedMaxChars(args: Record<string, unknown>): number {
  return typeof args.maxChars === 'number' &&
    Number.isSafeInteger(args.maxChars) &&
    args.maxChars >= MIN_MCP_RESPONSE_CHARS
    ? args.maxChars
    : MAX_CHARS;
}

function toolError(result: any, fallback: string): string {
  const code = normalizeErrorCode(result?.error?.code, 'ERROR');
  return `${code}: ${cleanErrorMessage(result?.error?.message, fallback)}`;
}

function boundedScreenshotResponse(
  id: string | number | null | undefined,
  result: any,
  maxChars: number,
): string {
  const dataUrl = result.data?.dataUrl || '';
  const metadata = result.data ? { ...result.data, dataUrl: undefined } : undefined;
  const match = /^data:([^;]+);base64,(.+)$/.exec(dataUrl);
  if (match) {
    const image = response(id, {
      content: [{ type: 'image', data: match[2], mimeType: match[1] }],
      structuredContent: { data: metadata ?? null },
    });
    if (image.length <= maxChars) return image;
  }
  return boundedToolResponse(
    id,
    {
      text: match
        ? 'The screenshot was omitted because it exceeds the response cap; call screenshot with a larger maxChars value.'
        : 'The browser returned no screenshot.',
      data: metadata,
    },
    maxChars,
  );
}

export async function runMcp(browser?: string): Promise<void> {
  let agent = 'mcp';
  let client = new CobrowserClient({ agent, browser });
  for await (const item of readMcpLines(process.stdin)) {
    if (item.tooLarge) {
      process.stdout.write(
        `${failure(undefined, 'MCP requests must be smaller than 1 MB.', -32700)}\n`,
      );
      continue;
    }
    const line = item.line || '';
    if (!line.trim()) continue;
    let request: RpcRequest;
    try {
      request = JSON.parse(line) as RpcRequest;
    } catch {
      process.stdout.write(
        `${failure(undefined, 'MCP input must be one JSON object per line.', -32700)}\n`,
      );
      continue;
    }
    if (!request || typeof request !== 'object' || Array.isArray(request)) {
      process.stdout.write(`${failure(undefined, 'MCP input must be a JSON object.', -32600)}\n`);
      continue;
    }
    if (!validRequestId(request.id)) {
      process.stdout.write(
        `${failure(undefined, 'MCP request id must be a string, number, or null.', -32600)}\n`,
      );
      continue;
    }
    if (typeof request.id === 'string' && request.id.length > MAX_RPC_ID_CHARS) {
      process.stdout.write(`${failure(undefined, 'MCP request id is too long.', -32600)}\n`);
      continue;
    }
    if (request.jsonrpc !== '2.0') {
      process.stdout.write(`${failure(request.id, 'MCP jsonrpc must be "2.0".', -32600)}\n`);
      continue;
    }
    if (typeof request.method !== 'string' || !request.method) {
      process.stdout.write(`${failure(request.id, 'MCP request method is required.', -32600)}\n`);
      continue;
    }
    if (request.method.startsWith('notifications/') || request.id === undefined) continue;
    try {
      if (request.method === 'initialize') {
        agent = String(request.params?.clientInfo?.name || 'mcp');
        client = new CobrowserClient({ agent, browser });
        process.stdout.write(
          `${response(request.id, { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'cobrowser', version: VERSION } })}\n`,
        );
        continue;
      }
      if (request.method === 'ping') {
        process.stdout.write(`${response(request.id, {})}\n`);
        continue;
      }
      if (request.method === 'tools/list') {
        process.stdout.write(`${response(request.id, { tools })}\n`);
        continue;
      }
      if (request.method !== 'tools/call')
        throw Object.assign(new Error(`Unsupported MCP method: ${request.method}`), {
          rpcCode: -32601,
        });
      if (!request.params || typeof request.params !== 'object' || Array.isArray(request.params))
        throw Object.assign(new Error('MCP tools/call params must be an object.'), {
          rpcCode: -32602,
        });
      if (typeof request.params.name !== 'string' || !request.params.name)
        throw Object.assign(new Error('MCP tools/call requires a tool name.'), { rpcCode: -32602 });
      const name = request.params.name;
      const suppliedArgs = request.params?.arguments;
      if (
        suppliedArgs !== undefined &&
        (!suppliedArgs || typeof suppliedArgs !== 'object' || Array.isArray(suppliedArgs))
      )
        throw Object.assign(new Error('MCP tool arguments must be an object.'), {
          rpcCode: -32602,
        });
      const args = suppliedArgs ?? {};
      const definition = tools.find((tool) => tool.name === name);
      if (!definition)
        throw Object.assign(new Error(`Unknown cobrowser tool: ${name}`), { rpcCode: -32602 });
      validateToolArguments(name, definition, args);
      let result;
      if (name === 'list_tabs') {
        const body = { ...args };
        if (typeof body.since === 'string') {
          try {
            body.sinceMs = parseDuration(body.since);
          } catch {
            throw Object.assign(new Error('MCP tool argument since has an invalid duration.'), {
              rpcCode: -32602,
            });
          }
        }
        result = await client.request('tabs', body);
      } else if (name === 'read_tab')
        result = await client.request('read', { ...args, ...(args.ids ? {} : { id: args.id }) });
      else if (name === 'find_in_tab') result = await client.request('find', args);
      else if (name === 'query_tab') result = await client.request('query', args);
      else if (name === 'get_selection') result = await client.request('selection', args);
      else if (name === 'read_log') result = await client.request('log', args);
      else if (name === 'screenshot') {
        result = await client.request('screenshot', {
          ...args,
          maxChars: MAX_SCREENSHOT_CHARS,
        });
        if (!result.ok) {
          process.stdout.write(
            `${boundedToolErrorResponse(request.id, toolError(result, 'The screenshot failed.'), requestedMaxChars(args))}\n`,
          );
          continue;
        }
        process.stdout.write(
          `${boundedScreenshotResponse(request.id, result, requestedMaxChars(args))}\n`,
        );
        continue;
      } else throw Object.assign(new Error(`Unknown cobrowser tool: ${name}`), { rpcCode: -32602 });
      if (!result.ok) {
        process.stdout.write(
          `${boundedToolErrorResponse(request.id, toolError(result, 'The cobrowser request failed.'), requestedMaxChars(args))}\n`,
        );
        continue;
      }
      process.stdout.write(`${boundedToolResponse(request.id, result, requestedMaxChars(args))}\n`);
    } catch (error: any) {
      const code = typeof error?.code === 'string' ? `${normalizeErrorCode(error.code)}: ` : '';
      const rpcCode =
        typeof error?.rpcCode === 'number' && Number.isInteger(error.rpcCode)
          ? error.rpcCode
          : -32000;
      const suppliedArgs = request.params?.arguments;
      const maxChars =
        suppliedArgs && typeof suppliedArgs === 'object' && !Array.isArray(suppliedArgs)
          ? requestedMaxChars(suppliedArgs)
          : MAX_CHARS;
      process.stdout.write(
        `${boundedFailure(request.id, `${code}${cleanErrorMessage(error?.message, 'The cobrowser request failed.')}`, rpcCode, maxChars)}\n`,
      );
    }
  }
}
