import type { RefObject } from 'react';
import { cn } from '@/lib/utils';
import type { PassagesResponse } from '../documents/api';
import { speakerTone, transcriptRows } from './transcript-lines';

export function TranscriptView({
  data,
  target,
}: {
  data: PassagesResponse;
  target: RefObject<HTMLLIElement | null>;
}) {
  const rows = transcriptRows(data.passages, data.target);
  const firstCited = rows.findIndex((row) => row.cited);

  return (
    <ol aria-label="Transcript" className="flex flex-col gap-0.5 text-sm">
      {rows.map((row, index) => (
        <li
          key={`${row.time}-${index}`}
          ref={index === firstCited ? target : undefined}
          aria-current={index === firstCited ? 'true' : undefined}
          data-cited={row.cited ? 'true' : undefined}
          className={cn(
            'grid grid-cols-[4.5rem_1fr] gap-x-2 rounded-md px-2 py-1',
            row.cited
              ? 'bg-amber-100 text-foreground dark:bg-amber-400/15'
              : 'text-muted-foreground',
          )}
        >
          <span className="pt-0.5 font-mono text-xs">{row.time}</span>
          <p className="min-w-0 break-words">
            <span className={cn('font-medium', speakerTone(row.speaker))}>{row.speaker}</span>
            {': '}
            {row.text}
          </p>
        </li>
      ))}
    </ol>
  );
}
