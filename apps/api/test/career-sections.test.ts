import { describe, expect, it } from 'vitest';
import { splitIntoSections, type CareerKind } from '../src/career/sections.js';

const split = (kind: CareerKind, text: string) => splitIntoSections(kind, [{ page: null, text }]);

const resume = (text: string) => split('resume', text);
const job = (text: string) => split('job_posting', text);

const names = (sections: ReturnType<typeof split>) =>
  sections.map(({ section, heading }) => [section, heading]);

describe('splitting a resume into sections', () => {
  describe('headings', () => {
    it('reads capitals, markdown, bold, plain and colon headings', () => {
      const sections = resume(
        [
          'Alex Morgan',
          'SUMMARY',
          'Backend engineer.',
          '## Work Experience',
          'Acme',
          '**Skills**',
          'TypeScript',
          'Education',
          'BSc',
          'Languages:',
          'English',
        ].join('\n'),
      );

      expect(names(sections)).toEqual([
        ['summary', null],
        ['summary', 'SUMMARY'],
        ['experience', 'Work Experience'],
        ['skills', 'Skills'],
        ['education', 'Education'],
        ['other', 'Languages'],
      ]);
    });

    it.each([
      ['Professional Experience', 'experience'],
      ['EMPLOYMENT HISTORY', 'experience'],
      ['Work History', 'experience'],
      ['Technical Skills', 'skills'],
      ['Skills & Tools', 'skills'],
      ['Core Competencies', 'skills'],
      ['Tech Stack', 'skills'],
      ['Certifications', 'education'],
      ['Education and Training', 'education'],
      ['Profile', 'summary'],
      ['About me', 'summary'],
      ['Personal Projects', 'other'],
      ['References', 'other'],
    ])('understands "%s" as %s', (heading, section) => {
      const [, found] = resume(`Alex\n${heading}\nsomething`);

      expect(found).toMatchObject({ section, heading, text: 'something' });
    });

    it('reads a heading in underscores or asterisks without the marks', () => {
      const sections = resume('Alex\n__Skills__\nGo\n**Education:**\nBSc');

      expect(names(sections)).toEqual([
        ['summary', null],
        ['skills', 'Skills'],
        ['education', 'Education'],
      ]);
    });

    it('keeps the text after a colon as the first line of the section', () => {
      const sections = resume('Alex\nSkills: TypeScript, Go, SQL\nLanguages: English');

      expect(sections.map((s) => [s.section, s.text])).toEqual([
        ['summary', 'Alex'],
        ['skills', 'TypeScript, Go, SQL'],
        ['other', 'English'],
      ]);
    });

    it('does not take a line of the work history for a heading', () => {
      const sections = resume(
        [
          'EXPERIENCE',
          'ACME CORP',
          'Skills gap analysis for 40 teams',
          'Requirements gathering',
          '- Education',
          'Experience: building APIs, 5 years',
          'Team size: 5 engineers',
          'Education.',
        ].join('\n'),
      );

      expect(names(sections)).toEqual([
        ['experience', 'EXPERIENCE'],
        ['experience', 'Experience'],
      ]);
      expect(sections[0]?.text).toBe(
        'ACME CORP\nSkills gap analysis for 40 teams\nRequirements gathering\n- Education',
      );
      expect(sections[1]?.text).toBe('building APIs, 5 years\nTeam size: 5 engineers\nEducation.');
    });

    it('starts a section at a heading that sits in the middle of a column layout', () => {
      const sections = resume(
        ['EXPERIENCE', 'Acme, Engineer', 'SKILLS', 'Go', 'More work text'].join('\n'),
      );

      expect(names(sections)).toEqual([
        ['experience', 'EXPERIENCE'],
        ['skills', 'SKILLS'],
      ]);
    });

    it('ignores lines made only of rules', () => {
      const sections = resume('Alex\nEXPERIENCE\n=====\nAcme\n-----\n___');

      expect(sections.map((s) => s.text)).toEqual(['Alex', 'Acme']);
    });

    it('keeps the name at the top as a summary without a heading, even after a markdown title', () => {
      const sections = resume('# Alex Morgan\nBackend engineer\n## Skills\nGo');

      expect(sections.map((s) => [s.section, s.heading, s.text])).toEqual([
        ['summary', null, 'Alex Morgan\nBackend engineer'],
        ['skills', 'Skills', 'Go'],
      ]);
    });

    it('turns an unknown markdown heading into an other section that keeps its name', () => {
      const sections = resume('Alex\n## Speaking\nRustConf 2023');

      expect(sections[1]).toMatchObject({
        section: 'other',
        heading: 'Speaking',
        text: 'RustConf 2023',
      });
    });

    it('keeps two sections with the same heading apart and drops a heading with nothing under it', () => {
      const sections = resume('Skills\nGo\nEducation\nSkills\nRust');

      expect(sections.map((s) => [s.section, s.text])).toEqual([
        ['skills', 'Go'],
        ['skills', 'Rust'],
      ]);
    });
  });

  describe('without headings', () => {
    it('gives plain text one other section per page', () => {
      const sections = splitIntoSections('resume', [
        { page: 1, text: 'Alex Morgan\nBackend engineer' },
        { page: 2, text: 'More about work' },
      ]);

      expect(sections.map((s) => [s.section, s.heading, s.page, s.text])).toEqual([
        ['other', null, 1, 'Alex Morgan\nBackend engineer'],
        ['other', null, 2, 'More about work'],
      ]);
    });

    it('returns nothing for an empty text', () => {
      expect(resume('')).toEqual([]);
      expect(resume('\n  \n')).toEqual([]);
      expect(splitIntoSections('resume', [])).toEqual([]);
    });
  });

  describe('roles in the experience section', () => {
    const experience = (lines: string[]) =>
      resume(['EXPERIENCE', ...lines].join('\n')).map((s) => [s.title, s.text]);

    it('makes one entry per role when the dates are on the title line', () => {
      expect(
        experience([
          'Senior Engineer, Acme (2021-03 – 2024-06)',
          '- Cut latency',
          '- Led 3 engineers',
          '',
          'Engineer, Beta (2018-01 – 2021-02)',
          '- Built APIs',
        ]),
      ).toEqual([
        [
          'Senior Engineer, Acme (2021-03 – 2024-06)',
          'Senior Engineer, Acme (2021-03 – 2024-06)\n- Cut latency\n- Led 3 engineers',
        ],
        ['Engineer, Beta (2018-01 – 2021-02)', 'Engineer, Beta (2018-01 – 2021-02)\n- Built APIs'],
      ]);
    });

    it('takes the title and the company above a line that holds only the dates', () => {
      expect(
        experience([
          'Senior Engineer',
          'Acme Corp',
          'Mar 2021 – Present',
          '- Cut latency',
          '',
          'Engineer',
          'Beta Inc',
          'Jan 2018 - Feb 2021',
          '- Built APIs',
        ]),
      ).toEqual([
        [
          'Senior Engineer · Acme Corp · Mar 2021 – Present',
          'Senior Engineer\nAcme Corp\nMar 2021 – Present\n- Cut latency',
        ],
        [
          'Engineer · Beta Inc · Jan 2018 - Feb 2021',
          'Engineer\nBeta Inc\nJan 2018 - Feb 2021\n- Built APIs',
        ],
      ]);
    });

    it('keeps a title that follows the line with the company and the dates', () => {
      const [first, second] = experience([
        'Acme Corp — Mar 2021 – Jun 2024',
        'Senior Engineer',
        '- Cut latency',
        'Beta Inc — 2018 – 2021',
        'Engineer',
        '- Built APIs',
      ]);

      expect(first).toEqual([
        'Acme Corp — Mar 2021 – Jun 2024',
        'Acme Corp — Mar 2021 – Jun 2024\nSenior Engineer\n- Cut latency',
      ]);
      expect(second?.[0]).toBe('Beta Inc — 2018 – 2021');
    });

    it.each([
      'Mar 2021 – Jun 2024',
      'March 2021 - June 2024',
      'Sept 2018 – Dec 2020',
      '03/2021 - 06/2024',
      '2021-03 to 2024-06',
      '2019 – Current',
      '2019 — now',
      'Jan. 2020 until Present',
      '2015 - 2018',
    ])('finds the range "%s"', (range) => {
      const found = experience([`Engineer, Acme ${range}`, '- Work', `Dev, Beta ${range}`]);

      expect(found).toHaveLength(2);
    });

    it('leaves the bullet out of the title when the role line starts with one', () => {
      const [first] = experience(['• Engineer, Acme (2020 – 2023)', '- Work']);

      expect(first?.[0]).toBe('Engineer, Acme (2020 – 2023)');
    });

    it('does not start a role at a single year or at a year in a sentence', () => {
      expect(
        experience(['Engineer at Acme', '- Joined in 2021 and shipped v2', 'Founded in 2015']),
      ).toHaveLength(1);
    });

    it('keeps the lines before the first role as an entry of their own', () => {
      const found = experience([
        'Ten years in backend work.',
        '',
        'Engineer, Acme (2020 – 2023)',
        '- Work',
      ]);

      expect(found).toEqual([
        [null, 'Ten years in backend work.'],
        ['Engineer, Acme (2020 – 2023)', 'Engineer, Acme (2020 – 2023)\n- Work'],
      ]);
    });

    it('does not pull bullets or sentences of the previous role into the next one', () => {
      const [first, second] = experience([
        'Engineer, Acme (2020 – 2023)',
        '- Shipped the billing service',
        'Built it with a small team.',
        'Engineer, Beta (2017 – 2020)',
      ]);

      expect(first?.[1]).toBe(
        'Engineer, Acme (2020 – 2023)\n- Shipped the billing service\nBuilt it with a small team.',
      );
      expect(second?.[1]).toBe('Engineer, Beta (2017 – 2020)');
    });

    it('pulls at most two lines above the dates and none across a blank line', () => {
      const found = experience([
        'Engineer, Acme (2020 – 2023)',
        '',
        'Stray line',
        'Team',
        'Group',
        'Mar 2017 – Jan 2020',
      ]);

      expect(found[1]?.[1]).toBe('Team\nGroup\nMar 2017 – Jan 2020');
      expect(found[0]?.[1]).toBe('Engineer, Acme (2020 – 2023)\n\nStray line');
    });

    it('does not split education or skills at dates', () => {
      const sections = resume(
        [
          'EDUCATION',
          'BSc, KNU, 2014 - 2018',
          'MSc, KNU, 2018 - 2020',
          'SKILLS',
          'Go 2019 - 2024',
        ].join('\n'),
      );

      expect(sections.map((s) => s.title)).toEqual([null, null]);
      expect(sections).toHaveLength(2);
    });

    it('keeps the title and the heading when a role runs over a page break', () => {
      const sections = splitIntoSections('resume', [
        { page: 1, text: 'EXPERIENCE\nEngineer, Acme (2020 – 2023)\n- First' },
        { page: 2, text: '- Second\nEngineer, Beta (2017 – 2020)' },
      ]);

      expect(sections.map((s) => [s.heading, s.title, s.page, s.text])).toEqual([
        ['EXPERIENCE', 'Engineer, Acme (2020 – 2023)', 1, 'Engineer, Acme (2020 – 2023)\n- First'],
        ['EXPERIENCE', 'Engineer, Acme (2020 – 2023)', 2, '- Second'],
        ['EXPERIENCE', 'Engineer, Beta (2017 – 2020)', 2, 'Engineer, Beta (2017 – 2020)'],
      ]);
    });
  });
});

describe('splitting a job posting into sections', () => {
  it('reads the usual headings of a posting', () => {
    const sections = job(
      [
        'Backend Engineer at Acme',
        'About the role',
        'Join us.',
        "What you'll do:",
        '- Own billing',
        'Requirements',
        '- 5+ years of Node',
        'Nice to have',
        '- Kubernetes',
        'Benefits',
        '- Remote',
      ].join('\n'),
    );

    expect(names(sections)).toEqual([
      ['summary', null],
      ['summary', 'About the role'],
      ['responsibilities', "What you'll do"],
      ['requirements', 'Requirements'],
      ['nice_to_have', 'Nice to have'],
      ['other', 'Benefits'],
    ]);
  });

  it.each([
    ['What you’ll need', 'requirements'],
    ['Who you are', 'requirements'],
    ['Qualifications', 'requirements'],
    ['Minimum Qualifications', 'requirements'],
    ['Preferred Qualifications', 'nice_to_have'],
    ['Bonus points', 'nice_to_have'],
    ['Good to have', 'nice_to_have'],
    ['Key Responsibilities', 'responsibilities'],
    ['What you will do', 'responsibilities'],
    ['Experience', 'requirements'],
    ['What we offer', 'other'],
    ['About us', 'summary'],
  ])('understands "%s" as %s', (heading, section) => {
    const [, found] = job(`Title\n${heading}\n- text`);

    expect(found).toMatchObject({ section, heading, text: '- text' });
  });

  it('takes a requirement written after the colon', () => {
    const sections = job('Title\nRequirements: 5+ years of Node\nPreferred: Kubernetes');

    expect(sections.map((s) => [s.section, s.text])).toEqual([
      ['summary', 'Title'],
      ['requirements', '5+ years of Node'],
      ['nice_to_have', 'Kubernetes'],
    ]);
  });

  it('keeps a requirement that looks like a heading inside its list', () => {
    const sections = job('Requirements\n- Experience\n- Bonus\nExperience with Node');

    expect(sections).toHaveLength(1);
    expect(sections[0]?.text).toBe('- Experience\n- Bonus\nExperience with Node');
  });

  it('does not split a posting at date ranges', () => {
    const sections = job(
      'Requirements\nEngineer 2015 - 2018 style experience\nMar 2020 – Jan 2021',
    );

    expect(sections).toHaveLength(1);
    expect(sections[0]?.title).toBeNull();
  });

  it('treats a posting without headings as one section per page', () => {
    const sections = job('We need a backend engineer.\nApply now.');

    expect(sections.map((s) => [s.section, s.heading])).toEqual([['other', null]]);
  });
});
