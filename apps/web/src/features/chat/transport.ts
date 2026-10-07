import { DefaultChatTransport } from 'ai';
import { reportUnauthorized } from '@/lib/api';
import { textOf, type ChatUIMessage } from './types';

async function fetchWithReadableErrors(input: RequestInfo | URL, init?: RequestInit) {
  const response = await fetch(input, init);
  if (response.ok) return response;
  if (response.status === 401) reportUnauthorized();

  let message = `Request failed (${response.status})`;
  try {
    const body = (await response.json()) as { error?: { message?: string } };
    if (body.error?.message) message = body.error.message;
  } catch {
    message = 'The server returned an unexpected response.';
  }
  return new Response(message, { status: response.status });
}

export function createChatTransport(chatId: string) {
  return new DefaultChatTransport<ChatUIMessage>({
    api: `/api/chats/${chatId}/messages`,
    fetch: (input, init) =>
      fetchWithReadableErrors(input, init).catch(() => {
        throw new Error('Cannot reach the server. Check your connection.');
      }),
    prepareSendMessagesRequest: ({ messages }) => {
      const last = messages.findLast((message) => message.role === 'user');
      return { body: { content: last ? textOf(last) : '' } };
    },
  });
}
