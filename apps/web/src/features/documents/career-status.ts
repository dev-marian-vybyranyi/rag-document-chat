import type { DocumentItem, FitSummary, IngestionProgress } from './api';

export const SKILLS_SHOWN = 8;

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

export const isCareer = (document: DocumentItem): boolean =>
  document.kind === 'resume' || document.kind === 'job_posting';

export function careerTitle(document: DocumentItem): string {
  if (document.kind === 'resume') return 'Resume';
  return document.jobNumber === null
    ? document.filename
    : `Job #${document.jobNumber} · ${document.filename}`;
}

export function describeCareerProgress(
  document: DocumentItem,
  progress: IngestionProgress | null = document.progress,
): string {
  if (!progress) return 'Processing…';
  const what = document.kind === 'resume' ? 'resume' : 'job posting';
  switch (progress.phase) {
    case 'reading':
      return 'Reading the file…';
    case 'analyzing':
      return `Analysing the ${what}…`;
    case 'embedding':
      return progress.total > 0
        ? `Indexing: ${progress.done} of ${plural(progress.total, 'passage')}`
        : 'Indexing…';
    default:
      return 'Processing…';
  }
}

export function describeYears(years: number): string {
  const rounded = Math.round(years * 10) / 10;
  const text = Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
  return `${text} ${rounded === 1 ? 'year' : 'years'} of experience`;
}

export function describeCareerStatus(document: DocumentItem): string {
  if (document.status === 'processing') return describeCareerProgress(document);
  if (document.status === 'failed') return 'Failed';
  const { profile } = document;
  const parts = [plural(document.chunkCount, 'passage')];
  if (profile?.role === 'resume') {
    if (profile.totalExperienceYears !== null)
      parts.push(describeYears(profile.totalExperienceYears));
    if (profile.skills.length > 0) parts.push(plural(profile.skills.length, 'skill'));
  }
  if (profile?.role === 'job') parts.push(plural(profile.requirementCount, 'requirement'));
  return parts.join(' · ');
}

export function shownSkills(skills: string[]): { shown: string[]; more: number } {
  const unique = [...new Set(skills)];
  return { shown: unique.slice(0, SKILLS_SHOWN), more: Math.max(0, unique.length - SKILLS_SHOWN) };
}

export function describeFit(fit: FitSummary): string {
  const musts = fit.mustCoverage === null ? '' : ` · ${fit.mustCoverage}% of the must-haves`;
  return `${fit.coverage}% of the requirements shown in the resume${musts}`;
}

export type JobState =
  | { kind: 'not_analysed' }
  | { kind: 'no_requirements' }
  | { kind: 'fit'; fit: FitSummary }
  | { kind: 'no_resume' }
  | { kind: 'waiting_for_resume' }
  | { kind: 'comparing' }
  | { kind: 'not_compared' };

export function jobState(
  job: DocumentItem,
  documents: DocumentItem[],
  comparingIds: string[],
): JobState | null {
  if (job.kind !== 'job_posting' || job.status !== 'ready') return null;
  if (job.profile === null || job.profile.role !== 'job') return { kind: 'not_analysed' };
  if (job.profile.requirementCount === 0) return { kind: 'no_requirements' };
  if (job.fit !== null) return { kind: 'fit', fit: job.fit };
  const resume = documents.find((document) => document.kind === 'resume');
  if (!resume || resume.status === 'failed') return { kind: 'no_resume' };
  if (resume.status === 'processing') return { kind: 'waiting_for_resume' };
  return comparingIds.includes(job.id) ? { kind: 'comparing' } : { kind: 'not_compared' };
}

export function awaitsFit(job: DocumentItem, documents: DocumentItem[]): boolean {
  if (job.kind !== 'job_posting' || job.status !== 'ready' || job.fit !== null) return false;
  if (job.profile === null || job.profile.role !== 'job' || job.profile.requirementCount === 0) {
    return false;
  }
  return documents.some((document) => document.kind === 'resume' && document.status === 'ready');
}
