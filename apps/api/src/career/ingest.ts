import type { FileType } from '../documents/file-types.js';
import type { DocumentRecord } from '../documents/repository.js';

export interface CareerJob {
  document: Pick<DocumentRecord, 'id' | 'userId' | 'filename' | 'kind' | 'jobNumber'>;
  type: FileType;
  content: Buffer;
}

export interface CareerIngestionService {
  enqueue(job: CareerJob): void;
  idle(): Promise<void>;
}
