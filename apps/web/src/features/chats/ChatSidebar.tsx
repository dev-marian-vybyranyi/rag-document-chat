import { Loader2Icon, PlusIcon } from 'lucide-react';
import { useState } from 'react';
import { NavLink, useNavigate } from 'react-router';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { DEFAULT_CHAT_TITLE, type Chat } from './api';
import { useChats } from './chats-context';

function isUntouched(chat: Chat): boolean {
  return chat.title === DEFAULT_CHAT_TITLE && chat.updatedAt === chat.createdAt;
}

export function ChatSidebar() {
  const { state, reload, createChat } = useChats();
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);
  const [createFailed, setCreateFailed] = useState(false);

  async function handleNewChat() {
    setCreating(true);
    setCreateFailed(false);
    try {
      const untouched = state.status === 'ready' ? state.chats.find(isUntouched) : undefined;
      const chat = untouched ?? (await createChat());
      void navigate(`/chats/${chat.id}`);
    } catch {
      setCreateFailed(true);
    } finally {
      setCreating(false);
    }
  }

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
                    cn(
                      'block truncate rounded-lg px-2.5 py-1.5 text-sm transition-colors hover:bg-muted',
                      isActive && 'bg-muted font-medium',
                    )
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
