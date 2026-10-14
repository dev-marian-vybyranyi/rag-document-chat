import { describe, expect, it } from 'vitest';
import type { CareerOverview, Fit, FitRequirement, Posting } from './api';
import {
  askAboutJob,
  awaitsFit,
  describeGap,
  orderRequirements,
  pendingIds,
  postingTitle,
  rankOf,
  sortPostings,
} from './career-view';

const fit = (coverage: number, mustCoverage: number | null = null): Fit => ({
  resumeId: 'r1',
  analyzedAt: '2026-10-14T10:00:00Z',
  requirements: [],
  coverage,
  mustCoverage,
});

const posting = (jobNumber: number | null, overrides: Partial<Posting> = {}): Posting => ({
  id: `j${jobNumber}`,
  jobNumber,
  filename: `Role ${jobNumber}`,
  status: 'ready',
  error: null,
  profile: { role: 'job', title: null, company: null, requirementCount: 3 },
  fit: null,
  ...overrides,
});

const resumeOf = (
  status: 'processing' | 'ready' | 'failed' = 'ready',
): CareerOverview['resume'] => ({
  id: 'r1',
  filename: 'cv',
  status,
  error: null,
  profile: null,
});

const overview = (
  postings: Posting[],
  resume: CareerOverview['resume'] = resumeOf(),
): CareerOverview => ({ resume, postings, compared: 0, gaps: [] });

const requirement = (
  id: string,
  status: FitRequirement['status'],
  importance: FitRequirement['importance'],
): FitRequirement => ({
  requirementId: id,
  text: id,
  skill: id,
  importance,
  status,
  quote: null,
  note: '',
});

describe('postingTitle', () => {
  it('numbers the posting the way a question refers to it', () => {
    expect(postingTitle(posting(2))).toBe('Job #2 · Role 2');
  });

  it('leaves out a missing number', () => {
    expect(postingTitle(posting(null, { filename: 'Role' }))).toBe('Role');
  });
});

describe('sortPostings', () => {
  const a = posting(1, { fit: fit(50, 40) });
  const b = posting(2, { fit: fit(80, 60) });
  const c = posting(3);
  const d = posting(4, { fit: fit(50, 70) });

  it('puts the best fit first, then the better must-have coverage, then the lower number', () => {
    expect(sortPostings([a, b, c, d], 'fit').map((p) => p.jobNumber)).toEqual([2, 4, 1, 3]);
  });

  it('puts postings that were not compared last, in the order of their numbers', () => {
    const e = posting(0);

    expect(sortPostings([c, e, a], 'fit').map((p) => p.jobNumber)).toEqual([1, 0, 3]);
  });

  it('puts a posting with 0% before one that was not compared', () => {
    const none = posting(5, { fit: fit(0, 0) });

    expect(sortPostings([c, none], 'fit').map((p) => p.jobNumber)).toEqual([5, 3]);
  });

  it('can sort by number alone', () => {
    expect(sortPostings([d, c, b, a], 'number').map((p) => p.jobNumber)).toEqual([1, 2, 3, 4]);
  });

  it('does not change the list it was given', () => {
    const list = [c, b, a];

    sortPostings(list, 'fit');
    sortPostings(list, 'number');

    expect(list.map((p) => p.jobNumber)).toEqual([3, 2, 1]);
  });
});

describe('rankOf', () => {
  it('ranks only the postings that were compared', () => {
    const a = posting(1, { fit: fit(50) });
    const b = posting(2, { fit: fit(80) });
    const c = posting(3);
    const all = [a, b, c];

    expect([rankOf(a, all), rankOf(b, all), rankOf(c, all)]).toEqual([2, 1, null]);
  });
});

describe('describeGap', () => {
  it('says in how many postings it is missing and in how many it is a must', () => {
    expect(describeGap({ label: 'Kubernetes', postings: 2, musts: 2 }, 3)).toBe(
      'Kubernetes: not fully shown in 2 of 3 postings (a must in 2)',
    );
  });

  it('leaves out the must-haves when it is a must nowhere', () => {
    expect(describeGap({ label: 'CSS', postings: 1, musts: 0 }, 4)).toBe(
      'CSS: not fully shown in 1 of 4 postings',
    );
  });
});

describe('orderRequirements', () => {
  it('puts what is not shown first, then what is partly shown, and musts before nice-to-haves', () => {
    const ordered = orderRequirements([
      requirement('met-must', 'met', 'must'),
      requirement('partial-nice', 'partial', 'nice'),
      requirement('missing-nice', 'not_shown', 'nice'),
      requirement('missing-must', 'not_shown', 'must'),
      requirement('partial-must', 'partial', 'must'),
      requirement('met-nice', 'met', 'nice'),
    ]);

    expect(ordered.map((r) => r.requirementId)).toEqual([
      'missing-must',
      'missing-nice',
      'partial-must',
      'partial-nice',
      'met-must',
      'met-nice',
    ]);
  });

  it('keeps the order of requirements that are alike, and does not change its input', () => {
    const input = [requirement('b', 'met', 'must'), requirement('a', 'met', 'must')];

    expect(orderRequirements(input).map((r) => r.requirementId)).toEqual(['b', 'a']);
    expect(input.map((r) => r.requirementId)).toEqual(['b', 'a']);
  });
});

describe('askAboutJob', () => {
  it('asks about the posting by its number', () => {
    expect(askAboutJob(posting(2))).toBe('How does my experience align with Job #2?');
  });

  it('asks in general words about a posting that has no number', () => {
    expect(askAboutJob(posting(null))).toBe('How does my experience align with this job?');
  });
});

describe('awaitsFit', () => {
  const ready = resumeOf();

  it('is true for a ready posting with requirements and no fit, next to a ready resume', () => {
    expect(awaitsFit(posting(1), ready)).toBe(true);
  });

  it.each([
    ['with a fit', posting(1, { fit: fit(10) })],
    ['being processed', posting(1, { status: 'processing' })],
    ['failed', posting(1, { status: 'failed' })],
    ['without a profile', posting(1, { profile: null })],
    [
      'with no requirements',
      posting(1, { profile: { role: 'job', title: null, company: null, requirementCount: 0 } }),
    ],
  ])('is false for a posting %s', (_label, candidate) => {
    expect(awaitsFit(candidate, ready)).toBe(false);
  });

  it('is false without a ready resume', () => {
    expect(awaitsFit(posting(1), null)).toBe(false);
    expect(awaitsFit(posting(1), resumeOf('processing'))).toBe(false);
    expect(awaitsFit(posting(1), resumeOf('failed'))).toBe(false);
  });
});

describe('pendingIds', () => {
  it('is empty when everything is settled', () => {
    expect(
      pendingIds(overview([posting(1, { fit: fit(10) }), posting(2, { profile: null })])),
    ).toEqual([]);
    expect(pendingIds(overview([], null))).toEqual([]);
  });

  it('names the resume and the postings that are being processed', () => {
    expect(
      pendingIds(
        overview(
          [posting(1, { status: 'processing' }), posting(2, { fit: fit(1) })],
          resumeOf('processing'),
        ),
      ),
    ).toEqual(['r1', 'j1']);
  });

  it('names the postings that wait for a comparison', () => {
    expect(pendingIds(overview([posting(1), posting(2, { fit: fit(1) })]))).toEqual(['j1']);
  });

  it('does not wait for a comparison without a ready resume', () => {
    expect(pendingIds(overview([posting(1)], null))).toEqual([]);
  });
});
