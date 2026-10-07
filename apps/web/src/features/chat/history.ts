import type { StoredMessage } from '../chats/api';
import type { ChatUIMessage } from './types';

export function toUIMessages(stored: StoredMessage[]): ChatUIMessage[] {
  return stored.map((message): ChatUIMessage => {
    const parts: ChatUIMessage['parts'] = [];
    if (message.role === 'assistant' && message.retrieval) {
      parts.push({
        type: 'data-sources',
        data: { sources: message.sources, retrieval: message.retrieval },
      });
    }
    parts.push({ type: 'text', text: message.content });
    return { id: message.id, role: message.role, parts };
  });
}
