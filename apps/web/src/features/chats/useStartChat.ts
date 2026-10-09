import { useCallback, useState } from 'react';
import { useNavigate } from 'react-router';
import { useChats } from './chats-context';

export function useStartChat() {
  const { createChat } = useChats();
  const navigate = useNavigate();
  const [failed, setFailed] = useState(false);

  const start = useCallback(
    async (question: string, sourceIds: string[] | null = null) => {
      setFailed(false);
      try {
        const chat = await createChat(sourceIds);
        void navigate(`/chats/${chat.id}`, { state: { ask: question } });
      } catch {
        setFailed(true);
      }
    },
    [createChat, navigate],
  );

  return { start, failed };
}
