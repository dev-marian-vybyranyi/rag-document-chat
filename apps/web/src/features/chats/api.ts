import { api } from '../../lib/api';

export interface Chat {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

export const chatsApi = {
  list: (signal?: AbortSignal) => api<{ chats: Chat[] }>('/chats', { signal }).then((r) => r.chats),
  create: () => api<{ chat: Chat }>('/chats', { method: 'POST', body: {} }).then((r) => r.chat),
};
