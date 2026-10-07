import { useChat } from '@ai-sdk/react';
import { Loader2Icon } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { useChats } from '@/features/chats/chats-context';
import { Composer } from './Composer';
import { MessageBubble } from './MessageBubble';
import { createChatTransport } from './transport';
import { textOf, type ChatStage, type ChatUIMessage } from './types';

interface ChatViewProps {
  chatId: string;
  initialMessages?: ChatUIMessage[];
}

const STAGE_LABEL: Record<ChatStage, string> = {
  searching: 'Searching your documents…',
  answering: 'Writing the answer…',
};

export function ChatView({ chatId, initialMessages }: ChatViewProps) {
  const { refresh } = useChats();
  const transport = useMemo(() => createChatTransport(chatId), [chatId]);
  const [stage, setStage] = useState<ChatStage>('searching');
  const bottomRef = useRef<HTMLDivElement>(null);

  const { messages, sendMessage, status, error, stop } = useChat<ChatUIMessage>({
    id: chatId,
    messages: initialMessages,
    transport,
    onData: (part) => {
      if (part.type === 'data-status') setStage(part.data.stage);
    },
    onFinish: () => {
      void refresh();
    },
  });

  const busy = status === 'submitted' || status === 'streaming';
  const last = messages.at(-1);
  const waiting = busy && (last?.role !== 'assistant' || textOf(last).length === 0);

  useEffect(() => {
    bottomRef.current?.scrollIntoView?.({ block: 'end' });
  }, [messages, waiting]);

  function handleSend(text: string) {
    setStage('searching');
    void sendMessage({ text });
  }

  return (
    <div className="mx-auto flex h-full max-w-3xl flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-6">
        {messages.length === 0 && (
          <p className="mt-16 text-center text-sm text-muted-foreground">
            Ask a question about your documents to start.
          </p>
        )}
        <ul className="flex flex-col gap-4" aria-label="Conversation">
          {messages.map((message) => (
            <li key={message.id}>
              <MessageBubble message={message} />
            </li>
          ))}
        </ul>
        {waiting && (
          <p role="status" className="mt-4 flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2Icon className="size-4 animate-spin" aria-hidden />
            {STAGE_LABEL[stage]}
          </p>
        )}
        <div ref={bottomRef} />
      </div>

      <div className="flex flex-col gap-2 border-t bg-background px-4 py-3">
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error.message}</AlertDescription>
          </Alert>
        )}
        <Composer busy={busy} onSend={handleSend} onStop={stop} />
      </div>
    </div>
  );
}
