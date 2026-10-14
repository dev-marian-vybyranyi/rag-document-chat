import { describe, expect, it } from 'vitest';
import { profileSections } from '../src/career/profile-text.js';
import type { JobProfile, ResumeProfile } from '../src/career/types.js';

const resume: ResumeProfile = {
  role: 'resume',
  headline: 'Backend Engineer',
  skills: [
    { name: 'TypeScript', quote: 'TypeScript' },
    { name: 'PostgreSQL', quote: 'PostgreSQL' },
  ],
  roles: [
    {
      title: 'Senior Engineer',
      company: 'Acme',
      start: '2021-03',
      end: '2024-06',
      quote: 'Senior Engineer, Acme (2021-03 – 2024-06)',
    },
    { title: 'Engineer', company: 'Beta', start: '2024-09', end: null, quote: 'Engineer, Beta' },
    { title: 'Intern', company: 'Gamma', start: null, end: null, quote: 'Intern at Gamma' },
  ],
  education: [
    { institution: 'KNU', degree: 'BSc Computer Science', quote: 'BSc Computer Science, KNU' },
    { institution: 'Coursera', degree: null, quote: 'Coursera' },
  ],
  totalExperienceYears: 6.5,
};

const job: JobProfile = {
  role: 'job',
  title: 'Backend Engineer',
  company: 'Stripe',
  minYearsExperience: 5,
  requirements: [
    {
      id: 'r1',
      text: '3+ years of Kubernetes',
      skill: 'Kubernetes',
      importance: 'must',
      quote: 'k',
    },
    { id: 'r2', text: 'Terraform', skill: 'Terraform', importance: 'nice', quote: 't' },
    { id: 'r3', text: 'Node', skill: 'Node', importance: 'must', quote: 'n' },
  ],
  responsibilities: ['Own the billing service'],
};

const textOf = (profile: ResumeProfile | JobProfile | null) =>
  profileSections(profile).map((section) => section.text);

describe('the text of a profile', () => {
  it('lists the headline, the years, the skills, the roles and the education of a resume', () => {
    expect(textOf(resume)).toEqual([
      [
        'Headline: Backend Engineer',
        'Total professional experience: 6.5 years (computed from the dates of the roles)',
        'Skills: TypeScript, PostgreSQL',
        'Roles:',
        '- Senior Engineer, Acme, 2021-03 to 2024-06',
        '- Engineer, Beta, 2024-09 to present',
        '- Intern, Gamma',
        'Education:',
        '- BSc Computer Science, KNU',
        '- Coursera',
      ].join('\n'),
    ]);
  });

  it('leaves out what a resume profile does not have', () => {
    const sparse: ResumeProfile = {
      ...resume,
      headline: null,
      totalExperienceYears: null,
      roles: [],
      education: [],
    };

    expect(textOf(sparse)).toEqual(['Skills: TypeScript, PostgreSQL']);
  });

  it('lists the role, the years, the requirements by importance and the duties of a posting', () => {
    expect(textOf(job)).toEqual([
      [
        'Role: Backend Engineer at Stripe',
        'Minimum years of professional experience: 5',
        'Must have:',
        '- 3+ years of Kubernetes',
        '- Node',
        'Nice to have:',
        '- Terraform',
        'Responsibilities:',
        '- Own the billing service',
      ].join('\n'),
    ]);
  });

  it('names the role by whatever of the title and the company is known', () => {
    expect(textOf({ ...job, company: null })[0]?.split('\n')[0]).toBe('Role: Backend Engineer');
    expect(textOf({ ...job, title: null })[0]?.split('\n')[0]).toBe('Role: Stripe');
    expect(textOf({ ...job, title: null, company: null })[0]?.split('\n')[0]).toBe(
      'Minimum years of professional experience: 5',
    );
  });

  it('skips a group that has nothing in it', () => {
    const onlyMust = textOf({
      ...job,
      minYearsExperience: null,
      requirements: [job.requirements[0]!],
      responsibilities: [],
    })[0]!;

    expect(onlyMust).toBe(
      ['Role: Backend Engineer at Stripe', 'Must have:', '- 3+ years of Kubernetes'].join('\n'),
    );
  });

  it('gives nothing for no profile or an empty one', () => {
    expect(profileSections(null)).toEqual([]);
    expect(
      profileSections({
        role: 'job',
        title: null,
        company: null,
        minYearsExperience: null,
        requirements: [],
        responsibilities: [],
      }),
    ).toEqual([]);
    expect(
      profileSections({
        role: 'resume',
        headline: null,
        skills: [],
        roles: [],
        education: [],
        totalExperienceYears: null,
      }),
    ).toEqual([]);
  });

  it('makes a section of the profile kind that belongs to no page', () => {
    expect(profileSections(resume)[0]).toMatchObject({
      section: 'profile',
      heading: null,
      title: null,
      page: null,
    });
  });
});
