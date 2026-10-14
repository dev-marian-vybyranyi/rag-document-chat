import { api } from '../../lib/api';
import type { FitSummary, ProfileSummary } from '../documents/api';

export type RequirementStatus = 'met' | 'partial' | 'not_shown';
export type RequirementImportance = 'must' | 'nice';

export interface FitRequirement {
  requirementId: string;
  text: string;
  skill: string;
  importance: RequirementImportance;
  status: RequirementStatus;
  quote: string | null;
  note: string;
}

export interface Fit extends FitSummary {
  resumeId: string;
  analyzedAt: string;
  requirements: FitRequirement[];
}

export interface Posting {
  id: string;
  jobNumber: number | null;
  filename: string;
  status: 'processing' | 'ready' | 'failed';
  error: string | null;
  profile: ProfileSummary | null;
  fit: Fit | null;
}

export interface SharedGap {
  label: string;
  postings: number;
  musts: number;
}

export interface CareerOverview {
  resume: {
    id: string;
    filename: string;
    status: 'processing' | 'ready' | 'failed';
    error: string | null;
    profile: ProfileSummary | null;
  } | null;
  postings: Posting[];
  compared: number;
  gaps: SharedGap[];
}

export const careerApi = {
  overview: (signal?: AbortSignal) => api<CareerOverview>('/career/overview', { signal }),
};
