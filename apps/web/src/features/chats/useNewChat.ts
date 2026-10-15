import { useCallback, useState } from 'react';
import { useNavigate } from 'react-router';
import { DEFAULT_CHAT_TITLE, type Chat } from './api';
import { useChats } from './chats-context';

function isUntouched(chat: Chat): boolean {
  return chat.title === DEFAULT_CHAT_TITLE && chat.updatedAt === chat.createdAt && !chat.sourceIds;
}

export function useNewChat() {
  const { state, createChat } = useChats();
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);
  const [failed, setFailed] = useState(false);

  const open = useCallback(async () => {
    setCreating(true);
    setFailed(false);
    try {
      const untouched = state.status === 'ready' ? state.chats.find(isUntouched) : undefined;
      const chat = untouched ?? (await createChat());
      void navigate(`/chats/${chat.id}`);
    } catch {
      setFailed(true);
    } finally {
      setCreating(false);
    }
  }, [state, createChat, navigate]);

  return { open, creating, failed };
}
