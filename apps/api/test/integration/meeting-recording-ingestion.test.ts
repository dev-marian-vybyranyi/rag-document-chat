import { eq } from 'drizzle-orm';
import { pino } from 'pino';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { chunks, documents } from '../../src/db/schema.js';
import { createDocumentRepository } from '../../src/documents/repository.js';
import { createMeetingIngestion, type MeetingIngestionOptions } from '../../src/meetings/ingest.js';
import type { NotesInput } from '../../src/meetings/notes-extractor.js';
import { defaultTranscriptLimits } from '../../src/meetings/limits.js';
import {
  transcriptFromSegments,
  TranscriptionError,
  type AudioInput,
  type Transcriber,
} from '../../src/meetings/transcriber.js';
import type { ParsedTranscript } from '../../src/meetings/transcript.js';
import { audioSamples } from '../helpers/audio.js';
import { createFakeEmbedder } from '../helpers/embedder.js';
import { buildTestApp, useTestDb } from './helpers.js';

const credentials = { email: 'ada@example.com', password: 'correct horse battery' };

const heard = () =>
  transcriptFromSegments([
    { speaker: 'Speaker 1', startMs: 4000, text: 'Morning everyone. Shall we ship on Friday?' },
    {
      speaker: 'Speaker 2',
      startMs: 20_000,
      text: 'Yes, ship it on Friday. I will write the notes.',
    },
    { speaker: 'Speaker 1', startMs: 95_000, text: 'Good, that is settled.' },
  ]);

const transcribing = (result: ParsedTranscript | Error): Transcriber => ({
  transcribe: async () => {
    if (result instanceof Error) throw result;
    return result;
  },
});

type Setup = Partial<Omit<MeetingIngestionOptions, 'repository' | 'embedder'>>;

describe('turning a recording into a meeting', () => {
  const db = useTestDb();
  const repository = createDocumentRepository(db);

  function setup(options: Setup = {}) {
    const ingestion = createMeetingIngestion({
      repository,
      embedder: createFakeEmbedder(),
      logger: pino({ level: 'silent' }),
      embeddingModel: 'fake-model',
      ...options,
    });
    return { app: buildTestApp(db, { meetingIngestion: ingestion }), ingestion };
  }

  async function upload(app: ReturnType<typeof buildTestApp>, fields: { heldOn?: string } = {}) {
    const agent = request.agent(app);
    await agent.post('/auth/register').send(credentials);
    const call = agent.post('/meetings/audio');
    for (const [key, value] of Object.entries(fields)) call.field(key, value);
    const res = await call.attach('file', audioSamples.mp3(), 'standup.mp3');
    return { res, id: res.body.document?.id as string };
  }

  const documentRow = async (id: string) =>
    (await db.select().from(documents).where(eq(documents.id, id)))[0]!;
  const chunkRows = (id: string) =>
    db.select().from(chunks).where(eq(chunks.documentId, id)).orderBy(chunks.ordinal);

  it('transcribes it, then indexes the transcript like a text one, with speakers and length from what was heard', async () => {
    const { app, ingestion } = setup({ transcriber: transcribing(heard()) });

    const { id } = await upload(app, { heldOn: '2026-10-01' });
    await ingestion.idle();

    expect(await documentRow(id)).toMatchObject({
      kind: 'transcript',
      filename: 'standup',
      mimeType: 'audio/mpeg',
      status: 'ready',
      error: null,
      embeddingModel: 'fake-model',
      participants: ['Speaker 1', 'Speaker 2'],
      durationMs: 91_000,
      meetingHeldOn: '2026-10-01',
      progressPhase: null,
    });
    const rows = await chunkRows(id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      startMs: 4000,
      endMs: 95_000,
      speakers: ['Speaker 1', 'Speaker 2'],
    });
    expect(rows[0]?.content).toBe(
      [
        'Meeting: standup (2026-10-01)',
        '[00:00:04] Speaker 1: Morning everyone. Shall we ship on Friday?',
        '[00:00:20] Speaker 2: Yes, ship it on Friday. I will write the notes.',
        '[00:01:35] Speaker 1: Good, that is settled.',
      ].join('\n'),
    );
  });

  it('hands the recording to the transcriber with its type', async () => {
    const received: AudioInput[] = [];
    const { app, ingestion } = setup({
      transcriber: {
        transcribe: async (audio) => {
          received.push(audio);
          return heard();
        },
      },
    });

    await upload(app);
    await ingestion.idle();

    expect(received).toHaveLength(1);
    expect(received[0]!.mediaType).toBe('audio/mpeg');
    expect(Buffer.from(received[0]!.data)).toEqual(audioSamples.mp3());
  });

  it('writes the notes from what was heard', async () => {
    const received: NotesInput[] = [];
    const { app, ingestion } = setup({
      transcriber: transcribing(heard()),
      notes: {
        extract: async (input) => {
          received.push(input);
          return null;
        },
      },
    });

    await upload(app);
    await ingestion.idle();

    expect(received).toHaveLength(1);
    expect(received[0]!.turns.map((turn) => turn.speaker)).toEqual([
      'Speaker 1',
      'Speaker 2',
      'Speaker 1',
    ]);
  });

  it('shows that it is transcribing while it waits for the transcriber, and counts the recording as waiting', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { app, ingestion } = setup({
      transcriber: {
        transcribe: async () => {
          await gate;
          return heard();
        },
      },
    });

    const { id } = await upload(app);
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(await documentRow(id)).toMatchObject({
      status: 'processing',
      progressPhase: 'transcribing',
    });
    expect(ingestion.pendingRecordings()).toBe(1);

    release();
    await ingestion.idle();

    expect(ingestion.pendingRecordings()).toBe(0);
    expect((await documentRow(id)).status).toBe('ready');
  });

  it.each([
    [
      'the service is busy',
      new TranscriptionError('rate_limited'),
      'The transcription service is busy (rate limit reached). Please try again in a few minutes.',
    ],
    [
      'there is no speech',
      new TranscriptionError('no_speech'),
      'No speech was found in the recording.',
    ],
    [
      'the recording is too long',
      new TranscriptionError('too_long'),
      'The recording is too long to transcribe in one go. Try a shorter one.',
    ],
    [
      'something unexpected happens',
      new Error('db password is hunter2'),
      'Something went wrong while processing the transcript.',
    ],
  ])('fails the meeting with a plain message when %s', async (_label, error, message) => {
    const { app, ingestion } = setup({ transcriber: transcribing(error) });

    const { id } = await upload(app);
    await ingestion.idle();

    expect(await documentRow(id)).toMatchObject({
      status: 'failed',
      error: message,
      progressPhase: null,
    });
    expect(await chunkRows(id)).toEqual([]);
    expect(ingestion.pendingRecordings()).toBe(0);
  });

  it('fails the meeting when what was heard goes over the transcript limits', async () => {
    const { app, ingestion } = setup({
      transcriber: transcribing(heard()),
      limits: { ...defaultTranscriptLimits, maxTurns: 2 },
    });

    const { id } = await upload(app);
    await ingestion.idle();

    expect(await documentRow(id)).toMatchObject({
      status: 'failed',
      error: 'The transcript has too many turns (limit 2)',
    });
    expect(await chunkRows(id)).toEqual([]);
  });

  it('says the service is not configured when there is no transcriber', async () => {
    const { app, ingestion } = setup();

    const { id } = await upload(app);
    await ingestion.idle();

    expect(await documentRow(id)).toMatchObject({
      status: 'failed',
      error: 'The transcription service is not configured correctly.',
    });
  });

  it('lets go of the recording as soon as it has been transcribed', async () => {
    const ingestion = createMeetingIngestion({
      repository,
      embedder: createFakeEmbedder(),
      logger: pino({ level: 'silent' }),
      embeddingModel: 'fake-model',
      transcriber: transcribing(heard()),
    });
    const agent = request.agent(buildTestApp(db));
    await agent.post('/auth/register').send(credentials);
    const me = await agent.get('/auth/me');
    const document = await repository.create({
      userId: me.body.user.id,
      kind: 'transcript',
      filename: 'standup',
      mimeType: 'audio/mpeg',
      sizeBytes: 64,
    });
    const job = { document, audio: { data: new Uint8Array(64), mediaType: 'audio/mpeg' } };

    ingestion.enqueue(job);
    expect(ingestion.pendingRecordings()).toBe(1);
    await ingestion.idle();

    expect(job.audio).toBeUndefined();
    expect(ingestion.pendingRecordings()).toBe(0);
  });

  it('leaves text meetings as they were: their speakers and length come from the upload', async () => {
    const { app, ingestion } = setup({
      transcriber: transcribing(new Error('must not be called')),
    });
    const agent = request.agent(app);
    await agent.post('/auth/register').send(credentials);

    const res = await agent
      .post('/meetings')
      .attach('file', Buffer.from('[00:00:05] Alice: Hi.\n[00:00:20] Bob: Hello.'), 'a.txt');
    await ingestion.idle();

    expect(await documentRow(res.body.document.id)).toMatchObject({
      status: 'ready',
      participants: ['Alice', 'Bob'],
      durationMs: 15_000,
    });
    expect(ingestion.pendingRecordings()).toBe(0);
  });
});
