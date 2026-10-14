import type { CareerOverview, FitRequirement, Posting, RequirementStatus, SharedGap } from './api';

export type SortOrder = 'fit' | 'number';

export const STATUS_LABEL: Record<RequirementStatus, string> = {
  met: 'Shown',
  partial: 'Partly shown',
  not_shown: 'Not shown in the resume',
};

export const IMPORTANCE_LABEL = { must: 'Must have', nice: 'Nice to have' } as const;

export function postingTitle(posting: Posting): string {
  return posting.jobNumber === null
    ? posting.filename
    : `Job #${posting.jobNumber} · ${posting.filename}`;
}

export function sortPostings(postings: Posting[], order: SortOrder): Posting[] {
  const byNumber = (a: Posting, b: Posting) =>
    (a.jobNumber ?? Infinity) - (b.jobNumber ?? Infinity);
  if (order === 'number') return [...postings].sort(byNumber);
  return [...postings].sort((a, b) => {
    const fitA = a.fit?.coverage ?? -1;
    const fitB = b.fit?.coverage ?? -1;
    return (
      fitB - fitA || (b.fit?.mustCoverage ?? -1) - (a.fit?.mustCoverage ?? -1) || byNumber(a, b)
    );
  });
}

export function rankOf(posting: Posting, postings: Posting[]): number | null {
  if (posting.fit === null) return null;
  return (
    sortPostings(postings, 'fit')
      .filter((p) => p.fit !== null)
      .indexOf(posting) + 1
  );
}

export function describeGap(gap: SharedGap, compared: number): string {
  const musts = gap.musts === 0 ? '' : ` (a must in ${gap.musts})`;
  return `${gap.label}: not fully shown in ${gap.postings} of ${compared} postings${musts}`;
}

export function orderRequirements(requirements: FitRequirement[]) {
  const order: Record<RequirementStatus, number> = { not_shown: 0, partial: 1, met: 2 };
  return [...requirements].sort(
    (a, b) =>
      order[a.status] - order[b.status] ||
      (a.importance === b.importance ? 0 : a.importance === 'must' ? -1 : 1),
  );
}

export function awaitsFit(posting: Posting, resume: CareerOverview['resume']): boolean {
  return (
    resume?.status === 'ready' &&
    posting.status === 'ready' &&
    posting.fit === null &&
    posting.profile?.role === 'job' &&
    posting.profile.requirementCount > 0
  );
}

export function pendingIds({ resume, postings }: CareerOverview): string[] {
  return [
    ...(resume?.status === 'processing' ? [resume.id] : []),
    ...postings
      .filter((posting) => posting.status === 'processing' || awaitsFit(posting, resume))
      .map((posting) => posting.id),
  ];
}

export function askAboutJob(posting: Posting): string {
  return posting.jobNumber === null
    ? 'How does my experience align with this job?'
    : `How does my experience align with Job #${posting.jobNumber}?`;
}
