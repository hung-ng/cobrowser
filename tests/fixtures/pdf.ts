import { deflateSync } from 'node:zlib';

export interface PdfOutlineFixture {
  title: string;
  page: number;
  top?: number;
  action?: boolean;
}

export interface PdfPageFixture {
  streams: string[];
  compressed?: boolean;
  filter?: string;
}

export function pdfLiteralText(text: string): string {
  return `(${text.replace(/[\\()]/g, '\\$&')})`;
}

export function pdfFixture(pages: PdfPageFixture[], outline: PdfOutlineFixture[] = []): Buffer {
  const objects = new Map<number, string>();
  const pageIds = pages.map((_, index) => 20 + index);
  objects.set(1, `<< /Type /Catalog /Pages 2 0 R${outline.length ? ' /Outlines 3 0 R' : ''} >>`);
  objects.set(
    2,
    `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pages.length} >>`,
  );
  objects.set(4, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  let nextId = 100;
  for (const [index, page] of pages.entries()) {
    const contents: number[] = [];
    for (const source of page.streams) {
      const id = nextId++;
      contents.push(id);
      const bytes = page.compressed
        ? deflateSync(Buffer.from(source, 'latin1'))
        : Buffer.from(source, 'latin1');
      const filter = page.filter || (page.compressed ? 'FlateDecode' : undefined);
      objects.set(
        id,
        `<< /Length ${bytes.length}${filter ? ` /Filter /${filter}` : ''} >>\nstream\n${bytes.toString('latin1')}\nendstream`,
      );
    }
    objects.set(
      pageIds[index],
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents [${contents.map((id) => `${id} 0 R`).join(' ')}] >>`,
    );
  }
  if (outline.length) {
    const firstId = nextId;
    objects.set(
      3,
      `<< /Type /Outlines /First ${firstId} 0 R /Last ${firstId + outline.length - 1} 0 R /Count ${outline.length} >>`,
    );
    for (const [index, entry] of outline.entries()) {
      const destination = `[${pageIds[entry.page]} 0 R ${entry.top === undefined ? '/Fit' : `/XYZ 72 ${entry.top} null`}]`;
      objects.set(
        nextId++,
        `<< /Title ${pdfLiteralText(entry.title)} /Parent 3 0 R ${entry.action ? `/A << /S /GoTo /D ${destination} >>` : `/Dest ${destination}`}${index + 1 < outline.length ? ` /Next ${firstId + index + 1} 0 R` : ''} >>`,
      );
    }
  }
  let source = '%PDF-1.4\n';
  const offsets = new Map<number, number>();
  for (const [id, body] of objects) {
    offsets.set(id, Buffer.byteLength(source, 'latin1'));
    source += `${id} 0 obj\n${body}\nendobj\n`;
  }
  const xref = Buffer.byteLength(source, 'latin1');
  const size = Math.max(...objects.keys()) + 1;
  source += `xref\n0 ${size}\n0000000000 65535 f \n`;
  for (let id = 1; id < size; id++)
    source += offsets.has(id)
      ? `${String(offsets.get(id)).padStart(10, '0')} 00000 n \n`
      : '0000000000 00000 f \n';
  source += `trailer\n<< /Size ${size} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(source, 'latin1');
}

export function pdfTextPage(text: string): PdfPageFixture {
  return { streams: [`BT /F1 12 Tf 72 720 Td ${pdfLiteralText(text)} Tj ET`] };
}
