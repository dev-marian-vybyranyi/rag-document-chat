export interface Turn {
  speaker: string;
  startMs: number;
  text: string;
}

export interface ParsedTranscript {
  turns: Turn[];
  participants: string[];
  durationMs: number;
  outOfOrderTurns: number;
}

export class TranscriptParseError extends Error {
  constructor(
    message: string,
    readonly line: number | null = null,
  ) {
    super(line === null ? message : `Line ${line}: ${message}`);
    this.name = 'TranscriptParseError';
  }
}
