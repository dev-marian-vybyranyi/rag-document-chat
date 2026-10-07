import type { ReactNode } from 'react';
import { describeMatch, describeSource } from './source-format';
import { useSourceViewer } from './source-viewer-context';
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card';
import type { ChatSource } from './types';

export const OPEN_DELAY_MS = 120;
export const CLOSE_DELAY_MS = 80;

export function Citation({ source, children }: { source: ChatSource; children: ReactNode }) {
  const { open } = useSourceViewer();

  return (
    <HoverCard openDelay={OPEN_DELAY_MS} closeDelay={CLOSE_DELAY_MS}>
      <HoverCardTrigger asChild>
        <button
          type="button"
          onClick={() => open(source)}
          aria-label={`Source ${source.id}: ${describeSource(source)}`}
          className="ml-0.5 inline-block cursor-pointer rounded bg-primary/10 px-1 align-baseline text-xs font-medium not-italic text-primary outline-none hover:bg-primary/20 focus-visible:ring-2 focus-visible:ring-ring"
        >
          {children}
        </button>
      </HoverCardTrigger>
      <HoverCardContent>
        <p className="text-sm font-medium break-words">{source.filename}</p>
        <p className="text-xs text-muted-foreground">
          {source.page !== null && `Page ${source.page} · `}
          {describeMatch(source.score)}
        </p>
        <p className="mt-2 line-clamp-6 text-xs break-words whitespace-pre-line">
          {source.excerpt}
        </p>
        <p className="mt-2 text-xs text-muted-foreground">Click to read it in context.</p>
      </HoverCardContent>
    </HoverCard>
  );
}
