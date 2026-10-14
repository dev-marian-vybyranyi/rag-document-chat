import { careerLabel } from './labels.js';

export interface JobFacts {
  id: string;
  jobNumber: number;
  name: string;
  title: string | null;
  company: string | null;
}

const ORDINALS: Record<string, number> = {
  first: 1,
  second: 2,
  third: 3,
  fourth: 4,
  fifth: 5,
  sixth: 6,
  seventh: 7,
  eighth: 8,
  ninth: 9,
  tenth: 10,
};

const POSTING_WORDS = String.raw`(?:jobs?|postings?|vacanc(?:y|ies))`;
const ROLE_WORDS = String.raw`(?:jobs?|postings?|vacanc(?:y|ies)|positions?|roles?|offers?|openings?|listings?)`;
const NOT_A_DURATION = String.raw`(?!\d)(?!\s*(?:years?|yrs?|months?|%))`;
const NUMBER = String.raw`(?:#\s*|no\.?\s*|number\s+)?\d{1,3}${NOT_A_DURATION}`;
const MORE_NUMBERS = String.raw`(?:\s*(?:,|and|&|or)\s*#?\d{1,3}${NOT_A_DURATION})*`;

const NUMBERED_POSTING = new RegExp(
  String.raw`\b${POSTING_WORDS}\s*${NUMBER}${MORE_NUMBERS}`,
  'gi',
);
const NUMBERED_ROLE = new RegExp(
  String.raw`\b${ROLE_WORDS}\s*#\s*\d{1,3}${NOT_A_DURATION}${MORE_NUMBERS}`,
  'gi',
);
const ORDINAL_POSTING = new RegExp(
  String.raw`\b(${Object.keys(ORDINALS).join('|')})\s+${ROLE_WORDS}\b`,
  'gi',
);
const DIGITS = /\d{1,3}/g;

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function numbersIn(query: string): Set<number> {
  const found = new Set<number>();
  for (const pattern of [NUMBERED_POSTING, NUMBERED_ROLE]) {
    for (const match of query.matchAll(pattern)) {
      const digits = match[0].replace(/^\D+/, '');
      for (const digit of digits.match(DIGITS) ?? []) found.add(Number(digit));
    }
  }
  for (const match of query.matchAll(ORDINAL_POSTING)) {
    found.add(ORDINALS[match[1]!.toLowerCase()]!);
  }
  return found;
}

function mentions(query: string, name: string | null): boolean {
  if (name === null) return false;
  const words = name.trim().split(/\s+/);
  if (words.join(' ').length < 3) return false;
  const phrase = words.map(escapeRegExp).join(String.raw`\s+`);
  const pattern = new RegExp(String.raw`(?<![\p{L}\p{N}])${phrase}(?![\p{L}\p{N}])`, 'giu');
  const single = words.length === 1;
  for (const match of query.matchAll(pattern)) {
    if (!single) return true;
    const first = match[0][0]!;
    if (first === first.toLocaleUpperCase() && first !== first.toLocaleLowerCase()) return true;
  }
  return false;
}

export function detectJobs(query: string, jobs: JobFacts[]): JobFacts[] {
  if (jobs.length === 0) return [];
  const numbers = numbersIn(query);
  return jobs
    .filter(
      (job) =>
        numbers.has(job.jobNumber) ||
        mentions(query, job.company) ||
        mentions(query, job.title) ||
        mentions(query, job.name),
    )
    .sort((a, b) => a.jobNumber - b.jobNumber);
}

export function describeJob(job: JobFacts): string {
  return careerLabel({ kind: 'job_posting', filename: job.name, jobNumber: job.jobNumber });
}
