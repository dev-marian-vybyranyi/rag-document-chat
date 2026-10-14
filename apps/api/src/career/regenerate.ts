import { EmbeddingError, type Embedder } from '../ai/embeddings.js';
import type { DocumentRepository, NewChunk } from '../documents/repository.js';
import { chunkSections } from './chunker.js';
import type { JobProfileExtractor } from './job-profile.js';
import { careerLabel } from './labels.js';
import { profileSections } from './profile-text.js';
import type { ResumeProfileExtractor } from './resume-profile.js';

export type ProfileResult =
  | { status: 'done' }
  | { status: 'not_found' }
  | { status: 'not_ready' }
  | { status: 'other_model' }
  | { status: 'unavailable' };

export interface CareerProfileService {
  regenerate(documentId: string, userId: string): Promise<ProfileResult>;
}

export function bodyOfPassage(content: string): string {
  return content.slice(content.indexOf('\n') + 1);
}

export function createCareerProfileService({
  repository,
  embedder,
  resumeProfiles,
  jobProfiles,
  embeddingModel,
}: {
  repository: DocumentRepository;
  embedder: Embedder;
  resumeProfiles: ResumeProfileExtractor;
  jobProfiles: JobProfileExtractor;
  embeddingModel?: string;
}): CareerProfileService {
  return {
    async regenerate(documentId, userId) {
      const document = await repository.findForUser(documentId, userId);
      if (!document || (document.kind !== 'resume' && document.kind !== 'job_posting')) {
        return { status: 'not_found' };
      }
      if (document.status !== 'ready') return { status: 'not_ready' };
      if (embeddingModel !== undefined && document.embeddingModel !== embeddingModel) {
        return { status: 'other_model' };
      }

      const text = (await repository.careerPassages(documentId, userId))
        .map(bodyOfPassage)
        .join('\n');
      const profile =
        document.kind === 'resume'
          ? await resumeProfiles.extract(text)
          : await jobProfiles.extract({ name: document.filename, text });
      if (profile === null) return { status: 'unavailable' };

      const passages = chunkSections(profileSections(profile), { label: careerLabel(document) });
      let vectors: number[][] = [];
      try {
        if (passages.length > 0) {
          vectors = await embedder.embedDocuments(passages.map((passage) => passage.content));
        }
      } catch (error) {
        if (error instanceof EmbeddingError) return { status: 'unavailable' };
        throw error;
      }

      await repository.replaceProfile({
        documentId,
        userId,
        profile,
        chunks: passages.map((passage, i): Omit<NewChunk, 'ordinal'> => ({
          page: null,
          section: 'profile',
          content: passage.content,
          tokenCount: passage.tokenCount,
          embedding: vectors[i]!,
        })),
      });
      return { status: 'done' };
    },
  };
}
