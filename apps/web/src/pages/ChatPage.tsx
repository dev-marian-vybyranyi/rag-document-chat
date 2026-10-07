import { Navigate, useParams } from 'react-router';
import { useChats } from '@/features/chats/chats-context';

export function ChatPage() {
  const { chatId } = useParams();
  const { state } = useChats();

  if (state.status === 'loading') return null;
  if (state.status === 'ready' && !state.chats.some((chat) => chat.id === chatId)) {
    return <Navigate to="/" replace />;
  }

  const chat = state.status === 'ready' ? state.chats.find((c) => c.id === chatId) : undefined;
  return (
    <div className="mx-auto max-w-3xl px-6 py-8">
      <h2 className="truncate text-xl font-semibold">{chat?.title ?? 'Conversation'}</h2>
    </div>
  );
}
