import { SendIcon, SquareIcon } from 'lucide-react';
import { useState, type FormEvent, type KeyboardEvent } from 'react';
import { Button } from '@/components/ui/button';

export const MAX_QUESTION_LENGTH = 2000;
export const COUNTER_FROM = 1800;

interface ComposerProps {
  busy: boolean;
  onSend: (text: string) => void;
  onStop: () => void;
}

export function Composer({ busy, onSend, onStop }: ComposerProps) {
  const [text, setText] = useState('');
  const trimmed = text.trim();

  function submit() {
    if (busy || trimmed.length === 0) return;
    onSend(trimmed);
    setText('');
  }

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    submit();
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      submit();
    }
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-1">
      <div className="flex items-end gap-2">
        <textarea
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={handleKeyDown}
          aria-label="Your question"
          placeholder="Ask about your documents or code…"
          maxLength={MAX_QUESTION_LENGTH}
          rows={1}
          autoFocus
          className="max-h-40 min-h-9 flex-1 resize-none rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none [field-sizing:content] focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
        />
        {busy ? (
          <Button type="button" variant="outline" size="lg" onClick={onStop}>
            <SquareIcon aria-hidden />
            Stop
          </Button>
        ) : (
          <Button type="submit" size="lg" disabled={trimmed.length === 0}>
            <SendIcon aria-hidden />
            Send
          </Button>
        )}
      </div>
      {text.length >= COUNTER_FROM && (
        <p className="text-right text-xs text-muted-foreground">
          {text.length} / {MAX_QUESTION_LENGTH}
        </p>
      )}
    </form>
  );
}
