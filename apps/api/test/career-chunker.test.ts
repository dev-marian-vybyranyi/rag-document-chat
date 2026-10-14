import { describe, expect, it } from 'vitest';
import { CAREER_MAX_CHARS, chunkSections } from '../src/career/chunker.js';
import { cleanLabel, sectionLabel } from '../src/career/labels.js';
import { splitIntoSections, type TextSection } from '../src/career/sections.js';

const section = (overrides: Partial<TextSection> & { text: string }): TextSection => ({
  section: 'skills',
  heading: 'Skills',
  title: null,
  page: null,
  ...overrides,
});

const chunkResume = (text: string, maxChars?: number) =>
  chunkSections(splitIntoSections('resume', [{ page: null, text }]), {
    label: 'Resume',
    ...(maxChars !== undefined && { maxChars }),
  });

const bodyOf = (content: string) => content.slice(content.indexOf('\n') + 1);

describe('chunking sections', () => {
  describe('the context line', () => {
    it('names the source and the section at the top of every chunk', () => {
      const chunks = chunkResume('Alex\nSKILLS\nGo\nEDUCATION\nBSc');

      expect(chunks.map((c) => c.content)).toEqual([
        'Resume · Summary\nAlex',
        'Resume · Skills\nGo',
        'Resume · Education\nBSc',
      ]);
    });

    it('adds the role to the context line of a role', () => {
      const [, role] = chunkResume(
        'Alex\nEXPERIENCE\nSenior Engineer, Acme (2021-03 – 2024-06)\n- Cut latency',
      );

      expect(role?.content).toBe(
        'Resume · Experience · Senior Engineer, Acme (2021-03 – 2024-06)\nSenior Engineer, Acme (2021-03 – 2024-06)\n- Cut latency',
      );
    });

    it('names a job posting by the label the caller gives', () => {
      const chunks = chunkSections(
        splitIntoSections('job_posting', [
          { page: null, text: 'Title\nRequirements\n- 5 years of Node\nNice to have\n- Go' },
        ]),
        { label: 'Job #2 · Backend Engineer' },
      );

      expect(chunks.map((c) => c.content.split('\n')[0])).toEqual([
        'Job #2 · Backend Engineer · Summary',
        'Job #2 · Backend Engineer · Requirements',
        'Job #2 · Backend Engineer · Nice to have',
      ]);
    });

    it('uses the heading of an other section, and nothing when there is none', () => {
      const named = chunkSections([section({ section: 'other', heading: 'Projects', text: 'x' })], {
        label: 'Resume',
      });
      const bare = chunkSections([section({ section: 'other', heading: null, text: 'x' })], {
        label: 'Resume',
      });

      expect(named[0]?.content).toBe('Resume · Projects\nx');
      expect(bare[0]?.content).toBe('Resume\nx');
    });

    it('cleans and shortens a label that came from a file name', () => {
      const chunks = chunkSections([section({ text: 'x' })], {
        label: `  Back\u200bend\n${'y'.repeat(300)}  `,
      });
      const header = chunks[0]!.content.split('\n')[0]!;

      expect(header.startsWith('Backend ')).toBe(true);
      expect(header).not.toMatch(/[\u200b\n]/);
      expect(header.length).toBeLessThan(160);
    });
  });

  describe('sizing', () => {
    const role = (bullets: number) =>
      [
        'EXPERIENCE',
        'Senior Engineer, Acme (2021-03 – 2024-06)',
        ...Array.from(
          { length: bullets },
          (_, i) => `- Delivered result number ${i} for the payments platform team`,
        ),
      ].join('\n');

    it('keeps a role in one chunk when it fits', () => {
      expect(chunkResume(role(4)).filter((c) => c.section === 'experience')).toHaveLength(1);
    });

    it('splits a long role between bullets and repeats the role in every part', () => {
      const parts = chunkResume(role(30), 400).filter((c) => c.section === 'experience');

      expect(parts.length).toBeGreaterThan(3);
      for (const part of parts) {
        expect(part.content.startsWith('Resume · Experience · Senior Engineer, Acme')).toBe(true);
        expect(part.content.length).toBeLessThanOrEqual(400);
      }
      expect(parts.map((p) => bodyOf(p.content)).join('\n')).toContain('result number 29');
    });

    it('never splits inside a bullet that fits', () => {
      const parts = chunkResume(role(30), 400).filter((c) => c.section === 'experience');
      const bullets = parts.flatMap((p) =>
        bodyOf(p.content)
          .split('\n')
          .filter((l) => l.startsWith('- ')),
      );

      expect(bullets).toHaveLength(30);
      expect(
        bullets.every((b) =>
          /^- Delivered result number \d+ for the payments platform team$/.test(b),
        ),
      ).toBe(true);
    });

    it('cuts one very long line at sentence ends', () => {
      const sentence = 'The service handled the load. ';
      const [first, second, ...rest] = chunkResume(`Skills\n${sentence.repeat(60)}`, 300);

      expect(first!.content.length).toBeLessThanOrEqual(300);
      expect(second!.content.length).toBeLessThanOrEqual(300);
      expect(rest.length).toBeGreaterThan(0);
      expect(bodyOf(second!.content).startsWith('The service')).toBe(true);
    });

    it('cuts a line with no spaces at the limit', () => {
      const chunks = chunkResume(`Skills\n${'x'.repeat(2000)}`, 300);

      expect(chunks.length).toBeGreaterThan(6);
      expect(chunks.every((c) => c.content.length <= 300)).toBe(true);
      expect(chunks.map((c) => bodyOf(c.content)).join('')).toBe('x'.repeat(2000));
    });

    it('still makes progress when the context line alone is longer than the limit', () => {
      const chunks = chunkSections(
        [
          section({
            title: 'T'.repeat(150),
            text: 'one two three four five six seven eight nine ten',
          }),
        ],
        { label: 'Resume', maxChars: 100 },
      );

      expect(chunks.length).toBeGreaterThan(0);
      expect(chunks.map((c) => bodyOf(c.content)).join(' ')).toContain('ten');
    });

    it('fills a chunk right up to the limit and no further', () => {
      const exact = chunkResume(`Skills\n${'a'.repeat(19)}\n${'b'.repeat(20)}`, 56);
      const over = chunkResume(`Skills\n${'a'.repeat(19)}\n${'b'.repeat(21)}`, 56);

      expect(exact).toHaveLength(1);
      expect(exact[0]?.content).toHaveLength(56);
      expect(over).toHaveLength(2);
    });

    it('drops trailing spaces from lines it is given', () => {
      const [chunk] = chunkSections([section({ text: 'Go   \nRust \t' })], { label: 'Resume' });

      expect(chunk?.content).toBe('Resume · Skills\nGo\nRust');
    });

    it('uses 900 characters by default', () => {
      expect(CAREER_MAX_CHARS).toBe(900);
      const chunks = chunkResume(`Skills\n${'word '.repeat(1000)}`);

      expect(chunks.length).toBeGreaterThan(4);
      expect(chunks.every((c) => c.content.length <= CAREER_MAX_CHARS)).toBe(true);
    });
  });

  describe('what it keeps', () => {
    it('numbers chunks from zero in reading order and carries the section and the page', () => {
      const chunks = chunkSections(
        splitIntoSections('resume', [
          { page: 1, text: 'Alex\nEXPERIENCE\nEngineer, Acme (2020 – 2023)\n- First' },
          { page: 2, text: '- Second\nSKILLS\nGo' },
        ]),
        { label: 'Resume' },
      );

      expect(chunks.map((c) => [c.ordinal, c.section, c.page])).toEqual([
        [0, 'summary', 1],
        [1, 'experience', 1],
        [2, 'experience', 2],
        [3, 'skills', 2],
      ]);
    });

    it('estimates the tokens of the whole chunk, including the context line', () => {
      const [chunk] = chunkResume('Skills\n' + 'a'.repeat(80));

      expect(chunk!.tokenCount).toBe(Math.ceil(chunk!.content.length / 4));
    });

    it('keeps every word of the text, in order, across any chunk size', () => {
      const text = [
        'Alex Morgan',
        'Backend engineer with a long summary of what the work has been about over the years.',
        'EXPERIENCE',
        'Senior Engineer, Acme (2021-03 – 2024-06)',
        ...Array.from(
          { length: 12 },
          (_, i) => `- Built part ${i} of the system and tested it well.`,
        ),
        'Engineer, Beta (2018-01 – 2021-02)',
        '- Wrote services.',
        'SKILLS',
        'TypeScript, Go, PostgreSQL, Redis, Docker, Kubernetes, Terraform',
      ].join('\n');
      const words = (value: string) => value.split(/\s+/).filter(Boolean);
      const expected = words(
        splitIntoSections('resume', [{ page: null, text }])
          .map((s) => s.text)
          .join('\n'),
      );

      for (const maxChars of [60, 90, 150, 240, 400, 900]) {
        const got = chunkResume(text, maxChars).flatMap((c) => words(bodyOf(c.content)));
        expect(got).toEqual(expected);
      }
    });

    it('gives the same chunks for the same input', () => {
      const text = 'Alex\nSKILLS\nGo, Rust\nEDUCATION\nBSc';

      expect(chunkResume(text)).toEqual(chunkResume(text));
    });

    it('returns nothing for no sections or empty ones', () => {
      expect(chunkSections([], { label: 'Resume' })).toEqual([]);
      expect(chunkSections([section({ text: '  \n \n' })], { label: 'Resume' })).toEqual([]);
    });

    it('makes a single chunk of a tiny file', () => {
      const chunks = chunkResume('Just one line');

      expect(chunks).toHaveLength(1);
      expect(chunks[0]).toMatchObject({
        ordinal: 0,
        section: 'other',
        content: 'Resume\nJust one line',
      });
    });
  });
});

describe('labels', () => {
  it('names the fixed sections and falls back to the heading for others', () => {
    expect(sectionLabel('nice_to_have', null)).toBe('Nice to have');
    expect(sectionLabel('fit', null)).toBe('Fit analysis');
    expect(sectionLabel('other', 'Open source')).toBe('Open source');
    expect(sectionLabel('other', null)).toBe('');
    expect(sectionLabel('skills', 'TECH STACK')).toBe('Skills');
  });

  it('flattens, strips invisible characters and shortens', () => {
    expect(cleanLabel(' a\u202e b\n c ')).toBe('a b c');
    expect(cleanLabel('abcdef', 4)).toBe('abc…');
  });
});
