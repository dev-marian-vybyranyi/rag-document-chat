export interface TranscriptLimits {
  maxBytes: number;
  maxCharacters: number;
  maxTurns: number;
  maxSpeakers: number;
}

export const defaultTranscriptLimits: TranscriptLimits = {
  maxBytes: 1_000_000,
  maxCharacters: 150_000,
  maxTurns: 20_000,
  maxSpeakers: 50,
};
