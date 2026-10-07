import { XIcon } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { ApiError } from '@/lib/api';
import { documentsApi, type PassagesResponse } from '@/features/documents/api';
import { cn } from '@/lib/utils';
import { describeMatch } from './source-format';
import { useSourceViewer } from './source-viewer-context';
import type { ChatSource } from './types';

export const VIEWER_RADIUS = 2;

type Loaded =
  | { status: 'loading' }
  | { status: 'gone' }
  | { status: 'error' }
  | { status: 'ready'; data: PassagesResponse };

export function SourceViewer() {
  const { source, close } = useSourceViewer();
  if (!source) return null;
  return <Panel key={source.chunkId} source={source} onClose={close} />;
}

function Panel({ source, onClose }: { source: ChatSource; onClose: () => void }) {
  const [loaded, setLoaded] = useState<Loaded>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const closeButton = useRef<HTMLButtonElement>(null);
  const target = useRef<HTMLLIElement>(null);

  useEffect(() => {
    closeButton.current?.focus();
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    documentsApi
      .passages(source.documentId, source.ordinal, VIEWER_RADIUS, controller.signal)
      .then((data) => setLoaded({ status: 'ready', data }))
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setLoaded({ status: error instanceof ApiError && error.status === 404 ? 'gone' : 'error' });
      });
    return () => controller.abort();
  }, [source.documentId, source.ordinal, attempt]);

  useEffect(() => {
    if (loaded.status === 'ready') target.current?.scrollIntoView?.({ block: 'center' });
  }, [loaded.status]);

  return (
    <aside
      aria-label="Source viewer"
      onKeyDown={(event) => event.key === 'Escape' && onClose()}
      className="fixed inset-x-0 top-14 bottom-0 z-30 flex flex-col border-l bg-background md:static md:z-auto md:w-96 md:shrink-0"
    >
      <header className="flex items-start gap-2 border-b px-4 py-3">
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-sm font-semibold" title={source.filename}>
            {source.filename}
          </h2>
          <p className="text-xs text-muted-foreground">
            Source [{source.id}]{source.page !== null && ` · Page ${source.page}`} ·{' '}
            {describeMatch(source.score)}
          </p>
        </div>
        <Button
          ref={closeButton}
          variant="ghost"
          size="icon-sm"
          aria-label="Close source viewer"
          onClick={onClose}
        >
          <XIcon aria-hidden />
        </Button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {loaded.status === 'loading' && (
          <div role="status" className="flex flex-col gap-3">
            <span className="sr-only">Loading the passage…</span>
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-24 w-full" />
            <Skeleton className="h-16 w-full" />
          </div>
        )}

        {loaded.status === 'error' && (
          <div className="flex flex-col items-start gap-2">
            <p role="alert" className="text-sm text-destructive">
              Could not load the passage.
            </p>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setLoaded({ status: 'loading' });
                setAttempt((n) => n + 1);
              }}
            >
              Try again
            </Button>
          </div>
        )}

        {loaded.status === 'gone' && <Unavailable source={source} />}

        {loaded.status === 'ready' && (
          <ol className="flex flex-col gap-3">
            {loaded.data.passages.map((passage) => {
              const cited = passage.ordinal === loaded.data.target;
              return (
                <li
                  key={passage.ordinal}
                  ref={cited ? target : undefined}
                  aria-current={cited ? 'true' : undefined}
                  className={cn(
                    'rounded-lg border px-3 py-2 text-sm whitespace-pre-line break-words',
                    cited ? 'border-primary bg-primary/10' : 'text-muted-foreground',
                  )}
                >
                  <p className="mb-1 text-xs font-medium">
                    {cited ? 'Cited passage' : 'Nearby'}
                    {passage.page !== null && ` · Page ${passage.page}`}
                  </p>
                  {passage.content}
                </li>
              );
            })}
          </ol>
        )}
      </div>
    </aside>
  );
}

function Unavailable({ source }: { source: ChatSource }) {
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm">
        This passage is no longer available. The document may have been deleted. Here is the text
        that was saved with the answer:
      </p>
      <blockquote className="rounded-lg border border-dashed px-3 py-2 text-sm whitespace-pre-line break-words text-muted-foreground">
        {source.excerpt}
      </blockquote>
    </div>
  );
}
