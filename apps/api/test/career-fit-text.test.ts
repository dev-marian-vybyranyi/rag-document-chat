import { describe, expect, it } from 'vitest';
import {
  fitSections,
  MAX_OVERVIEW_GAPS,
  overviewSections,
  type ComparedPosting,
} from '../src/career/fit-text.js';
import type {
  Fit,
  FitRequirement,
  RequirementImportance,
  RequirementStatus,
} from '../src/career/types.js';

const requirement = (
  id: string,
  status: RequirementStatus,
  options: {
    importance?: RequirementImportance;
    skill?: string;
    text?: string;
    quote?: string | null;
    note?: string;
  } = {},
): FitRequirement => ({
  requirementId: id,
  text: options.text ?? `Text of ${id}`,
  skill: options.skill ?? `Skill ${id}`,
  importance: options.importance ?? 'must',
  status,
  quote:
    options.quote === undefined
      ? status === 'not_shown'
        ? null
        : `quote of ${id}`
      : options.quote,
  note: options.note ?? '',
});

const fitOf = (
  requirements: FitRequirement[],
  coverage = 64,
  mustCoverage: number | null = 75,
): Fit => ({
  resumeId: 'resume-1',
  analyzedAt: '2026-10-13T10:00:00.000Z',
  requirements,
  coverage,
  mustCoverage,
});

const texts = (sections: ReturnType<typeof fitSections>) =>
  sections.map((s) => [s.title, s.text] as const);

describe('the passages of a fit', () => {
  const fit = fitOf([
    requirement('experience', 'met', {
      text: '5+ years of professional experience',
      quote: null,
      note: 'The resume shows 6.4 years, counted from the dates of its roles.',
    }),
    requirement('r1', 'partial', {
      text: 'Three or more years of Kubernetes',
      quote: 'familiar with Kubernetes',
      note: 'Only familiar.',
    }),
    requirement('r2', 'not_shown', {
      text: 'Terraform',
      importance: 'nice',
      note: 'Terraform is not mentioned.',
    }),
    requirement('r3', 'met', { text: 'TypeScript', quote: 'TypeScript, PostgreSQL' }),
  ]);

  it('gives one passage for what the resume shows and one for the gaps', () => {
    const sections = fitSections(fit);

    expect(sections.map((s) => [s.section, s.title, s.heading, s.page])).toEqual([
      ['fit', 'Strengths', null, null],
      ['fit', 'Gaps', null, null],
    ]);
  });

  it('puts the verdict, the importance, the note and the quote on every line of the strengths', () => {
    const [strengths] = fitSections(fit);

    expect(strengths?.text).toBe(
      [
        'Strengths of the resume for this posting: what it shows. The resume covers 64% of the requirements of this posting, weighted (a must counts three times as much as a nice to have), and 75% of the must-haves.',
        '- Shown in the resume: 5+ years of professional experience (must). The resume shows 6.4 years, counted from the dates of its roles.',
        '- Shown in the resume: TypeScript (must). The resume says: "TypeScript, PostgreSQL"',
      ].join('\n'),
    );
  });

  it('lists what is not shown before what is shown only partly, and says what not shown means', () => {
    const gaps = fitSections(fit)[1]!.text.split('\n');

    expect(gaps[0]).toMatch(
      /^Gaps of the resume for this posting: skills and requirements that are missing/,
    );
    expect(gaps[0]).toMatch(
      /Not shown means the resume does not mention it; the candidate may have it/,
    );
    expect(gaps.slice(1)).toEqual([
      '- Not shown in the resume: Terraform (nice to have). Terraform is not mentioned.',
      '- Only partly shown in the resume: Three or more years of Kubernetes (must). Only familiar. The resume says: "familiar with Kubernetes"',
    ]);
  });

  it('keeps every line understandable on its own, as a passage may be cut between lines', () => {
    const lines = fitSections(fit).flatMap((s) => s.text.split('\n').slice(1));

    for (const line of lines) {
      expect(line).toMatch(
        /^- (Shown|Only partly shown|Not shown) in the resume: .+ \((must|nice to have)\)\./,
      );
    }
  });

  it('makes a gaps passage for requirements that are only partly shown', () => {
    const partOnly = fitOf([requirement('a', 'partial')], 50, 50);

    expect(fitSections(partOnly).map((s) => s.title)).toEqual(['Gaps']);
  });

  it('puts musts before nice to haves within a group', () => {
    const mixed = fitOf([
      requirement('a', 'not_shown', { importance: 'nice', text: 'Nice one' }),
      requirement('b', 'not_shown', { importance: 'must', text: 'Must one' }),
    ]);

    const lines = fitSections(mixed)[0]!.text.split('\n').slice(1);

    expect(lines.map((l) => l.includes('Must one'))).toEqual([true, false]);
  });

  it('makes no passage for a group that is empty', () => {
    const allMet = fitOf([requirement('a', 'met')], 100, 100);
    const noneMet = fitOf([requirement('a', 'not_shown')], 0, 0);

    expect(fitSections(allMet).map((s) => s.title)).toEqual(['Strengths']);
    expect(fitSections(noneMet).map((s) => s.title)).toEqual(['Gaps']);
    expect(fitSections(fitOf([]))).toEqual([]);
  });

  it('leaves out the share of the musts when the posting has none', () => {
    const [strengths] = fitSections(
      fitOf([requirement('a', 'met', { importance: 'nice' })], 100, null),
    );

    expect(strengths?.text).not.toMatch(/must-haves/);
  });

  it('does not add a note or a quote that is not there', () => {
    const [strengths] = fitSections(fitOf([requirement('a', 'met', { quote: null, note: '' })]));

    expect(texts([strengths!])[0]?.[1].split('\n')[1]).toBe(
      '- Shown in the resume: Text of a (must).',
    );
  });
});

describe('the overview of all postings', () => {
  const posting = (
    jobNumber: number | null,
    name: string,
    coverage: number,
    mustCoverage: number | null,
    requirements: FitRequirement[] = [],
  ): ComparedPosting => ({ jobNumber, name, fit: fitOf(requirements, coverage, mustCoverage) });

  const lines = (
    compared: ComparedPosting[],
    uncompared = [] as Array<{ jobNumber: number | null; name: string }>,
  ) => overviewSections(compared, uncompared)[0]?.text.split('\n') ?? [];

  it('ranks the postings from the best covered', () => {
    const result = lines([
      posting(1, 'Acme backend', 55, 60),
      posting(2, 'Stripe platform', 82, 90),
      posting(3, 'Initech data', 30, 20),
    ]);

    expect(result.filter((l) => l.startsWith('- Rank'))).toEqual([
      '- Rank 1: Job #2 (Stripe platform): 82%, 90% of the must-haves.',
      '- Rank 2: Job #1 (Acme backend): 55%, 60% of the must-haves.',
      '- Rank 3: Job #3 (Initech data): 30%, 20% of the must-haves.',
    ]);
  });

  it('breaks a tie by the musts and then by the number', () => {
    const result = lines([
      posting(4, 'D', 50, null),
      posting(2, 'B', 50, 40),
      posting(3, 'C', 50, 50),
      posting(1, 'A', 50, 40),
    ]);

    expect(
      result.filter((l) => l.startsWith('- Rank')).map((l) => l.match(/Job #(\d)/)?.[1]),
    ).toEqual(['3', '1', '2', '4']);
  });

  it('names a posting without a number by its name alone', () => {
    const result = lines([posting(null, 'Old posting', 40, null)]);

    expect(result).toContain('- Rank 1: Old posting: 40%.');
  });

  it('says what it is about, so that the right questions find it', () => {
    expect(lines([posting(1, 'A', 50, 50)])[0]).toMatch(
      /Which job fits best and what to learn first/,
    );
  });

  describe('gaps across the postings', () => {
    const gap = (
      skill: string,
      status: RequirementStatus = 'not_shown',
      importance: RequirementImportance = 'must',
    ) => requirement(skill, status, { skill, importance });

    it('counts in how many postings a requirement is missing or only partly shown, and how often it is a must', () => {
      const result = lines([
        posting(1, 'A', 50, 50, [gap('Kubernetes'), gap('Terraform', 'not_shown', 'nice')]),
        posting(2, 'B', 60, 60, [gap('Kubernetes', 'partial'), gap('Go')]),
        posting(3, 'C', 70, 70, [gap('Kubernetes', 'not_shown', 'nice'), gap('Go', 'met')]),
      ]);

      expect(result.filter((l) => l.startsWith('- Gap'))).toEqual([
        '- Gap across postings: Kubernetes is not fully shown in 3 of 3 postings, a must in 2.',
        '- Gap across postings: Go is not fully shown in 1 of 3 postings, a must in 1.',
        '- Gap across postings: Terraform is not fully shown in 1 of 3 postings.',
      ]);
    });

    it('puts the requirement missing in more postings before one that is a must in fewer', () => {
      const result = lines([
        posting(1, 'A', 50, 50, [gap('Common', 'not_shown', 'nice'), gap('Rare')]),
        posting(2, 'B', 50, 50, [gap('Common', 'not_shown', 'nice')]),
        posting(3, 'C', 50, 50, [gap('Common', 'not_shown', 'nice')]),
      ]);

      const listed = result.filter((l) => l.startsWith('- Gap'));
      expect(listed[0]).toMatch(/Common/);
      expect(listed[1]).toMatch(/Rare/);
    });

    it('puts a must before a nice to have that is missing in as many postings', () => {
      const result = lines([
        posting(1, 'A', 50, 50, [gap('Alpha', 'not_shown', 'nice'), gap('Zulu')]),
      ]);

      const listed = result.filter((l) => l.startsWith('- Gap'));
      expect(listed[0]).toMatch(/Zulu/);
      expect(listed[1]).toMatch(/Alpha/);
    });

    it('counts a skill once in a posting, however many requirements it has there', () => {
      const result = lines([
        posting(1, 'A', 50, 50, [
          gap('Kubernetes'),
          { ...gap('Kubernetes'), requirementId: 'again' },
        ]),
      ]);

      expect(result.filter((l) => l.includes('Kubernetes'))).toEqual([
        '- Gap across postings: Kubernetes is not fully shown in 1 of 1 postings, a must in 1.',
      ]);
    });

    it('treats names that differ in case and punctuation as one skill', () => {
      const result = lines([
        posting(1, 'A', 50, 50, [gap('Node.js')]),
        posting(2, 'B', 50, 50, [gap('node js')]),
      ]);

      expect(result.filter((l) => l.startsWith('- Gap'))).toHaveLength(1);
      expect(result.join('\n')).toMatch(/is not fully shown in 2 of 2 postings/);
    });

    it('lists no more than the limit, the most common first', () => {
      const many = Array.from({ length: MAX_OVERVIEW_GAPS + 5 }, (_, i) =>
        gap(`Skill${String(i).padStart(2, '0')}`),
      );
      const result = lines([
        posting(1, 'A', 50, 50, many),
        posting(2, 'B', 50, 50, [gap('Skill16')]),
      ]);

      const listed = result.filter((l) => l.startsWith('- Gap'));
      expect(listed).toHaveLength(MAX_OVERVIEW_GAPS);
      expect(listed[0]).toMatch(/Skill16 .* 2 of 2/);
    });

    it('has no section about gaps when every requirement is met', () => {
      const result = lines([posting(1, 'A', 100, 100, [requirement('a', 'met')])]);

      expect(result.some((l) => l.includes('Gap across postings'))).toBe(false);
    });
  });

  it('lists the postings that have not been compared yet', () => {
    const result = lines(
      [posting(1, 'A', 50, 50)],
      [
        { jobNumber: 4, name: 'Pending role' },
        { jobNumber: null, name: 'Loose posting' },
      ],
    );

    expect(result.at(-1)).toBe('Not compared yet: Job #4 (Pending role), Loose posting.');
  });

  it('is nothing when no posting has been compared', () => {
    expect(overviewSections([], [{ jobNumber: 1, name: 'A' }])).toEqual([]);
  });

  it('is a section of the overview kind that belongs to no page', () => {
    expect(overviewSections([posting(1, 'A', 50, 50)])[0]).toMatchObject({
      section: 'overview',
      heading: null,
      title: null,
      page: null,
    });
  });

  it('cleans the names it prints', () => {
    const result = lines([posting(1, 'Ba​ck\nend', 50, 50)]);

    expect(result.join('\n')).toContain('Job #1 (Back end)');
  });
});
