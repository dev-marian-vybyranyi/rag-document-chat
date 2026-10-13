import type { ParsedTranscript } from './transcript.js';
import { MAX_AUDIO_BYTES } from './transcriber.js';

export interface TranscriptLimits {
  maxBytes: number;
  maxAudioBytes: number;
  maxCharacters: number;
  maxTurns: number;
  maxSpeakers: number;
}

export const defaultTranscriptLimits: TranscriptLimits = {
  maxBytes: 1_000_000,
  maxAudioBytes: MAX_AUDIO_BYTES,
  maxCharacters: 150_000,
  maxTurns: 20_000,
  maxSpeakers: 50,
};

export function transcriptLimitProblem(
  transcript: ParsedTranscript,
  limits: TranscriptLimits,
): string | null {
  if (transcript.turns.length > limits.maxTurns) {
    return `The transcript has too many turns (limit ${limits.maxTurns.toLocaleString('en-US')})`;
  }
  if (transcript.participants.length > limits.maxSpeakers) {
    return `The transcript has too many speakers (limit ${limits.maxSpeakers})`;
  }
  const characters = transcript.turns.reduce((sum, turn) => sum + turn.text.length, 0);
  if (characters > limits.maxCharacters) {
    return `The transcript is too long (limit ${limits.maxCharacters.toLocaleString('en-US')} characters)`;
  }
  return null;
}
