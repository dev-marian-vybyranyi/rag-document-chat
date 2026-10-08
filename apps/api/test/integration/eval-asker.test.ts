import { APICallError } from 'ai';
import type { MockLanguageModelV4 } from 'ai/test';
import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import { createCooldown } from '../../src/ai/cooldown.js';
import { CHAT_FAILURE_MESSAGES } from '../../src/chat/errors.js';
import { chunks, documents, users } from '../../src/db/schema.js';
import type { AnswerableQuestion, UnanswerableQuestion } from '../../src/eval/golden.js';
import { createResponderAsker, QuotaExhaustedError } from '../../src/eval/responder-asker.js';
import { createRetrievalStore } from '../../src/rag/retrieval.js';
import { createRetriever } from '../../src/rag/retriever.js';
import { createPassthroughRewriter } from '../../src/rag/rewrite.js';
import type { Embedder } from '../../src/ai/embeddings.js';
import { createFakeEmbedder, fakeVector } from '../helpers/embedder.js';
import {
  modelStreamFailing,
  modelStreaming,
  streamedPromptText,
} from '../helpers/language-model.js';
import { useTestDb } from './helpers.js';

const PASSAGE =
  'OAuth defines four roles: resource owner, resource server, client and authorization server.';
const LONG_PASSAGE = `${PASSAGE} ${'It goes on and on. '.repeat(40)}`;
const logger = pino({ level: 'silent' });

const answerable = (overrides: Partial<AnswerableQuestion> = {}): AnswerableQuestion => ({
  id: 'roles',
  type: 'answerable',
  question: PASSAGE,
  expected: [{ file: 'rfc.txt', quote: 'OAuth defines four roles' }],
  answer: 'Four.',
  ...overrides,
});

const unanswerable: UnanswerableQuestion = {
  id: 'peru',
  type: 'unanswerable',
  question: 'What is the capital of Peru?',
  note: 'n',
  absentTerms: ['Lima'],
};

const busy = (retryDelay?: string, daily = false) =>
  new APICallError({
    message: 'quota',
    url: 'https://example.test',
    requestBodyValues: {},
    statusCode: 429,
    responseBody: JSON.stringify({
      error: {
        details: [
          ...(retryDelay
            ? [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay }]
            : []),
          ...(daily
            ? [
                {
                  '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
                  violations: [{ quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier' }],
                },
              ]
            : []),
        ],
      },
    }),
    isRetryable: false,
  });

describe('asking the golden questions through the real responder', () => {
  const db = useTestDb();

  const oppositeEmbedder: Embedder = {
    embedDocuments: async (texts) => texts.map(fakeVector),
    embedQuery: async (text) => fakeVector(text).map((x) => -x),
  };

  async function setup(
    options: {
      model?: MockLanguageModelV4;
      embedder?: Embedder;
      relevanceThreshold?: number;
      busyRetries?: number;
    } = {},
  ) {
    const [user] = await db
      .insert(users)
      .values({ email: 'eval@rag-chat.invalid', passwordHash: 'x' })
      .returning();
    const [doc] = await db
      .insert(documents)
      .values({
        userId: user!.id,
        filename: 'rfc.txt',
        mimeType: 'text/plain',
        sizeBytes: 1,
        status: 'ready',
      })
      .returning();
    await db.insert(chunks).values({
      documentId: doc!.id,
      userId: user!.id,
      ordinal: 0,
      page: null,
      content: LONG_PASSAGE,
      tokenCount: 50,
      embedding: fakeVector(LONG_PASSAGE),
    });
    const embedder = options.embedder ?? createFakeEmbedder();
    const waits: Array<[number, string]> = [];
    const model = options.model ?? modelStreaming('Four roles [1].');
    let time = Date.now();
    const asker = createResponderAsker({
      db,
      userId: user!.id,
      chat: {
        retriever: createRetriever({ store: createRetrievalStore(db), embedder, logger }),
        rewriter: createPassthroughRewriter(),
        model,
        relevanceThreshold: options.relevanceThreshold ?? -1,
        cooldown: createCooldown(() => time),
      },
      logger,
      pacingMs: 0,
      busyRetries: options.busyRetries,
      sleep: async (ms) => {
        time += ms;
      },
      onWait: (ms, reason) => waits.push([ms, reason]),
    });
    return { asker, model, waits };
  }

  it('returns the answer with the sources in full, not the 300-character excerpts', async () => {
    const { asker } = await setup();

    const asked = await asker.ask(answerable());

    expect(asked.text).toBe('Four roles [1].');
    expect(asked.error).toBeNull();
    expect(asked.declined).toBe(false);
    expect(asked.sources).toHaveLength(1);
    expect(asked.sources[0]).toMatchObject({ id: 1, filename: 'rfc.txt', page: null });
    expect(asked.sources[0]!.content).toBe(LONG_PASSAGE);
    expect(asked.sources[0]!.content.length).toBeGreaterThan(300);
  });

  it('removes references to sources that do not exist, as the application does', async () => {
    const { asker } = await setup({ model: modelStreaming('Four roles [1][7].') });

    const asked = await asker.ask(answerable());

    expect(asked.text).toBe('Four roles [1].');
  });

  it('reports a question that the threshold turned away, without asking the model', async () => {
    const { asker, model } = await setup({
      embedder: oppositeEmbedder,
      relevanceThreshold: 0.65,
    });

    const asked = await asker.ask(unanswerable);

    expect(asked.declined).toBe(true);
    expect(asked.sources).toEqual([]);
    expect(model.doStreamCalls).toHaveLength(0);
  });

  it('gives the model the earlier turns of a follow-up', async () => {
    const { asker, model } = await setup();

    await asker.ask(
      answerable({
        id: 'follow',
        question: 'And the third one?',
        history: [
          { role: 'user', content: 'Which roles does OAuth define?' },
          { role: 'assistant', content: 'Four roles.' },
        ],
      }),
    );

    expect(streamedPromptText(model, 'user')).toContain('Which roles does OAuth define?');
    expect(streamedPromptText(model, 'assistant')).toContain('Four roles.');
  });

  it('asks each question in a conversation of its own', async () => {
    const { asker, model } = await setup();

    await asker.ask(answerable({ id: 'one' }));
    await asker.ask(answerable({ id: 'two', question: PASSAGE }));

    expect(streamedPromptText(model, 'user', 1)).not.toContain('Four roles [1].');
  });

  describe('when the model is busy', () => {
    it('waits as long as it is told and asks again', async () => {
      let calls = 0;
      const model = modelStreaming('Four roles [1].');
      const original = model.doStream.bind(model);
      model.doStream = async (options) => {
        if (++calls === 1) throw busy('20s');
        return original(options);
      };
      const { asker, waits } = await setup({ model });

      const asked = await asker.ask(answerable());

      expect(asked.text).toBe('Four roles [1].');
      expect(waits).toHaveLength(1);
      expect(waits[0]![0]).toBeGreaterThanOrEqual(20_000);
      expect(waits[0]![1]).toContain('rate limit');
    });

    it('gives the failure back after the allowed number of retries', async () => {
      const { asker, waits } = await setup({
        model: modelStreamFailing(busy('1s')),
        busyRetries: 2,
      });

      const asked = await asker.ask(answerable());

      expect(asked.error).toContain('rate limit reached');
      expect(asked.text).toBe('');
      expect(waits.length).toBeGreaterThanOrEqual(2);
    });

    it('stops the whole run when the daily quota is gone, since waiting will not help', async () => {
      const { asker } = await setup({ model: modelStreamFailing(busy(undefined, true)) });

      await expect(asker.ask(answerable())).rejects.toBeInstanceOf(QuotaExhaustedError);
    });

    it('does not retry a failure that waiting cannot fix', async () => {
      const { asker, model, waits } = await setup({
        model: modelStreamFailing(new Error('boom')),
      });

      const asked = await asker.ask(answerable());

      expect(asked.error).toBe(CHAT_FAILURE_MESSAGES.unexpected);
      expect(waits).toEqual([]);
      expect(model.doStreamCalls).toHaveLength(1);
    });
  });
});
