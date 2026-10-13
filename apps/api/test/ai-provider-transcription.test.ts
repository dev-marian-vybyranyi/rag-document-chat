import { pino } from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAiProvider } from '../src/ai/index.js';
import { loadEnv } from '../src/config/env.js';
import type { AudioInput } from '../src/meetings/transcriber.js';

const base = { DATABASE_URL: 'postgres://unused' };
const logger = pino({ level: 'silent' });
const audio: AudioInput = {
  data: new Uint8Array([0x49, 0x44, 0x33, 4, 0, 0]),
  mediaType: 'audio/mpeg',
};

interface Captured {
  url: string;
  headers: Headers;
  body: unknown;
}

function stubFetch(respond: () => Response) {
  const calls: Captured[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({
        url: String(input),
        headers: new Headers(init?.headers),
        body: init?.body,
      });
      return respond();
    }),
  );
  return calls;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('transcription model defaults', () => {
  it('asks a gemini model for google and a diarizing model for openai', () => {
    expect(loadEnv(base).TRANSCRIPTION_MODEL).toBe('gemini-3.5-flash-lite');
    expect(loadEnv({ ...base, AI_PROVIDER: 'openai' }).TRANSCRIPTION_MODEL).toBe(
      'gpt-4o-transcribe-diarize',
    );
  });

  it('lets TRANSCRIPTION_MODEL win', () => {
    expect(
      loadEnv({ ...base, AI_PROVIDER: 'openai', TRANSCRIPTION_MODEL: 'gpt-4o-transcribe' })
        .TRANSCRIPTION_MODEL,
    ).toBe('gpt-4o-transcribe');
  });
});

describe('a provider without a key', () => {
  it.each([
    ['google', 'GOOGLE_GENERATIVE_AI_API_KEY'],
    ['openai', 'OPENAI_API_KEY'],
  ])('names the missing variable for %s when a recording is transcribed', async (name, key) => {
    const provider = createAiProvider(loadEnv({ ...base, AI_PROVIDER: name }));

    await expect(provider.createTranscriber(logger).transcribe(audio)).rejects.toMatchObject({
      name: 'TranscriptionError',
      kind: 'misconfigured',
      cause: expect.objectContaining({ message: `${key} is not set` }),
    });
  });
});

describe('what the google provider sends to transcribe', () => {
  const env = loadEnv({ ...base, GOOGLE_GENERATIVE_AI_API_KEY: 'google-test' });
  const answer = {
    candidates: [
      {
        content: {
          role: 'model',
          parts: [
            {
              text: JSON.stringify({
                turns: [{ speaker: 'Speaker 1', time: '00:07', text: 'Good morning.' }],
              }),
            },
          ],
        },
        finishReason: 'STOP',
      },
    ],
    usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
  };

  it('puts the recording inline in a request to the transcription model, with the key', async () => {
    const calls = stubFetch(() => json(answer));

    const transcript = await createAiProvider(env).createTranscriber(logger).transcribe(audio);

    expect(transcript.turns).toEqual([
      { speaker: 'Speaker 1', startMs: 7000, text: 'Good morning.' },
    ]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toContain('gemini-3.5-flash-lite:generateContent');
    expect(calls[0]!.headers.get('x-goog-api-key')).toBe('google-test');
    const body = JSON.parse(String(calls[0]!.body)) as {
      contents: Array<{ parts: Array<{ inlineData?: { mimeType: string; data: string } }> }>;
    };
    const inline = body.contents[0]!.parts.find((part) => part.inlineData)?.inlineData;
    expect(inline).toEqual({
      mimeType: 'audio/mpeg',
      data: Buffer.from(audio.data).toString('base64'),
    });
  });

  it('reports a rejected key as a configuration problem', async () => {
    stubFetch(() =>
      json(
        { error: { code: 400, message: 'API key not valid. Please pass a valid API key.' } },
        400,
      ),
    );

    await expect(
      createAiProvider(env).createTranscriber(logger).transcribe(audio),
    ).rejects.toMatchObject({ kind: 'misconfigured' });
  });
});

describe('what the openai provider sends to transcribe', () => {
  const env = loadEnv({ ...base, AI_PROVIDER: 'openai', OPENAI_API_KEY: 'sk-test' });
  const answer = {
    text: 'Good morning. Morning.',
    usage: { type: 'duration', seconds: 12 },
    segments: [
      {
        type: 'transcript.text.segment',
        id: 'seg_1',
        start: 0.5,
        end: 2,
        text: 'Good morning.',
        speaker: 'A',
      },
      {
        type: 'transcript.text.segment',
        id: 'seg_2',
        start: 3,
        end: 4,
        text: 'Morning.',
        speaker: 'B',
      },
    ],
  };

  it('posts the recording to the diarizing model as diarized_json with automatic chunking', async () => {
    const calls = stubFetch(() => json(answer));

    const transcript = await createAiProvider(env).createTranscriber(logger).transcribe(audio);

    expect(transcript.turns).toEqual([
      { speaker: 'Speaker A', startMs: 500, text: 'Good morning.' },
      { speaker: 'Speaker B', startMs: 3000, text: 'Morning.' },
    ]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://api.openai.com/v1/audio/transcriptions');
    expect(calls[0]!.headers.get('authorization')).toBe('Bearer sk-test');
    const form = calls[0]!.body as FormData;
    expect(form.get('model')).toBe('gpt-4o-transcribe-diarize');
    expect(form.get('response_format')).toBe('diarized_json');
    expect(form.get('chunking_strategy')).toBe('auto');
    const file = form.get('file') as File;
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(audio.data);
  });
});
