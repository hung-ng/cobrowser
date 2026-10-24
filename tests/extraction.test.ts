import { describe, expect, it } from 'vitest';
import { convertSnapshot, plainLinks } from '../src/shared/read.js';
import { findInMarkdown } from '../src/shared/search.js';
import { buildSectionTree, flattenSections } from '../src/shared/sections.js';

function converted(html: string) {
  return convertSnapshot(
    {
      url: 'https://example.test/article',
      title: 'Article',
      html: `<html><body>${html}</body></html>`,
    },
    true,
  );
}

describe('extracted code whitespace', () => {
  it('preserves blank lines and trailing spaces inside multiline string values', () => {
    const code = 'const text = `first  \n\n\nlast`;\n\n\nconst next = 1;';
    const page = converted(`<pre><code>${code}</code></pre><p>After.</p>`);
    expect(page.markdown).toContain(`\n${code}\n`);
    expect(page.markdown).toContain('```\n\nAfter.');
  });
});

describe('rendered search text', () => {
  it.each([
    ['Literal a\\_b and a\\*b.', 'a_b', 'Literal a_b and a*b.'],
    ['Please *do not* enter.', 'Please do not enter.', 'Please do not enter.'],
    ['**bold and _nested_** labels', 'bold and nested', 'bold and nested labels'],
    ['***both styles***', 'both styles', 'both styles'],
    ['~~old~~ and new', 'old and new', 'old and new'],
    ['un_matched and a*b', 'un_matched', 'un_matched and a*b'],
    [
      'Inline `a_b *keep* [name](type)`.',
      'a_b *keep* [name](type)',
      'Inline a_b *keep* [name](type).',
    ],
    ['Use `` `[ticks]` a\\_b ``.', '`[ticks]` a\\_b', 'Use `[ticks]` a\\_b.'],
    [
      'Escaped \\*literal\\* and *styled*.',
      '*literal* and styled',
      'Escaped *literal* and styled.',
    ],
  ])('searches %s as visible text', (markdown, query, line) => {
    expect(findInMarkdown(markdown, query)).toEqual([{ line, section: '0' }]);
  });

  it.each([
    ['Before ~old~ after.', 'Before old after.'],
    ['Before ~~old~~ after.', 'Before old after.'],
    ['Code `~literal~` stays.', 'Code ~literal~ stays.'],
    ['Escaped \\~literal\\~ stays.', 'Escaped ~literal~ stays.'],
    ['Unpaired ~home and ~user.', 'Unpaired ~home and ~user.'],
    ['Mixed ~literal~~ stays.', 'Mixed ~literal~~ stays.'],
    ['Long ~~~literal~~~ stays.', 'Long ~~~literal~~~ stays.'],
  ])('handles converter strikethrough and literal controls in %s', (markdown, line) => {
    expect(findInMarkdown(markdown, line)).toEqual([{ line, section: '0' }]);
  });

  it.each([
    '<blockquote>CONTENT</blockquote>',
    '<blockquote><blockquote>CONTENT</blockquote></blockquote>',
    '<ul><li><blockquote>CONTENT</blockquote></li></ul>',
    '<blockquote><ul><li>CONTENT</li></ul></blockquote>',
    '<ul><li><ul><li><blockquote>CONTENT</blockquote></li></ul></li></ul>',
    '<blockquote><ul><li><blockquote>CONTENT</blockquote></li></ul></blockquote>',
    '<ol><li><blockquote><ul><li>CONTENT</li></ul></blockquote></li></ol>',
  ])('keeps code literal inside quote and list containers %s', (container) => {
    const html = container.replace(
      'CONTENT',
      '<pre><code>*literal* a_b\n&gt; *quoted* ~keep~</code></pre><p>Quoted <em>plain prose</em> remains.</p>',
    );
    const { markdown } = converted(html);
    for (const query of ['*literal* a_b', '> *quoted* ~keep~', 'Quoted plain prose remains.']) {
      expect(findInMarkdown(markdown, query)).toEqual([{ line: query, section: '0' }]);
    }
    expect(findInMarkdown(markdown, 'literal a_b')).toEqual([]);
  });

  it('keeps section identities after quoted code and treats indented quoted code literally', () => {
    const markdown =
      '# Root\n\n> ```\n> ## *literal*\n> ```\n>\n>     *indented* ~keep~\n>\n> Please *do not* enter.\n\n## Child\nAnswer.';
    expect(findInMarkdown(markdown, '## *literal*')[0].section).toBe('1');
    expect(findInMarkdown(markdown, '*indented* ~keep~')[0].section).toBe('1');
    expect(findInMarkdown(markdown, 'Please do not enter.')[0].section).toBe('1');
    expect(findInMarkdown(markdown, 'Answer.')[0].section).toBe('1.1');
  });

  it.each(['x\\', 'x\\*', 'x\\`'])('keeps backslashes literal inside inline code %s', (code) => {
    const page = converted(`<p>Use <code>${code}</code> here.</p>`);
    expect(findInMarkdown(page.markdown, code)).toEqual([
      { line: `Use ${code} here.`, section: '0' },
    ]);
  });

  it('keeps escaped prose ticks separate from real code delimiters', () => {
    expect(findInMarkdown('Use \\`*styled*\\` here.', '`styled`')).toEqual([
      { line: 'Use `styled` here.', section: '0' },
    ]);
    expect(findInMarkdown('Escaped \\` then `x\\` and *styled*.', 'x\\')).toEqual([
      { line: 'Escaped ` then x\\ and styled.', section: '0' },
    ]);
    expect(findInMarkdown('Use \\``x\\` here.', '`x\\')).toEqual([
      { line: 'Use `x\\ here.', section: '0' },
    ]);
    expect(findInMarkdown('Use ``literal` text.', '``literal`')).toEqual([
      { line: 'Use ``literal` text.', section: '0' },
    ]);
  });

  it('keeps fenced and indented code literal and preserves section identities', () => {
    const markdown =
      '# Root\n\n````md\n# *literal* a\\_b\n```\n````\n\n## Child\n\n    *literal* a\\_b\n\n- Nested\n  - Editor\n\n        *literal* a\\_b\n\n## Sibling\nPlease *do not* enter.';
    expect(findInMarkdown(markdown, '*literal* a\\_b').map(({ section }) => section)).toEqual([
      '1',
      '1.1',
      '1.1',
    ]);
    expect(findInMarkdown(markdown, 'Please do not enter.')).toEqual([
      { line: 'Please do not enter.', section: '1.2' },
    ]);
    expect(findInMarkdown(markdown, '*do not*')).toEqual([]);
  });

  it('keeps short and long scalar matches inside bounded excerpts', () => {
    for (const query of ['NEEDLETARGET', 'Q'.repeat(150), '𐐀MATCH🐈']) {
      const line = `${'İstanbul '.repeat(150)}${'🐈'.repeat(45)}${query}${'🐈'.repeat(120)}`;
      const match = findInMarkdown(line, query.toLowerCase())[0];
      expect(match.line).toContain(query);
      expect(match.line.length).toBeLessThanOrEqual(200);
      expect(match.line).not.toMatch(/[\ud800-\udfff]/u);
    }
  });

  it('maps expanding lowercase characters while retaining contextual final sigma', () => {
    const line = `${'İstanbul '.repeat(150)}ΟΣ ${'tail '.repeat(100)}`;
    const match = findInMarkdown(line, 'ος')[0];
    expect(match.line).toContain('ΟΣ');
    expect(match.line.length).toBeLessThanOrEqual(200);
    expect(findInMarkdown('ΟΣ', 'ΟΣ')).toEqual([{ line: 'ΟΣ', section: '0' }]);
    expect(findInMarkdown('ΟΣ', 'οσ')).toEqual([]);
    expect(findInMarkdown('İ', 'i\u0307')).toEqual([{ line: 'İ', section: '0' }]);
  });

  it('retains heading numbers and the matching heading text', () => {
    const markdown =
      'Preamble\n\n# Root\n## *First*\n### Child\none\n## **Second**\ntwo\n# Next\nthree';
    expect(findInMarkdown(markdown, 'Second')).toEqual([{ line: 'Second', section: '1.2' }]);
    expect(findInMarkdown(markdown, 'three')[0].section).toBe('2');
    expect(findInMarkdown(markdown, 'Preamble')[0].section).toBe('0');
  });
});

describe('selected section content', () => {
  it('keeps indented paragraph continuations as prose', () => {
    const markdown =
      '# Root\nParagraph.\n    # still prose\n    [label](https://example.test)\n\n   ## Child\nAnswer.';
    expect(flattenSections(buildSectionTree(markdown)).map(({ title }) => title)).toEqual([
      'Root',
      'Child',
    ]);
    expect(plainLinks(markdown)).toBe(markdown.replace('[label](https://example.test)', 'label'));
    expect(findInMarkdown(markdown, '# still prose')).toEqual([
      { line: '# still prose', section: '1' },
    ]);
    expect(findInMarkdown(markdown, 'Answer.')[0].section).toBe('1.1');
  });

  it.each([
    '- ```md\n  # literal\n  [name](type)\n  ```',
    '- Item\n  - ~~~md\n    # literal\n    [name](type)\n    ~~~',
    '> - ```md\n>   # literal\n>   [name](type)\n>   ```',
    '- > ~~~md\n  > # literal\n  > [name](type)\n  > ~~~',
    '- Item\n\n      # literal\n      [name](type)',
  ])('keeps container code out of the section outline in %s', (code) => {
    const markdown = `# Root\n\n${code}\n\n## Child\nChild answer.\n\n# Other\nOther answer.`;
    const sections = flattenSections(buildSectionTree(markdown));
    expect(sections.map(({ number, title }) => ({ number, title }))).toEqual([
      { number: '1', title: 'Root' },
      { number: '1.1', title: 'Child' },
      { number: '2', title: 'Other' },
    ]);
    expect(sections[0].text).toContain(code);
    expect(sections[1].text).toBe('## Child\nChild answer.');
    expect(findInMarkdown(markdown, '# literal')).toEqual([{ line: '# literal', section: '1' }]);
    expect(findInMarkdown(markdown, 'Child answer.')[0].section).toBe('1.1');
    expect(findInMarkdown(markdown, 'Other answer.')[0].section).toBe('2');
  });

  it('includes selected and descendant headings while excluding siblings', () => {
    const markdown =
      'Preamble\n\n# Root\nParent.\n\n## First\nOne.\n\n### Child\nTwo.\n\n## Second\nThree.\n\n# Other\nFour.';
    const sections = flattenSections(buildSectionTree(markdown));
    expect(sections.map(({ number }) => number)).toEqual(['0', '1', '1.1', '1.1.1', '1.2', '2']);
    expect(sections.find(({ number }) => number === '1.1')?.text).toBe(
      '## First\nOne.\n\n### Child\nTwo.',
    );
    expect(sections.find(({ number }) => number === '1')?.text).toContain('## Second\nThree.');
    expect(sections.find(({ number }) => number === '1')?.text).not.toContain('Four.');
    expect(sections[0].text).toBe('Preamble');
  });

  it('retains headings with no body and counts the returned content', () => {
    const sections = flattenSections(buildSectionTree('# Root\n\n## Child'));
    expect(sections[0].text).toBe('# Root\n\n## Child');
    expect(sections[1].text).toBe('## Child');
    expect(sections[1].words).toBe(2);
  });
});
