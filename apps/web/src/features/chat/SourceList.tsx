import { describeLocation } from './source-format';
import { useSourceViewer } from './source-viewer-context';
import type { ChatSource } from './types';

export function SourceList({ sources }: { sources: ChatSource[] }) {
  const { open } = useSourceViewer();
  if (sources.length === 0) return null;

  return (
    <div className="mt-3 border-t pt-2">
      <p className="text-xs font-medium text-muted-foreground">Sources</p>
      <ol className="mt-1 flex flex-wrap gap-1.5">
        {sources.map((source) => (
          <li key={source.id} className="max-w-full">
            <button
              type="button"
              onClick={() => open(source)}
              title={source.excerpt}
              className="block max-w-full cursor-pointer truncate rounded-md border bg-muted/50 px-2 py-0.5 text-left text-xs hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            >
              <span className="font-medium">[{source.id}]</span>{' '}
              {source.code ? describeLocation(source) : source.filename}
              {source.page !== null && (
                <span className="text-muted-foreground"> · p. {source.page}</span>
              )}
            </button>
          </li>
        ))}
      </ol>
    </div>
  );
}
