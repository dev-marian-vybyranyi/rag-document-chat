import { useState } from 'react';
import { Link } from 'react-router';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import type { CareerOverview } from '@/features/career/api';
import { PostingBoard } from '@/features/career/PostingBoard';
import { PostingDetail } from '@/features/career/PostingDetail';
import { ResumePanel } from '@/features/career/ResumePanel';
import { SharedGaps } from '@/features/career/SharedGaps';
import { sortPostings } from '@/features/career/career-view';
import { useCareerOverview } from '@/features/career/useCareerOverview';

export function CareerPage() {
  const { state, reload } = useCareerOverview();

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6 px-4 py-6">
      <h2 className="text-xl font-semibold">Career</h2>

      {state.status === 'loading' && (
        <div role="status" className="flex flex-col gap-2">
          <span className="sr-only">Loading your career overview…</span>
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-32 w-full" />
        </div>
      )}

      {state.status === 'error' && (
        <div className="flex flex-col items-start gap-2">
          <p role="alert" className="text-sm text-destructive">
            Could not load your career overview.
          </p>
          <Button variant="outline" size="sm" onClick={reload}>
            Try again
          </Button>
        </div>
      )}

      {state.status === 'ready' && (
        <>
          <ResumePanel resume={state.overview.resume} />

          {state.overview.postings.length === 0 ? (
            <p className="text-center text-sm text-muted-foreground">
              No job postings yet.{' '}
              <Link to="/documents" className="underline underline-offset-2 hover:text-foreground">
                Add some
              </Link>{' '}
              to compare them with your resume.
            </p>
          ) : (
            <Postings overview={state.overview} waiting={state.waiting} />
          )}
        </>
      )}
    </div>
  );
}

function Postings({ overview, waiting }: { overview: CareerOverview; waiting: boolean }) {
  const [chosenId, setChosenId] = useState<string | null>(null);
  const { postings, resume, gaps, compared } = overview;
  const selected =
    postings.find((posting) => posting.id === chosenId) ?? sortPostings(postings, 'fit')[0]!;

  return (
    <>
      <SharedGaps gaps={gaps} compared={compared} />
      <div className="@container">
        <div className="grid gap-6 @3xl:grid-cols-[minmax(0,20rem)_minmax(0,1fr)]">
          <PostingBoard
            postings={postings}
            resume={resume}
            waiting={waiting}
            selectedId={selected.id}
            onSelect={setChosenId}
          />
          <PostingDetail posting={selected} resume={resume} />
        </div>
      </div>
    </>
  );
}
