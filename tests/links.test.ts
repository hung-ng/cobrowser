import { describe, expect, it } from 'vitest';
import { convertSnapshot, plainLinks } from '../src/shared/read.js';
import { findInMarkdown } from '../src/shared/search.js';

describe('plain links', () => {
  it('removes balanced destinations and titles while preserving nested labels', () => {
    expect(plainLinks('[outer [inner]](https://example.test/a_(b))')).toBe('outer [inner]');
    expect(plainLinks('[escaped \\[label\\]](https://example.test/a_\\(b\\))')).toBe(
      'escaped \\[label\\]',
    );
    expect(plainLinks('[title](https://example.test/a_(b) "A title (with parentheses)")')).toBe(
      'title',
    );
    expect(plainLinks("[angle](<https://example.test/a_(b)> 'Title ) here')")).toBe('angle');
    expect(plainLinks('[empty]()')).toBe('empty');
  });

  it('preserves code spans, exact backtick runs, fences and indented code', () => {
    for (const code of [
      '`[name](type)`',
      '`` `[name](type)` ``',
      '`line\n[name](type)`',
      '~~~txt\n[name](type)\n~~~',
      '````\n```\n[name](type)\n```\n````',
      '    [name](type)',
    ]) {
      expect(plainLinks(`${code}\n\n[link](https://example.test)`)).toBe(`${code}\n\nlink`);
    }
    expect(plainLinks('[`[name](type)`](https://example.test)')).toBe('`[name](type)`');
    expect(plainLinks('``[name](type)`')).toBe('``name`');
  });

  it.each(['`', '``', '\\`'])(
    'preserves inline code immediately after literal ticks %s',
    (ticks) => {
      const page = convertSnapshot(
        {
          url: 'https://example.test/code',
          title: 'Code',
          html: `<html><body><p>${ticks}<code>[name](type)</code> <a href="https://example.test">link</a></p></body></html>`,
        },
        true,
      );
      const text = plainLinks(page.markdown);
      expect(text).toContain('[name](type)');
      expect(text).not.toContain('https://example.test');
      expect(findInMarkdown(text, '[name](type)')).toEqual([
        { line: `${ticks}[name](type) link`, section: '0' },
      ]);
    },
  );

  it.each([
    '> ~~~md\n> [name](type)\n> ~~~',
    '>     [name](type)',
    '> > ~~~md\n> > [name](type)\n> > ~~~~',
    '> - ~~~md\n>   [name](type)\n>   ~~~',
    '- > ~~~md\n  > [name](type)\n  > ~~~',
    '> - Item\n>\n>       [name](type)',
    '- Item\n\n  >     [name](type)',
    '> ~~~md\r\n> [name](type)\r\n> ~~~',
  ])('preserves quoted code and converts following prose links in %s', (code) => {
    const markdown = `${code}\n\n> [link](https://example.test)`;
    expect(plainLinks(markdown)).toBe(`${code}\n\n> link`);
    expect(findInMarkdown(plainLinks(markdown), '[name](type)')).toEqual([
      { line: '[name](type)', section: '0' },
    ]);
  });

  it('leaves escaped and malformed link text intact', () => {
    for (const text of [
      '\\[name](type)',
      '[missing](https://example.test/a_(b)',
      '[missing](url "unclosed)',
      '[missing](url invalid title)',
    ])
      expect(plainLinks(text)).toBe(text);
  });

  it('removes links in nested lists and indented paragraph continuations', () => {
    for (const text of [
      '1. Outer\n    - [Inner](https://example.test/nested)\n',
      '- Outer\n  - Middle\n    - [Inner](https://example.test/nested)\n',
      '1. Outer\n\n    [Inner](https://example.test/nested)\n',
      '1. Outer\n\t- [Inner](https://example.test/nested)\n',
      '1. Outer\n    - Nested\n      [Inner](https://example.test/nested)\n',
      'Paragraph\n    [Inner](https://example.test/nested)\n',
    ]) {
      expect(plainLinks(text)).toBe(text.replace('[Inner](https://example.test/nested)', 'Inner'));
    }
  });

  it('preserves real indented code at the document and list content indentation', () => {
    for (const code of [
      '    - [literal](type)\n',
      '1. Outer\n\n       [literal](type)\n',
      '- Outer\n  - Nested\n\n        [literal](type)\n',
      'Paragraph\n\n    [literal](type)\n',
      '# Heading\n    [literal](type)\n',
    ])
      expect(plainLinks(code)).toBe(code);
  });
});
