import { describe, expect, it } from 'vitest';
import { githubPermalink } from './permalink';

const SHA = '7fd1a60b01f91b314f59955a4e4d4e80d8edf11d';
const repository = { repoUrl: 'https://github.com/acme/shop', commitSha: SHA };
const location = (overrides = {}) => ({
  path: 'src/auth/login.ts',
  language: 'typescript',
  startLine: 12,
  endLine: 18,
  symbol: null,
  ...overrides,
});

describe('githubPermalink', () => {
  it('points at the file and lines of the commit that was indexed', () => {
    expect(githubPermalink(repository, location())).toBe(
      `https://github.com/acme/shop/blob/${SHA}/src/auth/login.ts#L12-L18`,
    );
  });

  it('names a single line once', () => {
    expect(githubPermalink(repository, location({ startLine: 7, endLine: 7 }))).toMatch(/#L7$/);
  });

  it('has no anchor when the lines are not known', () => {
    expect(githubPermalink(repository, location({ startLine: null, endLine: null }))).toBe(
      `https://github.com/acme/shop/blob/${SHA}/src/auth/login.ts`,
    );
  });

  it('encodes each part of a path that has unusual characters', () => {
    const link = githubPermalink(repository, location({ path: 'src/a b/c#d?.ts' }));

    expect(link).toBe(`https://github.com/acme/shop/blob/${SHA}/src/a%20b/c%23d%3F.ts#L12-L18`);
  });

  it.each([
    ['an archive without an address', { repoUrl: null, commitSha: null }],
    ['an import without a commit', { repoUrl: 'https://github.com/acme/shop', commitSha: null }],
    ['an odd commit', { repoUrl: 'https://github.com/acme/shop', commitSha: '../../x' }],
    ['another host', { repoUrl: 'https://evil.example/acme/shop', commitSha: SHA }],
    ['a script address', { repoUrl: 'javascript:alert(1)', commitSha: SHA }],
  ])('gives nothing for %s', (_label, repo) => {
    expect(githubPermalink(repo, location())).toBeNull();
  });
});
