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

export interface Passage {
  ordinal: number;
  page: number | null;
  content: string;
}

export interface PassagesResponse {
  document: { id: string; filename: string; pageCount: number | null };
  target: number;
  passages: Passage[];
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
  passages: (documentId: string, ordinal: number, radius: number, signal?: AbortSignal) =>
    api<PassagesResponse>(`/documents/${documentId}/passages?ordinal=${ordinal}&radius=${radius}`, {
      signal,
    }),
  remove: (id: string) => api<void>(`/documents/${id}`, { method: 'DELETE' }),
};
