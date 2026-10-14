import { describe, expect, it } from 'vitest';
import type { DocumentItem, ProfileSummary } from './api';
import {
  awaitsFit,
  careerTitle,
  describeCareerProgress,
  describeCareerStatus,
  describeFit,
  describeYears,
  isCareer,
  jobState,
  shownSkills,
} from './career-status';

function doc(overrides: Partial<DocumentItem> = {}): DocumentItem {
  return {
    id: 'd1',
    kind: 'document',
    filename: 'file',
    mimeType: 'text/plain',
    sizeBytes: 100,
    status: 'ready',
    error: null,
    pageCount: null,
    chunkCount: 4,
    fileCount: null,
    repoUrl: null,
    repoRef: null,
    commitSha: null,
    meetingHeldOn: null,
    participants: null,
    durationMs: null,
    notes: null,
    jobNumber: null,
    profile: null,
    fit: null,
    progress: null,
    suggestions: [],
    createdAt: '2026-10-14T10:00:00Z',
    ...overrides,
  };
}

const resume = (overrides: Partial<DocumentItem> = {}) =>
  doc({ id: 'r1', kind: 'resume', filename: 'cv', ...overrides });
const job = (overrides: Partial<DocumentItem> = {}) =>
  doc({
    id: 'j1',
    kind: 'job_posting',
    filename: 'Platform Engineer at Acme',
    jobNumber: 2,
    profile: { role: 'job', title: 'Platform Engineer', company: 'Acme', requirementCount: 5 },
    ...overrides,
  });

describe('isCareer', () => {
  it('is true for a resume and a job posting only', () => {
    expect(isCareer(resume())).toBe(true);
    expect(isCareer(job())).toBe(true);
    for (const kind of ['document', 'repository', 'transcript'] as const) {
      expect(isCareer(doc({ kind }))).toBe(false);
    }
  });
});

describe('careerTitle', () => {
  it('calls the resume Resume, whatever the file was named', () => {
    expect(careerTitle(resume({ filename: 'alex-final-v3' }))).toBe('Resume');
  });

  it('numbers a job posting, the way the user refers to it in a question', () => {
    expect(careerTitle(job())).toBe('Job #2 · Platform Engineer at Acme');
  });

  it('leaves out the number of a posting that has none', () => {
    expect(careerTitle(job({ jobNumber: null }))).toBe('Platform Engineer at Acme');
  });
});

describe('describeCareerProgress', () => {
  const progress = (
    phase: 'reading' | 'analyzing' | 'embedding' | 'downloading',
    done = 0,
    total = 0,
  ) => ({ phase, done, total }) as const;

  it('says what is being done, for the resume and for a posting', () => {
    expect(describeCareerProgress(resume(), progress('reading'))).toBe('Reading the file…');
    expect(describeCareerProgress(resume(), progress('analyzing'))).toBe('Analysing the resume…');
    expect(describeCareerProgress(job(), progress('analyzing'))).toBe('Analysing the job posting…');
  });

  it('counts the passages while indexing', () => {
    expect(describeCareerProgress(job(), progress('embedding', 3, 8))).toBe(
      'Indexing: 3 of 8 passages',
    );
    expect(describeCareerProgress(job(), progress('embedding', 0, 1))).toBe(
      'Indexing: 0 of 1 passage',
    );
    expect(describeCareerProgress(job(), progress('embedding'))).toBe('Indexing…');
  });

  it('says only that it is processing before it is known what is done', () => {
    expect(describeCareerProgress(job(), null)).toBe('Processing…');
    expect(describeCareerProgress(job(), progress('downloading'))).toBe('Processing…');
  });
});

describe('describeYears', () => {
  it.each([
    [5, '5 years of experience'],
    [1, '1 year of experience'],
    [5.3, '5.3 years of experience'],
    [5.04, '5 years of experience'],
    [0.5, '0.5 years of experience'],
    [8.75, '8.8 years of experience'],
  ])('writes %s as %s', (years, expected) => {
    expect(describeYears(years)).toBe(expected);
  });
});

describe('describeCareerStatus', () => {
  it('shows the progress while it is processing, and failure when it failed', () => {
    expect(
      describeCareerStatus(
        resume({ status: 'processing', progress: { phase: 'reading', done: 0, total: 0 } }),
      ),
    ).toBe('Reading the file…');
    expect(describeCareerStatus(resume({ status: 'failed' }))).toBe('Failed');
  });

  it('counts the passages, the years and the skills of a resume', () => {
    const profile: ProfileSummary = {
      role: 'resume',
      skills: ['Go', 'Rust'],
      totalExperienceYears: 5.3,
    };

    expect(describeCareerStatus(resume({ profile }))).toBe(
      '4 passages · 5.3 years of experience · 2 skills',
    );
    expect(describeCareerStatus(resume({ profile: { ...profile, skills: ['Go'] } }))).toBe(
      '4 passages · 5.3 years of experience · 1 skill',
    );
  });

  it('leaves out years and skills that are not known', () => {
    expect(
      describeCareerStatus(
        resume({ profile: { role: 'resume', skills: [], totalExperienceYears: null } }),
      ),
    ).toBe('4 passages');
    expect(describeCareerStatus(resume())).toBe('4 passages');
  });

  it('counts the requirements of a posting', () => {
    expect(describeCareerStatus(job())).toBe('4 passages · 5 requirements');
    expect(
      describeCareerStatus(
        job({ profile: { role: 'job', title: null, company: null, requirementCount: 1 } }),
      ),
    ).toBe('4 passages · 1 requirement');
  });
});

describe('shownSkills', () => {
  it('shows the first eight and counts the others', () => {
    const skills = Array.from({ length: 11 }, (_, i) => `Skill${i}`);

    expect(shownSkills(skills)).toEqual({ shown: skills.slice(0, 8), more: 3 });
  });

  it('shows a short list whole and drops repeats', () => {
    expect(shownSkills(['Go', 'Rust', 'Go'])).toEqual({ shown: ['Go', 'Rust'], more: 0 });
    expect(shownSkills([])).toEqual({ shown: [], more: 0 });
  });
});

describe('describeFit', () => {
  it('says how much is shown, and how much of the must-haves', () => {
    expect(describeFit({ coverage: 72, mustCoverage: 80 })).toBe(
      '72% of the requirements shown in the resume · 80% of the must-haves',
    );
  });

  it('leaves out the must-haves when the posting has none', () => {
    expect(describeFit({ coverage: 50, mustCoverage: null })).toBe(
      '50% of the requirements shown in the resume',
    );
  });
});

describe('jobState', () => {
  const ready = resume({ status: 'ready' });

  it('is nothing for what is not a posting that is ready', () => {
    expect(jobState(resume(), [], [])).toBeNull();
    expect(jobState(job({ status: 'processing' }), [ready], [])).toBeNull();
    expect(jobState(job({ status: 'failed' }), [ready], [])).toBeNull();
  });

  it('asks for the analysis when there is no profile, or one of another kind', () => {
    expect(jobState(job({ profile: null }), [ready], [])).toEqual({ kind: 'not_analysed' });
    expect(
      jobState(
        job({ profile: { role: 'resume', skills: [], totalExperienceYears: null } }),
        [ready],
        [],
      ),
    ).toEqual({ kind: 'not_analysed' });
  });

  it('says there is nothing to compare when no requirement was found', () => {
    const empty = { role: 'job', title: null, company: null, requirementCount: 0 } as const;

    expect(jobState(job({ profile: empty }), [ready], [])).toEqual({ kind: 'no_requirements' });
  });

  it('gives the fit when there is one, whatever the resume is doing', () => {
    const fit = { coverage: 72, mustCoverage: 80 };

    expect(jobState(job({ fit }), [], [])).toEqual({ kind: 'fit', fit });
    expect(jobState(job({ fit }), [resume({ status: 'processing' })], ['j1'])).toEqual({
      kind: 'fit',
      fit,
    });
  });

  it('says to add a resume when there is none, or it failed', () => {
    expect(jobState(job(), [], [])).toEqual({ kind: 'no_resume' });
    expect(jobState(job(), [resume({ status: 'failed' })], [])).toEqual({ kind: 'no_resume' });
  });

  it('waits for a resume that is being processed', () => {
    expect(jobState(job(), [resume({ status: 'processing' })], [])).toEqual({
      kind: 'waiting_for_resume',
    });
  });

  it('is comparing while the page is still waiting for the result, and not compared once it gave up', () => {
    expect(jobState(job(), [ready], ['j1'])).toEqual({ kind: 'comparing' });
    expect(jobState(job(), [ready], ['other'])).toEqual({ kind: 'not_compared' });
    expect(jobState(job(), [ready], [])).toEqual({ kind: 'not_compared' });
  });
});

describe('awaitsFit', () => {
  const ready = resume({ status: 'ready' });

  it('is true for a ready posting with requirements and no fit, next to a ready resume', () => {
    expect(awaitsFit(job(), [ready])).toBe(true);
  });

  it.each([
    ['a posting with a fit', job({ fit: { coverage: 1, mustCoverage: null } })],
    ['a posting being processed', job({ status: 'processing' })],
    ['a posting that failed', job({ status: 'failed' })],
    ['a posting without a profile', job({ profile: null })],
    [
      'a posting without requirements',
      job({ profile: { role: 'job', title: null, company: null, requirementCount: 0 } }),
    ],
    ['the resume', resume()],
    ['a document', doc()],
  ])('is false for %s', (_label, candidate) => {
    expect(awaitsFit(candidate, [ready])).toBe(false);
  });

  it('is false without a ready resume', () => {
    expect(awaitsFit(job(), [])).toBe(false);
    expect(awaitsFit(job(), [resume({ status: 'processing' })])).toBe(false);
    expect(awaitsFit(job(), [resume({ status: 'failed' })])).toBe(false);
  });
});
