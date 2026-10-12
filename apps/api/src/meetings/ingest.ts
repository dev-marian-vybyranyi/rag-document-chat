import type { ParsedTranscript } from './transcript.js';

export interface MeetingJob {
  document: { id: string; userId: string; filename: string };
  transcript: ParsedTranscript;
}

export interface MeetingIngestionService {
  enqueue(job: MeetingJob): void;
  idle(): Promise<void>;
}
