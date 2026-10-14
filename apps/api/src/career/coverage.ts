import type {
  Fit,
  FitRequirement,
  JobProfile,
  RequirementImportance,
  RequirementStatus,
} from './types.js';

export const EXPERIENCE_REQUIREMENT_ID = 'experience';
export const PARTIAL_EXPERIENCE_SHARE = 0.75;

export const IMPORTANCE_WEIGHT: Record<RequirementImportance, number> = { must: 3, nice: 1 };
export const STATUS_CREDIT: Record<RequirementStatus, number> = {
  met: 1,
  partial: 0.5,
  not_shown: 0,
};

export interface Judgement {
  requirementId: string;
  status: RequirementStatus;
  quote: string | null;
  note: string;
}

export interface Coverage {
  coverage: number;
  mustCoverage: number | null;
}

export interface AssembledFit {
  fit: Fit;
  downgraded: number;
}

export function experienceRequirement(
  minYears: number | null,
  resumeYears: number | null,
): FitRequirement | null {
  if (minYears === null) return null;
  const base = {
    requirementId: EXPERIENCE_REQUIREMENT_ID,
    text: `${minYears}+ years of professional experience`,
    skill: 'Years of experience',
    importance: 'must' as const,
    quote: null,
  };
  if (resumeYears === null) {
    return {
      ...base,
      status: 'not_shown',
      note: 'The roles in the resume have no dates to count years from.',
    };
  }
  const note = `The resume shows ${resumeYears} years, counted from the dates of its roles.`;
  if (resumeYears >= minYears) return { ...base, status: 'met', note };
  if (resumeYears >= minYears * PARTIAL_EXPERIENCE_SHARE)
    return { ...base, status: 'partial', note };
  return { ...base, status: 'not_shown', note };
}

export function computeCoverage(requirements: FitRequirement[]): Coverage | null {
  if (requirements.length === 0) return null;

  const share = (rows: FitRequirement[]) => {
    const total = rows.reduce((sum, row) => sum + IMPORTANCE_WEIGHT[row.importance], 0);
    const earned = rows.reduce(
      (sum, row) => sum + IMPORTANCE_WEIGHT[row.importance] * STATUS_CREDIT[row.status],
      0,
    );
    return Math.round((earned / total) * 100);
  };

  const musts = requirements.filter((row) => row.importance === 'must');
  return {
    coverage: share(requirements),
    mustCoverage: musts.length === 0 ? null : share(musts),
  };
}

export function assembleFit({
  job,
  judgements,
  resumeId,
  resumeYears,
  now = new Date(),
}: {
  job: JobProfile;
  judgements: Judgement[];
  resumeId: string;
  resumeYears: number | null;
  now?: Date;
}): AssembledFit | null {
  const byId = new Map<string, Judgement>();
  for (const judgement of judgements) {
    if (!byId.has(judgement.requirementId)) byId.set(judgement.requirementId, judgement);
  }

  let downgraded = 0;
  const rows = job.requirements.map((requirement): FitRequirement => {
    const judgement = byId.get(requirement.id);
    const quote = judgement?.quote?.trim() ? judgement.quote : null;
    const claimed = judgement?.status ?? 'not_shown';
    const proven = claimed === 'not_shown' || quote !== null;
    if (!proven) downgraded++;
    return {
      requirementId: requirement.id,
      text: requirement.text,
      skill: requirement.skill,
      importance: requirement.importance,
      status: proven ? claimed : 'not_shown',
      quote: proven && claimed !== 'not_shown' ? quote : null,
      note: judgement?.note ?? '',
    };
  });

  const experience = experienceRequirement(job.minYearsExperience, resumeYears);
  const requirements = experience === null ? rows : [experience, ...rows];
  const totals = computeCoverage(requirements);
  if (totals === null) return null;

  return {
    fit: { resumeId, analyzedAt: now.toISOString(), requirements, ...totals },
    downgraded,
  };
}

export interface GroupedRequirements {
  met: FitRequirement[];
  partial: FitRequirement[];
  notShown: FitRequirement[];
}

export function groupByStatus(requirements: FitRequirement[]): GroupedRequirements {
  const mustFirst = (rows: FitRequirement[]) => [
    ...rows.filter((row) => row.importance === 'must'),
    ...rows.filter((row) => row.importance === 'nice'),
  ];
  return {
    met: mustFirst(requirements.filter((row) => row.status === 'met')),
    partial: mustFirst(requirements.filter((row) => row.status === 'partial')),
    notShown: mustFirst(requirements.filter((row) => row.status === 'not_shown')),
  };
}
