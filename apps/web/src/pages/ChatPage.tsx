import { Loader2Icon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Navigate, useParams } from 'react-router';
import { Button } from '@/components/ui/button';
import { ChatHeader } from '@/features/chat/ChatHeader';
import { ChatView } from '@/features/chat/ChatView';
import { toUIMessages } from '@/features/chat/history';
import type { ChatUIMessage } from '@/features/chat/types';
import { chatsApi } from '@/features/chats/api';
import { useChats } from '@/features/chats/chats-context';
import { ApiError } from '@/lib/api';

type Loaded =
  | { status: 'loading' }
  | { status: 'missing' }
  | { status: 'error' }
  | { status: 'ready'; title: string; messages: ChatUIMessage[] };

export function ChatPage() {
  const { chatId } = useParams();
  if (!chatId) return <Navigate to="/" replace />;
  return <LoadedChat key={chatId} chatId={chatId} />;
}

function LoadedChat({ chatId }: { chatId: string }) {
  const { state } = useChats();
  const [loaded, setLoaded] = useState<Loaded>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    chatsApi
      .get(chatId, controller.signal)
      .then(({ chat, messages }) =>
        setLoaded({ status: 'ready', title: chat.title, messages: toUIMessages(messages) }),
      )
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        const notFound = error instanceof ApiError && error.status === 404;
        setLoaded({ status: notFound ? 'missing' : 'error' });
      });
    return () => controller.abort();
  }, [chatId, attempt]);

  if (loaded.status === 'missing') return <Navigate to="/" replace />;

  if (loaded.status === 'loading') {
    return (
      <p role="status" className="flex items-center gap-2 px-6 py-8 text-sm text-muted-foreground">
        <Loader2Icon className="size-4 animate-spin" aria-hidden />
        Loading conversation…
      </p>
    );
  }

  if (loaded.status === 'error') {
    return (
      <div className="flex flex-col items-start gap-3 px-6 py-8">
        <p role="alert" className="text-sm text-destructive">
          Could not load this conversation.
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
    );
  }

  const listed = state.status === 'ready' ? state.chats.find((chat) => chat.id === chatId) : null;

  return (
    <div className="mx-auto flex h-full max-w-3xl flex-col">
      <ChatHeader chatId={chatId} title={listed?.title ?? loaded.title} />
      <ChatView chatId={chatId} initialMessages={loaded.messages} />
    </div>
  );
}
