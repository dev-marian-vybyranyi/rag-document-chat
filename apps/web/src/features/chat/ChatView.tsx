import { useChat } from '@ai-sdk/react';
import { Loader2Icon } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { useChats } from '@/features/chats/chats-context';
import { Composer } from './Composer';
import { MessageBubble } from './MessageBubble';
import { SuggestedQuestions } from './SuggestedQuestions';
import { createChatTransport } from './transport';
import { textOf, type ChatStage, type ChatUIMessage } from './types';

interface ChatViewProps {
  chatId: string;
  sourceIds?: string[] | null;
  initialMessages?: ChatUIMessage[];
  initialQuestion?: string;
  onInitialQuestionSent?: () => void;
}

function questionBefore(messages: ChatUIMessage[], index: number): string {
  for (let i = index - 1; i >= 0; i--) {
    const candidate = messages[i]!;
    if (candidate.role === 'user') return textOf(candidate);
  }
  return '';
}

const STAGE_LABEL: Record<ChatStage, string> = {
  searching: 'Searching your documents…',
  answering: 'Writing the answer…',
};

export function ChatView({
  chatId,
  sourceIds = null,
  initialMessages,
  initialQuestion,
  onInitialQuestionSent,
}: ChatViewProps) {
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

  const askedInitial = useRef(false);
  useEffect(() => {
    if (!initialQuestion || askedInitial.current) return;
    askedInitial.current = true;
    setStage('searching');
    void sendMessage({ text: initialQuestion });
    onInitialQuestionSent?.();
  }, [initialQuestion, sendMessage, onInitialQuestionSent]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-6">
        {messages.length === 0 && !busy && (
          <div className="mt-16 text-center">
            <p className="text-sm text-muted-foreground">
              Ask a question about your documents or code to start.
            </p>
            <SuggestedQuestions onPick={handleSend} sourceIds={sourceIds} />
          </div>
        )}
        <ul className="flex flex-col gap-4" aria-label="Conversation">
          {messages.map((message, index) => (
            <li key={message.id}>
              <MessageBubble message={message} question={questionBefore(messages, index)} />
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
