import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { ApiError } from '../../lib/api';
import { chatsApi, type Chat } from './api';
import { ChatsContext, type ChatsContextValue, type ChatsState } from './chats-context';

function describe(error: unknown): string {
  if (error instanceof ApiError && error.isUnavailable) {
    return 'The server is not responding. It may be waking up, try again in a moment.';
  }
  return 'Could not load your conversations.';
}

export function ChatsProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<ChatsState>({ status: 'loading' });
  const [reloadCount, setReloadCount] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    chatsApi
      .list(controller.signal)
      .then((chats) => setState({ status: 'ready', chats }))
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setState({ status: 'error', message: describe(error) });
      });
    return () => controller.abort();
  }, [reloadCount]);

  const reload = useCallback(() => {
    setState({ status: 'loading' });
    setReloadCount((n) => n + 1);
  }, []);

  const refresh = useCallback(async () => {
    try {
      const chats = await chatsApi.list();
      setState({ status: 'ready', chats });
    } catch {
      return;
    }
  }, []);

  const createChat = useCallback(async (): Promise<Chat> => {
    const chat = await chatsApi.create();
    setState((current) =>
      current.status === 'ready' ? { status: 'ready', chats: [chat, ...current.chats] } : current,
    );
    return chat;
  }, []);

  const value = useMemo<ChatsContextValue>(
    () => ({ state, reload, refresh, createChat }),
    [state, reload, refresh, createChat],
  );

  return <ChatsContext.Provider value={value}>{children}</ChatsContext.Provider>;
}
