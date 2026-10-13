import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import { EmbeddingError, type Embedder } from '../../src/ai/embeddings.js';
import { chunks, documents, users } from '../../src/db/schema.js';
import { createRetrievalStore } from '../../src/rag/retrieval.js';
import { createRetriever } from '../../src/rag/retriever.js';
import { createFakeEmbedder, fakeVector } from '../helpers/embedder.js';
import { useTestDb } from './helpers.js';

interface Passage {
  content: string;
  startMs: number | null;
  endMs: number | null;
  speakers: string[];
}

const at = (minute: number) => minute * 60_000;

describe('filtering meetings by what the question names', () => {
  const db = useTestDb();
  const store = createRetrievalStore(db);

  async function createUser(email: string) {
    const [user] = await db.insert(users).values({ email, passwordHash: 'hash' }).returning();
    return user!;
  }

  async function addMeeting(
    userId: string,
    filename: string,
    passages: Passage[],
    options: {
      status?: 'ready' | 'processing';
      model?: string;
      participants?: string[];
      durationMs?: number;
    } = {},
  ) {
    const [doc] = await db
      .insert(documents)
      .values({
        userId,
        kind: 'transcript',
        filename,
        mimeType: 'text/plain',
        sizeBytes: 1,
        status: options.status ?? 'ready',
        embeddingModel: options.model ?? null,
        participants: options.participants ?? [...new Set(passages.flatMap((p) => p.speakers))],
        durationMs: options.durationMs ?? at(60),
      })
      .returning();
    await db.insert(chunks).values(
      passages.map((passage, ordinal) => ({
        documentId: doc!.id,
        userId,
        ordinal,
        ...passage,
        tokenCount: 5,
        embedding: fakeVector(passage.content),
      })),
    );
    return doc!;
  }

  async function addDocument(userId: string, content: string) {
    const [doc] = await db
      .insert(documents)
      .values({
        userId,
        filename: 'handbook.pdf',
        mimeType: 'text/plain',
        sizeBytes: 1,
        status: 'ready',
      })
      .returning();
    await db.insert(chunks).values({
      documentId: doc!.id,
      userId,
      ordinal: 0,
      content,
      tokenCount: 5,
      embedding: fakeVector(content),
    });
    return doc!;
  }

  const budget: Passage[] = [
    {
      content: 'Alice opens the budget review and sets the agenda.',
      startMs: at(0),
      endMs: at(10),
      speakers: ['Alice', 'Bob'],
    },
    {
      content: 'Carol proposes doubling the marketing budget.',
      startMs: at(10),
      endMs: at(20),
      speakers: ['Carol', 'Bob'],
    },
    {
      content: 'Bob worries about the marketing budget risk.',
      startMs: at(20),
      endMs: at(30),
      speakers: ['Bob'],
    },
    {
      content: 'Everyone agrees the marketing budget doubles.',
      startMs: at(50),
      endMs: at(60),
      speakers: ['Alice', 'Carol', 'Bob'],
    },
    {
      content: 'Meeting notes: Budget review. Summary: the marketing budget doubles.',
      startMs: null,
      endMs: null,
      speakers: ['Alice', 'Bob', 'Carol'],
    },
  ];

  function retrieverFor(embedder: Embedder = createFakeEmbedder()) {
    return createRetriever({ store, embedder, logger: pino({ level: 'silent' }) });
  }

  const contentsOf = (hits: Array<{ content: string }>) => hits.map((h) => h.content).sort();

  describe('the facts about the meetings in scope', () => {
    it('gives who spoke and where each meeting begins and ends', async () => {
      const ada = await createUser('ada@example.com');
      const meeting = await addMeeting(ada.id, 'Budget review', budget, { durationMs: at(60) });

      expect(await store.meetingFacts(ada.id)).toEqual([
        {
          id: meeting.id,
          participants: ['Alice', 'Bob', 'Carol'],
          firstStartMs: at(0),
          endMs: at(60),
        },
      ]);
    });

    it('counts from the first turn when the clock does not start at zero', async () => {
      const ada = await createUser('ada@example.com');
      await addMeeting(
        ada.id,
        'Afternoon',
        [
          { content: 'x one', startMs: 50_602_000, endMs: 50_700_000, speakers: ['Alice'] },
          { content: 'y two', startMs: 50_700_000, endMs: 50_800_000, speakers: ['Bob'] },
        ],
        { durationMs: 198_000 },
      );

      const [facts] = await store.meetingFacts(ada.id);

      expect(facts).toMatchObject({ firstStartMs: 50_602_000, endMs: 50_800_000 });
    });

    it('leaves out meetings that are still processing, other people’s, other models’, or not chosen', async () => {
      const ada = await createUser('ada@example.com');
      const bob = await createUser('bob@example.com');
      const kept = await addMeeting(ada.id, 'Kept', budget);
      await addMeeting(ada.id, 'Busy', budget, { status: 'processing' });
      await addMeeting(bob.id, 'Theirs', budget);
      await addDocument(ada.id, 'A plain document.');
      const other = createRetrievalStore(db, { embeddingModel: 'newer-model' });

      expect((await store.meetingFacts(ada.id)).map((f) => f.id)).toEqual([kept.id]);
      expect(await other.meetingFacts(ada.id)).toEqual([]);
      expect(await store.meetingFacts(ada.id, { documentIds: [] })).toEqual([]);
      expect(
        await store.meetingFacts(ada.id, { documentIds: [(await addDocument(ada.id, 'x')).id] }),
      ).toEqual([]);
    });
  });

  describe('by speaker', () => {
    it('keeps passages where that person speaks, notes included, in both searches', async () => {
      const ada = await createUser('ada@example.com');
      await addMeeting(ada.id, 'Budget review', budget);
      const scope = { meeting: { speakers: ['Carol'], windows: [] } };

      const byVector = await store.vectorSearch(ada.id, fakeVector('marketing budget'), 10, scope);
      const byKeyword = await store.keywordSearch(ada.id, 'marketing budget', 10, scope);

      for (const hits of [byVector, byKeyword]) {
        expect(contentsOf(hits)).toEqual(contentsOf([budget[1]!, budget[3]!, budget[4]!]));
      }
    });

    it('keeps passages where any of several people speaks', async () => {
      const ada = await createUser('ada@example.com');
      await addMeeting(ada.id, 'Budget review', budget);

      const hits = await store.vectorSearch(ada.id, fakeVector('x'), 10, {
        meeting: { speakers: ['Alice', 'Carol'], windows: [] },
      });

      expect(hits.map((h) => h.content)).not.toContain(budget[2]!.content);
      expect(hits).toHaveLength(4);
    });

    it('does not hide documents or code, which have no speakers', async () => {
      const ada = await createUser('ada@example.com');
      await addMeeting(ada.id, 'Budget review', budget);
      await addDocument(ada.id, 'The marketing budget is set each spring.');

      const hits = await store.keywordSearch(ada.id, 'marketing budget', 10, {
        meeting: { speakers: ['Zoe'], windows: [] },
      });

      expect(hits.map((h) => h.content)).toEqual(['The marketing budget is set each spring.']);
    });
  });

  describe('by time', () => {
    const window = (documentId: string, from: number, to: number) => ({
      documentId,
      fromMs: at(from),
      toMs: at(to),
    });

    it('keeps passages that overlap the window, and drops the notes, which have no time', async () => {
      const ada = await createUser('ada@example.com');
      const meeting = await addMeeting(ada.id, 'Budget review', budget);

      const hits = await store.vectorSearch(ada.id, fakeVector('x'), 10, {
        meeting: { speakers: [], windows: [window(meeting.id, 15, 25)] },
      });

      expect(contentsOf(hits)).toEqual(contentsOf([budget[1]!, budget[2]!]));
    });

    it('counts a passage that only touches the window', async () => {
      const ada = await createUser('ada@example.com');
      const meeting = await addMeeting(ada.id, 'Budget review', budget);

      const hits = await store.keywordSearch(ada.id, 'budget', 10, {
        meeting: { speakers: [], windows: [window(meeting.id, 20, 20)] },
      });

      expect(contentsOf(hits)).toEqual(contentsOf([budget[1]!, budget[2]!]));
    });

    it('applies to the meetings it lists and leaves the others whole', async () => {
      const ada = await createUser('ada@example.com');
      const first = await addMeeting(ada.id, 'Budget review', budget);
      const second = await addMeeting(ada.id, 'Retro', [
        {
          content: 'Retro: the marketing budget came up late.',
          startMs: at(55),
          endMs: at(60),
          speakers: ['Dan'],
        },
      ]);

      const hits = await store.keywordSearch(ada.id, 'marketing budget', 20, {
        meeting: { speakers: [], windows: [window(first.id, 0, 5)] },
      });

      expect(contentsOf(hits)).toEqual(
        contentsOf([budget[0]!, { content: 'Retro: the marketing budget came up late.' }]),
      );
      expect(hits.filter((h) => h.documentId === second.id)).toHaveLength(1);
    });

    it('combines with the speaker', async () => {
      const ada = await createUser('ada@example.com');
      const meeting = await addMeeting(ada.id, 'Budget review', budget);

      const hits = await store.vectorSearch(ada.id, fakeVector('x'), 10, {
        meeting: { speakers: ['Carol'], windows: [window(meeting.id, 0, 25)] },
      });

      expect(hits.map((h) => h.content)).toEqual([budget[1]!.content]);
    });
  });

  describe('through the retriever', () => {
    it('keeps to the person named in the question and says so', async () => {
      const ada = await createUser('ada@example.com');
      await addMeeting(ada.id, 'Budget review', budget);

      const result = await retrieverFor().retrieve(
        ada.id,
        'What did Carol say about the marketing budget?',
      );

      expect(result.filters).toEqual({ speakers: ['Carol'], time: null, relaxed: false });
      expect(contentsOf(result.chunks)).toEqual(contentsOf([budget[1]!, budget[3]!, budget[4]!]));
    });

    it('keeps to the time named in the question', async () => {
      const ada = await createUser('ada@example.com');
      await addMeeting(ada.id, 'Budget review', budget);

      const result = await retrieverFor().retrieve(
        ada.id,
        'What was said between 00:10:00 and 00:20:00?',
      );

      expect(result.filters).toEqual({ speakers: [], time: '00:10:00–00:20:00', relaxed: false });
      expect(contentsOf(result.chunks)).toEqual(contentsOf([budget[0]!, budget[1]!, budget[2]!]));
    });

    it('reads “the first N minutes” and “the last N minutes” on the clock of each meeting', async () => {
      const ada = await createUser('ada@example.com');
      await addMeeting(ada.id, 'Budget review', budget, { durationMs: at(60) });

      const first = await retrieverFor().retrieve(ada.id, 'What happened in the first 10 minutes?');
      const last = await retrieverFor().retrieve(ada.id, 'What happened in the last 5 minutes?');

      expect(first.filters?.time).toBe('first 10 minutes');
      expect(contentsOf(first.chunks)).toEqual(contentsOf([budget[0]!, budget[1]!]));
      expect(last.filters?.time).toBe('last 5 minutes');
      expect(contentsOf(last.chunks)).toEqual(contentsOf([budget[3]!]));
    });

    it('names both the person and the time when the question does', async () => {
      const ada = await createUser('ada@example.com');
      await addMeeting(ada.id, 'Budget review', budget);

      const result = await retrieverFor().retrieve(ada.id, 'What did Bob say after 00:15:00?');

      expect(result.filters).toEqual({ speakers: ['Bob'], time: 'after 00:15:00', relaxed: false });
      expect(contentsOf(result.chunks)).toEqual(contentsOf([budget[1]!, budget[2]!, budget[3]!]));
    });

    it('does not hide documents because a person was named', async () => {
      const ada = await createUser('ada@example.com');
      await addMeeting(ada.id, 'Budget review', budget);
      await addDocument(ada.id, 'The marketing budget is set each spring.');

      const result = await retrieverFor().retrieve(
        ada.id,
        'What did Carol say about the marketing budget?',
      );

      expect(result.chunks.map((c) => c.content)).toContain(
        'The marketing budget is set each spring.',
      );
    });

    it('gives up the filter, and says so, when it would leave nothing', async () => {
      const ada = await createUser('ada@example.com');
      await addMeeting(ada.id, 'Budget review', budget);

      const result = await retrieverFor().retrieve(ada.id, 'What did Carol say after 02:00:00?');

      expect(result.filters).toEqual({
        speakers: ['Carol'],
        time: 'after 02:00:00',
        relaxed: true,
      });
      expect(result.chunks.length).toBeGreaterThan(0);
    });

    it('embeds the question once, even when it has to search again', async () => {
      const ada = await createUser('ada@example.com');
      await addMeeting(ada.id, 'Budget review', budget);
      const embedder = createFakeEmbedder();

      await retrieverFor(embedder).retrieve(ada.id, 'What did Carol say after 02:00:00?');

      expect(embedder.queryCalls).toHaveLength(1);
    });

    it('still filters when only the keyword search is available', async () => {
      const ada = await createUser('ada@example.com');
      await addMeeting(ada.id, 'Budget review', budget);
      const broken: Embedder = {
        embedDocuments: async () => [],
        embedQuery: async () => {
          throw new EmbeddingError('rate_limited');
        },
      };

      const result = await retrieverFor(broken).retrieve(
        ada.id,
        'What did Carol say about the marketing budget?',
      );

      expect(result.mode).toBe('keyword-only');
      expect(result.filters).toMatchObject({ speakers: ['Carol'], relaxed: false });
      expect(contentsOf(result.chunks)).toEqual(contentsOf([budget[1]!, budget[3]!, budget[4]!]));
    });

    it('adds nothing when the question names no one and no time', async () => {
      const ada = await createUser('ada@example.com');
      await addMeeting(ada.id, 'Budget review', budget);

      const result = await retrieverFor().retrieve(
        ada.id,
        'What was decided about the marketing budget?',
      );

      expect(result).not.toHaveProperty('filters');
      expect(result.chunks).toHaveLength(5);
    });

    it('adds nothing for someone who has no meetings, even if the question names a time', async () => {
      const ada = await createUser('ada@example.com');
      await addDocument(ada.id, 'The marketing budget is set each spring.');

      const result = await retrieverFor().retrieve(ada.id, 'What did Carol say at 10:00?');

      expect(result).not.toHaveProperty('filters');
      expect(result.chunks).toHaveLength(1);
    });

    it('does not know the people in meetings that are outside the chosen sources', async () => {
      const ada = await createUser('ada@example.com');
      await addMeeting(ada.id, 'Budget review', budget);
      const handbook = await addDocument(ada.id, 'The marketing budget is set each spring.');

      const result = await retrieverFor().retrieve(ada.id, 'What did Carol say about the budget?', {
        documentIds: [handbook.id],
      });

      expect(result).not.toHaveProperty('filters');
      expect(result.chunks.map((c) => c.content)).toEqual([
        'The marketing budget is set each spring.',
      ]);
    });

    it('does not use other people’s meetings to find a name', async () => {
      const ada = await createUser('ada@example.com');
      const bob = await createUser('bob@example.com');
      await addMeeting(bob.id, 'Theirs', budget);
      await addDocument(ada.id, 'The marketing budget is set each spring.');

      const result = await retrieverFor().retrieve(ada.id, 'What did Carol say about the budget?');

      expect(result).not.toHaveProperty('filters');
    });
  });
});
