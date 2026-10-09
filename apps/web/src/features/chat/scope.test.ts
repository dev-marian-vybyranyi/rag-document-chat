import { describe, expect, it } from 'vitest';
import type { DocumentItem } from '../documents/api';
import { describeScope, idsOf, liveIds, normalizeScope, sourcesInScope } from './scope';

function source(id: string, kind: DocumentItem['kind'] = 'document'): DocumentItem {
  return {
    id,
    kind,
    filename: `${id}.${kind === 'document' ? 'txt' : 'repo'}`,
    mimeType: 'text/plain',
    sizeBytes: 1,
    status: 'ready',
    error: null,
    pageCount: null,
    chunkCount: 1,
    fileCount: null,
    repoUrl: null,
    repoRef: null,
    commitSha: null,
    progress: null,
    suggestions: [],
    createdAt: '2026-10-07T10:00:00Z',
  };
}

const library = [source('a'), source('b', 'repository'), source('c')];

describe('normalizeScope', () => {
  it('turns a choice of every source into "all", so later sources are included', () => {
    expect(normalizeScope(['a', 'b', 'c'], library)).toBeNull();
    expect(normalizeScope(['c', 'a', 'b'], library)).toBeNull();
  });

  it('keeps a choice of some sources', () => {
    expect(normalizeScope(['a', 'b'], library)).toEqual(['a', 'b']);
  });

  it('keeps the choice when the library is empty, so it is never "all" by accident', () => {
    expect(normalizeScope(['a'], [])).toEqual(['a']);
  });

  it('ignores deleted ids when deciding', () => {
    expect(normalizeScope(['a', 'b', 'c', 'gone'], library)).toBeNull();
  });
});

describe('liveIds and sourcesInScope', () => {
  it('drop the ids of deleted sources', () => {
    expect(liveIds(['a', 'gone', 'c'], library)).toEqual(['a', 'c']);
    expect(sourcesInScope(['a', 'gone'], library).map((s) => s.id)).toEqual(['a']);
  });

  it('give the whole library for "all"', () => {
    expect(sourcesInScope(null, library)).toBe(library);
    expect(idsOf(library)).toEqual(['a', 'b', 'c']);
  });
});

describe('describeScope', () => {
  it('names the whole library', () => {
    expect(describeScope(null, library)).toEqual({
      label: 'All sources',
      missing: 0,
      empty: false,
    });
    expect(describeScope(null, [])).toEqual({ label: 'All sources', missing: 0, empty: false });
  });

  it('names a single source and counts several', () => {
    expect(describeScope(['b'], library).label).toBe('b.repo');
    expect(describeScope(['a', 'b'], library).label).toBe('2 sources');
  });

  it('counts the chosen sources that were deleted', () => {
    expect(describeScope(['a', 'gone', 'gone2'], library)).toEqual({
      label: 'a.txt',
      missing: 2,
      empty: false,
    });
  });

  it('says so when nothing chosen is left', () => {
    expect(describeScope(['gone'], library)).toEqual({
      label: 'Chosen sources deleted',
      missing: 1,
      empty: true,
    });
  });
});
