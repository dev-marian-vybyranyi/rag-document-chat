import { describe, expect, it } from 'vitest';
import type { DocumentItem } from './api';
import {
  commitUrl,
  describeProgress,
  describeRepositoryCounts,
  progressFraction,
  safeGithubUrl,
  shortSha,
} from './repository-status';

const SHA = '7fd1a60b01f91b314f59955a4e4d4e80d8edf11d';

function repo(overrides: Partial<DocumentItem> = {}): DocumentItem {
  return {
    id: 'r1',
    kind: 'repository',
    filename: 'acme/shop',
    mimeType: 'application/zip',
    sizeBytes: 0,
    status: 'ready',
    error: null,
    pageCount: null,
    chunkCount: 40,
    fileCount: 12,
    repoUrl: 'https://github.com/acme/shop',
    repoRef: null,
    commitSha: SHA,
    progress: null,
    suggestions: [],
    createdAt: '2026-10-07T10:00:00Z',
    ...overrides,
  };
}

describe('safeGithubUrl', () => {
  it('passes a github.com address through', () => {
    expect(safeGithubUrl('https://github.com/acme/shop')).toBe('https://github.com/acme/shop');
  });

  it.each([
    null,
    '',
    'javascript:alert(1)',
    'http://github.com/acme/shop',
    'https://evil.example/https://github.com/acme/shop',
    'https://github.com.evil.example/acme/shop',
    'data:text/html,<script>1</script>',
  ])('refuses %j, so it is never put in a link', (url) => {
    expect(safeGithubUrl(url)).toBeNull();
  });
});

describe('commitUrl', () => {
  it('points at the exact commit that was indexed', () => {
    expect(commitUrl(repo())).toBe(`https://github.com/acme/shop/tree/${SHA}`);
  });

  it('is absent for an archive, an unfinished import or an odd value', () => {
    expect(commitUrl(repo({ repoUrl: null }))).toBeNull();
    expect(commitUrl(repo({ commitSha: null }))).toBeNull();
    expect(commitUrl(repo({ commitSha: '../../x' }))).toBeNull();
    expect(commitUrl(repo({ repoUrl: 'javascript:alert(1)' }))).toBeNull();
  });
});

describe('shortSha', () => {
  it('keeps seven characters', () => {
    expect(shortSha(SHA)).toBe('7fd1a60');
  });
});

describe('describeProgress', () => {
  it.each([
    [null, 'Processing…'],
    [{ phase: 'downloading', done: 0, total: 0 }, 'Downloading from GitHub…'],
    [{ phase: 'reading', done: 0, total: 0 }, 'Reading files…'],
    [{ phase: 'embedding', done: 0, total: 0 }, 'Indexing…'],
    [{ phase: 'embedding', done: 100, total: 380 }, 'Indexing: 100 of 380 passages'],
    [{ phase: 'embedding', done: 0, total: 1 }, 'Indexing: 0 of 1 passage'],
  ] as const)('describes %j', (progress, text) => {
    expect(describeProgress(progress)).toBe(text);
  });
});

describe('progressFraction', () => {
  it('is the share of passages embedded', () => {
    expect(progressFraction({ phase: 'embedding', done: 100, total: 400 })).toBe(0.25);
    expect(progressFraction({ phase: 'embedding', done: 400, total: 400 })).toBe(1);
  });

  it('stays within 0 and 1', () => {
    expect(progressFraction({ phase: 'embedding', done: 500, total: 400 })).toBe(1);
    expect(progressFraction({ phase: 'embedding', done: -5, total: 400 })).toBe(0);
  });

  it.each([
    null,
    { phase: 'downloading', done: 0, total: 0 },
    { phase: 'reading', done: 3, total: 10 },
    { phase: 'embedding', done: 0, total: 0 },
  ] as const)('is unknown for %j, so a moving bar is shown instead', (progress) => {
    expect(progressFraction(progress)).toBeNull();
  });
});

describe('describeRepositoryCounts', () => {
  it('counts files and passages', () => {
    expect(describeRepositoryCounts(repo())).toBe('12 files · 40 passages');
  });

  it('uses the singular', () => {
    expect(describeRepositoryCounts(repo({ fileCount: 1, chunkCount: 1 }))).toBe(
      '1 file · 1 passage',
    );
  });

  it('leaves out the files when they are not known', () => {
    expect(describeRepositoryCounts(repo({ fileCount: null }))).toBe('40 passages');
  });
});
