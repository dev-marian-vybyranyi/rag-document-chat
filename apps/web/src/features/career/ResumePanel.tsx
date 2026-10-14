import { FileUserIcon } from 'lucide-react';
import { Link } from 'react-router';
import { describeYears, shownSkills } from '../documents/career-status';
import type { CareerOverview } from './api';

export function ResumePanel({ resume }: { resume: CareerOverview['resume'] }) {
  if (resume === null) {
    return (
      <section aria-label="Your resume" className="rounded-lg border bg-background p-4 text-sm">
        <p className="font-medium">No resume yet</p>
        <p className="mt-1 text-muted-foreground">
          <Link to="/documents" className="underline underline-offset-2 hover:text-foreground">
            Add your resume
          </Link>{' '}
          to see how well it fits each job posting.
        </p>
      </section>
    );
  }

  const profile = resume.profile?.role === 'resume' ? resume.profile : null;
  const { shown, more } = shownSkills(profile?.skills ?? []);

  return (
    <section
      aria-label="Your resume"
      className="flex flex-col gap-2 rounded-lg border bg-background p-4"
    >
      <div className="flex items-center gap-2">
        <FileUserIcon className="size-5 text-muted-foreground" aria-hidden />
        <h3 className="text-sm font-medium">Your resume</h3>
        <p className="text-xs text-muted-foreground">
          {resume.status === 'processing' && 'Being processed…'}
          {resume.status === 'failed' && (resume.error ?? 'Could not be processed.')}
          {resume.status === 'ready' && profile === null && 'Not analysed yet.'}
          {resume.status === 'ready' &&
            profile !== null &&
            (profile.totalExperienceYears === null
              ? 'Years of experience not stated.'
              : describeYears(profile.totalExperienceYears))}
        </p>
      </div>
      {shown.length > 0 && (
        <ul className="flex flex-wrap gap-1.5" aria-label="Skills in the resume">
          {shown.map((skill) => (
            <li key={skill} className="rounded-full bg-muted px-2 py-0.5 text-xs">
              {skill}
            </li>
          ))}
          {more > 0 && <li className="px-1 py-0.5 text-xs text-muted-foreground">+{more} more</li>}
        </ul>
      )}
    </section>
  );
}
