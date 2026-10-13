import type { TextSegment } from '../documents/extract.js';
import type { CareerSection } from './types.js';

export type CareerKind = 'resume' | 'job_posting';

export interface TextSection {
  section: CareerSection;
  heading: string | null;
  title: string | null;
  page: number | null;
  text: string;
}

interface Line {
  text: string;
  page: number | null;
}

type HeadingTable = Array<[CareerSection, string[]]>;

const RESUME_HEADINGS: HeadingTable = [
  [
    'summary',
    [
      'summary',
      'professional summary',
      'career summary',
      'executive summary',
      'profile',
      'professional profile',
      'personal profile',
      'objective',
      'career objective',
      'about',
      'about me',
    ],
  ],
  [
    'experience',
    [
      'experience',
      'work experience',
      'professional experience',
      'relevant experience',
      'employment',
      'employment history',
      'work history',
      'career history',
      'professional background',
    ],
  ],
  [
    'skills',
    [
      'skills',
      'technical skills',
      'key skills',
      'core skills',
      'core competencies',
      'competencies',
      'technologies',
      'tech stack',
      'technical expertise',
      'skills and tools',
      'skills and technologies',
      'tools and technologies',
      'technical skills and tools',
    ],
  ],
  [
    'education',
    [
      'education',
      'education and training',
      'academic background',
      'certifications',
      'certificates',
      'courses',
      'training',
      'education and certifications',
      'certifications and courses',
    ],
  ],
  [
    'other',
    [
      'projects',
      'personal projects',
      'selected projects',
      'open source',
      'languages',
      'interests',
      'hobbies',
      'awards',
      'achievements',
      'publications',
      'volunteering',
      'volunteer experience',
      'references',
      'additional information',
    ],
  ],
];

const JOB_HEADINGS: HeadingTable = [
  [
    'summary',
    [
      'summary',
      'overview',
      'role overview',
      'job description',
      'job summary',
      'position summary',
      'about',
      'about the role',
      'about the job',
      'about the position',
      'about us',
      'about the company',
      'who we are',
      'company',
      'the role',
    ],
  ],
  [
    'responsibilities',
    [
      'responsibilities',
      'key responsibilities',
      'main responsibilities',
      'your responsibilities',
      'role and responsibilities',
      'duties',
      'main duties',
      'day to day',
      'your role',
      'what you will do',
      'what youll do',
      'in this role you will',
      'you will',
    ],
  ],
  [
    'requirements',
    [
      'requirements',
      'key requirements',
      'minimum requirements',
      'basic qualifications',
      'minimum qualifications',
      'required qualifications',
      'required skills',
      'qualifications',
      'essential',
      'must have',
      'must haves',
      'what you need',
      'what you will need',
      'what youll need',
      'what we are looking for',
      'what were looking for',
      'who you are',
      'you have',
      'you bring',
      'what you bring',
      'your profile',
      'skills and experience',
      'skills and qualifications',
      'requirements and skills',
      'experience',
    ],
  ],
  [
    'nice_to_have',
    [
      'nice to have',
      'nice to haves',
      'bonus',
      'bonus points',
      'preferred',
      'preferred qualifications',
      'preferred skills',
      'desirable',
      'good to have',
      'a plus',
      'plus',
      'pluses',
      'extra credit',
    ],
  ],
  [
    'other',
    [
      'benefits',
      'what we offer',
      'perks',
      'compensation',
      'compensation and benefits',
      'salary',
      'tech stack',
      'our stack',
      'our values',
      'how to apply',
      'application process',
      'equal opportunity',
      'diversity',
    ],
  ],
];

const TABLES: Record<CareerKind, Map<string, CareerSection>> = {
  resume: toLookup(RESUME_HEADINGS),
  job_posting: toLookup(JOB_HEADINGS),
};

function toLookup(table: HeadingTable): Map<string, CareerSection> {
  return new Map(
    table.flatMap(([section, names]) => names.map((name) => [name, section] as const)),
  );
}

const MARKDOWN_HEADING = /^#{1,6}\s+(.+?)\s*#*$/;
const BOLD_HEADING = /^(?:\*\*|__)(.+?)(?:\*\*|__)\s*:?$/;
const LABEL_WITH_COLON = /^([^:]{2,60}):\s*(.*)$/;
const RULE_LINE = /^\s*([=_*-])\1{2,}\s*$/;
const BULLET = /^\s*(?:[-•*·▪●‣◦]|\d{1,2}[.)])\s+/;
const MAX_HEADER_LINE_LENGTH = 100;
const MAX_HEADER_LINES_ABOVE_DATES = 2;
const MAX_TITLE_LENGTH = 160;

const MONTH =
  '(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\.?';
const YEAR = '(?:19|20)\\d{2}';
const POINT_IN_TIME = `(?:${MONTH}\\s+${YEAR}|${YEAR}[-/.](?:0[1-9]|1[0-2])|(?:0?[1-9]|1[0-2])[-/.]${YEAR}|${YEAR})`;
const DATE_RANGE = new RegExp(
  `(?<![\\w])${POINT_IN_TIME}\\s*(?:-|–|—|to|until)\\s*(?:${POINT_IN_TIME}|present|current|now|today|ongoing)(?![\\w])`,
  'i',
);

function normalizeHeading(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/['’]/g, '')
    .replace(/[^a-z\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

interface Heading {
  section: CareerSection;
  label: string;
  rest: string;
  known: boolean;
}

function readHeading(kind: CareerKind, line: string): Heading | null {
  const trimmed = line.trim();
  if (trimmed === '' || BULLET.test(trimmed)) return null;
  const table = TABLES[kind];
  const known = (label: string) => table.get(normalizeHeading(label));

  const markdown = MARKDOWN_HEADING.exec(trimmed) ?? BOLD_HEADING.exec(trimmed);
  if (markdown) {
    const label = markdown[1]!.replace(/:$/, '').trim();
    const section = known(label);
    return { section: section ?? 'other', label, rest: '', known: section !== undefined };
  }

  const withColon = LABEL_WITH_COLON.exec(trimmed);
  if (withColon) {
    const label = withColon[1]!.trim();
    const section = known(label);
    return section ? { section, label, rest: withColon[2]!.trim(), known: true } : null;
  }

  if (/[.,;]$/.test(trimmed)) return null;
  const section = known(trimmed);
  return section ? { section, label: trimmed, rest: '', known: true } : null;
}

function isHeaderLike(line: string): boolean {
  const trimmed = line.trim();
  return (
    trimmed !== '' &&
    trimmed.length <= MAX_HEADER_LINE_LENGTH &&
    !BULLET.test(trimmed) &&
    !/[.;]$/.test(trimmed)
  );
}

interface Entry {
  title: string | null;
  lines: Line[];
}

function entryTitle(lines: Line[]): string {
  return lines
    .map((line) => line.text.trim().replace(BULLET, ''))
    .filter((text) => text !== '')
    .join(' · ')
    .slice(0, MAX_TITLE_LENGTH);
}

function splitEntries(lines: Line[]): Entry[] {
  const dateLines = lines.flatMap((line, i) => (DATE_RANGE.test(line.text) ? [i] : []));
  if (dateLines.length === 0) return [{ title: null, lines }];

  const starts = dateLines.map((dateLine, n) => {
    const floor = n === 0 ? -1 : dateLines[n - 1]!;
    let start = dateLine;
    while (
      dateLine - start < MAX_HEADER_LINES_ABOVE_DATES &&
      start - 1 > floor &&
      isHeaderLike(lines[start - 1]!.text)
    ) {
      start--;
    }
    return start;
  });

  const entries: Entry[] = [];
  const preface = lines.slice(0, starts[0]);
  if (preface.some((line) => line.text.trim() !== '')) {
    entries.push({ title: null, lines: preface });
  }
  starts.forEach((start, n) => {
    const end = starts[n + 1] ?? lines.length;
    entries.push({
      title: entryTitle(lines.slice(start, dateLines[n]! + 1)),
      lines: lines.slice(start, end),
    });
  });
  return entries;
}

function piecesByPage(lines: Line[]): Line[][] {
  const pieces: Line[][] = [];
  let current: Line[] = [];
  let currentPage: number | null | undefined;
  for (const line of lines) {
    const isBlank = line.text.trim() === '';
    if (!isBlank && currentPage !== undefined && line.page !== currentPage) {
      pieces.push(current);
      current = [];
    }
    if (!isBlank) currentPage = line.page;
    current.push(line);
  }
  pieces.push(current);
  return pieces;
}

function toText(lines: Line[]): string {
  return lines
    .map((line) => line.text.trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function firstPage(lines: Line[]): number | null {
  return lines.find((line) => line.text.trim() !== '')?.page ?? null;
}

interface Block {
  section: CareerSection;
  heading: string | null;
  lines: Line[];
}

export function splitIntoSections(kind: CareerKind, segments: TextSegment[]): TextSection[] {
  const blocks: Block[] = [{ section: 'summary', heading: null, lines: [] }];

  for (const segment of segments) {
    for (const text of segment.text.split('\n')) {
      if (RULE_LINE.test(text)) continue;
      const heading = readHeading(kind, text);
      const isTitle =
        heading !== null &&
        !heading.known &&
        blocks.length === 1 &&
        blocks[0]!.lines.every((line) => line.text.trim() === '');
      if (heading && isTitle) {
        blocks[0]!.lines.push({ text: heading.label, page: segment.page });
        continue;
      }
      if (heading) {
        blocks.push({ section: heading.section, heading: heading.label, lines: [] });
        if (heading.rest !== '')
          blocks.at(-1)!.lines.push({ text: heading.rest, page: segment.page });
        continue;
      }
      blocks.at(-1)!.lines.push({ text, page: segment.page });
    }
  }

  const headed = blocks.length > 1;
  const sections: TextSection[] = [];
  for (const block of blocks) {
    const section = headed ? block.section : 'other';
    const entries =
      block.section === 'experience'
        ? splitEntries(block.lines)
        : [{ title: null, lines: block.lines }];
    for (const entry of entries) {
      for (const piece of piecesByPage(entry.lines)) {
        const text = toText(piece);
        if (text === '') continue;
        sections.push({
          section,
          heading: block.heading,
          title: entry.title,
          page: firstPage(piece),
          text,
        });
      }
    }
  }
  return sections;
}
