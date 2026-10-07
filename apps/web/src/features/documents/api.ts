import { api } from '../../lib/api';

export type DocumentStatus = 'processing' | 'ready' | 'failed';

export interface DocumentItem {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  status: DocumentStatus;
  error: string | null;
  pageCount: number | null;
  chunkCount: number;
  createdAt: string;
}

export const documentsApi = {
  list: (signal?: AbortSignal) =>
    api<{ documents: DocumentItem[] }>('/documents', { signal }).then((r) => r.documents),
  upload: (file: File, signal?: AbortSignal) => {
    const form = new FormData();
    form.append('file', file);
    return api<{ document: DocumentItem }>('/documents', {
      method: 'POST',
      body: form,
      signal,
    }).then((r) => r.document);
  },
  remove: (id: string) => api<void>(`/documents/${id}`, { method: 'DELETE' }),
};
