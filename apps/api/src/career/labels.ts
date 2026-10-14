import { stripInvisibleCharacters } from '../rag/sanitize.js';
import type { CareerSection } from './types.js';

export const MAX_LABEL_LENGTH = 120;

const SECTION_LABELS: Record<CareerSection, string> = {
  summary: 'Summary',
  experience: 'Experience',
  skills: 'Skills',
  education: 'Education',
  requirements: 'Requirements',
  nice_to_have: 'Nice to have',
  responsibilities: 'Responsibilities',
  profile: 'Profile',
  fit: 'Fit analysis',
  overview: 'Overview',
  other: '',
};

export function cleanLabel(raw: string, maxLength = MAX_LABEL_LENGTH): string {
  const flat = stripInvisibleCharacters(raw).replace(/\s+/g, ' ').trim();
  return flat.length <= maxLength ? flat : `${flat.slice(0, maxLength - 1).trimEnd()}…`;
}

export function sectionLabel(section: CareerSection, heading: string | null): string {
  const fixed = SECTION_LABELS[section];
  if (fixed !== '') return fixed;
  return heading === null ? '' : cleanLabel(heading, 60);
}

export function careerLabel(document: {
  kind: string;
  filename: string;
  jobNumber: number | null;
}): string {
  if (document.kind === 'resume') return 'Resume';
  const name = cleanLabel(document.filename);
  return document.jobNumber === null ? name : `Job #${document.jobNumber} · ${name}`;
}
