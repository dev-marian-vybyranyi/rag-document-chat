import type { SharedGap } from './api';
import { describeGap } from './career-view';

export function SharedGaps({ gaps, compared }: { gaps: SharedGap[]; compared: number }) {
  if (compared < 2 || gaps.length === 0) return null;
  return (
    <section aria-label="Gaps across postings" className="rounded-lg border bg-background p-4">
      <h3 className="text-sm font-medium">Gaps across postings</h3>
      <p className="mt-1 text-xs text-muted-foreground">
        What the resume does not fully show, most common first. Worth learning or adding to the
        resume.
      </p>
      <ul className="mt-2 flex flex-col gap-1 text-sm">
        {gaps.map((gap) => (
          <li key={gap.label}>{describeGap(gap, compared)}</li>
        ))}
      </ul>
    </section>
  );
}
