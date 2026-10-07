import { createContext, useContext } from 'react';
import type { Chat } from './api';

export type ChatsState =
  { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; chats: Chat[] };

export interface ChatsContextValue {
  state: ChatsState;
  reload: () => void;
  refresh: () => Promise<void>;
  createChat: () => Promise<Chat>;
  renameChat: (id: string, title: string) => Promise<void>;
  removeChat: (id: string) => Promise<void>;
}

export const ChatsContext = createContext<ChatsContextValue | null>(null);

export function useChats(): ChatsContextValue {
  const value = useContext(ChatsContext);
  if (!value) throw new Error('useChats must be used inside <ChatsProvider>');
  return value;
}
