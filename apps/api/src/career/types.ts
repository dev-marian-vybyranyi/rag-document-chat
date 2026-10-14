export type CareerSection =
  | 'summary'
  | 'experience'
  | 'skills'
  | 'education'
  | 'requirements'
  | 'nice_to_have'
  | 'responsibilities'
  | 'profile'
  | 'fit'
  | 'overview'
  | 'other';

export const GENERATED_SECTIONS: readonly CareerSection[] = ['profile', 'fit', 'overview'];

export const isGeneratedSection = (section: CareerSection | null): boolean =>
  section !== null && GENERATED_SECTIONS.includes(section);

export type RequirementImportance = 'must' | 'nice';

export type RequirementStatus = 'met' | 'partial' | 'not_shown';

export interface ResumeSkill {
  name: string;
  quote: string;
}

export interface ResumeRole {
  title: string;
  company: string;
  start: string | null;
  end: string | null;
  quote: string;
}

export interface ResumeEducation {
  institution: string;
  degree: string | null;
  quote: string;
}

export interface ResumeProfile {
  role: 'resume';
  headline: string | null;
  skills: ResumeSkill[];
  roles: ResumeRole[];
  education: ResumeEducation[];
  totalExperienceYears: number | null;
}

export interface JobRequirement {
  id: string;
  text: string;
  skill: string;
  importance: RequirementImportance;
  quote: string;
}

export interface JobProfile {
  role: 'job';
  title: string | null;
  company: string | null;
  minYearsExperience: number | null;
  requirements: JobRequirement[];
  responsibilities: string[];
}

export type CareerProfile = ResumeProfile | JobProfile;

export interface FitRequirement {
  requirementId: string;
  text: string;
  skill: string;
  importance: RequirementImportance;
  status: RequirementStatus;
  quote: string | null;
  note: string;
}

export interface Fit {
  resumeId: string;
  analyzedAt: string;
  requirements: FitRequirement[];
  coverage: number;
  mustCoverage: number | null;
}
