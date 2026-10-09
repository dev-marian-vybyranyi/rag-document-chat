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

  const createChat = useCallback(async (sourceIds: string[] | null = null): Promise<Chat> => {
    const chat = await chatsApi.create(sourceIds);
    setState((current) =>
      current.status === 'ready' ? { status: 'ready', chats: [chat, ...current.chats] } : current,
    );
    return chat;
  }, []);

  const renameChat = useCallback(async (id: string, title: string) => {
    const renamed = await chatsApi.rename(id, title);
    setState((current) =>
      current.status === 'ready'
        ? {
            status: 'ready',
            chats: current.chats.map((chat) => (chat.id === id ? renamed : chat)),
          }
        : current,
    );
  }, []);

  const setChatSources = useCallback(async (id: string, sourceIds: string[] | null) => {
    const updated = await chatsApi.setSources(id, sourceIds);
    setState((current) =>
      current.status === 'ready'
        ? {
            status: 'ready',
            chats: current.chats.map((chat) => (chat.id === id ? updated : chat)),
          }
        : current,
    );
  }, []);

  const removeChat = useCallback(async (id: string) => {
    await chatsApi.remove(id);
    setState((current) =>
      current.status === 'ready'
        ? { status: 'ready', chats: current.chats.filter((chat) => chat.id !== id) }
        : current,
    );
  }, []);

  const value = useMemo<ChatsContextValue>(
    () => ({ state, reload, refresh, createChat, setChatSources, renameChat, removeChat }),
    [state, reload, refresh, createChat, setChatSources, renameChat, removeChat],
  );

  return <ChatsContext.Provider value={value}>{children}</ChatsContext.Provider>;
}
