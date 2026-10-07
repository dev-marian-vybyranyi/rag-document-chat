import { api } from '../../lib/api';
import type { ChatRetrieval, ChatSource } from '../chat/types';

export interface Chat {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

export interface StoredMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  sources: ChatSource[];
  retrieval: ChatRetrieval | null;
  createdAt: string;
}

export const DEFAULT_CHAT_TITLE = 'New chat';
export const MAX_TITLE_LENGTH = 120;

export const chatsApi = {
  list: (signal?: AbortSignal) => api<{ chats: Chat[] }>('/chats', { signal }).then((r) => r.chats),
  get: (id: string, signal?: AbortSignal) =>
    api<{ chat: Chat; messages: StoredMessage[] }>(`/chats/${id}`, { signal }),
  rename: (id: string, title: string) =>
    api<{ chat: Chat }>(`/chats/${id}`, { method: 'PATCH', body: { title } }).then((r) => r.chat),
  remove: (id: string) => api<void>(`/chats/${id}`, { method: 'DELETE' }),
  create: () => api<{ chat: Chat }>('/chats', { method: 'POST', body: {} }).then((r) => r.chat),
};
