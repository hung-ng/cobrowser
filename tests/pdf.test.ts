import { describe, expect, it } from 'vitest';
import { convertSpecialSnapshot } from '../src/shared/read.js';
import { flattenSections } from '../src/shared/sections.js';
import {
  pdfFixture,
  pdfTextPage,
  type PdfOutlineFixture,
  type PdfPageFixture,
} from './fixtures/pdf.js';

function convert(pages: PdfPageFixture[], outline: PdfOutlineFixture[] = []) {
  return convertSpecialSnapshot({
    url: 'https://example.test/report.pdf',
    title: 'Report',
    html: '',
    special: { kind: 'pdf', base64: pdfFixture(pages, outline).toString('base64') },
  });
}

describe('PDF conversion', () => {
  it('keeps operator names and structural words inside literal text', () => {
    const page = convert([
      pdfTextPage('BETA report and METHODS, BT, ET, endobj, endstream and /Type /Page are text.'),
      pdfTextPage('Second page'),
    ]);
    expect(page.pages).toHaveLength(2);
    expect(page.pages[0]).toContain(
      'BETA report and METHODS, BT, ET, endobj, endstream and /Type /Page are text.',
    );
    expect(page.pages[1]).toContain('Second page');
    expect(flattenSections(page.sections).map((section) => section.title)).toEqual([
      'Page 1',
      'Page 2',
    ]);
  });

  it('uses physical pages as sections when there is no outline', () => {
    const page = convert([pdfTextPage('Alpha '.repeat(800)), pdfTextPage('Beta '.repeat(800))]);
    expect(page.pagesAreDocumentPages).toBe(true);
    expect(page.pages).toHaveLength(2);
    expect(
      flattenSections(page.sections).map(({ number, title, words }) => ({ number, title, words })),
    ).toEqual([
      { number: '1', title: 'Page 1', words: 803 },
      { number: '2', title: 'Page 2', words: 803 },
    ]);
    expect(page.sections[0].text).not.toContain('Beta');
    expect(page.sections[1].text).not.toContain('Alpha');
  });

  it('redacts credentials in page bodies, outline titles, markdown and section text', () => {
    const page = convert(
      [
        pdfTextPage(
          'Read https://user:secret@example.test/private and //reader:password@example.test/other',
        ),
        pdfTextPage('Second page'),
      ],
      [{ title: 'https://admin:topsecret@example.test/title', page: 0 }],
    );
    const output = JSON.stringify(page);
    for (const secret of ['user:', 'secret', 'reader:', 'password', 'admin:'])
      expect(output).not.toContain(secret);
    expect(page.pages[0]).toContain('https://example.test/private');
    expect(page.sections[0].title).toBe('https://example.test/title');
  });

  it('splits same-page outline sections at XYZ destinations across content streams', () => {
    const page = convert(
      [
        {
          compressed: true,
          streams: [
            'q 1 0 0 1 0 20 cm BT /F1 12 Tf 1 0 0 1 72 700 Tm (First section body) Tj ET Q',
            'BT /F1 12 Tf 72 420 Td (Second section body) Tj ET',
          ],
        },
      ],
      [
        { title: 'First title', page: 0, top: 720 },
        { title: 'Second title', page: 0, top: 420, action: true },
      ],
    );
    expect(page.sections.map(({ title, text }) => ({ title, text }))).toEqual([
      { title: 'First title', text: '# First title\n\nFirst section body' },
      { title: 'Second title', text: '# Second title\n\nSecond section body' },
    ]);
    expect(page.pages).toEqual([
      '# First title\n\nFirst section body\n\n# Second title\n\nSecond section body',
    ]);
  });

  it('keeps textless pages in place and reports the extraction gap', () => {
    const page = convert([{ streams: [] }, pdfTextPage('Middle page'), { streams: ['BT ET'] }]);
    expect(page.pages).toHaveLength(3);
    expect(page.pagesAreDocumentPages).toBe(true);
    expect(page.pages[0]).toContain('# Page 1\n\nPDF text could not be extracted');
    expect(page.pages[1]).toContain('Middle page');
    expect(page.pages[2]).toContain('# Page 3\n\nPDF text could not be extracted');
    expect(page.note).toContain('2 of 3 PDF pages');
    const empty = convert([{ streams: [] }, { streams: [] }]);
    expect(empty.pages).toHaveLength(2);
    expect(empty.note).toContain('2 of 2 PDF pages');
  });

  it('reads quote operators, TJ spacing, hex strings and text spanning streams', () => {
    const page = convert([
      {
        streams: [
          'BT /F1 12 Tf 72 720 Td 24 TL (First line) Tj % ET is a comment\r (Second line) \' 0 0 (Third line) " [(Two) -250 (words) 20 (!)] TJ <42 45 54 41> Tj',
          '(Last line) Tj ET (Outside text) Tj',
        ],
      },
    ]);
    for (const text of [
      'First line',
      'Second line',
      'Third line',
      'Two words!',
      'BETA',
      'Last line',
    ])
      expect(page.markdown).toContain(text);
    expect(page.markdown).not.toContain('Outside text');
  });

  it('reports unsupported filters and destinations without assigning the wrong body', () => {
    const filtered = convert([{ streams: ['BT (Hidden) Tj ET'], filter: 'ASCII85Decode' }]);
    expect(filtered.pages).toHaveLength(1);
    expect(filtered.markdown).not.toContain('Hidden');
    expect(filtered.note).toContain('filters are unsupported');
    const unpositioned = convert(
      [{ streams: ['BT (Body without coordinates) Tj ET'] }],
      [{ title: 'Unknown location', page: 0, top: 400 }],
    );
    expect(unpositioned.sections[0].title).toBe('Page 1');
    expect(unpositioned.note).toContain('outline destinations could not be matched');
  });
});
