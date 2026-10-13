import { describe, expect, it } from 'vitest';
import { summarizeFit, summarizeProfile } from '../src/career/summary.js';
import type { Fit, JobProfile, ResumeProfile } from '../src/career/types.js';

const resume: ResumeProfile = {
  role: 'resume',
  headline: 'Backend engineer',
  skills: [
    { name: 'TypeScript', quote: 'TypeScript' },
    { name: 'PostgreSQL', quote: 'PostgreSQL' },
  ],
  roles: [
    {
      title: 'Engineer',
      company: 'Acme',
      start: '2020-01',
      end: null,
      quote: 'Engineer, Acme, 2020 - present',
    },
  ],
  education: [],
  totalExperienceYears: 6.4,
};

const job: JobProfile = {
  role: 'job',
  title: 'Backend Engineer',
  company: 'Stripe',
  minYearsExperience: 5,
  requirements: [
    { id: 'r1', text: 'Five years of Node', skill: 'Node', importance: 'must', quote: '5+ years' },
    { id: 'r2', text: 'Kubernetes', skill: 'Kubernetes', importance: 'nice', quote: 'Kubernetes' },
  ],
  responsibilities: ['Own the billing service'],
};

describe('career summaries', () => {
  it('lists the skills and years of a resume without the quotes', () => {
    expect(summarizeProfile(resume)).toEqual({
      role: 'resume',
      skills: ['TypeScript', 'PostgreSQL'],
      totalExperienceYears: 6.4,
    });
  });

  it('counts the requirements of a job posting', () => {
    expect(summarizeProfile(job)).toEqual({
      role: 'job',
      title: 'Backend Engineer',
      company: 'Stripe',
      requirementCount: 2,
    });
  });

  it('has nothing to say about a missing profile or fit', () => {
    expect(summarizeProfile(null)).toBeNull();
    expect(summarizeFit(null)).toBeNull();
  });

  it('keeps only the coverage figures of a fit', () => {
    const fit: Fit = {
      resumeId: 'r',
      analyzedAt: '2026-10-13T10:00:00.000Z',
      requirements: [
        {
          requirementId: 'r1',
          text: 'Five years of Node',
          skill: 'Node',
          importance: 'must',
          status: 'met',
          quote: 'Node since 2019',
          note: '',
        },
      ],
      coverage: 72,
      mustCoverage: 80,
    };

    expect(summarizeFit(fit)).toEqual({ coverage: 72, mustCoverage: 80 });
  });
});
