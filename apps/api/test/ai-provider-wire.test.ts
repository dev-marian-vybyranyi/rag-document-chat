import { pino } from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAiProvider } from '../src/ai/index.js';
import { EmbeddingError } from '../src/ai/embeddings.js';
import { loadEnv } from '../src/config/env.js';
import { EMBEDDING_DIMENSIONS } from '../src/db/schema.js';

const base = { DATABASE_URL: 'postgres://unused' };
const logger = pino({ level: 'silent' });
const vector = Array.from({ length: EMBEDDING_DIMENSIONS }, (_, i) => i / 1000);
const history = [
  { role: 'user' as const, content: 'What is hybrid retrieval?' },
  { role: 'assistant' as const, content: 'It fuses vector and keyword rankings.' },
];

interface Captured {
  url: string;
  headers: Headers;
  body: Record<string, unknown>;
}

function stubFetch(respond: (request: Captured) => Response) {
  const calls: Captured[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const captured: Captured = {
        url: String(input),
        headers: new Headers(init?.headers),
        body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
      };
      calls.push(captured);
      return respond(captured);
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

describe('what the openai provider sends', () => {
  const env = loadEnv({ ...base, AI_PROVIDER: 'openai', OPENAI_API_KEY: 'sk-test' });

  it('embeds with the configured model, 768 dimensions and the key', async () => {
    const calls = stubFetch(() =>
      json({
        object: 'list',
        data: [{ object: 'embedding', index: 0, embedding: vector }],
        model: 'text-embedding-3-small',
        usage: { prompt_tokens: 3, total_tokens: 3 },
      }),
    );

    const result = await createAiProvider(env).embedder.embedQuery('hybrid retrieval');

    expect(result).toHaveLength(EMBEDDING_DIMENSIONS);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://api.openai.com/v1/embeddings');
    expect(calls[0]!.headers.get('authorization')).toBe('Bearer sk-test');
    expect(calls[0]!.body).toMatchObject({
      model: 'text-embedding-3-small',
      input: ['hybrid retrieval'],
      dimensions: EMBEDDING_DIMENSIONS,
    });
  });

  it('rewrites a follow-up with the small model and minimal reasoning', async () => {
    const calls = stubFetch(() =>
      json({
        id: 'chatcmpl-1',
        object: 'chat.completion',
        created: 1,
        model: 'gpt-5-nano',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: 'hybrid retrieval ranking fusion' },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }),
    );

    const result = await createAiProvider(env)
      .createRewriter(logger)
      .rewrite(history, 'How does it rank?');

    expect(result).toEqual({ query: 'hybrid retrieval ranking fusion', rewritten: true });
    expect(calls[0]!.url).toBe('https://api.openai.com/v1/chat/completions');
    expect(calls[0]!.body).toMatchObject({ model: 'gpt-5-nano', reasoning_effort: 'minimal' });
  });

  it('reports a rejected key as a configuration problem', async () => {
    stubFetch(() =>
      json(
        {
          error: {
            message: 'Incorrect API key provided: sk-test.',
            type: 'invalid_request_error',
            code: 'invalid_api_key',
          },
        },
        401,
      ),
    );

    const failure = await createAiProvider(env)
      .embedder.embedQuery('a')
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(EmbeddingError);
    expect(failure).toMatchObject({ kind: 'misconfigured' });
  });
});

describe('what the google provider sends', () => {
  const env = loadEnv({ ...base, GOOGLE_GENERATIVE_AI_API_KEY: 'google-test' });

  it('embeds with a retrieval task type and 768 dimensions', async () => {
    const calls = stubFetch(() =>
      json({ embedding: { values: vector }, embeddings: [{ values: vector }] }),
    );

    await createAiProvider(env).embedder.embedDocuments(['one passage']);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toContain('generativelanguage.googleapis.com');
    expect(calls[0]!.url).toContain('gemini-embedding-001');
    expect(JSON.stringify(calls[0]!.body)).toContain('RETRIEVAL_DOCUMENT');
    expect(JSON.stringify(calls[0]!.body)).toContain(String(EMBEDDING_DIMENSIONS));
    expect(calls[0]!.headers.get('x-goog-api-key')).toBe('google-test');
  });
});
