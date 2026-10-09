import { useEffect, useState } from 'react';
import { Navigate, useLocation, useNavigate, useParams } from 'react-router';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { ChatHeader } from '@/features/chat/ChatHeader';
import { ChatView } from '@/features/chat/ChatView';
import { SourceViewer } from '@/features/chat/SourceViewer';
import { WhyThisAnswer } from '@/features/chat/WhyThisAnswer';
import { SourceViewerProvider } from '@/features/chat/SourceViewerProvider';
import { toUIMessages } from '@/features/chat/history';
import type { ChatUIMessage } from '@/features/chat/types';
import { chatsApi } from '@/features/chats/api';
import { useChats } from '@/features/chats/chats-context';
import { ApiError } from '@/lib/api';

type Loaded =
  | { status: 'loading' }
  | { status: 'missing' }
  | { status: 'error' }
  | { status: 'ready'; title: string; sourceIds: string[] | null; messages: ChatUIMessage[] };

export function ChatPage() {
  const { chatId } = useParams();
  if (!chatId) return <Navigate to="/" replace />;
  return <LoadedChat key={chatId} chatId={chatId} />;
}

function LoadedChat({ chatId }: { chatId: string }) {
  const { state } = useChats();
  const location = useLocation();
  const navigate = useNavigate();
  const initialQuestion = (location.state as { ask?: string } | null)?.ask;
  const [loaded, setLoaded] = useState<Loaded>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    chatsApi
      .get(chatId, controller.signal)
      .then(({ chat, messages }) =>
        setLoaded({
          status: 'ready',
          title: chat.title,
          sourceIds: chat.sourceIds ?? null,
          messages: toUIMessages(messages),
        }),
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
      <div role="status" className="mx-auto flex max-w-3xl flex-col gap-4 px-4 py-6">
        <span className="sr-only">Loading conversation…</span>
        <Skeleton className="ml-auto h-10 w-1/2" />
        <Skeleton className="h-24 w-4/5" />
      </div>
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
  const sourceIds = listed ? (listed.sourceIds ?? null) : loaded.sourceIds;

  return (
    <SourceViewerProvider>
      <div className="flex h-full">
        <div className="mx-auto flex h-full min-w-0 max-w-3xl flex-1 flex-col">
          <ChatHeader chatId={chatId} title={listed?.title ?? loaded.title} sourceIds={sourceIds} />
          <ChatView
            chatId={chatId}
            sourceIds={sourceIds}
            initialMessages={loaded.messages}
            initialQuestion={initialQuestion}
            onInitialQuestionSent={() =>
              void navigate(location.pathname, { replace: true, state: null })
            }
          />
        </div>
        <SourceViewer />
        <WhyThisAnswer />
      </div>
    </SourceViewerProvider>
  );
}
