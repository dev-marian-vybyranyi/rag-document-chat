import { createContext, useContext } from 'react';
import type { DocumentItem } from './api';

export type DocumentsState =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; documents: DocumentItem[]; announcement: string };

export interface UploadEntry {
  key: number;
  filename: string;
  state: 'uploading' | 'failed';
  message?: string;
}

export interface DocumentsContextValue {
  state: DocumentsState;
  uploads: UploadEntry[];
  announcement: string;
  anyProcessing: boolean;
  reload: () => void;
  upload: (files: File[]) => void;
  dismissUpload: (key: number) => void;
  remove: (id: string) => Promise<void>;
}

export const DocumentsContext = createContext<DocumentsContextValue | null>(null);

export function useDocuments(): DocumentsContextValue {
  const value = useContext(DocumentsContext);
  if (!value) throw new Error('useDocuments must be used inside <DocumentsProvider>');
  return value;
}
