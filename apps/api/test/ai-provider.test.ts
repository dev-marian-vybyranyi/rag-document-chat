import { MockEmbeddingModelV4 } from 'ai/test';
import { describe, expect, it } from 'vitest';
import { createAiProvider } from '../src/ai/index.js';
import { createEmbedder } from '../src/ai/embeddings.js';
import { openAiEmbeddingOptions } from '../src/ai/providers/openai.js';
import { loadEnv } from '../src/config/env.js';
import { EMBEDDING_DIMENSIONS } from '../src/db/schema.js';

const base = { DATABASE_URL: 'postgres://unused' };

describe('provider model defaults', () => {
  it('keeps the gemini models when no provider is chosen', () => {
    expect(loadEnv(base)).toMatchObject({
      AI_PROVIDER: 'google',
      EMBEDDING_MODEL: 'gemini-embedding-001',
      REWRITE_MODEL: 'gemini-3.5-flash-lite',
      CHAT_MODEL: 'gemini-3.5-flash-lite',
    });
  });

  it('uses the openai models when openai is chosen', () => {
    expect(loadEnv({ ...base, AI_PROVIDER: 'openai' })).toMatchObject({
      EMBEDDING_MODEL: 'text-embedding-3-small',
      REWRITE_MODEL: 'gpt-5-nano',
      CHAT_MODEL: 'gpt-5-nano',
    });
  });

  it('lets explicit model variables win over the provider defaults', () => {
    expect(loadEnv({ ...base, AI_PROVIDER: 'openai', CHAT_MODEL: 'gpt-5-mini' }).CHAT_MODEL).toBe(
      'gpt-5-mini',
    );
  });

  it('rejects an unknown provider', () => {
    expect(() => loadEnv({ ...base, AI_PROVIDER: 'cohere' })).toThrow(/AI_PROVIDER/);
  });
});

describe('the openai provider', () => {
  const env = loadEnv({ ...base, AI_PROVIDER: 'openai', OPENAI_API_KEY: 'test-key' });

  it('is configured by OPENAI_API_KEY alone', () => {
    const provider = createAiProvider(env);

    expect(provider).toMatchObject({
      name: 'openai',
      keyVariable: 'OPENAI_API_KEY',
      configured: true,
    });
    expect(provider.chat.model).not.toBeNull();
    expect(provider.chat.providerOptions).toEqual({ openai: { reasoningEffort: 'minimal' } });
  });

  it('ignores the google key', () => {
    const provider = createAiProvider(
      loadEnv({ ...base, AI_PROVIDER: 'openai', GOOGLE_GENERATIVE_AI_API_KEY: 'google-key' }),
    );

    expect(provider.configured).toBe(false);
    expect(provider.chat.model).toBeNull();
  });

  it('names the missing variable when the embedder is used without a key', async () => {
    const provider = createAiProvider(loadEnv({ ...base, AI_PROVIDER: 'openai' }));

    await expect(provider.embedder.embedQuery('a')).rejects.toMatchObject({
      kind: 'misconfigured',
      cause: expect.objectContaining({ message: 'OPENAI_API_KEY is not set' }),
    });
  });

  it('asks for vectors that fit the database column, with no task type', async () => {
    const model = new MockEmbeddingModelV4({
      doEmbed: async ({ values }) => ({
        embeddings: values.map(() => Array.from({ length: 4 }, () => 0.1)),
        warnings: [],
      }),
    });
    const embedder = createEmbedder({
      model,
      dimensions: 4,
      providerOptions: openAiEmbeddingOptions(4),
    });

    await embedder.embedDocuments(['a']);
    await embedder.embedQuery('b');

    expect(model.doEmbedCalls.map((call) => call.providerOptions)).toEqual([
      { openai: { dimensions: 4 } },
      { openai: { dimensions: 4 } },
    ]);
    expect(openAiEmbeddingOptions(EMBEDDING_DIMENSIONS)()).toEqual({
      openai: { dimensions: 768 },
    });
  });
});

describe('the judge model for the evaluation', () => {
  it('uses the thinking option of the configured provider', () => {
    const google = createAiProvider(
      loadEnv({ ...base, GOOGLE_GENERATIVE_AI_API_KEY: 'google-key' }),
    );
    const openai = createAiProvider(
      loadEnv({ ...base, AI_PROVIDER: 'openai', OPENAI_API_KEY: 'openai-key' }),
    );

    expect(google.createJudgeModel('judge-model', 'low').providerOptions).toEqual({
      google: { thinkingConfig: { thinkingLevel: 'low' } },
    });
    expect(openai.createJudgeModel('judge-model', 'high').providerOptions).toEqual({
      openai: { reasoningEffort: 'high' },
    });
  });

  it('cannot be created without a key, and says which one is missing', () => {
    const google = createAiProvider(loadEnv(base));
    const openai = createAiProvider(loadEnv({ ...base, AI_PROVIDER: 'openai' }));

    expect(() => google.createJudgeModel('m', 'low')).toThrow('GOOGLE_GENERATIVE_AI_API_KEY');
    expect(() => openai.createJudgeModel('m', 'low')).toThrow('OPENAI_API_KEY');
  });
});
