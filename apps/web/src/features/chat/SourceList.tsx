import type { ChatSource } from './types';

export function SourceList({ sources }: { sources: ChatSource[] }) {
  if (sources.length === 0) return null;

  return (
    <div className="mt-3 border-t pt-2">
      <p className="text-xs font-medium text-muted-foreground">Sources</p>
      <ol className="mt-1 flex flex-wrap gap-1.5">
        {sources.map((source) => (
          <li
            key={source.id}
            title={source.excerpt}
            className="max-w-full truncate rounded-md border bg-muted/50 px-2 py-0.5 text-xs"
          >
            <span className="font-medium">[{source.id}]</span> {source.filename}
            {source.page !== null && (
              <span className="text-muted-foreground"> · p. {source.page}</span>
            )}
          </li>
        ))}
      </ol>
    </div>
  );
}
