import { ExternalLinkIcon } from 'lucide-react';
import { useEffect, useRef, useState, type RefObject } from 'react';
import { Button } from '@/components/ui/button';
import { SidePanel } from './SidePanel';
import { Skeleton } from '@/components/ui/skeleton';
import { ApiError } from '@/lib/api';
import { documentsApi, type PassagesResponse } from '@/features/documents/api';
import { cn } from '@/lib/utils';
import { CodeSnippet } from './CodeSnippet';
import { githubPermalink } from './permalink';
import { describeLines, describeMatch, OVERVIEW_PATH } from './source-format';
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
  const target = useRef<HTMLLIElement>(null);

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

  const code = source.code;
  const isFile = code !== undefined && code.path !== OVERVIEW_PATH;
  const title = !code ? source.filename : isFile ? code.path : `Overview of ${source.filename}`;
  const origin = isFile ? `${source.filename} · ` : '';

  return (
    <SidePanel
      label="Source viewer"
      title={title}
      subtitle={`${origin}Source [${source.id}]${source.page !== null ? ` · Page ${source.page}` : ''} · ${describeMatch(source.score)}`}
      closeLabel="Close source viewer"
      onClose={onClose}
    >
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

      {loaded.status === 'ready' && isFile && (
        <FileView data={loaded.data} source={source} target={target} />
      )}

      {loaded.status === 'ready' && !isFile && (
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
                  cited
                    ? 'border-amber-500/60 bg-amber-100 text-foreground dark:bg-amber-400/15'
                    : 'text-muted-foreground',
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
    </SidePanel>
  );
}

function FileView({
  data,
  source,
  target,
}: {
  data: PassagesResponse;
  source: ChatSource;
  target: RefObject<HTMLLIElement | null>;
}) {
  const path = source.code!.path;
  const sameFile = data.passages.filter((passage) => passage.code?.path === path);
  const passages = sameFile.some((p) => p.ordinal === data.target) ? sameFile : data.passages;
  const cited = passages.find((p) => p.ordinal === data.target)?.code ?? source.code!;
  const permalink = githubPermalink(data.document, cited);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        {cited.symbol && <span className="font-mono">{cited.symbol}</span>}
        {cited.language && <span>{cited.language}</span>}
        {permalink && (
          <a
            href={permalink}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-primary underline underline-offset-2"
          >
            View these lines on GitHub
            <ExternalLinkIcon className="size-3" aria-hidden />
          </a>
        )}
      </div>
      <ol className="flex flex-col gap-3">
        {passages.map((passage) => {
          const isCited = passage.ordinal === data.target;
          const code = passage.code;
          const lines = code ? describeLines(code) : null;
          return (
            <li
              key={passage.ordinal}
              ref={isCited ? target : undefined}
              aria-current={isCited ? 'true' : undefined}
              className={cn(
                'rounded-lg border',
                isCited
                  ? 'border-amber-500/60 bg-amber-100 text-foreground dark:bg-amber-400/15'
                  : 'text-muted-foreground',
              )}
            >
              <p className="px-3 pt-2 text-xs font-medium">
                {isCited ? 'Cited lines' : 'Nearby'}
                {lines && ` · ${code!.startLine === code!.endLine ? 'line' : 'lines'} ${lines}`}
              </p>
              <CodeSnippet
                code={passage.content}
                language={code?.language ?? null}
                startLine={code?.startLine ?? 1}
                label={`${isCited ? 'Cited code' : 'Nearby code'}${lines ? `, lines ${lines}` : ''}`}
              />
            </li>
          );
        })}
      </ol>
    </div>
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
