export interface CareerLimits {
  maxResumeBytes: number;
  maxResumeCharacters: number;
  maxResumePages: number;
  maxJobBytes: number;
  maxJobCharacters: number;
  maxJobs: number;
}

export const defaultCareerLimits: CareerLimits = {
  maxResumeBytes: 5 * 1024 * 1024,
  maxResumeCharacters: 40_000,
  maxResumePages: 10,
  maxJobBytes: 1_000_000,
  maxJobCharacters: 25_000,
  maxJobs: 10,
};
