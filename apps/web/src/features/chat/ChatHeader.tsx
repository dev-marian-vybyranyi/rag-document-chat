import { PencilIcon, Trash2Icon } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ApiError } from '@/lib/api';
import { MAX_TITLE_LENGTH } from '@/features/chats/api';
import { useChats } from '@/features/chats/chats-context';
import { SourcePicker } from './SourcePicker';

type Mode = 'view' | 'rename' | 'confirm-delete';

function messageOf(error: unknown, fallback: string): string {
  return error instanceof ApiError && error.code === 'validation_error'
    ? 'Choose a title between 1 and 120 characters.'
    : fallback;
}

export function ChatHeader({
  chatId,
  title,
  sourceIds,
}: {
  chatId: string;
  title: string;
  sourceIds: string[] | null;
}) {
  const { renameChat, removeChat } = useChats();
  const navigate = useNavigate();
  const [mode, setMode] = useState<Mode>('view');
  const [draft, setDraft] = useState(title);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function enter(next: Mode) {
    setDraft(title);
    setError(null);
    setMode(next);
  }

  async function submitRename(event: FormEvent) {
    event.preventDefault();
    const next = draft.trim();
    if (next.length === 0) {
      setError('Enter a title.');
      return;
    }
    if (next === title) {
      setMode('view');
      return;
    }
    setPending(true);
    setError(null);
    try {
      await renameChat(chatId, next);
      setMode('view');
    } catch (failure) {
      setError(messageOf(failure, 'Could not rename the chat. Try again.'));
    } finally {
      setPending(false);
    }
  }

  async function confirmDelete() {
    setPending(true);
    setError(null);
    try {
      await removeChat(chatId);
      void navigate('/', { replace: true });
    } catch {
      setError('Could not delete the chat. Try again.');
      setPending(false);
    }
  }

  return (
    <div className="flex min-h-12 flex-wrap items-center gap-2 border-b bg-background px-4 py-2">
      {mode === 'rename' ? (
        <form onSubmit={submitRename} className="flex flex-1 items-center gap-2">
          <Input
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => event.key === 'Escape' && enter('view')}
            aria-label="Chat title"
            maxLength={MAX_TITLE_LENGTH}
            autoFocus
            onFocus={(event) => event.target.select()}
            disabled={pending}
          />
          <Button type="submit" size="sm" disabled={pending}>
            Save
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={() => enter('view')}>
            Cancel
          </Button>
        </form>
      ) : (
        <h2 className="min-w-0 flex-1 truncate text-sm font-semibold" title={title}>
          {title}
        </h2>
      )}

      {mode === 'view' && (
        <>
          <SourcePicker chatId={chatId} sourceIds={sourceIds} />
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Rename chat"
            onClick={() => enter('rename')}
          >
            <PencilIcon aria-hidden />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Delete chat"
            onClick={() => enter('confirm-delete')}
          >
            <Trash2Icon aria-hidden />
          </Button>
        </>
      )}

      {mode === 'confirm-delete' && (
        <div className="flex items-center gap-2">
          <span className="text-sm">Delete this chat and its messages?</span>
          <Button variant="destructive" size="sm" onClick={confirmDelete} disabled={pending}>
            Delete
          </Button>
          <Button variant="ghost" size="sm" onClick={() => enter('view')} disabled={pending}>
            Cancel
          </Button>
        </div>
      )}

      {error && (
        <p role="alert" className="w-full text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
