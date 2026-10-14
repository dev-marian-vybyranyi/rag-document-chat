import { describe, expect, it } from 'vitest';
import {
  assembleFit,
  computeCoverage,
  experienceRequirement,
  groupByStatus,
  IMPORTANCE_WEIGHT,
  STATUS_CREDIT,
  type Judgement,
} from '../src/career/coverage.js';
import type {
  FitRequirement,
  JobProfile,
  RequirementImportance,
  RequirementStatus,
} from '../src/career/types.js';

const NOW = new Date(Date.UTC(2026, 9, 13, 10, 0, 0));

const row = (
  importance: RequirementImportance,
  status: RequirementStatus,
  id = 'r1',
): FitRequirement => ({
  requirementId: id,
  text: `Requirement ${id}`,
  skill: id,
  importance,
  status,
  quote: status === 'not_shown' ? null : 'a quote',
  note: '',
});

const job = (
  requirements: Array<[string, RequirementImportance]>,
  minYearsExperience: number | null = null,
): JobProfile => ({
  role: 'job',
  title: 'Backend Engineer',
  company: 'Stripe',
  minYearsExperience,
  requirements: requirements.map(([id, importance]) => ({
    id,
    text: `Text of ${id}`,
    skill: `Skill ${id}`,
    importance,
    quote: `Quote of ${id}`,
  })),
  responsibilities: [],
});

const judged = (
  requirementId: string,
  status: RequirementStatus,
  quote: string | null = status === 'not_shown' ? null : 'resume words',
  note = '',
): Judgement => ({ requirementId, status, quote, note });

const assemble = (
  profile: JobProfile,
  judgements: Judgement[],
  resumeYears: number | null = null,
) => assembleFit({ job: profile, judgements, resumeId: 'resume-1', resumeYears, now: NOW });

describe('the weights', () => {
  it('count a must three times as much as a nice and give half credit for a partial', () => {
    expect(IMPORTANCE_WEIGHT).toEqual({ must: 3, nice: 1 });
    expect(STATUS_CREDIT).toEqual({ met: 1, partial: 0.5, not_shown: 0 });
  });
});

describe('years of experience as a requirement', () => {
  it('has no row when the posting asks for no years', () => {
    expect(experienceRequirement(null, 6)).toBeNull();
    expect(experienceRequirement(null, null)).toBeNull();
  });

  it('is met when the resume shows at least the years asked for', () => {
    expect(experienceRequirement(5, 5)).toMatchObject({ status: 'met' });
    expect(experienceRequirement(5, 8.4)).toMatchObject({ status: 'met' });
  });

  it('is partly met from three quarters of the years asked for', () => {
    expect(experienceRequirement(4, 3)).toMatchObject({ status: 'partial' });
    expect(experienceRequirement(5, 3.8)).toMatchObject({ status: 'partial' });
    expect(experienceRequirement(5, 4.9)).toMatchObject({ status: 'partial' });
  });

  it('is not shown below three quarters of the years asked for', () => {
    expect(experienceRequirement(4, 2.9)).toMatchObject({ status: 'not_shown' });
    expect(experienceRequirement(5, 3.7)).toMatchObject({ status: 'not_shown' });
    expect(experienceRequirement(5, 0.5)).toMatchObject({ status: 'not_shown' });
  });

  it('is not shown, and says why, when the resume has no dated roles', () => {
    expect(experienceRequirement(5, null)).toMatchObject({
      status: 'not_shown',
      note: 'The roles in the resume have no dates to count years from.',
    });
  });

  it('is a must, has no quote, and says what it counted', () => {
    expect(experienceRequirement(5, 6.4)).toEqual({
      requirementId: 'experience',
      text: '5+ years of professional experience',
      skill: 'Years of experience',
      importance: 'must',
      status: 'met',
      quote: null,
      note: 'The resume shows 6.4 years, counted from the dates of its roles.',
    });
  });
});

describe('computing the coverage', () => {
  it('has nothing to say when there are no requirements', () => {
    expect(computeCoverage([])).toBeNull();
  });

  it('is 100 when everything is met and 0 when nothing is shown', () => {
    expect(computeCoverage([row('must', 'met', 'a'), row('nice', 'met', 'b')])).toEqual({
      coverage: 100,
      mustCoverage: 100,
    });
    expect(computeCoverage([row('must', 'not_shown', 'a'), row('nice', 'not_shown', 'b')])).toEqual(
      { coverage: 0, mustCoverage: 0 },
    );
  });

  it('weighs a must three times as much as a nice', () => {
    const mustMet = computeCoverage([row('must', 'met', 'a'), row('nice', 'not_shown', 'b')]);
    const niceMet = computeCoverage([row('must', 'not_shown', 'a'), row('nice', 'met', 'b')]);

    expect(mustMet?.coverage).toBe(75);
    expect(niceMet?.coverage).toBe(25);
  });

  it('gives half credit for a partial', () => {
    expect(computeCoverage([row('must', 'partial')])).toEqual({ coverage: 50, mustCoverage: 50 });
    expect(computeCoverage([row('must', 'met', 'a'), row('must', 'partial', 'b')])?.coverage).toBe(
      75,
    );
  });

  it('rounds to a whole number', () => {
    const rows = [row('must', 'met', 'a'), row('must', 'not_shown', 'b'), row('nice', 'met', 'c')];

    expect(computeCoverage(rows)).toEqual({ coverage: 57, mustCoverage: 50 });
    expect(
      computeCoverage([
        row('nice', 'met', 'a'),
        row('nice', 'not_shown', 'b'),
        row('nice', 'not_shown', 'c'),
      ])?.coverage,
    ).toBe(33);
    expect(
      computeCoverage([
        row('nice', 'met', 'a'),
        row('nice', 'met', 'b'),
        row('nice', 'not_shown', 'c'),
      ])?.coverage,
    ).toBe(67);
  });

  it('has no coverage of the musts when the posting has none', () => {
    expect(computeCoverage([row('nice', 'met', 'a'), row('nice', 'not_shown', 'b')])).toEqual({
      coverage: 50,
      mustCoverage: null,
    });
  });

  it('does not depend on the order of the requirements', () => {
    const rows = [
      row('must', 'met', 'a'),
      row('nice', 'partial', 'b'),
      row('must', 'not_shown', 'c'),
      row('nice', 'met', 'd'),
    ];

    expect(computeCoverage([...rows].reverse())).toEqual(computeCoverage(rows));
  });
});

describe('assembling a fit', () => {
  const profile = job([
    ['r1', 'must'],
    ['r2', 'must'],
    ['r3', 'nice'],
  ]);

  it('takes the text, the label and the importance from the posting and the verdict from the judgement', () => {
    const result = assemble(profile, [
      judged('r1', 'met', 'Node since 2019', 'Used daily.'),
      judged('r2', 'partial', 'familiar with Go'),
      judged('r3', 'not_shown'),
    ]);

    expect(result?.fit).toEqual({
      resumeId: 'resume-1',
      analyzedAt: '2026-10-13T10:00:00.000Z',
      requirements: [
        {
          requirementId: 'r1',
          text: 'Text of r1',
          skill: 'Skill r1',
          importance: 'must',
          status: 'met',
          quote: 'Node since 2019',
          note: 'Used daily.',
        },
        {
          requirementId: 'r2',
          text: 'Text of r2',
          skill: 'Skill r2',
          importance: 'must',
          status: 'partial',
          quote: 'familiar with Go',
          note: '',
        },
        {
          requirementId: 'r3',
          text: 'Text of r3',
          skill: 'Skill r3',
          importance: 'nice',
          status: 'not_shown',
          quote: null,
          note: '',
        },
      ],
      coverage: 64,
      mustCoverage: 75,
    });
    expect(result?.downgraded).toBe(0);
  });

  describe('a claim without proof', () => {
    it.each([
      ['no quote', null],
      ['an empty quote', ''],
      ['a quote of blanks', '   '],
    ])('becomes not shown when met comes with %s', (_label, quote) => {
      const result = assemble(profile, [judged('r1', 'met', quote)]);

      expect(result?.fit.requirements[0]).toMatchObject({ status: 'not_shown', quote: null });
      expect(result?.downgraded).toBe(1);
    });

    it('becomes not shown when partial comes without a quote', () => {
      const result = assemble(profile, [judged('r2', 'partial', null)]);

      expect(result?.fit.requirements[1]).toMatchObject({ status: 'not_shown', quote: null });
      expect(result?.downgraded).toBe(1);
    });

    it('counts as nothing in the coverage', () => {
      const unproven = assemble(profile, [judged('r1', 'met', null), judged('r2', 'met', null)]);
      const nothing = assemble(profile, []);

      expect(unproven?.fit.coverage).toBe(0);
      expect(unproven?.fit.coverage).toBe(nothing?.fit.coverage);
    });

    it('does not count a requirement that was not shown anyway as a downgrade', () => {
      expect(assemble(profile, [judged('r1', 'not_shown')])?.downgraded).toBe(0);
    });

    it('drops a quote that came with not shown', () => {
      const result = assemble(profile, [judged('r1', 'not_shown', 'some words')]);

      expect(result?.fit.requirements[0]?.quote).toBeNull();
    });
  });

  describe('judgements that do not fit', () => {
    it('treats a requirement nobody judged as not shown', () => {
      const result = assemble(profile, [judged('r1', 'met')]);

      expect(result?.fit.requirements.map((r) => r.status)).toEqual([
        'met',
        'not_shown',
        'not_shown',
      ]);
    });

    it('ignores a judgement of a requirement the posting does not have', () => {
      const result = assemble(profile, [judged('r9', 'met'), judged('r1', 'met')]);

      expect(result?.fit.requirements).toHaveLength(3);
      expect(result?.fit.requirements.map((r) => r.requirementId)).toEqual(['r1', 'r2', 'r3']);
    });

    it('uses the first judgement when there are two for one requirement', () => {
      const result = assemble(profile, [
        judged('r1', 'not_shown'),
        judged('r1', 'met', 'later claim'),
      ]);

      expect(result?.fit.requirements[0]?.status).toBe('not_shown');
    });
  });

  describe('years of experience', () => {
    const withYears = job(
      [
        ['r1', 'must'],
        ['r2', 'nice'],
      ],
      5,
    );

    it('adds a row of its own in front, worked out from the resume and not from the model', () => {
      const result = assemble(withYears, [judged('r1', 'met'), judged('experience', 'met')], 6.4);

      expect(result?.fit.requirements.map((r) => [r.requirementId, r.status])).toEqual([
        ['experience', 'met'],
        ['r1', 'met'],
        ['r2', 'not_shown'],
      ]);
      expect(result?.fit.requirements[0]?.note).toBe(
        'The resume shows 6.4 years, counted from the dates of its roles.',
      );
    });

    it('counts as a must in the coverage', () => {
      const short = assemble(withYears, [judged('r1', 'met'), judged('r2', 'met')], 2);
      const enough = assemble(withYears, [judged('r1', 'met'), judged('r2', 'met')], 5);

      expect(short?.fit).toMatchObject({ coverage: 57, mustCoverage: 50 });
      expect(enough?.fit).toMatchObject({ coverage: 100, mustCoverage: 100 });
    });

    it('is not shown when the resume has no dated roles', () => {
      const result = assemble(withYears, [], null);

      expect(result?.fit.requirements[0]).toMatchObject({
        requirementId: 'experience',
        status: 'not_shown',
      });
    });

    it('makes a fit from the years alone when the posting lists nothing else', () => {
      const result = assemble(job([], 3), [], 4);

      expect(result?.fit).toMatchObject({ coverage: 100, mustCoverage: 100 });
      expect(result?.fit.requirements).toHaveLength(1);
    });
  });

  it('gives no fit for a posting with nothing to compare', () => {
    expect(assemble(job([]), [])).toBeNull();
  });

  it('records the resume and the moment of the analysis', () => {
    const result = assemble(profile, []);

    expect(result?.fit.resumeId).toBe('resume-1');
    expect(result?.fit.analyzedAt).toBe('2026-10-13T10:00:00.000Z');
  });
});

describe('grouping by status', () => {
  const rows = [
    row('nice', 'met', 'a'),
    row('must', 'not_shown', 'b'),
    row('must', 'met', 'c'),
    row('nice', 'not_shown', 'd'),
    row('must', 'partial', 'e'),
    row('nice', 'partial', 'f'),
    row('must', 'met', 'g'),
  ];

  it('puts each status in its own list, musts first and the order of the posting kept', () => {
    const { met, partial, notShown } = groupByStatus(rows);

    expect(met.map((r) => r.requirementId)).toEqual(['c', 'g', 'a']);
    expect(partial.map((r) => r.requirementId)).toEqual(['e', 'f']);
    expect(notShown.map((r) => r.requirementId)).toEqual(['b', 'd']);
  });

  it('loses nothing', () => {
    const { met, partial, notShown } = groupByStatus(rows);

    expect(met.length + partial.length + notShown.length).toBe(rows.length);
  });

  it('gives empty lists for no requirements', () => {
    expect(groupByStatus([])).toEqual({ met: [], partial: [], notShown: [] });
  });
});
