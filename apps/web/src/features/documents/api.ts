import { api } from '../../lib/api';

export type DocumentStatus = 'processing' | 'ready' | 'failed';

export type DocumentKind = 'document' | 'repository' | 'transcript';

export interface IngestionProgress {
  phase: 'downloading' | 'reading' | 'analyzing' | 'transcribing' | 'embedding';
  done: number;
  total: number;
}

export interface MeetingNotes {
  summary: string;
  topics: string[];
  decisions: Array<{ text: string; startMs: number; evidence: string }>;
  actionItems: Array<{
    task: string;
    owner: string | null;
    due: string | null;
    startMs: number;
    evidence: string;
  }>;
  openQuestions: string[];
}

export interface MeetingDetails {
  title?: string;
  heldOn?: string;
}

export interface DocumentItem {
  id: string;
  kind: DocumentKind;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  status: DocumentStatus;
  error: string | null;
  pageCount: number | null;
  chunkCount: number;
  fileCount: number | null;
  repoUrl: string | null;
  repoRef: string | null;
  commitSha: string | null;
  meetingHeldOn: string | null;
  participants: string[] | null;
  durationMs: number | null;
  notes: MeetingNotes | null;
  progress: IngestionProgress | null;
  suggestions: string[];
  createdAt: string;
}

export interface CodeLocation {
  path: string;
  language: string | null;
  startLine: number | null;
  endLine: number | null;
  symbol: string | null;
}

export interface MeetingLocation {
  startMs: number | null;
  endMs: number | null;
  speakers: string[];
}

export interface Passage {
  ordinal: number;
  page: number | null;
  code?: CodeLocation;
  meeting?: MeetingLocation;
  content: string;
}

export interface PassagesResponse {
  document: {
    id: string;
    filename: string;
    pageCount: number | null;
    kind: DocumentKind;
    repoUrl: string | null;
    commitSha: string | null;
  };
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
  addRepositoryUrl: (url: string, signal?: AbortSignal) =>
    api<{ document: DocumentItem }>('/repositories', {
      method: 'POST',
      body: { url },
      signal,
    }).then((r) => r.document),
  addRepositoryZip: (file: File, signal?: AbortSignal) => {
    const form = new FormData();
    form.append('file', file);
    return api<{ document: DocumentItem }>('/repositories/upload', {
      method: 'POST',
      body: form,
      signal,
    }).then((r) => r.document);
  },
  addMeeting: (file: File, details: MeetingDetails = {}, signal?: AbortSignal) => {
    const form = new FormData();
    if (details.title) form.append('title', details.title);
    if (details.heldOn) form.append('heldOn', details.heldOn);
    form.append('file', file);
    return api<{ document: DocumentItem }>('/meetings', {
      method: 'POST',
      body: form,
      signal,
    }).then((r) => r.document);
  },
  addRecording: (file: File, details: MeetingDetails = {}, signal?: AbortSignal) => {
    const form = new FormData();
    if (details.title) form.append('title', details.title);
    if (details.heldOn) form.append('heldOn', details.heldOn);
    form.append('file', file);
    return api<{ document: DocumentItem }>('/meetings/audio', {
      method: 'POST',
      body: form,
      signal,
    }).then((r) => r.document);
  },
  regenerateNotes: (id: string, signal?: AbortSignal) =>
    api<{ document: DocumentItem }>(`/meetings/${id}/notes`, { method: 'POST', signal }).then(
      (r) => r.document,
    ),
  passages: (documentId: string, ordinal: number, radius: number, signal?: AbortSignal) =>
    api<PassagesResponse>(`/documents/${documentId}/passages?ordinal=${ordinal}&radius=${radius}`, {
      signal,
    }),
  remove: (id: string) => api<void>(`/documents/${id}`, { method: 'DELETE' }),
};
