import { Navigate, useParams } from 'react-router';
import { ChatView } from '@/features/chat/ChatView';
import { useChats } from '@/features/chats/chats-context';

export function ChatPage() {
  const { chatId } = useParams();
  const { state } = useChats();

  if (!chatId || state.status === 'loading') return null;
  if (state.status === 'ready' && !state.chats.some((chat) => chat.id === chatId)) {
    return <Navigate to="/" replace />;
  }

  return <ChatView key={chatId} chatId={chatId} />;
}
