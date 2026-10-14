import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ApiError } from '../../lib/api';
import { documentsApi, type DocumentItem, type JobDetails, type MeetingDetails } from './api';
import {
  DocumentsContext,
  type DocumentsContextValue,
  type DocumentsState,
  type UploadEntry,
} from './documents-context';
import { awaitsFit } from './career-status';
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

export const MAX_FIT_POLLS = 30;

export function DocumentsProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<DocumentsState>({ status: 'loading' });
  const [uploads, setUploads] = useState<UploadEntry[]>([]);
  const [reloadCount, setReloadCount] = useState(0);
  const [exhaustedKey, setExhaustedKey] = useState<string | null>(null);
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

  const refresh = useCallback(async (signal: AbortSignal) => {
    const fresh = new Map((await documentsApi.list(signal)).map((doc) => [doc.id, doc]));
    setState((current) => {
      if (current.status !== 'ready') return current;
      const documents = current.documents.map((doc) => fresh.get(doc.id) ?? doc);
      const message = announcementFor(current.documents, documents);
      return { ...current, documents, announcement: message || current.announcement };
    });
  }, []);

  useEffect(() => {
    if (!anyProcessing) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    let attempt = 0;

    const poll = async () => {
      try {
        await refresh(controller.signal);
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
  }, [anyProcessing, refresh]);

  const awaitingFit = useMemo(
    () =>
      state.status === 'ready'
        ? state.documents.filter((doc) => awaitsFit(doc, state.documents)).map((doc) => doc.id)
        : [],
    [state],
  );
  const awaitingKey = awaitingFit.join(',');
  const comparingIds = useMemo(
    () => (awaitingKey === '' || exhaustedKey === awaitingKey ? [] : awaitingFit),
    [awaitingKey, exhaustedKey, awaitingFit],
  );

  useEffect(() => {
    if (awaitingKey === '') return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    let attempt = 0;

    const poll = async () => {
      try {
        await refresh(controller.signal);
      } catch {
        if (controller.signal.aborted) return;
      }
      attempt++;
      if (attempt >= MAX_FIT_POLLS) {
        setExhaustedKey(awaitingKey);
        return;
      }
      timer = setTimeout(poll, pollDelay(attempt));
    };

    timer = setTimeout(poll, pollDelay(0));
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [awaitingKey, refresh]);

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

  const addDocument = useCallback((document: DocumentItem) => {
    setState((current) =>
      current.status === 'ready'
        ? { ...current, documents: [document, ...current.documents] }
        : current,
    );
  }, []);

  const addRepositoryUrl = useCallback(
    async (url: string) => addDocument(await documentsApi.addRepositoryUrl(url)),
    [addDocument],
  );

  const addRepositoryZip = useCallback(
    async (file: File) => addDocument(await documentsApi.addRepositoryZip(file)),
    [addDocument],
  );

  const addMeeting = useCallback(
    async (file: File, details?: MeetingDetails) =>
      addDocument(await documentsApi.addMeeting(file, details)),
    [addDocument],
  );

  const addRecording = useCallback(
    async (file: File, details?: MeetingDetails) =>
      addDocument(await documentsApi.addRecording(file, details)),
    [addDocument],
  );

  const addResume = useCallback(
    async (file: File) => addDocument(await documentsApi.addResume(file)),
    [addDocument],
  );

  const addJob = useCallback(
    async (file: File, details?: JobDetails) =>
      addDocument(await documentsApi.addJob(file, details)),
    [addDocument],
  );

  const replaceDocument = useCallback((fresh: DocumentItem) => {
    setState((current) =>
      current.status === 'ready'
        ? {
            ...current,
            documents: current.documents.map((doc) => (doc.id === fresh.id ? fresh : doc)),
          }
        : current,
    );
  }, []);

  const analyze = useCallback(
    async (id: string) => replaceDocument(await documentsApi.analyze(id)),
    [replaceDocument],
  );

  const compare = useCallback(
    async (id: string) => replaceDocument(await documentsApi.compare(id)),
    [replaceDocument],
  );

  const regenerateNotes = useCallback(async (id: string) => {
    const fresh = await documentsApi.regenerateNotes(id);
    setState((current) =>
      current.status === 'ready'
        ? {
            ...current,
            documents: current.documents.map((doc) => (doc.id === fresh.id ? fresh : doc)),
          }
        : current,
    );
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
    () => ({
      state,
      uploads,
      announcement,
      anyProcessing,
      comparingIds,
      reload,
      upload,
      addRepositoryUrl,
      addRepositoryZip,
      addMeeting,
      addRecording,
      addResume,
      addJob,
      analyze,
      compare,
      regenerateNotes,
      dismissUpload,
      remove,
    }),
    [
      state,
      uploads,
      announcement,
      anyProcessing,
      comparingIds,
      reload,
      upload,
      addRepositoryUrl,
      addRepositoryZip,
      addMeeting,
      addRecording,
      addResume,
      addJob,
      analyze,
      compare,
      regenerateNotes,
      dismissUpload,
      remove,
    ],
  );

  return <DocumentsContext.Provider value={value}>{children}</DocumentsContext.Provider>;
}
