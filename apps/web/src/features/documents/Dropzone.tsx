import { UploadIcon } from 'lucide-react';
import { useRef, useState, type DragEvent } from 'react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { ACCEPTED_EXTENSIONS, MAX_UPLOAD_BYTES, formatBytes } from './validation';

export function Dropzone({ onFiles }: { onFiles: (files: File[]) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);

  function handleDrop(event: DragEvent) {
    event.preventDefault();
    setDragging(false);
    onFiles(Array.from(event.dataTransfer.files));
  }

  return (
    <div
      onDragOver={(event) => {
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={handleDrop}
      data-dragging={dragging}
      className={cn(
        'flex flex-col items-center gap-3 rounded-xl border-2 border-dashed bg-background px-6 py-10 text-center transition-colors',
        dragging && 'border-primary bg-primary/5',
      )}
    >
      <UploadIcon className="size-8 text-muted-foreground" aria-hidden />
      <div>
        <p className="font-medium">Drop files here to add them</p>
        <p className="mt-1 text-sm text-muted-foreground">
          PDF, TXT or Markdown, up to {formatBytes(MAX_UPLOAD_BYTES)} each
        </p>
      </div>
      <Button variant="outline" onClick={() => input.current?.click()}>
        Choose files
      </Button>
      <input
        ref={input}
        type="file"
        multiple
        hidden
        accept={ACCEPTED_EXTENSIONS.join(',')}
        aria-label="Choose files to upload"
        onChange={(event) => {
          onFiles(Array.from(event.target.files ?? []));
          event.target.value = '';
        }}
      />
    </div>
  );
}
