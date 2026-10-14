import { createContext, useContext } from 'react';
import type { DocumentItem, JobDetails, MeetingDetails } from './api';

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
  comparingIds: string[];
  reload: () => void;
  upload: (files: File[]) => void;
  addRepositoryUrl: (url: string) => Promise<void>;
  addRepositoryZip: (file: File) => Promise<void>;
  addMeeting: (file: File, details?: MeetingDetails) => Promise<void>;
  addRecording: (file: File, details?: MeetingDetails) => Promise<void>;
  addResume: (file: File) => Promise<void>;
  addJob: (file: File, details?: JobDetails) => Promise<void>;
  analyze: (id: string) => Promise<void>;
  compare: (id: string) => Promise<void>;
  regenerateNotes: (id: string) => Promise<void>;
  dismissUpload: (key: number) => void;
  remove: (id: string) => Promise<void>;
}

export const DocumentsContext = createContext<DocumentsContextValue | null>(null);

export function useDocuments(): DocumentsContextValue {
  const value = useContext(DocumentsContext);
  if (!value) throw new Error('useDocuments must be used inside <DocumentsProvider>');
  return value;
}
