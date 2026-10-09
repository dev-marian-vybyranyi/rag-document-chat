import { ChevronDownIcon, FileTextIcon, FolderGit2Icon } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';
import { useChats } from '@/features/chats/chats-context';
import { useDocuments } from '@/features/documents/documents-context';
import { describeScope, idsOf, liveIds, normalizeScope } from './scope';

export function SourcePicker({
  chatId,
  sourceIds,
}: {
  chatId: string;
  sourceIds: string[] | null;
}) {
  const { state } = useDocuments();
  const { setChatSources } = useChats();
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);

  const library = state.status === 'ready' ? state.documents : [];
  const { label, missing, empty } = describeScope(sourceIds, library);
  const documents = library.filter((source) => source.kind === 'document');
  const repositories = library.filter((source) => source.kind === 'repository');

  async function apply(next: string[] | null) {
    setPending(true);
    setFailed(false);
    try {
      await setChatSources(chatId, next === null ? null : normalizeScope(next, library));
    } catch {
      setFailed(true);
    } finally {
      setPending(false);
    }
  }

  const chosen = sourceIds === null ? idsOf(library) : liveIds(sourceIds, library);
  const isChosen = (id: string) => chosen.includes(id);

  function toggle(id: string) {
    const next = isChosen(id) ? chosen.filter((other) => other !== id) : [...chosen, id];
    if (next.length > 0) void apply(next);
  }

  const preset = (name: string, ids: string[]) => (
    <Button
      type="button"
      variant="outline"
      size="xs"
      disabled={pending || ids.length === 0}
      onClick={() => void apply(ids)}
    >
      {name}
    </Button>
  );

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className={cn('max-w-56 min-w-0', empty && 'border-destructive text-destructive')}
        >
          <span className="text-muted-foreground">Searching in: </span>
          <span className="truncate">{label}</span>
          <ChevronDownIcon aria-hidden />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80">
        <p className="text-sm font-medium">Search in</p>
        <div className="flex flex-wrap gap-1.5">
          <Button
            type="button"
            variant="outline"
            size="xs"
            disabled={pending || sourceIds === null}
            onClick={() => void apply(null)}
          >
            All sources
          </Button>
          {preset(
            'Documents only',
            documents.map((source) => source.id),
          )}
          {preset(
            'Code only',
            repositories.map((source) => source.id),
          )}
        </div>

        {state.status !== 'ready' && (
          <p className="text-xs text-muted-foreground">Your library is not loaded yet.</p>
        )}
        {state.status === 'ready' && library.length === 0 && (
          <p className="text-xs text-muted-foreground">
            You have no sources yet. Add a document or a code repository first.
          </p>
        )}

        {library.length > 0 && (
          <ul
            aria-label="Sources to search"
            className="flex max-h-64 flex-col gap-0.5 overflow-y-auto"
          >
            {library.map((source) => {
              const Icon = source.kind === 'repository' ? FolderGit2Icon : FileTextIcon;
              const only = chosen.length === 1 && isChosen(source.id);
              return (
                <li key={source.id}>
                  <label className="flex cursor-pointer items-center gap-2 rounded-md px-1.5 py-1 text-sm hover:bg-muted">
                    <input
                      type="checkbox"
                      checked={isChosen(source.id)}
                      disabled={pending || only}
                      onChange={() => toggle(source.id)}
                      className="size-4 accent-primary"
                    />
                    <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                    <span className="min-w-0 flex-1 truncate" title={source.filename}>
                      {source.filename}
                    </span>
                    {source.status === 'processing' && (
                      <span className="text-xs text-muted-foreground">indexing…</span>
                    )}
                    {source.status === 'failed' && (
                      <span className="text-xs text-destructive">failed</span>
                    )}
                  </label>
                </li>
              );
            })}
          </ul>
        )}

        {empty && (
          <p role="alert" className="text-xs text-destructive">
            The sources chosen for this chat were deleted, so nothing can be found. Choose others.
          </p>
        )}
        {!empty && missing > 0 && (
          <p className="text-xs text-muted-foreground">
            {missing === 1 ? 'One chosen source was' : `${missing} chosen sources were`} deleted and
            is ignored.
          </p>
        )}
        {failed && (
          <p role="alert" className="text-xs text-destructive">
            Could not change the sources. Try again.
          </p>
        )}
        <p className="text-xs text-muted-foreground">
          Applies to the next question. Sources added later are included when all are chosen.
        </p>
      </PopoverContent>
    </Popover>
  );
}
