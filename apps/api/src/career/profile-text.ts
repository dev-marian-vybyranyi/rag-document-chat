import type { TextSection } from './sections.js';
import type { CareerProfile, JobProfile, ResumeProfile } from './types.js';

function resumeLines(profile: ResumeProfile): string[] {
  const lines: string[] = [];
  if (profile.headline) lines.push(`Headline: ${profile.headline}`);
  if (profile.totalExperienceYears !== null) {
    lines.push(
      `Total professional experience: ${profile.totalExperienceYears} years (computed from the dates of the roles)`,
    );
  }
  if (profile.skills.length > 0) {
    lines.push(`Skills: ${profile.skills.map((skill) => skill.name).join(', ')}`);
  }
  if (profile.roles.length > 0) {
    lines.push('Roles:');
    for (const role of profile.roles) {
      const dates =
        role.start === null ? '' : `, ${role.start} to ${role.end === null ? 'present' : role.end}`;
      lines.push(`- ${role.title}, ${role.company}${dates}`);
    }
  }
  if (profile.education.length > 0) {
    lines.push('Education:');
    for (const item of profile.education) {
      lines.push(
        `- ${item.degree === null ? item.institution : `${item.degree}, ${item.institution}`}`,
      );
    }
  }
  return lines;
}

function jobLines(profile: JobProfile): string[] {
  const lines: string[] = [];
  const role = [profile.title, profile.company].filter((part) => part !== null).join(' at ');
  if (role !== '') lines.push(`Role: ${role}`);
  if (profile.minYearsExperience !== null) {
    lines.push(`Minimum years of professional experience: ${profile.minYearsExperience}`);
  }
  for (const [importance, heading] of [
    ['must', 'Must have'],
    ['nice', 'Nice to have'],
  ] as const) {
    const wanted = profile.requirements.filter(
      (requirement) => requirement.importance === importance,
    );
    if (wanted.length === 0) continue;
    lines.push(`${heading}:`);
    for (const requirement of wanted) lines.push(`- ${requirement.text}`);
  }
  if (profile.responsibilities.length > 0) {
    lines.push('Responsibilities:');
    for (const duty of profile.responsibilities) lines.push(`- ${duty}`);
  }
  return lines;
}

export function profileSections(profile: CareerProfile | null): TextSection[] {
  if (profile === null) return [];
  const lines = profile.role === 'resume' ? resumeLines(profile) : jobLines(profile);
  if (lines.length === 0) return [];
  return [{ section: 'profile', heading: null, title: null, page: null, text: lines.join('\n') }];
}
