import { describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { guessAgent, liveBrowsers } from '../src/client.js';
import { matchesDenylist } from '../src/shared/denylist.js';
import { filterTabs } from '../src/shared/filters.js';
import { NativeFrameDecoder, encodeFrame } from '../src/shared/native.js';
import { capText, splitPages } from '../src/shared/paging.js';
import { convertSnapshot } from '../src/shared/read.js';
import { buildSectionTree, flattenSections } from '../src/shared/sections.js';

describe('filters', () => {
  const tabs = [
    {
      id: 1,
      windowId: 1,
      active: false,
      title: 'GitHub issue',
      url: 'https://github.com/a',
      openedAt: 10,
      lastAccessed: 10,
    },
    {
      id: 2,
      windowId: 1,
      active: true,
      title: 'Docs',
      url: 'https://docs.test',
      lastAccessed: 20,
    },
    {
      id: 3,
      windowId: 2,
      active: true,
      title: 'Recent GitHub',
      url: 'https://github.com/b',
      openedAt: 25,
      lastAccessed: 30,
    },
  ];

  it('matches every search word and sorts newest opens first', () => {
    const result = filterTabs(tabs, { match: 'github issue', now: 30 });

    expect(result.map((tab) => tab.id)).toEqual([1]);
  });

  it('treats tabs without open times as older than a since filter', () => {
    const result = filterTabs(tabs, { sinceMs: 15, now: 30 });

    expect(result.map((tab) => tab.id)).toEqual([3]);
  });

  it('filters the front window and active tabs', () => {
    const result = filterTabs(tabs, { window: 'front', active: true }, 2);

    expect(result.map((tab) => tab.id)).toEqual([3]);
  });

  it('keeps offset pagination stable after sorting', () => {
    const result = filterTabs(
      [
        { ...tabs[0], openedAt: 10 },
        { ...tabs[1], openedAt: 20 },
        { ...tabs[2], openedAt: 30 },
      ],
      {},
    );

    expect(result.slice(1, 3).map((tab) => tab.id)).toEqual([2, 1]);
  });
});

describe('sections', () => {
  it('creates section zero for preamble text', () => {
    const sections = flattenSections(buildSectionTree('Preamble\n\n# One\nText'));

    expect(sections[0]).toMatchObject({ number: '0', title: 'Introduction' });
  });

  it('numbers a skipped h1 to h3 level as a child', () => {
    const sections = flattenSections(buildSectionTree('# One\n## Two\n### Three'));

    expect(sections.map((section) => section.number)).toEqual(['1', '1.1', '1.1.1']);
  });

  it('gives duplicate titles distinct numbers', () => {
    const sections = flattenSections(buildSectionTree('# Same\ntext\n# Same\nmore'));

    expect(sections.map((section) => [section.number, section.title])).toEqual([
      ['1', 'Same'],
      ['2', 'Same'],
    ]);
  });
});

describe('paging', () => {
  it('splits at paragraph breaks', () => {
    expect(splitPages('aaaa\n\nbbbb', 4)).toEqual(['aaaa', 'bbbb']);
  });

  it('keeps a long paragraph within the page cap', () => {
    expect(splitPages('abcdefghij', 4)).toEqual(['abcd', 'efgh', 'ij']);
  });

  it('adds a continuation command without exceeding the cap', () => {
    const result = capText('a'.repeat(100), 80, 'cobrowser read 1 --section 2 --page 3', 'next');

    expect(result.truncated).toBe(true);
    expect(result.text).toContain('next: cobrowser read 1 --section 2 --page 3');
    expect(result.text.length).toBeLessThanOrEqual(80);
  });
});

describe('denylist', () => {
  it('matches subdomains and path prefixes', () => {
    expect(matchesDenylist('https://mail.google.com/x', ['google.com'])).toBe(true);
    expect(matchesDenylist('https://icloud.com/mail/inbox', ['icloud.com/mail'])).toBe(true);
    expect(matchesDenylist('https://icloud.com/photos', ['icloud.com/mail'])).toBe(false);
  });
});

describe('native framing', () => {
  it('decodes several frames from one chunk', () => {
    const decoder = new NativeFrameDecoder();
    const first = encodeFrame({ id: 1, ok: true });
    const second = encodeFrame({ id: 2, ok: false });

    expect(decoder.push(Buffer.concat([first, second]))).toEqual([
      { id: 1, ok: true },
      { id: 2, ok: false },
    ]);
  });

  it('handles a frame split across chunks', () => {
    const decoder = new NativeFrameDecoder();
    const frame = encodeFrame({ id: 3, ok: true });

    expect(decoder.push(frame.subarray(0, 2))).toEqual([]);
    expect(decoder.push(frame.subarray(2))).toEqual([{ id: 3, ok: true }]);
  });
});

describe('agent names', () => {
  it('uses the Claude Code name', () => {
    expect(guessAgent({ CLAUDECODE: '1' })).toBe('claude-code');
  });

  it('uses the Codex name for variables Codex sets on its commands', () => {
    expect(guessAgent({ CODEX_THREAD_ID: 'abc' })).toBe('codex');
    expect(guessAgent({ CODEX_THREAD_ID: 'abc', CLAUDECODE: '1' })).toBe('codex');
  });

  it('ignores CODEX_HOME because people set it globally', () => {
    expect(guessAgent({ CODEX_HOME: '/tmp/codex' })).toBe('cli');
  });

  it('falls back to cli', () => {
    expect(guessAgent({})).toBe('cli');
  });
});

describe('socket discovery', () => {
  it('ignores stale socket files', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'cobrowser-client-'));
    const run = path.join(home, 'run');
    await mkdir(run);
    await writeFile(path.join(run, 'stale.sock'), '');
    try {
      expect(await liveBrowsers(home)).toEqual([]);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});

describe('page conversion', () => {
  const snapshot = {
    url: 'https://bsky.app/post/1',
    title: 'Post',
    html: `<html><body><nav>Navigation</nav><article><h1>Post</h1><p>${'main '.repeat(100)}</p></article></body></html>`,
  };

  it('marks supported feed hosts', () => {
    expect(convertSnapshot(snapshot).note).toBe('more may load on scroll');
  });

  it('supports full-body conversion', () => {
    expect(convertSnapshot(snapshot).markdown).not.toContain('Navigation');
    expect(convertSnapshot(snapshot, true).markdown).toContain('Navigation');
  });
});
