import { APICallError, RetryError } from 'ai';
import { isInvalidKeyResponse } from '../ai/api-errors.js';
import { quotaInfoOf } from '../ai/quota.js';
import { stripInvisibleCharacters } from '../rag/sanitize.js';
import { cleanSpeakerName, createSpeakerRegistry } from './speakers.js';
import type { ParsedTranscript, Turn } from './transcript.js';

export const MAX_AUDIO_BYTES = 15 * 1024 * 1024;
export const DEFAULT_TRANSCRIPTION_TIMEOUT_MS = 300_000;
export const DEFAULT_TRANSCRIPTION_RETRIES = 2;
export const MAX_MERGED_TURN_CHARS = 600;
export const MAX_MERGED_TURN_SPAN_MS = 30_000;

export const AUDIO_MEDIA_TYPES: Record<string, string> = {
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  m4a: 'audio/mp4',
  webm: 'audio/webm',
};

export interface AudioInput {
  data: Uint8Array;
  mediaType: string;
}

export interface Transcriber {
  transcribe(audio: AudioInput, options?: { signal?: AbortSignal }): Promise<ParsedTranscript>;
}

export interface RawSegment {
  speaker: string | null;
  startMs: number;
  text: string;
}

export type TranscriptionErrorKind =
  | 'rate_limited'
  | 'quota_exhausted'
  | 'misconfigured'
  | 'unavailable'
  | 'timeout'
  | 'cancelled'
  | 'invalid_audio'
  | 'too_long'
  | 'no_speech'
  | 'unexpected';

const USER_MESSAGES: Record<TranscriptionErrorKind, string> = {
  rate_limited:
    'The transcription service is busy (rate limit reached). Please try again in a few minutes.',
  quota_exhausted: 'The quota of the transcription service is used up. Please try again later.',
  misconfigured: 'The transcription service is not configured correctly.',
  unavailable: 'The transcription service is temporarily unavailable. Please try again later.',
  timeout: 'The transcription service took too long to respond. Please try again.',
  cancelled: 'The transcription was cancelled.',
  invalid_audio: 'The recording could not be read as audio that can be transcribed.',
  too_long: 'The recording is too long to transcribe in one go. Try a shorter one.',
  no_speech: 'No speech was found in the recording.',
  unexpected: 'The transcription service returned an unexpected result.',
};

export class TranscriptionError extends Error {
  constructor(
    readonly kind: TranscriptionErrorKind,
    options?: { cause?: unknown },
  ) {
    super(USER_MESSAGES[kind], options);
    this.name = 'TranscriptionError';
  }
}

export function toTranscriptionError(error: unknown): TranscriptionError {
  if (error instanceof TranscriptionError) return error;

  const cause = RetryError.isInstance(error) ? error.lastError : error;

  if (APICallError.isInstance(cause)) {
    const status = cause.statusCode;
    if (status === 429) {
      return new TranscriptionError(quotaInfoOf(cause).daily ? 'quota_exhausted' : 'rate_limited', {
        cause,
      });
    }
    if (status === 401 || status === 403 || isInvalidKeyResponse(cause)) {
      return new TranscriptionError('misconfigured', { cause });
    }
    if (status === 400 || status === 413 || status === 415) {
      return new TranscriptionError('invalid_audio', { cause });
    }
    return new TranscriptionError('unavailable', { cause });
  }
  if (cause instanceof Error && cause.name === 'TimeoutError') {
    return new TranscriptionError('timeout', { cause });
  }
  if (cause instanceof Error && cause.name === 'AbortError') {
    return new TranscriptionError('cancelled', { cause });
  }
  if (cause instanceof TypeError) return new TranscriptionError('unavailable', { cause });
  return new TranscriptionError('unexpected', { cause });
}

const UNKNOWN_SPEAKER = 'Unknown speaker';

function speakerLabel(raw: string | null): string {
  const trimmed = stripInvisibleCharacters(raw ?? '').trim();
  if (/^[\p{L}\p{N}]$/u.test(trimmed)) return `Speaker ${trimmed.toLocaleUpperCase()}`;
  return cleanSpeakerName(trimmed) ?? UNKNOWN_SPEAKER;
}

export function transcriptFromSegments(segments: RawSegment[]): ParsedTranscript {
  const registry = createSpeakerRegistry();
  const turns: Turn[] = [];
  let outOfOrderTurns = 0;
  let previousStartMs = 0;

  for (const segment of segments) {
    const text = stripInvisibleCharacters(segment.text).replace(/\s+/g, ' ').trim();
    if (text === '') continue;

    const speaker = registry.canonical(speakerLabel(segment.speaker));
    const requested = Number.isFinite(segment.startMs) ? Math.max(0, segment.startMs) : 0;
    if (requested < previousStartMs) outOfOrderTurns++;
    const startMs = Math.max(requested, previousStartMs);
    previousStartMs = startMs;

    const last = turns.at(-1);
    if (
      last &&
      last.speaker === speaker &&
      last.text.length + 1 + text.length <= MAX_MERGED_TURN_CHARS &&
      startMs - last.startMs <= MAX_MERGED_TURN_SPAN_MS
    ) {
      last.text = `${last.text} ${text}`;
    } else {
      turns.push({ speaker, startMs, text });
    }
  }

  if (turns.length === 0) throw new TranscriptionError('no_speech');

  return {
    turns,
    participants: registry.names(),
    durationMs: turns.at(-1)!.startMs - turns[0]!.startMs,
    outOfOrderTurns,
  };
}

export function createUnconfiguredTranscriber(keyVariable: string): Transcriber {
  return {
    transcribe: async () => {
      throw new TranscriptionError('misconfigured', {
        cause: new Error(`${keyVariable} is not set`),
      });
    },
  };
}
