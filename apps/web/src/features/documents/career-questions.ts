import type { DocumentItem } from './api';

export const MAX_CAREER_QUESTIONS = 4;

const ready = (document: DocumentItem) => document.status === 'ready';

export function readyResume(documents: DocumentItem[]): DocumentItem | undefined {
  return documents.find((document) => document.kind === 'resume' && ready(document));
}

export function readyJobs(documents: DocumentItem[]): DocumentItem[] {
  return documents
    .filter((document) => document.kind === 'job_posting' && ready(document))
    .sort(
      (a, b) =>
        (b.fit?.coverage ?? -1) - (a.fit?.coverage ?? -1) ||
        (a.jobNumber ?? Infinity) - (b.jobNumber ?? Infinity),
    );
}

const jobName = (job: DocumentItem) =>
  job.jobNumber === null ? 'this job' : `Job #${job.jobNumber}`;

function aboutJob(job: DocumentItem, withResume: boolean): string[] {
  const name = jobName(job);
  return withResume
    ? [
        `What skills am I missing for ${name}?`,
        `How does my experience align with ${name}?`,
        `Prepare me for an interview for ${name}.`,
      ]
    : [`What does ${name} require?`, `What are the responsibilities of ${name}?`];
}

const ABOUT_RESUME = ['What are the strongest skills on my resume?', 'Summarize my experience.'];

export function careerQuestions(documents: DocumentItem[]): string[] {
  const resume = readyResume(documents);
  const jobs = readyJobs(documents);
  const [best] = jobs;

  if (!resume && !best) return [];
  if (!best) return ABOUT_RESUME;
  if (!resume) return jobs.slice(0, 2).flatMap((job) => aboutJob(job, false).slice(0, 1));

  return [...(jobs.length > 1 ? ['Which job fits me best?'] : []), ...aboutJob(best, true)].slice(
    0,
    MAX_CAREER_QUESTIONS,
  );
}

export function cardQuestions(
  document: DocumentItem,
  documents: DocumentItem[],
): { questions: string[]; sourceIds: string[] } {
  if (!ready(document)) return { questions: [], sourceIds: [document.id] };
  if (document.kind === 'resume') return { questions: ABOUT_RESUME, sourceIds: [document.id] };
  const resume = readyResume(documents);
  return {
    questions: aboutJob(document, resume !== undefined),
    sourceIds: resume ? [resume.id, document.id] : [document.id],
  };
}
