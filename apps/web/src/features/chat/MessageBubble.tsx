import { cn } from '@/lib/utils';
import { Markdown } from './Markdown';
import { SourceList } from './SourceList';
import { WhyButton } from './WhyButton';
import { retrievalOf, sourcesOf, textOf, type ChatUIMessage } from './types';

export function MessageBubble({ message, question }: { message: ChatUIMessage; question: string }) {
  const isUser = message.role === 'user';
  const text = textOf(message);
  const sources = sourcesOf(message);
  const retrieval = retrievalOf(message);

  return (
    <div className={cn('flex', isUser ? 'justify-end' : 'justify-start')}>
      <div
        className={cn(
          'max-w-[85%] rounded-2xl px-4 py-2.5 text-sm',
          isUser ? 'bg-primary text-primary-foreground' : 'border bg-background',
        )}
      >
        {isUser ? (
          <p className="break-words whitespace-pre-wrap">{text}</p>
        ) : (
          <Markdown sources={sources}>{text}</Markdown>
        )}
        {!isUser && <SourceList sources={sources} />}
        {!isUser && retrieval && (
          <WhyButton data={{ question, answer: text, sources, retrieval }} />
        )}
      </div>
    </div>
  );
}
