import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { documents } from '../../src/db/schema.js';
import { MAX_PENDING_UPLOADS } from '../../src/documents/upload.js';
import type { MeetingJob } from '../../src/meetings/ingest.js';
import { audioSamples } from '../helpers/audio.js';
import { buildTestApp, useTestDb } from './helpers.js';

const credentials = { email: 'ada@example.com', password: 'correct horse battery' };

describe('meeting recording endpoint', () => {
  const db = useTestDb();
  const jobs: MeetingJob[] = [];
  let pending = 0;
  let queued = 0;
  const app = buildTestApp(db, {
    meetingIngestion: {
      enqueue: (job) => jobs.push(job),
      pendingRecordings: () => pending,
      pending: () => queued,
      idle: async () => {},
    },
    transcriptLimits: {
      maxBytes: 4096,
      maxAudioBytes: 2048,
      maxCharacters: 1500,
      maxTurns: 6,
      maxSpeakers: 3,
    },
    usageLimits: { maxDocumentsPerUser: 2, maxChatsPerUser: 100, maxMessagesPerChat: 200 },
  });

  async function signedIn(email = credentials.email) {
    jobs.length = 0;
    pending = 0;
    const agent = request.agent(app);
    await agent.post('/auth/register').send({ ...credentials, email });
    return agent;
  }

  const upload = (
    agent: Awaited<ReturnType<typeof signedIn>>,
    content: Buffer = audioSamples.mp3(),
    name = 'standup.mp3',
  ) => agent.post('/meetings/audio').attach('file', content, name);

  it('requires a signed-in user', async () => {
    const res = await request(app)
      .post('/meetings/audio')
      .attach('file', audioSamples.mp3(), 'a.mp3');

    expect(res.status).toBe(401);
    expect(await db.select().from(documents)).toEqual([]);
  });

  describe('accepting a recording', () => {
    it('stores the meeting without speakers or length, which are not known yet, and starts transcribing it', async () => {
      const agent = await signedIn();

      const res = await upload(agent);

      expect(res.status).toBe(202);
      expect(res.body.document).toMatchObject({
        kind: 'transcript',
        filename: 'standup',
        mimeType: 'audio/mpeg',
        sizeBytes: 64,
        status: 'processing',
        participants: null,
        durationMs: null,
        meetingHeldOn: null,
        notes: null,
        chunkCount: 0,
      });
      expect(jobs).toHaveLength(1);
      expect(jobs[0]?.document.id).toBe(res.body.document.id);
      expect(jobs[0]?.transcript).toBeUndefined();
      expect(jobs[0]?.audio?.mediaType).toBe('audio/mpeg');
      expect(Buffer.from(jobs[0]!.audio!.data)).toEqual(audioSamples.mp3());
    });

    it.each([
      ['a.wav', audioSamples.wav(), 'audio/wav'],
      ['a.m4a', audioSamples.m4a(), 'audio/mp4'],
      ['a.webm', audioSamples.webm(), 'audio/webm'],
    ])('accepts %s', async (name, bytes, mediaType) => {
      const agent = await signedIn();

      const res = await upload(agent, bytes, name);

      expect(res.status).toBe(202);
      expect(res.body.document.mimeType).toBe(mediaType);
      expect(jobs[0]?.audio?.mediaType).toBe(mediaType);
    });

    it('uses the given title and date', async () => {
      const agent = await signedIn();

      const res = await agent
        .post('/meetings/audio')
        .field('title', '  Release   sync ')
        .field('heldOn', '2026-10-01')
        .attach('file', audioSamples.mp3(), 'x.mp3');

      expect(res.body.document).toMatchObject({
        filename: 'Release sync',
        meetingHeldOn: '2026-10-01',
      });
      expect(jobs[0]?.heldOn).toBe('2026-10-01');
    });

    it('records the owner, so meetings are private to their user', async () => {
      const agent = await signedIn();
      const me = await agent.get('/auth/me');

      await upload(agent);

      const [row] = await db.select().from(documents);
      expect(row?.userId).toBe(me.body.user.id);
    });
  });

  describe('refusing what is not a recording', () => {
    it('asks for a file when none is sent', async () => {
      const agent = await signedIn();

      const res = await agent.post('/meetings/audio');

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('file_required');
    });

    it.each(['talk.ogg', 'talk.txt', 'talk'])('refuses the name %s', async (name) => {
      const agent = await signedIn();

      const res = await upload(agent, audioSamples.mp3(), name);

      expect(res.status).toBe(415);
      expect(res.body.error.code).toBe('unsupported_file_type');
      expect(jobs).toEqual([]);
    });

    it('refuses a file whose bytes are not what its name says', async () => {
      const agent = await signedIn();

      const res = await upload(agent, audioSamples.wav(), 'talk.mp3');

      expect(res.status).toBe(400);
      expect(res.body.error).toMatchObject({
        code: 'invalid_file',
        message: 'The file is not a valid .mp3 recording',
      });
      expect(await db.select().from(documents)).toEqual([]);
    });

    it('refuses a transcript sent as a recording', async () => {
      const agent = await signedIn();

      const res = await upload(agent, Buffer.from('[00:00:01] Alice: hi'), 'talk.mp3');

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('invalid_file');
    });

    it('refuses a file over the size limit, which is its own and larger than the one for text', async () => {
      const agent = await signedIn();

      const small = await upload(
        agent,
        Buffer.concat([audioSamples.mp3(), Buffer.alloc(3000)]),
        'long.mp3',
      );
      const large = await upload(
        agent,
        Buffer.concat([audioSamples.mp3(), Buffer.alloc(1900)]),
        'ok.mp3',
      );

      expect(small.status).toBe(413);
      expect(small.body.error.code).toBe('file_too_large');
      expect(large.status).toBe(202);
    });

    it('refuses fields it does not know about', async () => {
      const agent = await signedIn();

      const res = await agent
        .post('/meetings/audio')
        .field('title', 'a')
        .field('heldOn', '2026-10-01')
        .field('extra', 'x')
        .attach('file', audioSamples.mp3(), 'a.mp3');

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('invalid_upload');
    });

    it('refuses a date that is not a date', async () => {
      const agent = await signedIn();

      const res = await agent
        .post('/meetings/audio')
        .field('heldOn', '2026-13-45')
        .attach('file', audioSamples.mp3(), 'a.mp3');

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('validation_error');
      expect(jobs).toEqual([]);
    });
  });

  describe('limits', () => {
    it('refuses once the user has reached the document limit, counting every kind of source', async () => {
      const agent = await signedIn();
      await upload(agent);
      await agent
        .post('/meetings')
        .attach('file', Buffer.from('[00:00:01] Alice: hi\n[00:00:05] Bob: hello'), 'a.txt');

      const res = await upload(agent);

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('document_limit');
      expect(await db.select().from(documents)).toHaveLength(2);
    });

    it('asks to wait when recordings are already being transcribed, and keeps nothing', async () => {
      const agent = await signedIn();
      pending = 3;

      const res = await upload(agent);

      expect(res.status).toBe(503);
      expect(res.body.error).toMatchObject({
        code: 'ai_busy',
        message: 'Other recordings are being transcribed. Try again in a few minutes.',
      });
      expect(await db.select().from(documents)).toEqual([]);
      expect(jobs).toEqual([]);
    });

    it('asks to wait when the indexing queue is full, and keeps nothing', async () => {
      const agent = await signedIn();
      queued = MAX_PENDING_UPLOADS.meetings;

      const res = await upload(agent);
      queued = 0;

      expect(res.status).toBe(503);
      expect(res.body.error.code).toBe('ai_busy');
      expect(await db.select().from(documents)).toEqual([]);
      expect(jobs).toEqual([]);
    });

    it('still accepts a recording when fewer than the limit are waiting', async () => {
      const agent = await signedIn();
      pending = 2;

      expect((await upload(agent)).status).toBe(202);
    });
  });
});
