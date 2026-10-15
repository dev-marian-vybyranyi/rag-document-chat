import type { IngestionService } from '../../src/documents/ingest.js';

export function createInertIngestion(): IngestionService {
  return { enqueue: () => {}, pending: () => 0, idle: async () => {} };
}
