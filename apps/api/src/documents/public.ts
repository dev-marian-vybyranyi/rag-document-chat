import type { DocumentWithChunkCount } from './repository.js';

export function toPublicDocument(document: DocumentWithChunkCount) {
  const progress =
    document.status === 'processing' && document.progressPhase
      ? {
          phase: document.progressPhase,
          done: document.progressDone ?? 0,
          total: document.progressTotal ?? 0,
        }
      : null;

  return {
    id: document.id,
    kind: document.kind,
    filename: document.filename,
    mimeType: document.mimeType,
    sizeBytes: document.sizeBytes,
    status: document.status,
    error: document.error,
    pageCount: document.pageCount,
    chunkCount: document.chunkCount,
    fileCount: document.fileCount,
    repoUrl: document.repoUrl,
    repoRef: document.repoRef,
    commitSha: document.commitSha,
    progress,
    suggestions: document.suggestions,
    createdAt: document.createdAt,
  };
}
