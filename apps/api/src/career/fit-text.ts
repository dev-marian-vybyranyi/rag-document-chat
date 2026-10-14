import { normalizeForMatch } from '../meetings/notes.js';
import { cleanLabel } from './labels.js';
import type { TextSection } from './sections.js';
import type { Fit, FitRequirement } from './types.js';
import { groupByStatus } from './coverage.js';

export const MAX_OVERVIEW_GAPS = 12;

export interface ComparedPosting {
  jobNumber: number | null;
  name: string;
  fit: Fit;
}

export interface UncomparedPosting {
  jobNumber: number | null;
  name: string;
}

const importanceName = (requirement: FitRequirement) =>
  requirement.importance === 'must' ? 'must' : 'nice to have';

const STATUS_NAME = {
  met: 'Shown in the resume',
  partial: 'Only partly shown in the resume',
  not_shown: 'Not shown in the resume',
} as const;

function requirementLine(requirement: FitRequirement): string {
  const parts = [
    `- ${STATUS_NAME[requirement.status]}: ${requirement.text} (${importanceName(requirement)}).`,
  ];
  if (requirement.note !== '') parts.push(requirement.note);
  if (requirement.quote !== null) parts.push(`The resume says: "${requirement.quote}"`);
  return parts.join(' ');
}

function coverageLine(fit: Fit): string {
  const musts = fit.mustCoverage === null ? '' : `, and ${fit.mustCoverage}% of the must-haves`;
  return `The resume covers ${fit.coverage}% of the requirements of this posting, weighted (a must counts three times as much as a nice to have)${musts}.`;
}

export function fitSections(fit: Fit): TextSection[] {
  const { met, partial, notShown } = groupByStatus(fit.requirements);
  const section = (title: string, lines: string[]): TextSection => ({
    section: 'fit',
    heading: null,
    title,
    page: null,
    text: lines.join('\n'),
  });

  const sections: TextSection[] = [];
  if (met.length > 0) {
    sections.push(
      section('Strengths', [
        `Strengths of the resume for this posting: what it shows. ${coverageLine(fit)}`,
        ...met.map(requirementLine),
      ]),
    );
  }
  if (partial.length + notShown.length > 0) {
    sections.push(
      section('Gaps', [
        `Gaps of the resume for this posting: skills and requirements that are missing, not shown or only partly shown. Not shown means the resume does not mention it; the candidate may have it and not have written it down. ${coverageLine(fit)}`,
        ...notShown.map(requirementLine),
        ...partial.map(requirementLine),
      ]),
    );
  }
  return sections;
}

const postingName = (posting: UncomparedPosting) =>
  posting.jobNumber === null
    ? cleanLabel(posting.name)
    : `Job #${posting.jobNumber} (${cleanLabel(posting.name)})`;

export function byFitness(a: ComparedPosting, b: ComparedPosting): number {
  return (
    b.fit.coverage - a.fit.coverage ||
    (b.fit.mustCoverage ?? -1) - (a.fit.mustCoverage ?? -1) ||
    (a.jobNumber ?? Infinity) - (b.jobNumber ?? Infinity)
  );
}

export interface SharedGap {
  label: string;
  postings: number;
  musts: number;
}

export function sharedGaps(compared: ComparedPosting[]): SharedGap[] {
  const gaps = new Map<string, SharedGap>();
  for (const { fit } of compared) {
    const seen = new Set<string>();
    for (const requirement of fit.requirements) {
      if (requirement.status === 'met') continue;
      const key = normalizeForMatch(requirement.skill);
      if (key === '' || seen.has(key)) continue;
      seen.add(key);
      const gap = gaps.get(key) ?? { label: cleanLabel(requirement.skill), postings: 0, musts: 0 };
      gap.postings++;
      if (requirement.importance === 'must') gap.musts++;
      gaps.set(key, gap);
    }
  }
  return [...gaps.values()]
    .sort(
      (a, b) =>
        b.postings - a.postings || b.musts - a.musts || a.label.localeCompare(b.label, 'en'),
    )
    .slice(0, MAX_OVERVIEW_GAPS);
}

export function overviewSections(
  compared: ComparedPosting[],
  uncompared: UncomparedPosting[] = [],
): TextSection[] {
  if (compared.length === 0) return [];

  const ranked = [...compared].sort(byFitness);
  const lines = [
    'Overview of all job postings compared with this resume. Which job fits best and what to learn first.',
    'Ranking of the postings by how much of their requirements the resume covers, weighted:',
    ...ranked.map((posting, i) => {
      const musts =
        posting.fit.mustCoverage === null ? '' : `, ${posting.fit.mustCoverage}% of the must-haves`;
      return `- Rank ${i + 1}: ${postingName(posting)}: ${posting.fit.coverage}%${musts}.`;
    }),
  ];

  const gaps = sharedGaps(compared);
  if (gaps.length > 0) {
    lines.push(
      `Skills and requirements missing or only partly shown in the resume, across the ${compared.length} compared postings:`,
    );
    for (const gap of gaps) {
      const musts = gap.musts === 0 ? '' : `, a must in ${gap.musts}`;
      lines.push(
        `- Gap across postings: ${gap.label} is not fully shown in ${gap.postings} of ${compared.length} postings${musts}.`,
      );
    }
  }
  if (uncompared.length > 0) {
    lines.push(`Not compared yet: ${uncompared.map(postingName).join(', ')}.`);
  }

  return [{ section: 'overview', heading: null, title: null, page: null, text: lines.join('\n') }];
}
