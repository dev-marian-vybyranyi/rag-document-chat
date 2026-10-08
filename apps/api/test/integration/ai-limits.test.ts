import { APICallError } from 'ai';
import { pino } from 'pino';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createCooldown } from '../../src/ai/cooldown.js';
import { CHAT_FAILURE_MESSAGES } from '../../src/chat/errors.js';
import { createChatRepository } from '../../src/chat/repository.js';
import type { ChatDeps } from '../../src/chat/responder.js';
import { chunks, documents, ragTraces } from '../../src/db/schema.js';
import { createRetrievalStore } from '../../src/rag/retrieval.js';
import { createRetriever } from '../../src/rag/retriever.js';
import { createPassthroughRewriter } from '../../src/rag/rewrite.js';
import { createFakeEmbedder, fakeVector } from '../helpers/embedder.js';
import { modelStreamFailing, modelStreaming } from '../helpers/language-model.js';
import { buildTestApp, useTestDb } from './helpers.js';

const password = 'correct horse battery';
const PASSAGE = 'HNSW is an approximate nearest neighbour index built on layered graphs.';

function geminiError(status: number, details: unknown[] = []) {
  return new APICallError({
    message: 'upstream',
    url: 'https://example.test',
    requestBodyValues: {},
    statusCode: status,
    responseBody: JSON.stringify({ error: { details } }),
    isRetryable: false,
  });
}

const retryInfo = (retryDelay: string) => ({
  '@type': 'type.googleapis.com/google.rpc.RetryInfo',
  retryDelay,
});
const perDay = {
  '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
  violations: [{ quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier' }],
};

describe('Gemini rate limits and quotas', () => {
  const db = useTestDb();
  const chats = createChatRepository(db);

  function setup(model: ChatDeps['model']) {
    let time = Date.now();
    const cooldown = createCooldown(() => time);
    const chat: ChatDeps = {
      retriever: createRetriever({
        store: createRetrievalStore(db),
        embedder: createFakeEmbedder(),
        logger: pino({ level: 'silent' }),
      }),
      rewriter: createPassthroughRewriter(),
      model,
      relevanceThreshold: -1,
      cooldown,
    };
    return { app: buildTestApp(db, { chat }), advance: (ms: number) => void (time += ms) };
  }

  async function startChat(app: ReturnType<typeof setup>['app']) {
    const agent = request.agent(app);
    const res = await agent.post('/auth/register').send({ email: 'ann@example.com', password });
    const userId = res.body.user.id as string;
    const [doc] = await db
      .insert(documents)
      .values({
        userId,
        filename: 'a.md',
        mimeType: 'text/markdown',
        sizeBytes: 1,
        status: 'ready',
      })
      .returning();
    await db.insert(chunks).values({
      documentId: doc!.id,
      userId,
      ordinal: 0,
      page: 1,
      content: PASSAGE,
      tokenCount: 5,
      embedding: fakeVector(PASSAGE),
    });
    return { agent, chatId: (await chats.create(userId)).id };
  }

  const ask = (agent: ReturnType<typeof request.agent>, chatId: string) =>
    agent
      .post(`/chats/${chatId}/messages`)
      .buffer(true)
      .parse((r, done) => {
        let data = '';
        r.setEncoding('utf8');
        r.on('data', (piece: string) => (data += piece));
        r.on('end', () => done(null, data));
      })
      .send({ content: PASSAGE });

  const streamError = (body: unknown) =>
    String(body)
      .split('\n\n')
      .map((block) => block.replace(/^data: /, '').trim())
      .filter((data) => data.startsWith('{'))
      .map((data) => JSON.parse(data) as { type: string; errorText?: string })
      .find((part) => part.type === 'error')?.errorText as string;

  const settle = () => new Promise((resolve) => setTimeout(resolve, 150));

  it('tells the user how long to wait, and then refuses new questions without calling Gemini', async () => {
    const model = modelStreamFailing(geminiError(429, [retryInfo('40s')]));
    const { app } = setup(model);
    const { agent, chatId } = await startChat(app);

    const first = await ask(agent, chatId);
    await settle();
    const calls = model.doStreamCalls.length;
    const stored = (await chats.messagesOf(chatId)).length;
    const second = await ask(agent, chatId);

    expect(streamError(first.body)).toBe(
      'The AI service is busy (rate limit reached). Please try again in 40 seconds.',
    );
    expect(second.status).toBe(503);
    expect(second.body).toBeTypeOf('string');
    const body = JSON.parse(second.body as string) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('ai_busy');
    expect(body.error.message).toMatch(/Please try again in (\d+ seconds?)\./);
    expect(Number(second.headers['retry-after'])).toBeGreaterThan(0);
    expect(Number(second.headers['retry-after'])).toBeLessThanOrEqual(40);
    expect(model.doStreamCalls).toHaveLength(calls);
    expect((await chats.messagesOf(chatId)).length).toBe(stored);
  });

  it('lets questions through again once the wait is over', async () => {
    const failing = modelStreamFailing(geminiError(429, [retryInfo('30s')]));
    const { app, advance } = setup(failing);
    const { agent, chatId } = await startChat(app);
    await ask(agent, chatId);
    await settle();
    expect((await ask(agent, chatId)).status).toBe(503);

    advance(31_000);
    const third = await ask(agent, chatId);

    expect(third.status).toBe(200);
    expect(failing.doStreamCalls.length).toBeGreaterThan(1);
  });

  it('keeps waiting about ten minutes when the daily quota is used up', async () => {
    const { app, advance } = setup(modelStreamFailing(geminiError(429, [perDay])));
    const { agent, chatId } = await startChat(app);

    const first = await ask(agent, chatId);
    await settle();
    const blocked = await ask(agent, chatId);

    expect(streamError(first.body)).toBe(CHAT_FAILURE_MESSAGES.quota_exhausted);
    expect(blocked.status).toBe(503);
    expect(JSON.parse(blocked.body as string).error.message).toBe(
      CHAT_FAILURE_MESSAGES.quota_exhausted,
    );
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(9 * 60);
    advance(11 * 60_000);
    expect((await ask(agent, chatId)).status).toBe(200);
  });

  it('records the kind of failure in the trace', async () => {
    const { app } = setup(modelStreamFailing(geminiError(429, [perDay])));
    const { agent, chatId } = await startChat(app);

    await ask(agent, chatId);

    const [trace] = await vi.waitFor(async () => {
      const rows = await db.select().from(ragTraces);
      expect(rows).toHaveLength(1);
      return rows;
    });
    expect(trace).toMatchObject({ outcome: 'failed', errorKind: 'quota_exhausted' });
  });

  it.each([
    ['an overloaded model', geminiError(503)],
    ['an unexpected failure', new Error('boom')],
  ])('does not stop questions after %s, which a retry can fix', async (_name, error) => {
    const { app } = setup(modelStreamFailing(error));
    const { agent, chatId } = await startChat(app);
    await ask(agent, chatId);
    await settle();

    const next = await ask(agent, chatId);

    expect(next.status).toBe(200);
  });

  it('answers normally while nothing has gone wrong', async () => {
    const { app } = setup(modelStreaming('Fine [1].'));
    const { agent, chatId } = await startChat(app);

    expect((await ask(agent, chatId)).status).toBe(200);
  });
});
