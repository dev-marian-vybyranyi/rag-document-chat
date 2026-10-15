import { BriefcaseBusinessIcon, FileTextIcon, Loader2Icon, PlusIcon } from 'lucide-react';
import { NavLink } from 'react-router';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { useDocuments } from '../documents/documents-context';
import { useChats } from './chats-context';
import { useNewChat } from './useNewChat';

const ITEM =
  'rounded-lg px-2.5 py-1.5 pointer-coarse:py-3 text-sm transition-colors hover:bg-muted';

export function ChatSidebar() {
  const { state, reload } = useChats();
  const { anyProcessing } = useDocuments();
  const { open: handleNewChat, creating, failed: createFailed } = useNewChat();

  return (
    <div className="flex h-full flex-col gap-3 p-3">
      <Button onClick={handleNewChat} disabled={creating} className="w-full justify-start">
        {creating ? <Loader2Icon className="animate-spin" aria-hidden /> : <PlusIcon aria-hidden />}
        New chat
      </Button>
      {createFailed && (
        <p role="alert" className="px-1 text-sm text-destructive">
          Could not start a new chat. Try again.
        </p>
      )}

      <nav aria-label="Main" className="flex flex-col gap-3">
        <NavLink
          to="/documents"
          className={({ isActive }) =>
            cn('flex items-center gap-2', ITEM, isActive && 'bg-muted font-medium')
          }
        >
          <FileTextIcon className="size-4" aria-hidden />
          Documents
          {anyProcessing && (
            <>
              <Loader2Icon
                className="ml-auto size-3.5 animate-spin text-muted-foreground"
                aria-hidden
              />
              <span className="sr-only">(processing)</span>
            </>
          )}
        </NavLink>

        <NavLink
          to="/career"
          className={({ isActive }) =>
            cn('flex items-center gap-2', ITEM, isActive && 'bg-muted font-medium')
          }
        >
          <BriefcaseBusinessIcon className="size-4" aria-hidden />
          Career
        </NavLink>
      </nav>

      <nav aria-label="Conversations" className="-mx-1 min-h-0 flex-1 overflow-y-auto px-1">
        {state.status === 'loading' && (
          <div role="status" className="flex flex-col gap-1.5 px-2 py-1.5">
            <span className="sr-only">Loading conversations…</span>
            <Skeleton className="h-6 w-full" />
            <Skeleton className="h-6 w-5/6" />
            <Skeleton className="h-6 w-4/6" />
          </div>
        )}

        {state.status === 'error' && (
          <div className="flex flex-col items-start gap-2 px-2 py-1.5">
            <p role="alert" className="text-sm text-destructive">
              {state.message}
            </p>
            <Button variant="outline" size="sm" onClick={reload}>
              Try again
            </Button>
          </div>
        )}

        {state.status === 'ready' && state.chats.length === 0 && (
          <p className="px-2 py-1.5 text-sm text-muted-foreground">
            No conversations yet. Start one with “New chat”.
          </p>
        )}

        {state.status === 'ready' && state.chats.length > 0 && (
          <ul className="flex flex-col gap-0.5">
            {state.chats.map((chat) => (
              <li key={chat.id}>
                <NavLink
                  to={`/chats/${chat.id}`}
                  title={chat.title}
                  className={({ isActive }) =>
                    cn('block truncate', ITEM, isActive && 'bg-muted font-medium')
                  }
                >
                  {chat.title}
                </NavLink>
              </li>
            ))}
          </ul>
        )}
      </nav>
    </div>
  );
}
