import type { CareerProfile, Fit } from './types.js';

export type ProfileSummary =
  | { role: 'resume'; skills: string[]; totalExperienceYears: number | null }
  | {
      role: 'job';
      title: string | null;
      company: string | null;
      requirementCount: number;
    };

export interface FitSummary {
  coverage: number;
  mustCoverage: number | null;
}

export function summarizeProfile(profile: CareerProfile | null): ProfileSummary | null {
  if (profile === null) return null;
  if (profile.role === 'resume') {
    return {
      role: 'resume',
      skills: profile.skills.map((skill) => skill.name),
      totalExperienceYears: profile.totalExperienceYears,
    };
  }
  return {
    role: 'job',
    title: profile.title,
    company: profile.company,
    requirementCount: profile.requirements.length,
  };
}

export function summarizeFit(fit: Fit | null): FitSummary | null {
  if (fit === null) return null;
  return { coverage: fit.coverage, mustCoverage: fit.mustCoverage };
}
