import { cn } from '@/lib/utils';
import { SourceList } from './SourceList';
import { sourcesOf, textOf, type ChatUIMessage } from './types';

export function MessageBubble({ message }: { message: ChatUIMessage }) {
  const isUser = message.role === 'user';
  const text = textOf(message);

  return (
    <div className={cn('flex', isUser ? 'justify-end' : 'justify-start')}>
      <div
        className={cn(
          'max-w-[85%] rounded-2xl px-4 py-2.5 text-sm',
          isUser ? 'bg-primary text-primary-foreground' : 'border bg-background',
        )}
      >
        <p className="break-words whitespace-pre-wrap">{text}</p>
        {!isUser && <SourceList sources={sourcesOf(message)} />}
      </div>
    </div>
  );
}
