import { EmbeddingError, type Embedder } from '../ai/embeddings.js';
import type { DocumentRepository, NewChunk } from '../documents/repository.js';
import type { NotesExtractor } from './notes-extractor.js';
import { notesPassages } from './notes-text.js';
import { turnsFromPassages } from './reconstruct.js';

export type RegenerateResult =
  | { status: 'done' }
  | { status: 'not_found' }
  | { status: 'not_ready' }
  | { status: 'other_model' }
  | { status: 'unavailable' };

export interface MeetingNotesService {
  regenerate(documentId: string, userId: string): Promise<RegenerateResult>;
}

export function createMeetingNotesService({
  repository,
  embedder,
  extractor,
  embeddingModel,
}: {
  repository: DocumentRepository;
  embedder: Embedder;
  extractor: NotesExtractor;
  embeddingModel?: string;
}): MeetingNotesService {
  return {
    async regenerate(documentId, userId) {
      const document = await repository.findForUser(documentId, userId);
      if (!document || document.kind !== 'transcript') return { status: 'not_found' };
      if (document.status !== 'ready') return { status: 'not_ready' };
      if (embeddingModel !== undefined && document.embeddingModel !== embeddingModel) {
        return { status: 'other_model' };
      }

      const turns = turnsFromPassages(await repository.transcriptPassages(documentId, userId));
      const notes = await extractor.extract({
        title: document.filename,
        heldOn: document.meetingHeldOn,
        turns,
      });
      if (!notes) return { status: 'unavailable' };

      const texts = notesPassages(notes, {
        title: document.filename,
        heldOn: document.meetingHeldOn,
        participants: document.participants ?? [],
      });
      let vectors: number[][] = [];
      try {
        if (texts.length > 0) vectors = await embedder.embedDocuments(texts);
      } catch (error) {
        if (error instanceof EmbeddingError) return { status: 'unavailable' };
        throw error;
      }
      await repository.replaceNotes({
        documentId,
        userId,
        notes,
        chunks: texts.map((content, i): Omit<NewChunk, 'ordinal'> => ({
          page: null,
          content,
          tokenCount: Math.ceil(content.length / 4),
          embedding: vectors[i]!,
          speakers: document.participants ?? [],
        })),
      });
      return { status: 'done' };
    },
  };
}
