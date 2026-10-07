import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ApiError } from '../../lib/api';
import { documentsApi, type DocumentItem } from './api';
import {
  DocumentsContext,
  type DocumentsContextValue,
  type DocumentsState,
  type UploadEntry,
} from './documents-context';
import { pollDelay } from './polling';
import { MAX_UPLOAD_BYTES, formatBytes, validateFile } from './validation';

function announcementFor(before: DocumentItem[], after: DocumentItem[]): string {
  const previous = new Map(before.map((doc) => [doc.id, doc.status]));
  const messages = after.flatMap((doc) => {
    if (previous.get(doc.id) !== 'processing') return [];
    if (doc.status === 'ready') return [`${doc.filename} is ready.`];
    if (doc.status === 'failed') return [`${doc.filename} could not be processed.`];
    return [];
  });
  return messages.join(' ');
}

function uploadMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 413) {
      return `The file is too large (limit ${formatBytes(MAX_UPLOAD_BYTES)}).`;
    }
    if (error.isUnavailable) return 'The server is not responding. Try again in a moment.';
    return error.message;
  }
  return 'The upload failed. Try again.';
}

export function DocumentsProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<DocumentsState>({ status: 'loading' });
  const [uploads, setUploads] = useState<UploadEntry[]>([]);
  const [reloadCount, setReloadCount] = useState(0);
  const nextKey = useRef(0);

  useEffect(() => {
    const controller = new AbortController();
    documentsApi
      .list(controller.signal)
      .then((documents) => setState({ status: 'ready', documents, announcement: '' }))
      .catch(() => {
        if (!controller.signal.aborted) setState({ status: 'error' });
      });
    return () => controller.abort();
  }, [reloadCount]);

  const anyProcessing =
    state.status === 'ready' && state.documents.some((doc) => doc.status === 'processing');

  useEffect(() => {
    if (!anyProcessing) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    let attempt = 0;

    const poll = async () => {
      try {
        const fresh = new Map(
          (await documentsApi.list(controller.signal)).map((doc) => [doc.id, doc]),
        );
        setState((current) => {
          if (current.status !== 'ready') return current;
          const documents = current.documents.map((doc) => fresh.get(doc.id) ?? doc);
          const message = announcementFor(current.documents, documents);
          return { ...current, documents, announcement: message || current.announcement };
        });
      } catch {
        if (controller.signal.aborted) return;
      }
      timer = setTimeout(poll, pollDelay(attempt++));
    };

    timer = setTimeout(poll, pollDelay(attempt++));
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [anyProcessing]);

  const reload = useCallback(() => {
    setState({ status: 'loading' });
    setReloadCount((n) => n + 1);
  }, []);

  const upload = useCallback((files: File[]) => {
    for (const file of files) {
      const key = nextKey.current++;
      const problem = validateFile(file);
      if (problem) {
        setUploads((current) => [
          ...current,
          { key, filename: file.name, state: 'failed', message: problem },
        ]);
        continue;
      }

      setUploads((current) => [...current, { key, filename: file.name, state: 'uploading' }]);
      documentsApi
        .upload(file)
        .then((document) => {
          setUploads((current) => current.filter((entry) => entry.key !== key));
          setState((current) =>
            current.status === 'ready'
              ? { ...current, documents: [document, ...current.documents] }
              : current,
          );
        })
        .catch((error: unknown) => {
          setUploads((current) =>
            current.map((entry) =>
              entry.key === key
                ? { ...entry, state: 'failed', message: uploadMessage(error) }
                : entry,
            ),
          );
        });
    }
  }, []);

  const dismissUpload = useCallback((key: number) => {
    setUploads((current) => current.filter((entry) => entry.key !== key));
  }, []);

  const remove = useCallback(async (id: string) => {
    await documentsApi.remove(id);
    setState((current) =>
      current.status === 'ready'
        ? { ...current, documents: current.documents.filter((doc) => doc.id !== id) }
        : current,
    );
  }, []);

  const announcement = state.status === 'ready' ? state.announcement : '';

  const value = useMemo<DocumentsContextValue>(
    () => ({ state, uploads, announcement, anyProcessing, reload, upload, dismissUpload, remove }),
    [state, uploads, announcement, anyProcessing, reload, upload, dismissUpload, remove],
  );

  return <DocumentsContext.Provider value={value}>{children}</DocumentsContext.Provider>;
}
