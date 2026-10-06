import type { Database } from '../db/client.js';
import { documents } from '../db/schema.js';

export type DocumentRecord = typeof documents.$inferSelect;

export function createDocumentRepository(db: Database) {
  return {
    async create(input: {
      userId: string;
      filename: string;
      mimeType: string;
      sizeBytes: number;
    }): Promise<DocumentRecord> {
      const [document] = await db.insert(documents).values(input).returning();
      return document!;
    },
  };
}

export type DocumentRepository = ReturnType<typeof createDocumentRepository>;
