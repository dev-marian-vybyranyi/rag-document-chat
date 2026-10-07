import { FileTextIcon, Trash2Icon } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import type { DocumentItem } from './api';
import { useStartChat } from '../chats/useStartChat';
import { useDocuments } from './documents-context';
import { formatBytes } from './validation';

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

function describeStatus(document: DocumentItem): string {
  if (document.status === 'processing') return 'Processing…';
  if (document.status === 'failed') return 'Failed';
  const parts = ['Ready'];
  if (document.pageCount !== null) parts.push(plural(document.pageCount, 'page'));
  parts.push(plural(document.chunkCount, 'passage'));
  return parts.join(' · ');
}

export function DocumentRow({ document }: { document: DocumentItem }) {
  const { remove } = useDocuments();
  const { start, failed: startFailed } = useStartChat();
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);

  async function confirmRemove() {
    setPending(true);
    setFailed(false);
    try {
      await remove(document.id);
    } catch {
      setFailed(true);
      setPending(false);
    }
  }

  return (
    <li className="flex flex-col gap-1 rounded-lg border bg-background px-4 py-3">
      <div className="flex items-center gap-3">
        <FileTextIcon className="size-5 shrink-0 text-muted-foreground" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium" title={document.filename}>
            {document.filename}
          </p>
          <p className="text-xs text-muted-foreground">
            {formatBytes(document.sizeBytes)} · {describeStatus(document)}
          </p>
        </div>
        {confirming ? (
          <div className="flex items-center gap-2">
            <span className="text-sm">Delete?</span>
            <Button variant="destructive" size="sm" onClick={confirmRemove} disabled={pending}>
              Delete
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setConfirming(false)}
              disabled={pending}
            >
              Cancel
            </Button>
          </div>
        ) : (
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`Delete ${document.filename}`}
            onClick={() => {
              setFailed(false);
              setConfirming(true);
            }}
          >
            <Trash2Icon aria-hidden />
          </Button>
        )}
      </div>
      {document.status === 'processing' && (
        <div
          role="progressbar"
          aria-label={`Processing ${document.filename}`}
          className="relative h-1 overflow-hidden rounded-full bg-muted"
        >
          <div className="absolute inset-y-0 w-1/3 animate-[indeterminate_1.4s_ease-in-out_infinite] rounded-full bg-primary" />
        </div>
      )}
      {document.status === 'ready' && document.suggestions.length > 0 && (
        <ul
          className="flex flex-wrap gap-1.5 pt-1"
          aria-label={`Questions to ask about ${document.filename}`}
        >
          {document.suggestions.map((question) => (
            <li key={question} className="max-w-full">
              <Button
                variant="outline"
                size="xs"
                className="h-auto max-w-full py-1 text-left whitespace-normal"
                onClick={() => void start(question)}
              >
                {question}
              </Button>
            </li>
          ))}
        </ul>
      )}
      {startFailed && (
        <p role="alert" className="text-sm text-destructive">
          Could not start a chat. Try again.
        </p>
      )}
      {document.status === 'failed' && document.error && (
        <p className="text-sm text-destructive">{document.error}</p>
      )}
      {failed && (
        <p role="alert" className="text-sm text-destructive">
          Could not delete the document. Try again.
        </p>
      )}
    </li>
  );
}
