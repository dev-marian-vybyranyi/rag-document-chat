import { assembleFit, type Judgement } from '../../src/career/coverage.js';
import type { JobProfileExtractor } from '../../src/career/job-profile.js';
import type { FitMatcher } from '../../src/career/matcher.js';
import type { ResumeProfileExtractor } from '../../src/career/resume-profile.js';
import type { JobProfile, ResumeProfile } from '../../src/career/types.js';
import type { CareerAnalysers } from '../../src/eval/career-corpus.js';
import type { GoldenCareer, JobKey } from '../../src/eval/golden-career.js';

export interface Flaws {
  inflate?: (job: JobKey, skill: string) => 'met' | 'partial' | 'not_shown' | undefined;
  quote?: (job: JobKey, skill: string, quote: string | null) => string | null;
  years?: number | null;
  dropSkills?: string[];
  dropRequirements?: (job: JobKey) => string[];
  matcherFails?: (job: JobKey) => boolean;
  profileFails?: (job: JobKey) => boolean;
}

export function oracle(golden: GoldenCareer, flaws: Flaws = {}): CareerAnalysers {
  const keyOf = (title: string | null, company: string | null) =>
    golden.jobs.find((job) => job.title === title && job.company === company)!;

  const resumeProfiles: ResumeProfileExtractor = {
    extract: async (): Promise<ResumeProfile> => ({
      role: 'resume',
      headline: null,
      skills: golden.resume.skills
        .filter((skill) => !(flaws.dropSkills ?? []).includes(skill))
        .map((name) => ({ name, quote: name })),
      roles: golden.resume.roles.map((role) => ({
        title: role.title,
        company: role.company,
        start: role.start,
        end: role.end,
        quote: `${role.title}, ${role.company}`,
      })),
      education: [],
      totalExperienceYears:
        flaws.years === undefined ? golden.resume.totalExperienceYears : flaws.years,
    }),
  };

  const profileOf = (key: JobKey): JobProfile => ({
    role: 'job',
    title: key.title,
    company: key.company,
    minYearsExperience: key.minYearsExperience,
    requirements: key.requirements
      .filter((requirement) => !(flaws.dropRequirements?.(key) ?? []).includes(requirement.skill))
      .map((requirement, i) => ({
        id: `r${i + 1}`,
        text: requirement.text,
        skill: requirement.skill,
        importance: requirement.importance,
        quote: requirement.text,
      })),
    responsibilities: [],
  });

  const jobProfiles: JobProfileExtractor = {
    extract: async ({ text }) => {
      const lines = text.split('\n');
      const key = keyOf(lines[0] ?? null, lines[1]?.replace(/^Company: /, '') ?? null);
      return flaws.profileFails?.(key) ? null : profileOf(key);
    },
  };

  const matcher: FitMatcher = {
    match: async ({ job, resumeId, resumeYears }) => {
      const key = keyOf(job.title, job.company);
      if (flaws.matcherFails?.(key)) return null;
      const judgements: Judgement[] = job.requirements.map((requirement) => {
        const keyed = key.requirements.find((item) => item.skill === requirement.skill)!;
        const status = flaws.inflate?.(key, keyed.skill) ?? keyed.status;
        const quote = flaws.quote
          ? flaws.quote(key, keyed.skill, keyed.evidence)
          : (keyed.evidence ?? (status === 'not_shown' ? null : 'invented'));
        return { requirementId: requirement.id, status, quote, note: '' };
      });
      return assembleFit({ job, judgements, resumeId, resumeYears })?.fit ?? null;
    },
  };

  return { resumeProfiles, jobProfiles, matcher };
}
