import { parseHTML } from 'linkedom';
import { inflateRawSync, inflateSync } from 'node:zlib';
import { Readability } from '@mozilla/readability';
import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';
import { buildSectionTree, type SectionNode } from './sections.js';
import { splitPages } from './paging.js';
import type { SpecialKind } from './special.js';
import { redactEmbeddedUrls } from './url.js';

export interface PageSnapshot {
  url: string;
  title: string;
  html: string;
  contentType?: string;
  scrollHeight?: number;
  clientHeight?: number;
  feed?: boolean;
  canvas?: boolean;
  reloaded?: boolean;
  special?: { kind: SpecialKind; text?: string; base64?: string; sourceUrls?: string[] };
}

export interface ConvertedPage {
  url: string;
  title: string;
  markdown: string;
  words: number;
  sections: SectionNode[];
  pages: string[];
  pagesAreDocumentPages?: boolean;
  note?: string;
}

const FEED_HOSTS =
  /(^|\.)((x|twitter|reddit|linkedin|facebook|instagram)\.com|threads\.net|bsky\.app)$/i;
const MAX_PDF_STREAM_BYTES = 8 * 1024 * 1024;
const MAX_PDF_DECOMPRESSED_BYTES = 32 * 1024 * 1024;
const MAX_PDF_ARRAY_DEPTH = 64;

function stripUnsafeControls(value: string): string {
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
}

export function convertSnapshot(snapshot: PageSnapshot, full = false): ConvertedPage {
  const { document } = parseHTML(snapshot.html);
  for (const selector of ['script', 'style', 'noscript', 'svg', 'iframe'])
    document.querySelectorAll(selector).forEach((node) => node.remove());
  let content = document.body?.innerHTML ?? snapshot.html;
  if (!full) {
    try {
      const article = new Readability(document as unknown as Document).parse();
      if (article?.textContent && article.textContent.trim().length >= 200)
        content = article.content ?? content;
    } catch {
      /* malformed pages still get the body text */
    }
  }
  const turndown = new TurndownService({
    headingStyle: 'atx',
    bulletListMarker: '-',
    codeBlockStyle: 'fenced',
  });
  turndown.use(gfm);
  let markdown = stripUnsafeControls(turndown.turndown(content).trim());
  markdown = markdown.replace(/!\[([^\]]*)\]\([^)]*\)/g, (_, alt: string) =>
    alt ? `[image: ${alt}]` : '',
  );
  markdown = redactEmbeddedUrls(stripUnsafeControls(markdown));
  const words = markdown ? markdown.split(/\s+/).length : 0;
  const sections = buildSectionTree(markdown);
  let host = '';
  try {
    host = new URL(snapshot.url).hostname;
  } catch {
    /* the browser normally supplies a valid URL */
  }
  const notes = [
    FEED_HOSTS.test(host) || snapshot.feed ? 'more may load on scroll' : undefined,
    snapshot.canvas && words < 100
      ? 'page has little readable text; try screenshot if the tab is visible'
      : undefined,
  ].filter(Boolean) as string[];
  return {
    url: snapshot.url,
    title: snapshot.title,
    markdown,
    words,
    sections,
    pages: splitPages(markdown, 20_000),
    note: notes.length ? notes.join('\n') : undefined,
  };
}

function pdfString(bytes: Buffer): string {
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    const swapped = Buffer.alloc(bytes.length - 2);
    for (let index = 2; index + 1 < bytes.length; index += 2) {
      swapped[index - 2] = bytes[index + 1];
      swapped[index - 1] = bytes[index];
    }
    return swapped.toString('utf16le');
  }
  return bytes.toString('latin1');
}

function pdfLiteral(value: string): string {
  const escapes: Record<string, string> = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f' };
  let result = '';
  for (let index = 0; index < value.length; index++) {
    if (value[index] !== '\\') {
      result += value[index];
      continue;
    }
    const next = value[index + 1];
    if (next === '\r' || next === '\n') {
      index++;
      if (next === '\r' && value[index + 1] === '\n') index++;
      continue;
    }
    if (next && /^[0-7]$/.test(next)) {
      let digits = next;
      while (digits.length < 3 && /^[0-7]$/.test(value[index + 1 + digits.length]))
        digits += value[index + 1 + digits.length];
      index += digits.length;
      result += String.fromCharCode(Number.parseInt(digits, 8));
      continue;
    }
    result += (next && escapes[next]) || next || '\\';
    if (next) index++;
  }
  return pdfString(Buffer.from(result, 'latin1'));
}

function pdfHex(value: string): string {
  value = value.replace(/\s/g, '');
  return pdfString(Buffer.from(value.length % 2 ? `${value}0` : value, 'hex'));
}

type PdfToken =
  | { kind: 'text'; value: string }
  | { kind: 'array'; values: PdfToken[] }
  | { kind: 'word'; value: string };

function pdfTokens(
  source: string,
  start = 0,
  stopAtArrayEnd = false,
  depth = 0,
): { tokens: PdfToken[]; next: number } {
  const tokens: PdfToken[] = [];
  let index = start;
  while (index < source.length) {
    const char = source[index];
    if (/\s/.test(char)) {
      index++;
      continue;
    }
    if (stopAtArrayEnd && char === ']') return { tokens, next: index + 1 };
    if (char === '%') {
      const end = source.slice(index + 1).search(/[\r\n]/);
      index = end < 0 ? source.length : index + end + 2;
      continue;
    }
    if (char === '(') {
      let literalDepth = 1;
      let value = '';
      index++;
      while (index < source.length && literalDepth > 0) {
        const current = source[index];
        if (current === '\\') {
          value += current;
          index++;
          if (index < source.length) value += source[index++];
          continue;
        }
        if (current === '(') literalDepth++;
        else if (current === ')') {
          literalDepth--;
          if (!literalDepth) {
            index++;
            break;
          }
        }
        value += current;
        index++;
      }
      tokens.push({ kind: 'text', value: pdfLiteral(value) });
      continue;
    }
    if (char === '<' && source[index + 1] !== '<') {
      const end = source.indexOf('>', index + 1);
      if (end >= 0) {
        tokens.push({ kind: 'text', value: pdfHex(source.slice(index + 1, end)) });
        index = end + 1;
        continue;
      }
    }
    if ((char === '<' || char === '>') && source[index + 1] === char) {
      tokens.push({ kind: 'word', value: char + char });
      index += 2;
      continue;
    }
    if (char === '[') {
      if (depth >= MAX_PDF_ARRAY_DEPTH) {
        let nesting = 1;
        while (++index < source.length && nesting) {
          if (source[index] === '[') nesting++;
          if (source[index] === ']') nesting--;
        }
        continue;
      }
      const nested = pdfTokens(source, index + 1, true, depth + 1);
      tokens.push({ kind: 'array', values: nested.tokens });
      index = nested.next;
      continue;
    }
    let end = index + 1;
    while (end < source.length && !/[\s()[\]<>%/]/.test(source[end])) end++;
    tokens.push({ kind: 'word', value: source.slice(index, end) });
    index = end;
  }
  return { tokens, next: index };
}

type PdfMatrix = [number, number, number, number, number, number];
interface PdfTextChunk {
  text: string;
  x?: number;
  y?: number;
}

function pdfMultiply(left: PdfMatrix, right: PdfMatrix): PdfMatrix {
  const [a, b, c, d, e, f] = left;
  const [g, h, i, j, k, l] = right;
  return [
    a * g + c * h,
    b * g + d * h,
    a * i + c * j,
    b * i + d * j,
    a * k + c * l + e,
    b * k + d * l + f,
  ];
}

function pdfNumber(token: PdfToken | undefined): number | undefined {
  if (token?.kind !== 'word' || !/^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(token.value)) return undefined;
  const value = Number(token.value);
  return Number.isFinite(value) ? value : undefined;
}

function pdfTextOperators(body: string): PdfTextChunk[] {
  const chunks: PdfTextChunk[] = [];
  let operands: PdfToken[] = [];
  let inText = false;
  let positioned = false;
  let matrix: PdfMatrix = [1, 0, 0, 1, 0, 0];
  let line: PdfMatrix = [...matrix];
  let transform: PdfMatrix = [...matrix];
  const saved: PdfMatrix[] = [];
  let leading = 0;
  const moveLine = (x: number, y: number) => {
    line = pdfMultiply(line, [1, 0, 0, 1, x, y]);
    matrix = [...line];
    positioned = true;
  };
  const show = (text: string) => {
    if (!inText || !text.trim()) return;
    const point = pdfMultiply(transform, matrix);
    chunks.push({
      text,
      x: positioned ? point[4] : undefined,
      y: positioned ? point[5] : undefined,
    });
  };
  for (const token of pdfTokens(body).tokens) {
    if (token.kind !== 'word' || token.value.startsWith('/') || pdfNumber(token) !== undefined) {
      operands.push(token);
      continue;
    }
    const numbers = operands.map(pdfNumber);
    const last = operands.at(-1);
    if (token.value === 'BT') {
      inText = true;
      positioned = false;
      matrix = [1, 0, 0, 1, 0, 0];
      line = [...matrix];
    } else if (token.value === 'ET') inText = false;
    else if (token.value === 'q') saved.push([...transform]);
    else if (token.value === 'Q') transform = saved.pop() || transform;
    else if (token.value === 'cm' && numbers.length === 6 && numbers.every((n) => n !== undefined))
      transform = pdfMultiply(transform, numbers as PdfMatrix);
    else if (inText) {
      if (token.value === 'Tm' && numbers.length === 6 && numbers.every((n) => n !== undefined)) {
        matrix = numbers as PdfMatrix;
        line = [...matrix];
        positioned = true;
      } else if (
        (token.value === 'Td' || token.value === 'TD') &&
        numbers.length === 2 &&
        numbers.every((n) => n !== undefined)
      ) {
        if (token.value === 'TD') leading = -numbers[1]!;
        moveLine(numbers[0]!, numbers[1]!);
      } else if (token.value === 'TL' && numbers[0] !== undefined) leading = numbers[0];
      else if (token.value === 'T*') moveLine(0, -leading);
      else if (
        (token.value === 'Tj' || token.value === "'" || token.value === '"') &&
        last?.kind === 'text'
      ) {
        if (token.value !== 'Tj') moveLine(0, -leading);
        show(last.value);
      } else if (token.value === 'TJ' && last?.kind === 'array') {
        let text = '';
        for (const value of last.values) {
          if (value.kind === 'text') text += value.value;
          else {
            const adjustment = pdfNumber(value);
            if (adjustment !== undefined && adjustment <= -100 && text && !/\s$/.test(text))
              text += ' ';
          }
        }
        show(text);
      }
    }
    operands = [];
  }
  return chunks;
}

interface PdfObject {
  id: number;
  body: string;
}

interface PdfLimits {
  decompressedBytes: number;
  notes: Set<string>;
}

interface PdfDocumentText {
  markdown: string;
  pages: string[];
  note?: string;
}

interface PdfOutlineEntry {
  title: string;
  level: number;
  pageIndex?: number;
  top?: number;
  left?: number;
}

function pdfDictionaryEnd(source: string, start = 0): number | undefined {
  let index = start;
  while (/\s/.test(source[index] || '') && index < source.length) index++;
  if (source.slice(index, index + 2) !== '<<') return undefined;
  let depth = 0;
  while (index < source.length) {
    const char = source[index];
    if (char === '%') {
      while (index < source.length && !/[\r\n]/.test(source[index])) index++;
      continue;
    }
    if (char === '(') {
      let literalDepth = 1;
      while (++index < source.length && literalDepth) {
        if (source[index] === '\\') index++;
        else if (source[index] === '(') literalDepth++;
        else if (source[index] === ')') literalDepth--;
      }
      continue;
    }
    if (char === '<' && source[index + 1] !== '<') {
      const end = source.indexOf('>', index + 1);
      index = end < 0 ? source.length : end + 1;
      continue;
    }
    if (source.slice(index, index + 2) === '<<') {
      depth++;
      index += 2;
    } else if (source.slice(index, index + 2) === '>>') {
      index += 2;
      if (--depth === 0) return index;
    } else index++;
  }
  return undefined;
}

function pdfDictionary(body: string): string {
  const end = pdfDictionaryEnd(body);
  return end === undefined ? body : body.slice(0, end);
}

function parsePdfObjects(source: string): Map<number, PdfObject> {
  const objects = new Map<number, PdfObject>();
  const pattern = /(?:^|[\r\n])(\d+)\s+\d+\s+obj\b/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source))) {
    const id = Number(match[1]);
    const start = pattern.lastIndex;
    let searchFrom = pdfDictionaryEnd(source, start) ?? start;
    const stream = /^\s*stream(?:\r\n|\r|\n)/.exec(source.slice(searchFrom));
    if (stream) {
      const streamStart = searchFrom + stream[0].length;
      const length = pdfStreamLength(source.slice(start, searchFrom));
      searchFrom =
        length !== undefined && Number.isSafeInteger(length) && length >= 0
          ? streamStart + length
          : source.indexOf('endstream', streamStart);
      if (searchFrom < 0) break;
    }
    const end = source.indexOf('endobj', searchFrom);
    if (end < 0) break;
    if (Number.isSafeInteger(id)) objects.set(id, { id, body: source.slice(start, end) });
    pattern.lastIndex = end + 'endobj'.length;
  }
  return objects;
}

function pdfDictionaryValue(body: string, key: string): PdfToken[] {
  const tokens = pdfTokens(pdfDictionary(body)).tokens;
  let depth = 0;
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token.kind !== 'word') continue;
    if (token.value === '<<') depth++;
    else if (token.value === '>>') depth--;
    else if (depth === 1 && token.value === `/${key}`) return tokens.slice(index + 1);
  }
  return [];
}

function pdfHasType(body: string, type: string): boolean {
  const value = pdfDictionaryValue(body, 'Type')[0];
  return value?.kind === 'word' && value.value === `/${type}`;
}

function pdfTokenReference(tokens: PdfToken[]): number | undefined {
  const id = pdfNumber(tokens[0]);
  const generation = pdfNumber(tokens[1]);
  return id !== undefined &&
    Number.isSafeInteger(id) &&
    generation !== undefined &&
    tokens[2]?.kind === 'word' &&
    tokens[2].value === 'R'
    ? id
    : undefined;
}

function pdfReference(body: string, key: string): number | undefined {
  return pdfTokenReference(pdfDictionaryValue(body, key));
}

function pdfStreamLength(body: string): number | undefined {
  const values = pdfDictionaryValue(body, 'Length');
  return pdfTokenReference(values) === undefined ? pdfNumber(values[0]) : undefined;
}

function pdfReferences(body: string, key: string): number[] {
  const value = pdfDictionaryValue(body, key);
  if (value[0]?.kind !== 'array') {
    const single = pdfTokenReference(value);
    return single === undefined ? [] : [single];
  }
  const references: number[] = [];
  for (let index = 0; index < value[0].values.length; index++) {
    const reference = pdfTokenReference(value[0].values.slice(index, index + 3));
    if (reference !== undefined) references.push(reference);
  }
  return references;
}

function pdfDictionaryText(body: string, key: string): string | undefined {
  const value = pdfDictionaryValue(body, key)[0];
  return value?.kind === 'text'
    ? stripUnsafeControls(value.value).replace(/\s+/g, ' ').trim()
    : undefined;
}

function pdfDestination(
  body: string,
  objects: Map<number, PdfObject>,
): { page?: number; top?: number; left?: number } {
  let values = pdfDictionaryValue(body, 'Dest');
  if (!values.length) {
    const action = pdfDictionaryValue(body, 'A');
    const reference = pdfTokenReference(action);
    const actionBody =
      reference === undefined
        ? pdfDictionary(body).slice(pdfDictionary(body).search(/\/A\b/) + 2)
        : objects.get(reference)?.body || '';
    values = pdfDictionaryValue(actionBody, 'D');
  }
  const reference = pdfTokenReference(values);
  if (reference !== undefined) values = pdfTokens(objects.get(reference)?.body || '').tokens;
  if (values[0]?.kind !== 'array') return {};
  const destination = values[0].values;
  const page = pdfTokenReference(destination);
  const mode = destination[3];
  const kind = mode?.kind === 'word' ? mode.value : '';
  if (kind === '/XYZ')
    return { page, left: pdfNumber(destination[4]), top: pdfNumber(destination[5]) };
  if (kind === '/FitH' || kind === '/FitBH') return { page, top: pdfNumber(destination[4]) };
  if (kind === '/FitR')
    return { page, left: pdfNumber(destination[4]), top: pdfNumber(destination[7]) };
  return { page };
}

function decodePdfStream(
  bytes: Buffer,
  compressed: boolean,
  limits: PdfLimits,
): string | undefined {
  const skipped = () => {
    limits.notes.add(
      'Some PDF streams could not be decoded within the extraction limits; text may be missing.',
    );
    return undefined;
  };
  if (bytes.length > MAX_PDF_STREAM_BYTES) return skipped();
  let decoded = bytes;
  if (compressed) {
    try {
      decoded = inflateSync(bytes, { maxOutputLength: MAX_PDF_STREAM_BYTES });
    } catch {
      try {
        decoded = inflateRawSync(bytes, { maxOutputLength: MAX_PDF_STREAM_BYTES });
      } catch {
        return skipped();
      }
    }
  }
  if (
    decoded.length > MAX_PDF_STREAM_BYTES ||
    limits.decompressedBytes + decoded.length > MAX_PDF_DECOMPRESSED_BYTES
  )
    return skipped();
  limits.decompressedBytes += decoded.length;
  return decoded.toString('latin1');
}

function pdfStreamDocuments(body: string, limits: PdfLimits): string[] {
  const documents: string[] = [];
  const dictionaryEnd = pdfDictionaryEnd(body);
  const pattern = /\bstream(?:\r\n|\r|\n)([\s\S]*?)(?:\r\n|\r|\n)endstream\b/g;
  if (dictionaryEnd !== undefined) pattern.lastIndex = dictionaryEnd;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(body))) {
    const dictionary =
      dictionaryEnd === undefined ? body.slice(0, match.index) : body.slice(0, dictionaryEnd);
    const filter = pdfDictionaryValue(dictionary, 'Filter')[0];
    const filters = filter?.kind === 'array' ? filter.values : filter ? [filter] : [];
    if (
      filters.some((value) => value.kind !== 'word' || value.value !== '/FlateDecode') ||
      filters.length > 1
    ) {
      limits.notes.add('Some PDF stream filters are unsupported; text may be missing.');
      continue;
    }
    const start = match.index + /^stream(?:\r\n|\r|\n)/.exec(match[0])![0].length;
    const length = pdfStreamLength(dictionary);
    const data =
      length !== undefined && Number.isSafeInteger(length) && length >= 0
        ? body.slice(start, start + length)
        : match[1];
    if (dictionaryEnd !== undefined) pattern.lastIndex = start + data.length;
    const text = decodePdfStream(Buffer.from(data, 'latin1'), filters.length === 1, limits);
    if (text !== undefined) documents.push(text);
  }
  return documents;
}

function pdfPageReferences(objects: Map<number, PdfObject>): number[] {
  const catalog = [...objects.values()].find((object) => pdfHasType(object.body, 'Catalog'));
  const roots = [...objects.values()].filter((object) => pdfHasType(object.body, 'Pages'));
  const catalogRoot = catalog ? pdfReference(catalog.body, 'Pages') : undefined;
  const root =
    catalogRoot === undefined
      ? roots.find((object) => pdfReference(object.body, 'Parent') === undefined) || roots[0]
      : objects.get(catalogRoot);
  const pages: number[] = [];
  const seen = new Set<number>();
  const visit = (id: number, depth: number) => {
    if (depth > MAX_PDF_ARRAY_DEPTH || seen.has(id)) return;
    seen.add(id);
    const object = objects.get(id);
    if (!object) return;
    if (pdfHasType(object.body, 'Page')) {
      pages.push(id);
      return;
    }
    for (const child of pdfReferences(object.body, 'Kids')) visit(child, depth + 1);
  };
  if (root) visit(root.id, 0);
  if (pages.length) return pages;
  return [...objects.values()]
    .filter((object) => pdfHasType(object.body, 'Page'))
    .map((object) => object.id);
}

function pdfOutlineEntries(
  objects: Map<number, PdfObject>,
  pageIndexes: Map<number, number>,
): PdfOutlineEntry[] {
  const catalog = [...objects.values()].find((object) => pdfHasType(object.body, 'Catalog'));
  const rootId = catalog ? pdfReference(catalog.body, 'Outlines') : undefined;
  const root =
    rootId === undefined
      ? [...objects.values()].find((object) => pdfHasType(object.body, 'Outlines'))
      : objects.get(rootId);
  const first = root ? pdfReference(root.body, 'First') : undefined;
  if (first === undefined) return [];
  const entries: PdfOutlineEntry[] = [];
  const seen = new Set<number>();
  const visit = (start: number, level: number) => {
    let current: number | undefined = start;
    let count = 0;
    while (current !== undefined && count++ <= MAX_PDF_ARRAY_DEPTH && !seen.has(current)) {
      seen.add(current);
      const object = objects.get(current);
      if (!object) break;
      const title = pdfDictionaryText(object.body, 'Title');
      if (title) {
        const destination = pdfDestination(object.body, objects);
        entries.push({
          title,
          level,
          pageIndex: destination.page === undefined ? undefined : pageIndexes.get(destination.page),
          top: destination.top,
          left: destination.left,
        });
      }
      const child = pdfReference(object.body, 'First');
      if (child !== undefined && level < MAX_PDF_ARRAY_DEPTH) visit(child, level + 1);
      current = pdfReference(object.body, 'Next');
    }
  };
  visit(first, 0);
  return entries;
}

function pdfPageText(
  page: PdfObject,
  streams: Map<number, string[]>,
  limits: PdfLimits,
): PdfTextChunk[] {
  const contentReferences = pdfReferences(page.body, 'Contents');
  const documents = contentReferences.length
    ? contentReferences.flatMap((reference) => streams.get(reference) || [])
    : pdfStreamDocuments(page.body, limits);
  return pdfTextOperators(documents.join('\n'));
}

function pdfText(text: string): string {
  return redactEmbeddedUrls(stripUnsafeControls(text))
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .trim()
    .replace(/^( {0,3})(?=#{1,6}\s|`{3,}|~{3,})/gm, '$1\\');
}

function pdfOutlinePosition(entry: PdfOutlineEntry, chunks: PdfTextChunk[]): number | undefined {
  if (entry.top === undefined) return 0;
  let best: { index: number; distance: number } | undefined;
  for (const [index, chunk] of chunks.entries()) {
    if (chunk.y === undefined) continue;
    const delta = entry.top - chunk.y;
    const distance =
      (delta < -2 ? 1_000_000 : 0) +
      Math.abs(delta) +
      (entry.left === undefined || chunk.x === undefined
        ? 0
        : Math.abs(entry.left - chunk.x) / 10_000);
    if (!best || distance < best.distance) best = { index, distance };
  }
  return best?.index;
}

function extractPdfDocument(base64: string): PdfDocumentText {
  const source = Buffer.from(base64, 'base64').toString('latin1');
  const objects = parsePdfObjects(source);
  const limits: PdfLimits = { decompressedBytes: 0, notes: new Set() };
  const streams = new Map<number, string[]>();
  for (const object of objects.values())
    streams.set(object.id, pdfStreamDocuments(object.body, limits));
  const pageReferences = pdfPageReferences(objects);
  if (!pageReferences.length) {
    const documents = [...streams.values()].flat();
    if (!documents.length) documents.push(...pdfStreamDocuments(source, limits));
    if (!documents.length && !/\bstream(?:\r\n|\r|\n)/.test(source)) documents.push(source);
    return {
      markdown: pdfText(
        pdfTextOperators(documents.join('\n'))
          .map((chunk) => chunk.text)
          .join('\n'),
      ),
      pages: [],
      note: [...limits.notes].join('\n') || undefined,
    };
  }
  const pageIndexes = new Map(pageReferences.map((id, index) => [id, index]));
  const pageChunks = pageReferences.map((id) => pdfPageText(objects.get(id)!, streams, limits));
  const outline = pdfOutlineEntries(objects, pageIndexes);
  const headings = new Map<number, Map<number, string[]>>();
  let missedOutlines = false;
  for (const entry of outline) {
    if (entry.pageIndex === undefined) {
      missedOutlines = true;
      continue;
    }
    const position = pdfOutlinePosition(entry, pageChunks[entry.pageIndex]);
    if (position === undefined) {
      missedOutlines = true;
      continue;
    }
    const page = headings.get(entry.pageIndex) || new Map<number, string[]>();
    const values = page.get(position) || [];
    values.push(`${'#'.repeat(Math.min(3, entry.level + 1))} ${pdfText(entry.title)}`);
    page.set(position, values);
    headings.set(entry.pageIndex, page);
  }
  if (missedOutlines)
    limits.notes.add(
      'Some PDF outline destinations could not be matched to extracted text; those headings were omitted.',
    );
  const usePageSections = !headings.size;
  let textlessPages = 0;
  const pages = pageChunks.map((chunks, index) => {
    const pageHeadings = headings.get(index);
    const parts: string[] = usePageSections ? [`# Page ${index + 1}`] : [];
    for (let position = 0; position <= chunks.length; position++) {
      parts.push(...(pageHeadings?.get(position) || []));
      if (position < chunks.length) parts.push(pdfText(chunks[position].text));
    }
    if (!chunks.some((chunk) => pdfText(chunk.text))) {
      textlessPages++;
      parts.push(
        'PDF text could not be extracted from this page. Use a screenshot of the visible tab.',
      );
    }
    return parts.filter(Boolean).join('\n\n');
  });
  if (textlessPages)
    limits.notes.add(
      `No readable text was extracted from ${textlessPages} of ${pages.length} PDF pages; try a screenshot of the visible tab.`,
    );
  return { markdown: pages.join('\n\n'), pages, note: [...limits.notes].join('\n') || undefined };
}

function csvToMarkdown(csv: string): string {
  csv = csv.replace(/^\uFEFF/, '');
  if (!csv.trim()) return '';
  const rows: string[][] = [];
  let row: string[] = [];
  let value = '';
  let quoted = false;
  for (let i = 0; i < csv.length; i++) {
    const char = csv[i];
    if (char === '"' && quoted && csv[i + 1] === '"') {
      value += '"';
      i++;
    } else if (char === '"') quoted = !quoted;
    else if (char === ',' && !quoted) {
      row.push(value.trim());
      value = '';
    } else if ((char === '\n' || char === '\r') && !quoted) {
      row.push(value.trim());
      value = '';
      if (row.some((cell) => cell)) rows.push(row);
      row = [];
      if (char === '\r' && csv[i + 1] === '\n') i++;
    } else value += char;
  }
  row.push(value.trim());
  if (row.some((cell) => cell) || rows.length === 0) rows.push(row);
  if (!rows.length) return '';
  const width = Math.max(...rows.map((row) => row.length));
  const normalized = rows.map((row) => [...row, ...Array(width - row.length).fill('')]);
  const cell = (value: string) => value.replaceAll('|', '\\|').replace(/\r?\n/g, '<br>');
  const header = `| ${normalized[0].map(cell).join(' | ')} |`;
  const divider = `| ${normalized[0].map(() => '---').join(' | ')} |`;
  return [
    header,
    divider,
    ...normalized.slice(1).map((row) => `| ${row.map(cell).join(' | ')} |`),
  ].join('\n');
}

export function convertSpecialSnapshot(snapshot: PageSnapshot): ConvertedPage {
  const special = snapshot.special;
  if (!special) return convertSnapshot(snapshot);
  let markdown = '';
  let documentPages: string[] | undefined;
  let extractionNote: string | undefined;
  if (special.kind === 'pdf') {
    const extracted = extractPdfDocument(special.base64 || '');
    markdown = extracted.markdown;
    documentPages = extracted.pages.map((page) => redactEmbeddedUrls(stripUnsafeControls(page)));
    extractionNote = extracted.note;
  } else if (special.kind === 'google-sheet') markdown = csvToMarkdown(special.text || '');
  else markdown = (special.text || '').trim();
  markdown = redactEmbeddedUrls(stripUnsafeControls(markdown));
  if (!markdown)
    markdown =
      special.kind === 'pdf'
        ? 'PDF text could not be extracted. Use a screenshot of the visible tab.'
        : 'The exported document was empty.';
  const sections = buildSectionTree(markdown);
  return {
    url: snapshot.url,
    title: snapshot.title,
    markdown,
    words: markdown.split(/\s+/).filter(Boolean).length,
    sections,
    pages: documentPages?.length ? documentPages : splitPages(markdown, 20_000),
    pagesAreDocumentPages: special.kind === 'pdf' && Boolean(documentPages?.length),
    note:
      extractionNote ||
      (special.kind === 'pdf' && markdown.startsWith('PDF text could not')
        ? 'try screenshot for this visual document'
        : undefined),
  };
}

export { plainLinks } from './links.js';
