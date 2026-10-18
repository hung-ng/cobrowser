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
  special?: { kind: SpecialKind; text?: string; base64?: string };
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
  let markdown = stripUnsafeControls(
    turndown
      .turndown(content)
      .replace(/\n{3,}/g, '\n\n')
      .trim(),
  );
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
  return result;
}

function pdfHex(value: string): string {
  const bytes = Buffer.from(value.length % 2 ? `${value}0` : value, 'hex');
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
      const end = source.indexOf('\n', index + 1);
      index = end < 0 ? source.length : end + 1;
      continue;
    }
    if (char === '(') {
      let depth = 1;
      let value = '';
      index++;
      while (index < source.length && depth > 0) {
        const current = source[index];
        if (current === '\\') {
          value += current;
          index++;
          if (index < source.length) value += source[index++];
          continue;
        }
        if (current === '(') depth++;
        else if (current === ')') {
          depth--;
          if (!depth) {
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
    if (char === '<' && source[index + 1] === '<') {
      tokens.push({ kind: 'word', value: '<<' });
      index += 2;
      continue;
    }
    if (char === '>' && source[index + 1] === '>') {
      tokens.push({ kind: 'word', value: '>>' });
      index += 2;
      continue;
    }
    if (char === '[') {
      if (depth >= MAX_PDF_ARRAY_DEPTH) {
        const end = source.indexOf(']', index + 1);
        index = end < 0 ? source.length : end + 1;
        continue;
      }
      const nested = pdfTokens(source, index + 1, true, depth + 1);
      tokens.push({ kind: 'array', values: nested.tokens });
      index = nested.next;
      continue;
    }
    let end = index + 1;
    while (end < source.length && !/[\s()[\]<>%]/.test(source[end])) end++;
    tokens.push({ kind: 'word', value: source.slice(index, end) });
    index = end;
  }
  return { tokens, next: index };
}

function pdfTextOperators(body: string): string[] {
  const tokens = pdfTokens(body).tokens;
  const chunks: string[] = [];
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token.kind !== 'word') continue;
    const previous = tokens[index - 1];
    if (token.value === 'Tj' && previous?.kind === 'text') chunks.push(previous.value);
    if (token.value === 'TJ' && previous?.kind === 'array')
      chunks.push(
        previous.values
          .filter((value): value is Extract<PdfToken, { kind: 'text' }> => value.kind === 'text')
          .map((value) => value.value)
          .join(''),
      );
  }
  return chunks;
}

interface PdfObject {
  id: number;
  body: string;
}

interface PdfStreamDocument {
  text: string;
  compressed: boolean;
}

interface PdfLimits {
  decompressedBytes: number;
}

interface PdfDocumentText {
  markdown: string;
  pages: string[];
}

interface PdfOutlineEntry {
  title: string;
  level: number;
  pageIndex?: number;
}

function pdfDictionary(body: string): string {
  const stream = /\bstream\r?\n/.exec(body)?.index;
  return stream === undefined ? body : body.slice(0, stream);
}

function parsePdfObjects(source: string): Map<number, PdfObject> {
  const objects = new Map<number, PdfObject>();
  for (const match of source.matchAll(/(?:^|\r?\n)(\d+)\s+\d+\s+obj\b([\s\S]*?)\bendobj\b/g)) {
    const id = Number(match[1]);
    if (Number.isSafeInteger(id)) objects.set(id, { id, body: match[2] });
  }
  return objects;
}

function pdfHasType(body: string, type: string): boolean {
  return new RegExp(`/Type\\s+/${type}\\b`).test(pdfDictionary(body));
}

function pdfReference(body: string, key: string): number | undefined {
  const match = new RegExp(`/${key}\\s+(\\d+)\\s+\\d+\\s+R`).exec(pdfDictionary(body));
  const id = match ? Number(match[1]) : NaN;
  return Number.isSafeInteger(id) ? id : undefined;
}

function pdfReferences(body: string, key: string): number[] {
  const dictionary = pdfDictionary(body);
  const array = new RegExp(`/${key}\\s*\\[([\\s\\S]*?)\\]`).exec(dictionary)?.[1];
  const values = array
    ? [...array.matchAll(/(\d+)\s+\d+\s+R/g)].map((match) => Number(match[1]))
    : [];
  if (values.length) return values.filter((value) => Number.isSafeInteger(value));
  const single = pdfReference(dictionary, key);
  return single === undefined ? [] : [single];
}

function pdfDictionaryText(body: string, key: string): string | undefined {
  const dictionary = pdfDictionary(body);
  const tokens = pdfTokens(dictionary).tokens;
  for (let index = 0; index + 1 < tokens.length; index++) {
    const token = tokens[index];
    const value = tokens[index + 1];
    if (token.kind === 'word' && token.value === `/${key}` && value?.kind === 'text')
      return stripUnsafeControls(value.value).replace(/\s+/g, ' ').trim();
  }
  return undefined;
}

function pdfDestinationPageReference(body: string): number | undefined {
  const dictionary = pdfDictionary(body);
  const destination =
    /\/Dest\s*(?:\[\s*)?(\d+)\s+\d+\s+R/.exec(dictionary)?.[1] ||
    /\/D\s*(?:\[\s*)?(\d+)\s+\d+\s+R/.exec(dictionary)?.[1];
  const id = destination === undefined ? NaN : Number(destination);
  return Number.isSafeInteger(id) ? id : undefined;
}

function decodePdfStream(
  bytes: Buffer,
  compressed: boolean,
  limits: PdfLimits,
): string | undefined {
  if (bytes.length > MAX_PDF_STREAM_BYTES) return undefined;
  let decoded = bytes;
  if (compressed) {
    try {
      decoded = inflateSync(bytes, { maxOutputLength: MAX_PDF_STREAM_BYTES });
    } catch {
      try {
        decoded = inflateRawSync(bytes, { maxOutputLength: MAX_PDF_STREAM_BYTES });
      } catch {
        return undefined;
      }
    }
  }
  if (
    decoded.length > MAX_PDF_STREAM_BYTES ||
    limits.decompressedBytes + decoded.length > MAX_PDF_DECOMPRESSED_BYTES
  )
    return undefined;
  limits.decompressedBytes += decoded.length;
  return decoded.toString('latin1');
}

function pdfStreamDocuments(body: string, limits: PdfLimits): PdfStreamDocument[] {
  const documents: PdfStreamDocument[] = [];
  const pattern = /([\s\S]*?)\bstream\r?\n([\s\S]*?)\r?\nendstream/g;
  for (const match of body.matchAll(pattern)) {
    const bytes = Buffer.from(match[2], 'latin1');
    const compressed = /\/FlateDecode\b/.test(match[1]);
    const text = decodePdfStream(bytes, compressed, limits);
    if (text !== undefined) documents.push({ text, compressed });
  }
  return documents;
}

function pdfTextFromDocuments(documents: Iterable<string>): string {
  const chunks: string[] = [];
  for (const document of documents)
    for (const stream of document.matchAll(/BT([\s\S]*?)ET/g))
      chunks.push(...pdfTextOperators(stream[1]));
  return chunks
    .join('\n')
    .replace(/[\u0000\r]+/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .trim();
}

function pdfPageReferences(objects: Map<number, PdfObject>): number[] {
  const roots = [...objects.values()].filter((object) => pdfHasType(object.body, 'Pages'));
  const root =
    roots.find((object) => pdfReference(object.body, 'Parent') === undefined) || roots[0];
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
  const root = [...objects.values()].find((object) => pdfHasType(object.body, 'Outlines'));
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
        const pageReference = pdfDestinationPageReference(object.body);
        entries.push({
          title,
          level,
          pageIndex: pageReference === undefined ? undefined : pageIndexes.get(pageReference),
        });
      }
      const child = pdfReference(object.body, 'First');
      if (child !== undefined) visit(child, level + 1);
      current = pdfReference(object.body, 'Next');
    }
  };
  visit(first, 0);
  return entries;
}

function pdfPageText(
  page: PdfObject,
  objects: Map<number, PdfObject>,
  streams: Map<number, PdfStreamDocument[]>,
  limits: PdfLimits,
): string {
  const documents: string[] = [];
  const contentReferences = pdfReferences(page.body, 'Contents');
  if (contentReferences.length) {
    for (const reference of contentReferences) {
      const content = streams.get(reference);
      if (content?.length) documents.push(...content.map((item) => item.text));
      else {
        const object = objects.get(reference);
        if (object)
          documents.push(...pdfStreamDocuments(object.body, limits).map((item) => item.text));
      }
    }
  } else documents.push(...pdfStreamDocuments(page.body, limits).map((item) => item.text));
  return pdfTextFromDocuments(documents);
}

function extractPdfDocument(base64: string): PdfDocumentText {
  let source: string;
  try {
    source = Buffer.from(base64, 'base64').toString('latin1');
  } catch {
    return { markdown: '', pages: [] };
  }
  const objects = parsePdfObjects(source);
  const limits: PdfLimits = { decompressedBytes: 0 };
  const streams = new Map<number, PdfStreamDocument[]>();
  const documents = [source];
  let compressedStreamFound = false;
  for (const object of objects.values()) {
    const decoded = pdfStreamDocuments(object.body, limits);
    if (!decoded.length) continue;
    streams.set(object.id, decoded);
    for (const item of decoded) {
      if (item.compressed) {
        compressedStreamFound = true;
        documents.push(item.text);
      }
    }
  }
  if (!compressedStreamFound) {
    for (const item of pdfStreamDocuments(source, limits))
      if (item.compressed) documents.push(item.text);
  }
  const fallback = pdfTextFromDocuments(documents);
  const pageReferences = pdfPageReferences(objects);
  if (!pageReferences.length) return { markdown: fallback, pages: [] };
  const pageIndexes = new Map(pageReferences.map((id, index) => [id, index]));
  const pageTexts = pageReferences.map((id) => {
    const page = objects.get(id);
    return page ? pdfPageText(page, objects, streams, limits) : '';
  });
  if (!pageTexts.some(Boolean)) return { markdown: fallback, pages: [] };
  const headings = new Map<number, string[]>();
  for (const entry of pdfOutlineEntries(objects, pageIndexes)) {
    if (entry.pageIndex === undefined) continue;
    const prefix = '#'.repeat(Math.min(6, entry.level + 1));
    const values = headings.get(entry.pageIndex) || [];
    values.push(`${prefix} ${entry.title}`);
    headings.set(entry.pageIndex, values);
  }
  const pages = pageTexts.map((text, index) => {
    const parts = [...(headings.get(index) || []), text].filter(Boolean);
    return parts.join('\n\n').trim();
  });
  return { markdown: pages.filter(Boolean).join('\n\n'), pages };
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
  if (special.kind === 'pdf') {
    const extracted = extractPdfDocument(special.base64 || '');
    markdown = extracted.markdown;
    documentPages = extracted.pages;
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
      special.kind === 'pdf' && markdown.startsWith('PDF text could not')
        ? 'try screenshot for this visual document'
        : undefined,
  };
}

export function plainLinks(markdown: string): string {
  return markdown.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1');
}
