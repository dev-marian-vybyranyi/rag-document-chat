import { Loader2Icon, XIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { AddRepositoryDialog } from '@/features/documents/AddRepositoryDialog';
import { useDocuments } from '@/features/documents/documents-context';
import { DocumentRow } from '@/features/documents/DocumentRow';
import { Dropzone } from '@/features/documents/Dropzone';

export function DocumentsPage() {
  const { state, uploads, announcement, upload, dismissUpload, reload } = useDocuments();

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6 px-4 py-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-xl font-semibold">Your documents</h2>
        <AddRepositoryDialog />
      </div>
      <Dropzone onFiles={upload} />
      <p role="status" className="sr-only">
        {announcement}
      </p>

      {uploads.length > 0 && (
        <ul className="flex flex-col gap-2" aria-label="Uploads">
          {uploads.map((entry) => (
            <li
              key={entry.key}
              className="flex items-center gap-3 rounded-lg border bg-background px-4 py-3 text-sm"
            >
              {entry.state === 'uploading' ? (
                <>
                  <Loader2Icon className="size-4 animate-spin" aria-hidden />
                  <span className="min-w-0 flex-1 truncate">Uploading {entry.filename}…</span>
                </>
              ) : (
                <>
                  <p role="alert" className="min-w-0 flex-1 text-destructive">
                    <span className="font-medium">{entry.filename}:</span> {entry.message}
                  </p>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`Dismiss ${entry.filename}`}
                    onClick={() => dismissUpload(entry.key)}
                  >
                    <XIcon aria-hidden />
                  </Button>
                </>
              )}
            </li>
          ))}
        </ul>
      )}

      {state.status === 'loading' && (
        <div role="status" className="flex flex-col gap-2">
          <span className="sr-only">Loading documents…</span>
          <Skeleton className="h-14 w-full" />
          <Skeleton className="h-14 w-full" />
        </div>
      )}

      {state.status === 'error' && (
        <div className="flex flex-col items-start gap-2">
          <p role="alert" className="text-sm text-destructive">
            Could not load your documents.
          </p>
          <Button variant="outline" size="sm" onClick={reload}>
            Try again
          </Button>
        </div>
      )}

      {state.status === 'ready' && state.documents.length === 0 && (
        <p className="text-center text-sm text-muted-foreground">
          No documents yet. Add one above to start asking questions about it.
        </p>
      )}

      {state.status === 'ready' && state.documents.length > 0 && (
        <ul className="flex flex-col gap-2" aria-label="Documents">
          {state.documents.map((document) => (
            <DocumentRow key={document.id} document={document} />
          ))}
        </ul>
      )}
    </div>
  );
}
