import { transcribe, type TranscriptionModel } from 'ai';
import type { Logger } from 'pino';
import { z } from 'zod';
import {
  DEFAULT_TRANSCRIPTION_RETRIES,
  DEFAULT_TRANSCRIPTION_TIMEOUT_MS,
  toTranscriptionError,
  transcriptFromSegments,
  type RawSegment,
  type Transcriber,
} from './transcriber.js';

type ProviderOptions = NonNullable<Parameters<typeof transcribe>[0]['providerOptions']>;

const diarizedSegmentsSchema = z.array(
  z.object({ text: z.string(), startSecond: z.number(), speaker: z.string().optional() }),
);

export function createDiarizingTranscriber({
  model,
  logger,
  providerOptions,
  timeoutMs = DEFAULT_TRANSCRIPTION_TIMEOUT_MS,
  maxRetries = DEFAULT_TRANSCRIPTION_RETRIES,
}: {
  model: TranscriptionModel;
  logger: Logger;
  providerOptions?: ProviderOptions;
  timeoutMs?: number;
  maxRetries?: number;
}): Transcriber {
  return {
    async transcribe(audio, { signal } = {}) {
      try {
        const timeout = AbortSignal.timeout(timeoutMs);
        const result = await transcribe({
          model,
          audio: audio.data,
          providerOptions,
          maxRetries,
          abortSignal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        });

        const diarized = diarizedSegmentsSchema.safeParse(result.providerMetadata.openai?.segments);
        const source = diarized.success && diarized.data.length > 0 ? diarized.data : null;
        const segments: RawSegment[] = (source ?? result.segments).map((segment) => ({
          speaker: 'speaker' in segment && segment.speaker !== undefined ? segment.speaker : null,
          startMs: Math.round(segment.startSecond * 1000),
          text: segment.text,
        }));
        if (segments.length === 0 && result.text.trim() !== '') {
          segments.push({ speaker: null, startMs: 0, text: result.text });
        }
        return transcriptFromSegments(segments);
      } catch (error) {
        const failure = toTranscriptionError(error);
        if (failure.kind !== 'no_speech') logger.warn({ err: failure }, 'transcription failed');
        throw failure;
      }
    },
  };
}
