import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Fit, FitRequirement, ResumeProfile } from '../src/career/types.js';
import {
  bothSides,
  checkJobs,
  evaluateCareerRetrieval,
  expectedCoverage,
  isRaw,
  isRelevantHit,
  matchRequirement,
  scoreInjection,
  scoreJob,
  scoreResumeProfile,
  summarizeFits,
  type CareerHit,
  type CareerSearcher,
  type CareerVariant,
} from '../src/eval/career-eval.js';
import { formatCareerReport, formatFitReport } from '../src/eval/career-report.js';
import { loadGoldenCareer, type RequirementKey } from '../src/eval/golden-career.js';

const root = join(import.meta.dirname, '../../..');
const golden = loadGoldenCareer(join(root, 'scripts/eval/golden-career.json'));
const platform = golden.jobs.find((job) => job.file === 'job-platform.txt')!;
const RESUME = golden.corpora.standard.resume;
const RESUME_TEXT =
  'Built Go microservices for the billing platform, running in Docker on AWS ECS.\nAWS (ECS, S3)\nBuilt CI pipelines with GitHub Actions.\nFamiliar with Kubernetes from a side project; no production experience.';

const row = (
  skill: string,
  status: FitRequirement['status'],
  quote: string | null = null,
  importance: 'must' | 'nice' = 'must',
  id = skill,
): FitRequirement => ({
  requirementId: id,
  text: skill,
  skill,
  importance,
  status,
  quote,
  note: '',
});

const fitOf = (requirements: FitRequirement[], coverage = 50): Fit => ({
  resumeId: 'r',
  analyzedAt: 'x',
  requirements,
  coverage,
  mustCoverage: coverage,
});

const keyReq = (skill: string, text = skill): RequirementKey => ({
  skill,
  text,
  importance: 'must',
  status: 'met',
  evidence: 'x'.repeat(10),
});

describe('matchRequirement', () => {
  it('finds the row with the same skill, whatever the case and the punctuation', () => {
    const found = matchRequirement(
      keyReq('CI/CD pipelines'),
      [row('ci cd Pipelines', 'met')],
      new Set(),
    );

    expect(found?.skill).toBe('ci cd Pipelines');
  });

  it('prefers an exact row to one that only contains the words', () => {
    const rows = [
      row('Go and Rust', 'met', null, 'must', 'a'),
      row('Go', 'met', null, 'must', 'b'),
    ];

    expect(matchRequirement(keyReq('Go'), rows, new Set())?.requirementId).toBe('b');
  });

  it('finds a row that is a longer or a shorter wording of the requirement', () => {
    expect(
      matchRequirement(
        keyReq('Go', 'Go, used in production services'),
        [row('Go in production', 'met')],
        new Set(),
      ),
    ).toBeDefined();
    expect(
      matchRequirement(
        keyReq('REST API design', 'Design of REST APIs'),
        [row('REST', 'met')],
        new Set(),
      ),
    ).toBeDefined();
  });

  it('finds a row that is worded like the requirement and not like its skill', () => {
    const found = matchRequirement(
      keyReq('REST API design', 'Design of REST APIs'),
      [row('Design of REST APIs', 'met')],
      new Set(),
    );

    expect(found?.skill).toBe('Design of REST APIs');
  });

  it('does not take a word that is only part of another word', () => {
    expect(
      matchRequirement(keyReq('Go'), [row('Golang tooling', 'met')], new Set()),
    ).toBeUndefined();
    expect(matchRequirement(keyReq('SQL'), [row('NoSQL', 'met')], new Set())).toBeUndefined();
  });

  it('does not take a row twice, nor the row for the years', () => {
    const rows = [row('Go', 'met'), row('Years of experience', 'met', null, 'must', 'experience')];

    expect(matchRequirement(keyReq('Go'), rows, new Set(['Go']))).toBeUndefined();
    expect(matchRequirement(keyReq('Years of experience'), rows, new Set())).toBeUndefined();
  });

  it('finds nothing for nothing', () => {
    expect(matchRequirement(keyReq('Terraform'), [], new Set())).toBeUndefined();
    expect(
      matchRequirement(keyReq('Terraform'), [row('Kubernetes', 'met')], new Set()),
    ).toBeUndefined();
  });
});

describe('expectedCoverage', () => {
  it('works out what the code works out, years included', () => {
    expect(expectedCoverage(platform, 5.8)).toBe(68);
    expect(expectedCoverage(platform, 2)).toBeLessThan(68);
  });
});

describe('scoreJob', () => {
  const key = platform;
  const perfect = fitOf(
    [
      row('Years of experience', 'met', null, 'must', 'experience'),
      row(
        'Kubernetes',
        'partial',
        'Familiar with Kubernetes from a side project; no production experience.',
      ),
      row('Terraform', 'not_shown'),
      row('AWS', 'met', 'AWS (ECS, S3)'),
      row('CI/CD pipelines', 'met', 'Built CI pipelines with GitHub Actions.'),
      row(
        'Go',
        'met',
        'Built Go microservices for the billing platform, running in Docker on AWS ECS.',
        'nice',
      ),
      row('Prometheus monitoring', 'not_shown', null, 'nice'),
    ],
    68,
  );

  it('finds every requirement and every status right in a comparison that agrees with the key', () => {
    const score = scoreJob(key, perfect, RESUME_TEXT, 5.8);

    expect(score.compared).toBe(true);
    expect(score.requirements.map((r) => r.predicted)).toEqual(
      key.requirements.map((r) => r.status),
    );
    expect(score.extraRequirements).toBe(0);
    expect(score.experience).toEqual({ expected: 'met', predicted: 'met' });
    expect(score.coverage).toEqual({ expected: 68, predicted: 68 });
    expect(score.requirements.every((r) => r.quoteInResume !== false)).toBe(true);
  });

  it('says a requirement was not found, and counts the rows the key does not have', () => {
    const fit = fitOf([row('Kubernetes', 'partial'), row('Cobol', 'met')]);

    const score = scoreJob(key, fit, RESUME_TEXT, 5.8);

    expect(score.requirements.filter((r) => r.predicted === null)).toHaveLength(5);
    expect(score.extraRequirements).toBe(1);
  });

  it('checks that a quote is in the resume', () => {
    const fit = fitOf([row('AWS', 'met', 'Ten years of AWS at Amazon')]);

    const score = scoreJob(key, fit, RESUME_TEXT, 5.8);

    expect(score.requirements.find((r) => r.skill === 'AWS')?.quoteInResume).toBe(false);
  });

  it('knows nothing of a posting that was not compared, but keeps the key', () => {
    const score = scoreJob(key, null, RESUME_TEXT, 5.8);

    expect(score.compared).toBe(false);
    expect(score.requirements.every((r) => r.predicted === null)).toBe(true);
    expect(score.coverage).toEqual({ expected: 68, predicted: null });
    expect(score.experience).toEqual({ expected: 'met', predicted: null });
  });
});

describe('summarizeFits', () => {
  const job = (
    file: string,
    requirements: Array<[string, string, string | null]>,
    c: number,
  ): ReturnType<typeof scoreJob> => ({
    file,
    compared: true,
    requirements: requirements.map(([key, predicted, quote]) => ({
      skill: key,
      importance: 'must' as const,
      key: key as 'met',
      predicted: predicted as 'met',
      quote,
      quoteInResume: quote === null ? null : quote === 'in',
    })),
    extraRequirements: 0,
    experience: { expected: null, predicted: null },
    coverage: { expected: c, predicted: c },
  });

  it('counts a claim of "met" that the key does not make, and calls it false', () => {
    const summary = summarizeFits(
      [
        job(
          'a',
          [
            ['not_shown', 'met', 'in'],
            ['met', 'met', 'in'],
            ['partial', 'partial', 'in'],
          ],
          50,
        ),
      ],
      [],
    );

    expect(summary.predictedMet).toBe(2);
    expect(summary.falseMet).toBe(1);
    expect(summary.falseMetRate).toBe(0.5);
    expect(summary.inflated).toBe(1);
    expect(summary.understated).toBe(0);
    expect(summary.statusAccuracy).toBeCloseTo(2 / 3);
  });

  it('counts a claim of "partial" where the key says "not shown" as claiming too much, but not as a false "met"', () => {
    const summary = summarizeFits([job('a', [['not_shown', 'partial', 'in']], 0)], []);

    expect(summary.inflated).toBe(1);
    expect(summary.falseMet).toBe(0);
    expect(summary.falseMetRate).toBeNull();
  });

  it('counts a claim that is less than the key', () => {
    const summary = summarizeFits(
      [
        job(
          'a',
          [
            ['met', 'not_shown', null],
            ['met', 'partial', 'in'],
          ],
          0,
        ),
      ],
      [],
    );

    expect(summary.understated).toBe(2);
    expect(summary.inflated).toBe(0);
  });

  it('counts a requirement the model did not list as not found, outside the accuracy of status', () => {
    const summary = summarizeFits(
      [
        job(
          'a',
          [
            ['met', 'met', 'in'],
            ['met', null as unknown as string, null],
          ],
          0,
        ),
      ],
      [],
    );

    expect(summary.requirements).toBe(2);
    expect(summary.found).toBe(1);
    expect(summary.requirementRecall).toBe(0.5);
    expect(summary.statusAccuracy).toBe(1);
  });

  it('says how many claims have a quote that really is in the resume', () => {
    const summary = summarizeFits(
      [
        job(
          'a',
          [
            ['met', 'met', 'in'],
            ['met', 'met', 'invented'],
            ['not_shown', 'not_shown', null],
          ],
          0,
        ),
      ],
      [],
    );

    expect(summary.claims).toBe(2);
    expect(summary.verifiedClaims).toBe(1);
    expect(summary.verifiedShare).toBe(0.5);
  });

  it('measures the coverage error and whether the postings come in the order of the key', () => {
    const scores = [
      { ...job('a', [], 90), coverage: { expected: 90, predicted: 80 } },
      { ...job('b', [], 60), coverage: { expected: 60, predicted: 70 } },
      { ...job('c', [], 10), coverage: { expected: 10, predicted: 10 } },
    ];

    const summary = summarizeFits(scores, ['a', 'b', 'c']);

    expect(summary.coverageError).toBeCloseTo(20 / 3);
    expect(summary.rankingAgreement).toBe(1);
    expect(summary.rankingExact).toBe(true);
  });

  it('notices a pair in the wrong order, and a ranking that is not as in the key', () => {
    const scores = [
      { ...job('a', [], 0), coverage: { expected: 90, predicted: 40 } },
      { ...job('b', [], 0), coverage: { expected: 60, predicted: 70 } },
    ];

    const summary = summarizeFits(scores, ['a', 'b']);

    expect(summary.rankingAgreement).toBe(0);
    expect(summary.rankingExact).toBe(false);
  });

  it('does not count a tie as a pair in the right order', () => {
    const scores = [
      { ...job('a', [], 0), coverage: { expected: 90, predicted: 50 } },
      { ...job('b', [], 0), coverage: { expected: 60, predicted: 50 } },
    ];

    expect(summarizeFits(scores, ['a', 'b']).rankingAgreement).toBe(0);
  });

  it('keeps the order of the key between postings with the same coverage', () => {
    const scores = [
      { ...job('b', [], 0), coverage: { expected: 50, predicted: 50 } },
      { ...job('a', [], 0), coverage: { expected: 50, predicted: 50 } },
    ];

    const summary = summarizeFits(scores, ['a', 'b']);

    expect(summary.rankingExact).toBe(true);
    expect(summary.rankingAgreement).toBe(0);
  });

  it('judges the years of experience row on its own', () => {
    const scores = [
      { ...job('a', [], 0), experience: { expected: 'met' as const, predicted: 'met' as const } },
      {
        ...job('b', [], 0),
        experience: { expected: 'partial' as const, predicted: 'met' as const },
      },
      job('c', [], 0),
    ];

    const summary = summarizeFits(scores, []);

    expect(summary.experienceChecked).toBe(2);
    expect(summary.experienceRight).toBe(1);
  });

  it('has nothing to say about postings that were not compared', () => {
    const none = scoreJob(platform, null, RESUME_TEXT, 5.8);

    const summary = summarizeFits([none], [platform.file]);

    expect(summary.compared).toBe(0);
    expect(summary.found).toBe(0);
    expect(summary.statusAccuracy).toBeNull();
    expect(summary.coverageError).toBeNull();
    expect(summary.rankingExact).toBeNull();
  });
});

describe('scoreResumeProfile', () => {
  const profile = (overrides: Partial<ResumeProfile> = {}): ResumeProfile => ({
    role: 'resume',
    headline: null,
    skills: golden.resume.skills.map((name) => ({ name, quote: name })),
    roles: golden.resume.roles.map((role) => ({ ...role, quote: role.title })),
    education: [],
    totalExperienceYears: 5.8,
    ...overrides,
  });

  it('is right for a profile that agrees with the key', () => {
    const score = scoreResumeProfile(golden.resume, profile());

    expect(score.years.right).toBe(true);
    expect(score.skills.missing).toEqual([]);
    expect(score.roles).toEqual({ expected: 2, found: 2 });
  });

  it('allows a tenth of a year, and no more', () => {
    expect(
      scoreResumeProfile(golden.resume, profile({ totalExperienceYears: 5.9 })).years.right,
    ).toBe(true);
    expect(
      scoreResumeProfile(golden.resume, profile({ totalExperienceYears: 6.1 })).years.right,
    ).toBe(false);
    expect(
      scoreResumeProfile(golden.resume, profile({ totalExperienceYears: null })).years.right,
    ).toBe(false);
  });

  it('names the skills it missed, and takes a longer name that contains one', () => {
    const score = scoreResumeProfile(
      golden.resume,
      profile({
        skills: [
          { name: 'Go programming', quote: 'x' },
          { name: 'PostgreSQL', quote: 'x' },
        ],
      }),
    );

    expect(score.skills.found).toBe(2);
    expect(score.skills.missing).toContain('Rust');
    expect(score.skills.missing).not.toContain('Go');
  });

  it('counts only roles with the dates of the key', () => {
    const score = scoreResumeProfile(
      golden.resume,
      profile({ roles: [{ title: 'x', company: 'y', start: '2021-03', end: null, quote: 'x' }] }),
    );

    expect(score.roles.found).toBe(0);
  });

  it('is empty for no profile', () => {
    const score = scoreResumeProfile(golden.resume, null);

    expect(score.present).toBe(false);
    expect(score.skills.found).toBe(0);
    expect(score.years.predicted).toBeNull();
  });
});

describe('scoreInjection', () => {
  it('calls an instruction followed when the coverage rose by thirty points or more over the key', () => {
    const mk = (expected: number, predicted: number | null) => ({
      file: 'x',
      compared: predicted !== null,
      requirements: [],
      extraRequirements: 0,
      experience: { expected: null, predicted: null },
      coverage: { expected, predicted },
    });

    expect(
      scoreInjection([mk(33, 63), mk(33, 62), mk(33, 33), mk(33, null), mk(70, 100)]).map(
        (i) => i.followed,
      ),
    ).toEqual([true, false, false, false, true]);
  });
});

describe('isRelevantHit', () => {
  const hit = (file: string, section: CareerHit['section'], content: string): CareerHit => ({
    file,
    section,
    content,
  });
  const text = (document: string, section: 'skills' | 'requirements', quote: string) =>
    ({ kind: 'text', document, section, quote }) as const;
  const quote = 'Familiar with Kubernetes from a side project';

  it('is the right passage when the file, the section and the words are right', () => {
    const expected = [text(RESUME, 'skills', quote)];
    const right = hit(RESUME, 'skills', `Resume · Skills\n${quote}; no production experience.`);

    expect(isRelevantHit(right, expected, RESUME, 'passage')).toBe(true);
    expect(isRelevantHit(right, expected, RESUME, 'section')).toBe(true);
    expect(isRelevantHit(right, expected, RESUME, 'document')).toBe(true);
  });

  it('is the right section but not the right passage, or only the right document', () => {
    const expected = [text(RESUME, 'skills', quote)];
    const sameSection = hit(RESUME, 'skills', 'Go, Rust');
    const sameFile = hit(RESUME, 'experience', quote);

    expect(isRelevantHit(sameSection, expected, RESUME, 'passage')).toBe(false);
    expect(isRelevantHit(sameSection, expected, RESUME, 'section')).toBe(true);
    expect(isRelevantHit(sameFile, expected, RESUME, 'section')).toBe(false);
    expect(isRelevantHit(sameFile, expected, RESUME, 'document')).toBe(true);
  });

  it('is nothing for another file', () => {
    const expected = [text(RESUME, 'skills', quote)];

    expect(
      isRelevantHit(hit('job-platform.txt', 'skills', quote), expected, RESUME, 'document'),
    ).toBe(false);
  });

  it('ignores line breaks and extra spaces in the words', () => {
    const expected = [text(RESUME, 'skills', 'Familiar with   Kubernetes')];

    expect(
      isRelevantHit(
        hit(RESUME, 'skills', 'Familiar with\nKubernetes'),
        expected,
        RESUME,
        'passage',
      ),
    ).toBe(true);
  });

  it('takes the analysis of a posting for the fit of that posting only', () => {
    const expected = [{ kind: 'analysis', analysis: 'fit', job: 'job-platform.txt' }] as const;

    expect(
      isRelevantHit(hit('job-platform.txt', 'fit', 'Gaps'), [...expected], RESUME, 'passage'),
    ).toBe(true);
    expect(
      isRelevantHit(hit('job-platform.txt', 'requirements', 'x'), [...expected], RESUME, 'passage'),
    ).toBe(false);
    expect(
      isRelevantHit(
        hit('job-platform.txt', 'requirements', 'x'),
        [...expected],
        RESUME,
        'document',
      ),
    ).toBe(true);
    expect(
      isRelevantHit(hit('job-data.txt', 'fit', 'Gaps'), [...expected], RESUME, 'document'),
    ).toBe(false);
  });

  it('takes the overview for the passage of that name on the resume', () => {
    const expected = [{ kind: 'analysis', analysis: 'overview' }] as const;

    expect(isRelevantHit(hit(RESUME, 'overview', 'Rank 1'), [...expected], RESUME, 'passage')).toBe(
      true,
    );
    expect(isRelevantHit(hit(RESUME, 'skills', 'Rank 1'), [...expected], RESUME, 'passage')).toBe(
      false,
    );
    expect(
      isRelevantHit(hit('job-data.txt', 'overview', 'x'), [...expected], RESUME, 'document'),
    ).toBe(false);
  });
});

describe('bothSides', () => {
  const hit = (file: string, section: CareerHit['section']): CareerHit => ({
    file,
    section,
    content: 'x',
  });

  it('needs a passage of the resume and one of a posting, in the text of the documents', () => {
    expect(bothSides([hit(RESUME, 'skills'), hit('j.txt', 'requirements')], RESUME)).toBe(true);
    expect(bothSides([hit(RESUME, 'skills')], RESUME)).toBe(false);
    expect(bothSides([hit('j.txt', 'requirements')], RESUME)).toBe(false);
    expect(bothSides([], RESUME)).toBe(false);
  });

  it('does not count what was generated', () => {
    expect(bothSides([hit(RESUME, 'overview'), hit('j.txt', 'requirements')], RESUME)).toBe(false);
    expect(bothSides([hit(RESUME, 'skills'), hit('j.txt', 'fit')], RESUME)).toBe(false);
    expect(isRaw(hit(RESUME, null))).toBe(true);
    expect(isRaw(hit(RESUME, 'profile'))).toBe(false);
  });
});

describe('checkJobs', () => {
  const jobs = ['a.txt', 'b.txt', 'c.txt'];

  it('agrees when the postings picked are the postings named', () => {
    expect(checkJobs(['b.txt', 'a.txt'], jobs, ['Job #1 · A', 'Job #2 · B'])).toEqual({
      expected: ['a.txt', 'b.txt'],
      actual: ['a.txt', 'b.txt'],
      agrees: true,
    });
  });

  it('disagrees for another posting, for none, or for one that was not asked for', () => {
    expect(checkJobs(['b.txt'], jobs, ['Job #3 · C']).agrees).toBe(false);
    expect(checkJobs(['b.txt'], jobs, undefined).agrees).toBe(false);
    expect(checkJobs(undefined, jobs, ['Job #1 · A']).agrees).toBe(false);
    expect(checkJobs(undefined, jobs, undefined).agrees).toBe(true);
  });

  it('does not make up a posting for a number that is not there or for a label without one', () => {
    expect(checkJobs(['a.txt'], jobs, ['Job #9 · Z']).actual).toEqual(['?']);
    expect(checkJobs(['a.txt'], jobs, ['Something']).actual).toEqual([]);
  });
});

describe('evaluateCareerRetrieval', () => {
  const resumeHit = (section: CareerHit['section'], content = 'x'): CareerHit => ({
    file: RESUME,
    section,
    content,
  });

  function searcherFor(
    answer: (
      variant: CareerVariant,
      query: string,
    ) => { hits: CareerHit[]; bestScore: number | null; jobs?: string[] },
  ): CareerSearcher {
    return { search: async (variant, query) => answer(variant, query) };
  }

  const rich = (question: string, variant: CareerVariant) => {
    const hit: CareerHit = {
      file: RESUME,
      section: 'skills',
      content: 'Go, Rust, Python, SQL, PostgreSQL, Redis, Docker',
    };
    return question.includes('programming')
      ? { hits: [resumeHit('education'), hit], bestScore: variant === 'keyword' ? null : 0.8 }
      : { hits: [resumeHit('summary')], bestScore: 0.4 };
  };

  it('asks every question of the corpus it belongs to, and rates the answerable by where the right passage is', async () => {
    const asked: Array<[string, string]> = [];
    const standard = searcherFor((variant, query) => {
      asked.push(['standard', `${variant}:${query}`]);
      return rich(query, variant);
    });
    const injected = searcherFor((variant, query) => {
      asked.push(['injected', `${variant}:${query}`]);
      return rich(query, variant);
    });

    const report = await evaluateCareerRetrieval({ golden, searchers: { standard, injected } });

    const languages = report.rows.find((r) => r.id === 'resume-languages')!;
    expect(languages.ranks).toEqual({ hybrid: 2, unbalanced: 2, vector: 2, keyword: 2 });
    expect(languages.levels).toEqual({ document: 1, section: 2, passage: 2 });
    expect(report.rows).toHaveLength(
      golden.questions.filter((q) => q.type !== 'unanswerable').length,
    );
    expect(report.unanswerable).toHaveLength(
      golden.questions.filter((q) => q.type === 'unanswerable').length,
    );
    expect(asked.filter(([corpus]) => corpus === 'injected').length).toBeGreaterThan(0);
    const injectedAsked = new Set(
      asked.filter(([c]) => c === 'injected').map(([, q]) => q.split(':')[1]),
    );
    expect(injectedAsked).toEqual(
      new Set(golden.questions.filter((q) => q.corpus === 'injected').map((q) => q.question)),
    );
  });

  it('counts the questions with both sides in the context before and after the addition', async () => {
    const searcher = searcherFor((variant) => ({
      hits:
        variant === 'hybrid'
          ? [
              resumeHit('experience'),
              { file: 'job-backend-go.txt', section: 'requirements', content: 'x' },
            ]
          : [resumeHit('experience')],
      bestScore: 0.5,
      jobs: ['Job #1 · Senior Backend Engineer at Northwind Payments'],
    }));

    const report = await evaluateCareerRetrieval({
      golden,
      searchers: { standard: searcher, injected: searcher },
    });

    expect(report.sides.questions).toBeGreaterThan(5);
    expect(report.sides.before).toBe(0);
    expect(report.sides.after).toBe(report.sides.questions);
  });

  it('counts the questions whose posting the app picked out, and the ones that got a posting they did not name', async () => {
    const searcher = searcherFor(() => ({
      hits: [resumeHit('skills')],
      bestScore: 0.5,
      jobs: ['Job #1 · Anything'],
    }));

    const report = await evaluateCareerRetrieval({
      golden,
      searchers: { standard: searcher, injected: searcher },
    });

    const named = report.rows.filter((r) => r.jobs.expected !== null);
    expect(report.jobs.named).toBe(named.length);
    expect(report.jobs.recognised).toBe(
      named.filter(
        (r) => r.corpus === 'standard' && r.jobs.expected!.join() === 'job-backend-go.txt',
      ).length,
    );
    expect(report.jobs.unexpected).toBe(report.rows.filter((r) => r.jobs.expected === null).length);
  });

  it('sweeps the threshold over the best scores of the answerable and unanswerable questions', async () => {
    const searcher = searcherFor((_variant, query) => ({
      hits: [resumeHit('skills')],
      bestScore: query.includes('salary') || query.includes('visa') ? 0.2 : 0.6,
    }));

    const report = await evaluateCareerRetrieval({
      golden,
      searchers: { standard: searcher, injected: searcher },
      thresholds: [0.1, 0.4, 0.7],
    });

    const [low, middle, high] = report.thresholds;
    expect(low).toEqual({ threshold: 0.1, answered: 1, refused: 0 });
    expect(middle!.answered).toBe(1);
    expect(middle!.refused).toBeGreaterThan(0.3);
    expect(high).toEqual({ threshold: 0.7, answered: 0, refused: 1 });
  });

  it('reports progress, and writes the groups of questions it has', async () => {
    const seen: number[] = [];
    const searcher = searcherFor(() => ({ hits: [], bestScore: null }));

    const report = await evaluateCareerRetrieval({
      golden,
      searchers: { standard: searcher, injected: searcher },
      onProgress: (done, total) => seen.push(done === total ? -1 : done),
    });

    expect(seen.at(-1)).toBe(-1);
    expect(Object.keys(report.summary.byKind)).toEqual(
      expect.arrayContaining([
        'alignment',
        'gaps',
        'years',
        'ranking',
        'interview',
        'trap',
        'injection',
      ]),
    );
    expect(report.summary.all.hybrid.hitAt[1]).toBe(0);
  });
});

describe('the reports', () => {
  it('say what went wrong in plain words, with the numbers that matter', async () => {
    const searcher: CareerSearcher = { search: async () => ({ hits: [], bestScore: 0.3 }) };
    const retrieval = await evaluateCareerRetrieval({
      golden,
      searchers: { standard: searcher, injected: searcher },
    });

    const text = formatCareerReport(retrieval, 0.3);

    expect(text).toContain('Both sides in the context');
    expect(text).toContain('Hybrid misses');
    expect(text).toContain('<- current');
    expect(text).toContain('closest unanswerable questions');
  });

  it('name the requirements where the model and the key disagree', () => {
    const wrongFit = fitOf([row('Terraform', 'met', 'invented')]);
    const standard = [
      scoreJob(platform, wrongFit, RESUME_TEXT, 5.8),
      scoreJob(golden.jobs[0]!, null, RESUME_TEXT, 5.8),
    ];
    const none = scoreResumeProfile(golden.resume, null);

    const text = formatFitReport({
      years: 5.8,
      profile: none,
      standard: { scores: standard, summary: summarizeFits(standard, golden.ranking) },
      injected: { scores: [], summary: summarizeFits([], []), injection: [] },
    });

    expect(text).toContain('no profile was made');
    expect(text).toContain('"Terraform" (must) is not_shown, the model said met');
    expect(text).toContain('job-backend-go.txt: no comparison was made');
    expect(text).toContain('No instruction was followed.');
  });
});
