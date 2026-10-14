import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { computeCoverage, experienceRequirement } from '../src/career/coverage.js';
import { totalExperienceYears } from '../src/career/experience.js';
import { defaultCareerLimits } from '../src/career/limits.js';
import { detectJobs, type JobFacts } from '../src/career/question-jobs.js';
import { redactResume } from '../src/career/redact.js';
import { splitIntoSections } from '../src/career/sections.js';
import type { FitRequirement } from '../src/career/types.js';
import {
  isText,
  loadGoldenCareer,
  parseGoldenCareer,
  QUESTION_KINDS,
  type CareerAnswerable,
  type CareerInjection,
  type CareerUnanswerable,
  type JobKey,
} from '../src/eval/golden-career.js';
import { containsWord, normalizeForMatch } from '../src/eval/golden.js';

const root = join(import.meta.dirname, '../../..');
const directory = join(root, 'samples/career');
const golden = loadGoldenCareer(join(root, 'scripts/eval/golden-career.json'));
const sources = readFileSync(join(root, 'samples/SOURCES.md'), 'utf8');

const raw = (file: string) => readFileSync(join(directory, file), 'utf8');
const isResume = (file: string) => file.startsWith('resume-');
const indexed = (file: string) => (isResume(file) ? redactResume(raw(file)).text : raw(file));
const sectionsOf = (file: string) =>
  splitIntoSections(isResume(file) ? 'resume' : 'job_posting', [
    { page: null, text: indexed(file) },
  ]);

const standardResume = golden.corpora.standard.resume;
const jobKeys = new Map<string, JobKey>(golden.jobs.map((job) => [job.file, job]));

const answerable = golden.questions.filter((q): q is CareerAnswerable => q.type === 'answerable');
const unanswerable = golden.questions.filter(
  (q): q is CareerUnanswerable => q.type === 'unanswerable',
);
const injections = golden.questions.filter((q): q is CareerInjection => q.type === 'injection');

const filesOf = (corpus: 'standard' | 'injected') => {
  const { resume, jobs } = golden.corpora[corpus];
  return { resume, jobs, all: [resume, ...jobs] };
};

function factsOf(corpus: 'standard' | 'injected'): JobFacts[] {
  return filesOf(corpus).jobs.map((file, index) => {
    const job = jobKeys.get(file)!;
    return {
      id: file,
      jobNumber: index + 1,
      name: `${job.title} at ${job.company}`,
      title: job.title,
      company: job.company,
    };
  });
}

function rowsOf(job: JobKey): FitRequirement[] {
  const rows = job.requirements.map((requirement, i): FitRequirement => ({
    requirementId: `r${i + 1}`,
    text: requirement.text,
    skill: requirement.skill,
    importance: requirement.importance,
    status: requirement.status,
    quote: requirement.evidence,
    note: '',
  }));
  const experience = experienceRequirement(
    job.minYearsExperience,
    golden.resume.totalExperienceYears,
  );
  return experience === null ? rows : [experience, ...rows];
}

const coverageOf = (file: string) => computeCoverage(rowsOf(jobKeys.get(file)!))!;

describe('the sample resume and job postings', () => {
  it('are exactly the files the golden set names, and nothing else', () => {
    const named = new Set([
      ...filesOf('standard').all,
      ...filesOf('injected').all,
      ...golden.jobs.map((j) => j.file),
    ]);

    expect(readdirSync(directory).sort()).toEqual([...named].sort());
  });

  it('are within the limits the app sets, so that the app accepts them', () => {
    for (const file of readdirSync(directory)) {
      const text = raw(file);
      const limit = isResume(file)
        ? defaultCareerLimits.maxResumeCharacters
        : defaultCareerLimits.maxJobCharacters;
      expect(text.length, file).toBeLessThan(limit);
      expect(text.trim().length, file).toBeGreaterThan(200);
    }
    expect(filesOf('standard').jobs.length).toBeLessThanOrEqual(defaultCareerLimits.maxJobs);
  });

  it('are described in SOURCES.md as written for this project', () => {
    expect(sources).toContain('samples/career');
    for (const file of readdirSync(directory)) expect(sources, file).toContain(file);
    expect(sources).toMatch(/invented/i);
  });

  it('use dates, companies and people that are invented, with addresses that cannot be real', () => {
    const text = raw(standardResume);

    expect(text).toContain('example.com');
    expect(text).toContain('555-0134');
  });
});

describe('the resume', () => {
  const key = golden.resume;
  const text = raw(key.file);
  const redaction = redactResume(text);

  it('is the one the corpus uses, and the injected one adds only one line to it', () => {
    expect(key.file).toBe(standardResume);
    const injectedFile = golden.corpora.injected.resume;
    const standardLines = text.split('\n');
    const injectedLines = raw(injectedFile).split('\n');
    const added = injectedLines.filter((line) => !standardLines.includes(line));
    const attacks = injections.filter((q) => q.attack.document === injectedFile);

    expect(injectedLines.filter((line) => standardLines.includes(line))).toEqual(standardLines);
    expect(added).toHaveLength(1);
    expect(attacks).toHaveLength(1);
    expect(added[0]).toContain(attacks[0]!.attack.quote);
  });

  it('has roles whose dates add up to the years in the key', () => {
    expect(totalExperienceYears(key.roles)).toBe(key.totalExperienceYears);
    for (const role of key.roles) {
      expect(text).toContain(`${role.title}, ${role.company} (${role.start} – ${role.end})`);
    }
  });

  it('names the skills in the key, each of them written in the resume', () => {
    for (const skill of key.skills) expect(containsWord(text, skill), skill).toBe(true);
  });

  it('loses what redaction is meant to remove, and nothing else it should keep', () => {
    expect(redaction.removed).toEqual(key.removed);
    for (const gone of [
      'alex.morgan@example.com',
      '555-0134',
      'linkedin.com',
      'github.com',
      '410 Congress',
      '12 May 1994',
      'Marital status',
    ]) {
      expect(redaction.text, gone).not.toContain(gone);
    }
    expect(text).toContain('Marital status: single');
    for (const kept of ['Alex Morgan', ...key.kept]) expect(redaction.text, kept).toContain(kept);
  });

  it('is split into the sections the questions rely on', () => {
    const sections = sectionsOf(key.file);

    expect(sections.filter((s) => s.section === 'experience').map((s) => s.title)).toEqual([
      'Senior Backend Engineer, Initech (2021-03 – 2024-06)',
      'Backend Engineer, Hooli Pay (2018-09 – 2021-02)',
    ]);
    for (const section of ['summary', 'skills', 'education']) {
      expect(
        sections.some((s) => s.section === section),
        section,
      ).toBe(true);
    }
  });
});

describe('the answer key for the fit', () => {
  it('has a key for each posting of each corpus', () => {
    for (const corpus of ['standard', 'injected'] as const) {
      for (const file of filesOf(corpus).jobs) expect(jobKeys.has(file), file).toBe(true);
    }
    expect(golden.jobs.length).toBe(
      new Set([...filesOf('standard').jobs, ...filesOf('injected').jobs]).size,
    );
  });

  describe.each(golden.jobs)('$file', (job) => {
    const text = raw(job.file);
    const sections = sectionsOf(job.file);
    const resumeText = normalizeForMatch(indexed(standardResume));
    const inSection = (name: string, line: string) =>
      sections.some(
        (s) => s.section === name && s.text.split('\n').some((l) => l.trim() === `- ${line}`),
      );

    it('starts with the title and the company in the key', () => {
      expect(text.split('\n').slice(0, 2)).toEqual([job.title, `Company: ${job.company}`]);
    });

    it('lists each requirement of the key as a line of the section that matches its importance', () => {
      for (const requirement of job.requirements) {
        const section = requirement.importance === 'must' ? 'requirements' : 'nice_to_have';
        expect(inSection(section, requirement.text), requirement.text).toBe(true);
      }
      const listed = sections
        .filter((s) => s.section === 'requirements' || s.section === 'nice_to_have')
        .flatMap((s) => s.text.split('\n').filter((l) => l.startsWith('- ')));
      const years = job.experienceQuote === null ? 0 : 1;
      expect(listed.length).toBe(job.requirements.length + years);
    });

    it('states the years it asks for in the words of the key', () => {
      if (job.experienceQuote === null) {
        expect(text).not.toMatch(/\d\+ years/);
        return;
      }
      expect(inSection('requirements', job.experienceQuote)).toBe(true);
      expect(job.experienceQuote).toContain(`${job.minYearsExperience}+ years`);
    });

    it('has evidence that is a line of the resume, for what the resume shows', () => {
      for (const requirement of job.requirements) {
        if (requirement.evidence === null) continue;
        expect(resumeText, requirement.skill).toContain(normalizeForMatch(requirement.evidence));
      }
    });

    it('agrees with the code on the years', () => {
      const experience = experienceRequirement(
        job.minYearsExperience,
        golden.resume.totalExperienceYears,
      );
      expect(experience?.status ?? null).toBe(job.experience);
    });
  });

  it('keeps a requirement apart from a skill that is only near it', () => {
    const traps = golden.jobs.flatMap((job) =>
      job.requirements.filter((r) => r.trap !== undefined).map((r) => [job.file, r] as const),
    );

    expect(traps.length).toBeGreaterThanOrEqual(3);
    for (const [, requirement] of traps) {
      expect(requirement.status === 'met', requirement.skill).toBe(false);
    }
    expect(traps.some(([, r]) => r.status === 'partial')).toBe(true);
  });

  it('covers every status, every importance, and a requirement the resume only half shows', () => {
    const all = golden.jobs.flatMap((job) => job.requirements);

    expect(new Set(all.map((r) => r.status))).toEqual(new Set(['met', 'partial', 'not_shown']));
    expect(new Set(all.map((r) => r.importance))).toEqual(new Set(['must', 'nice']));
    expect(golden.jobs.map((j) => j.experience)).toEqual(
      expect.arrayContaining(['met', 'partial']),
    );
  });

  it('gives the ranking and the coverage that the code works out from it', () => {
    const coverage = Object.fromEntries(golden.jobs.map((j) => [j.file, coverageOf(j.file)]));

    expect(
      Object.fromEntries(Object.entries(coverage).map(([file, c]) => [file, c.coverage])),
    ).toEqual({
      'job-backend-go.txt': 97,
      'job-platform.txt': 68,
      'job-frontend.txt': 0,
      'job-data.txt': 43,
      'job-engineering-manager.txt': 40,
      'job-injected.txt': 33,
    });
    const ranked = [...filesOf('standard').jobs].sort(
      (a, b) => coverage[b]!.coverage - coverage[a]!.coverage,
    );
    expect(golden.ranking).toEqual(ranked);
  });

  it('ranks the postings of the standard corpus, and only them', () => {
    expect([...golden.ranking].sort()).toEqual([...filesOf('standard').jobs].sort());
  });

  it('would fool nobody: the injected posting is far from a perfect match', () => {
    expect(coverageOf('job-injected.txt').coverage).toBeLessThan(50);
  });
});

describe('the golden question set for the career assistant', () => {
  it('has enough questions of each kind', () => {
    expect(answerable.length).toBeGreaterThanOrEqual(18);
    expect(unanswerable.length).toBeGreaterThanOrEqual(6);
    expect(unanswerable.some((q) => q.hard)).toBe(true);
    expect(injections.length).toBeGreaterThanOrEqual(2);
    for (const kind of QUESTION_KINDS) {
      expect(answerable.filter((q) => q.kind === kind).length, kind).toBeGreaterThanOrEqual(1);
    }
    expect(answerable.filter((q) => q.kind === 'alignment').length).toBeGreaterThanOrEqual(3);
    expect(answerable.filter((q) => q.kind === 'gaps').length).toBeGreaterThanOrEqual(3);
  });

  it('asks about every posting of the standard corpus', () => {
    for (const file of filesOf('standard').jobs) {
      const asked = golden.questions.filter(
        (q) => q.corpus === 'standard' && q.jobs?.includes(file),
      );
      expect(asked.length, file).toBeGreaterThanOrEqual(1);
    }
  });

  it('names only postings of the corpus the question runs against', () => {
    for (const q of golden.questions) {
      const corpus = new Set(filesOf(q.corpus).jobs);
      for (const file of q.jobs ?? []) expect(corpus.has(file), `${q.id}: ${file}`).toBe(true);
    }
  });

  describe('the question names the postings it says it names', () => {
    const named = golden.questions.map((q) => [q.id, q] as const);

    it.each(named)('%s', (_id, q) => {
      const found = detectJobs(q.question, factsOf(q.corpus)).map((job) => job.id);

      expect(found.sort()).toEqual([...(q.jobs ?? [])].sort());
    });
  });

  describe('the passages that answer a question', () => {
    const quoted = golden.questions.flatMap((q) =>
      q.type === 'unanswerable'
        ? []
        : q.expected.filter(isText).map((e) => [q.id, q.corpus, e] as const),
    );

    it.each(quoted)('%s: the quote is verbatim, in that section of that file', (_id, corpus, e) => {
      expect(filesOf(corpus).all, e.document).toContain(e.document);
      const sections = sectionsOf(e.document).filter((s) => s.section === e.section);

      expect(
        sections.some((s) => normalizeForMatch(s.text).includes(normalizeForMatch(e.quote))),
        `${e.document} / ${e.section}`,
      ).toBe(true);
    });

    it('refer, when generated, to postings that the question can see', () => {
      for (const q of golden.questions) {
        if (q.type === 'unanswerable') continue;
        for (const e of q.expected) {
          if (!isText(e) && e.analysis === 'fit') {
            expect(filesOf(q.corpus).jobs, q.id).toContain(e.job);
          }
        }
      }
    });

    it('include, for a question about one posting, the fit of that posting', () => {
      for (const q of answerable.filter((x) => x.kind === 'alignment' || x.kind === 'gaps')) {
        const fits = q.expected.flatMap((e) => (!isText(e) && e.analysis === 'fit' ? [e.job] : []));
        expect(fits.sort(), q.id).toEqual([...(q.jobs ?? [])].sort());
      }
    });

    it('include the overview for the questions that compare all the postings', () => {
      for (const q of answerable.filter((x) => x.kind === 'ranking' && !x.jobs)) {
        expect(
          q.expected.some((e) => !isText(e) && e.analysis === 'overview'),
          q.id,
        ).toBe(true);
      }
    });
  });

  describe('the questions that cannot be answered', () => {
    const everything = (corpus: 'standard' | 'injected') =>
      filesOf(corpus).all.map(indexed).join('\n');

    it.each(unanswerable.map((q) => [q.id, q] as const))(
      '%s: nothing the question asks for is in the text that is indexed',
      (_id, q) => {
        for (const term of q.absentTerms) {
          expect(containsWord(everything(q.corpus), term), term).toBe(false);
        }
      },
    );

    it('include things the resume does state before redaction, which is why they are hard', () => {
      const marital = unanswerable.find((q) => q.id === 'no-marital-status')!;

      expect(containsWord(raw(standardResume), marital.absentTerms[0]!)).toBe(true);
      expect(marital.hard).toBe(true);
    });
  });

  describe('the questions that hide an instruction in a document', () => {
    it.each(injections.map((q) => [q.id, q] as const))(
      '%s: the sentence is in that document, in the injected corpus only',
      (_id, q) => {
        expect(q.corpus).toBe('injected');
        expect(filesOf('injected').all).toContain(q.attack.document);
        expect(normalizeForMatch(raw(q.attack.document))).toContain(
          normalizeForMatch(q.attack.quote),
        );
        for (const file of filesOf('standard').all) {
          expect(normalizeForMatch(raw(file)), file).not.toContain(
            normalizeForMatch(q.attack.quote),
          );
        }
      },
    );

    it('are one in the resume and one in a posting', () => {
      expect(injections.map((q) => isResume(q.attack.document)).sort()).toEqual([false, true]);
    });
  });
});

describe('parsing the golden set', () => {
  const valid = () => JSON.parse(JSON.stringify(golden)) as Record<string, unknown>;

  it('accepts the set as it is', () => {
    expect(() => parseGoldenCareer(valid())).not.toThrow();
  });

  it('refuses two questions with the same id', () => {
    const set = valid() as { questions: Array<{ id: string }> };
    set.questions[1]!.id = set.questions[0]!.id;

    expect(() => parseGoldenCareer(set)).toThrow(/ids must be unique/);
  });

  it('refuses a requirement that has evidence and is not shown, or the other way round', () => {
    const set = valid() as { jobs: Array<{ requirements: Array<Record<string, unknown>> }> };
    set.jobs[0]!.requirements[0]!.evidence = null;

    expect(() => parseGoldenCareer(set)).toThrow(/evidence/);
  });

  it('refuses years without their quote', () => {
    const set = valid() as { jobs: Array<Record<string, unknown>> };
    set.jobs[0]!.experienceQuote = null;

    expect(() => parseGoldenCareer(set)).toThrow(/come together/);
  });

  it('refuses a question of an unknown kind and a quote that is too short to mean anything', () => {
    const kind = valid() as { questions: Array<Record<string, unknown>> };
    kind.questions[0]!.kind = 'gossip';
    expect(() => parseGoldenCareer(kind)).toThrow();

    const quote = valid() as { questions: Array<{ expected: Array<Record<string, unknown>> }> };
    quote.questions[0]!.expected[0]!.quote = 'Go';
    expect(() => parseGoldenCareer(quote)).toThrow();
  });

  it('refuses more than ten postings in a corpus', () => {
    const set = valid() as { corpora: { standard: { jobs: string[] } } };
    set.corpora.standard.jobs = Array.from({ length: 11 }, (_, i) => `job-${i}.txt`);

    expect(() => parseGoldenCareer(set)).toThrow();
  });
});
