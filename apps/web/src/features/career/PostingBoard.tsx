import { Loader2Icon } from 'lucide-react';
import { useState } from 'react';
import { SegmentedControl } from '@/components/SegmentedControl';
import { cn } from '@/lib/utils';
import type { CareerOverview, Posting } from './api';
import { postingTitle, rankOf, sortPostings, type SortOrder } from './career-view';
import { FitMeter } from './FitMeter';

const SORTS: Array<{ value: SortOrder; label: string }> = [
  { value: 'fit', label: 'Best fit' },
  { value: 'number', label: 'Job number' },
];

function stateOf(
  posting: Posting,
  resume: CareerOverview['resume'],
  waiting: boolean,
): { text: string; busy: boolean } {
  const idle = (text: string) => ({ text, busy: false });
  if (posting.status === 'processing') return { text: 'Being processed…', busy: true };
  if (posting.status === 'failed') return idle(posting.error ?? 'Could not be processed.');
  if (posting.profile === null || posting.profile.role !== 'job') return idle('Not analysed yet.');
  if (posting.profile.requirementCount === 0) return idle('No requirements were found.');
  if (resume === null || resume.status === 'failed') return idle('Add your resume to compare.');
  if (resume.status === 'processing') return { text: 'Waiting for your resume…', busy: true };
  return waiting ? { text: 'Comparing with your resume…', busy: true } : idle('Not compared yet.');
}

interface PostingBoardProps {
  postings: Posting[];
  resume: CareerOverview['resume'];
  waiting: boolean;
  selectedId: string | null;
  onSelect: (id: string) => void;
}

export function PostingBoard({
  postings,
  resume,
  waiting,
  selectedId,
  onSelect,
}: PostingBoardProps) {
  const [order, setOrder] = useState<SortOrder>('fit');
  const sorted = sortPostings(postings, order);

  return (
    <section aria-label="Job postings" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-medium">Job postings</h3>
        <SegmentedControl
          label="Sort postings by"
          value={order}
          options={SORTS}
          onChange={setOrder}
          size="xs"
          className="gap-1"
        />
      </div>
      <ul className="flex flex-col gap-2">
        {sorted.map((posting) => {
          const rank = rankOf(posting, postings);
          const selected = posting.id === selectedId;
          const state = stateOf(posting, resume, waiting);
          return (
            <li key={posting.id}>
              <button
                type="button"
                aria-pressed={selected}
                onClick={() => onSelect(posting.id)}
                className={cn(
                  'flex w-full flex-col gap-1.5 rounded-lg border bg-background px-4 py-3 text-left text-sm transition-colors hover:bg-muted/60',
                  selected && 'border-primary ring-1 ring-primary',
                )}
              >
                <span className="flex items-baseline gap-2">
                  {rank !== null && (
                    <span className="text-xs text-muted-foreground" aria-label={`Rank ${rank}`}>
                      #{rank}
                    </span>
                  )}
                  <span className="min-w-0 flex-1 truncate font-medium">
                    {postingTitle(posting)}
                  </span>
                  {posting.fit && (
                    <span className="shrink-0 text-xs font-medium">{posting.fit.coverage}%</span>
                  )}
                </span>
                {posting.fit ? (
                  <>
                    <FitMeter fit={posting.fit} label={`Fit with ${postingTitle(posting)}`} />
                    {posting.fit.mustCoverage !== null && (
                      <span className="text-xs text-muted-foreground">
                        {posting.fit.mustCoverage}% of the must-haves
                      </span>
                    )}
                  </>
                ) : (
                  <span className="flex items-center gap-2 text-xs text-muted-foreground">
                    {state.busy && <Loader2Icon className="size-3 animate-spin" aria-hidden />}
                    {state.text}
                  </span>
                )}
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
