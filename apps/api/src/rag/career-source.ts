import type { CareerSection } from '../career/types.js';

export interface CareerSource {
  role: 'resume' | 'job_posting';
  section: CareerSection | null;
  jobNumber: number | null;
}
