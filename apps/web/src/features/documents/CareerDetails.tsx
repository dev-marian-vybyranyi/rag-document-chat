import { Loader2Icon } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import type { DocumentItem } from './api';
import { careerTitle, describeFit, jobState, shownSkills } from './career-status';
import { useDocuments } from './documents-context';
import { failureMessage } from './failure-message';

type Action = 'analyze' | 'compare';

function Note({ children }: { children: string }) {
  return <p className="text-xs text-muted-foreground">{children}</p>;
}

export function CareerDetails({ document }: { document: DocumentItem }) {
  const { state, comparingIds, analyze, compare } = useDocuments();
  const [pending, setPending] = useState<Action | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  if (document.status !== 'ready') return null;
  const documents = state.status === 'ready' ? state.documents : [];
  const title = careerTitle(document);

  async function run(action: Action) {
    setPending(action);
    setProblem(null);
    try {
      await (action === 'analyze' ? analyze(document.id) : compare(document.id));
    } catch (error) {
      setProblem(failureMessage(error));
    } finally {
      setPending(null);
    }
  }

  const actionButton = (action: Action, label: string) => (
    <Button
      variant="outline"
      size="xs"
      className="self-start"
      disabled={pending !== null}
      aria-label={`${label} ${title}`}
      onClick={() => void run(action)}
    >
      {pending === action && <Loader2Icon className="animate-spin" aria-hidden />}
      {label}
    </Button>
  );

  let body;
  if (document.kind === 'resume') {
    if (document.profile === null || document.profile.role !== 'resume') {
      body = (
        <>
          <Note>Not analysed yet, so skills and years of experience are not known.</Note>
          {actionButton('analyze', 'Analyze')}
        </>
      );
    } else {
      const { shown, more } = shownSkills(document.profile.skills);
      body =
        shown.length > 0 ? (
          <ul className="flex flex-wrap gap-1.5 pt-1" aria-label="Skills in the resume">
            {shown.map((skill) => (
              <li key={skill} className="rounded-full bg-muted px-2 py-0.5 text-xs">
                {skill}
              </li>
            ))}
            {more > 0 && (
              <li className="px-1 py-0.5 text-xs text-muted-foreground">+{more} more</li>
            )}
          </ul>
        ) : (
          <Note>No skills were found in the resume.</Note>
        );
    }
  } else {
    const job = jobState(document, documents, comparingIds);
    switch (job?.kind) {
      case 'not_analysed':
        body = (
          <>
            <Note>Not analysed yet, so it cannot be compared with your resume.</Note>
            {actionButton('analyze', 'Analyze')}
          </>
        );
        break;
      case 'no_requirements':
        body = (
          <>
            <Note>No requirements were found in this posting.</Note>
            {actionButton('analyze', 'Analyze again')}
          </>
        );
        break;
      case 'fit':
        body = (
          <div className="flex flex-col gap-1 pt-1">
            <div
              role="meter"
              aria-label={`Fit with ${title}`}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={job.fit.coverage}
              aria-valuetext={describeFit(job.fit)}
              className="relative h-1.5 overflow-hidden rounded-full bg-muted"
            >
              <div
                className="absolute inset-y-0 left-0 rounded-full bg-primary"
                style={{ width: `${job.fit.coverage}%` }}
              />
            </div>
            <p className="text-xs">
              <span className="font-medium">{job.fit.coverage}%</span>
              <span className="text-muted-foreground">
                {describeFit(job.fit).slice(`${job.fit.coverage}%`.length)}
              </span>
            </p>
          </div>
        );
        break;
      case 'no_resume':
        body = <Note>Add your resume to see how well it fits this posting.</Note>;
        break;
      case 'waiting_for_resume':
        body = <Note>Waiting for your resume to be indexed…</Note>;
        break;
      case 'comparing':
        body = (
          <p className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2Icon className="size-3 animate-spin" aria-hidden />
            Comparing with your resume…
          </p>
        );
        break;
      case 'not_compared':
        body = (
          <>
            <Note>Not compared with your resume yet.</Note>
            {actionButton('compare', 'Compare')}
          </>
        );
        break;
      default:
        body = null;
    }
  }

  return (
    <>
      {body}
      {problem && (
        <p role="alert" className="text-sm text-destructive">
          {problem}
        </p>
      )}
    </>
  );
}
