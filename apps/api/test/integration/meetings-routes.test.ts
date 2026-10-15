import { eq } from 'drizzle-orm';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { documents } from '../../src/db/schema.js';
import { MAX_PENDING_UPLOADS } from '../../src/documents/upload.js';
import type { MeetingJob } from '../../src/meetings/ingest.js';
import { buildTestApp, useTestDb, withoutRequestId } from './helpers.js';

const credentials = { email: 'ada@example.com', password: 'correct horse battery' };

const standup = [
  '[00:00:05] Alice: Morning everyone.',
  '[00:00:12] Bob: Morning. The release is ready.',
  '[00:01:30] Alice: Great, ship it on Friday.',
].join('\n');

const vtt = [
  'WEBVTT',
  '',
  '00:00:01.000 --> 00:00:04.000',
  '<v Alice>Hello there.</v>',
  '',
  '00:00:05.000 --> 00:00:07.000',
  '<v Bob>Hi.</v>',
].join('\n');

describe('meeting transcript endpoint', () => {
  const db = useTestDb();
  const jobs: MeetingJob[] = [];
  let queued = 0;
  const app = buildTestApp(db, {
    meetingIngestion: {
      enqueue: (job) => jobs.push(job),
      pendingRecordings: () => 0,
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
    const agent = request.agent(app);
    await agent.post('/auth/register').send({ ...credentials, email });
    return agent;
  }

  const upload = (
    agent: Awaited<ReturnType<typeof signedIn>>,
    content: string,
    name = 'standup.txt',
  ) => agent.post('/meetings').attach('file', Buffer.from(content), name);

  it('asks to wait when the indexing queue is full, and keeps nothing', async () => {
    const agent = await signedIn();
    queued = MAX_PENDING_UPLOADS.meetings;

    const res = await upload(agent, standup);
    queued = 0;

    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('ai_busy');
    expect(await db.select().from(documents)).toEqual([]);
    expect(jobs).toEqual([]);
  });

  it('requires a signed-in user', async () => {
    const res = await request(app).post('/meetings').attach('file', Buffer.from(standup), 'a.txt');

    expect(res.status).toBe(401);
    expect(await db.select().from(documents)).toEqual([]);
  });

  describe('accepting a transcript', () => {
    it('stores the meeting, tells who spoke and for how long, and starts indexing it', async () => {
      const agent = await signedIn();

      const res = await upload(agent, standup, 'standup.txt');

      expect(res.status).toBe(202);
      expect(res.body.document).toMatchObject({
        kind: 'transcript',
        filename: 'standup',
        mimeType: 'text/plain',
        sizeBytes: Buffer.byteLength(standup),
        status: 'processing',
        participants: ['Alice', 'Bob'],
        durationMs: 85_000,
        meetingHeldOn: null,
        notes: null,
        chunkCount: 0,
        progress: null,
      });
      expect(jobs).toHaveLength(1);
      expect(jobs[0]?.document.id).toBe(res.body.document.id);
      expect(jobs[0]?.transcript?.turns).toHaveLength(3);
      expect(jobs[0]?.transcript?.turns[1]).toEqual({
        speaker: 'Bob',
        startMs: 12_000,
        text: 'Morning. The release is ready.',
      });
    });

    it('accepts a WebVTT file', async () => {
      const agent = await signedIn();

      const res = await upload(agent, vtt, 'Weekly Sync.VTT');

      expect(res.status).toBe(202);
      expect(res.body.document).toMatchObject({
        filename: 'Weekly Sync',
        mimeType: 'text/vtt',
        participants: ['Alice', 'Bob'],
      });
    });

    it('records the owner, so meetings are private to their user', async () => {
      const agent = await signedIn();
      const me = await agent.get('/auth/me');

      const res = await upload(agent, standup);

      const [row] = await db.select().from(documents).where(eq(documents.id, res.body.document.id));
      expect(row?.userId).toBe(me.body.user.id);
      expect(row?.kind).toBe('transcript');
    });

    it('uses the given title and date', async () => {
      const agent = await signedIn();

      const res = await agent
        .post('/meetings')
        .field('title', '  Q3 / Q4 planning  ')
        .field('heldOn', '2026-10-01')
        .attach('file', Buffer.from(standup), 'export-1234.txt');

      expect(res.status).toBe(202);
      expect(res.body.document).toMatchObject({
        filename: 'Q3 / Q4 planning',
        meetingHeldOn: '2026-10-01',
      });
    });

    it('removes invisible characters from the title', async () => {
      const agent = await signedIn();

      const res = await agent
        .post('/meetings')
        .field('title', 'Pla​n‮')
        .attach('file', Buffer.from(standup), 'a.txt');

      expect(res.body.document.filename).toBe('Plan');
    });

    it('falls back to the file name when the title is left blank', async () => {
      const agent = await signedIn();

      const res = await agent
        .post('/meetings')
        .field('title', '   ')
        .field('heldOn', '')
        .attach('file', Buffer.from(standup), 'retro.txt');

      expect(res.status).toBe(202);
      expect(res.body.document).toMatchObject({ filename: 'retro', meetingHeldOn: null });
    });
  });

  describe('refusing what is not acceptable', () => {
    it.each([
      ['a date that does not exist', { heldOn: '2026-13-40' }],
      ['a date in words', { heldOn: 'yesterday' }],
      ['a title that is too long', { title: 'x'.repeat(121) }],
    ])('refuses %s', async (_label, fields) => {
      const agent = await signedIn();

      const res = await agent
        .post('/meetings')
        .field(fields)
        .attach('file', Buffer.from(standup), 'a.txt');

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('validation_error');
      expect(await db.select().from(documents)).toEqual([]);
      expect(jobs).toEqual([]);
    });

    it('refuses fields it does not know about', async () => {
      const agent = await signedIn();

      const res = await agent
        .post('/meetings')
        .field({ title: 'a', heldOn: '2026-10-01', extra: 'b' })
        .attach('file', Buffer.from(standup), 'a.txt');

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('invalid_upload');
    });

    it('asks for a file when none is sent', async () => {
      const agent = await signedIn();

      const res = await agent.post('/meetings').field('title', 'x');

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('file_required');
    });

    it('refuses more than one file', async () => {
      const agent = await signedIn();

      const res = await agent
        .post('/meetings')
        .attach('file', Buffer.from(standup), 'a.txt')
        .attach('file', Buffer.from(standup), 'b.txt');

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('invalid_upload');
    });

    it.each(['notes.pdf', 'notes.docx', 'notes', 'notes.txt.exe', 'notes.srt'])(
      'refuses a file named %s',
      async (name) => {
        const agent = await signedIn();

        const res = await upload(agent, standup, name);

        expect(res.status).toBe(415);
        expect(res.body.error.code).toBe('unsupported_file_type');
        expect(await db.select().from(documents)).toEqual([]);
      },
    );

    it.each([
      ['an empty file', ''],
      ['a file with only blanks', '  \n \n'],
    ])('refuses %s', async (_label, content) => {
      const agent = await signedIn();

      const res = await upload(agent, content);

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('invalid_file');
    });

    it('refuses a binary file with a text name', async () => {
      const agent = await signedIn();

      const res = await agent
        .post('/meetings')
        .attach('file', Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0x01]), 'a.txt');

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('invalid_file');
    });

    it('refuses text that is not valid UTF-8', async () => {
      const agent = await signedIn();

      const res = await agent
        .post('/meetings')
        .attach(
          'file',
          Buffer.from([0x5b, 0x30, 0x30, 0x3a, 0x30, 0x35, 0x5d, 0xff, 0xfe]),
          'a.txt',
        );

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('invalid_file');
    });

    it('explains, with the line, why text is not a transcript', async () => {
      const agent = await signedIn();

      const res = await upload(agent, 'Just some notes\nabout nothing in particular\n');

      expect(res.status).toBe(400);
      expect(withoutRequestId(res.body)).toEqual({
        error: {
          code: 'invalid_transcript',
          message:
            'Line 1: no line starts with a speaker and a time (for example "[00:01:05] Alice: Hello")',
        },
      });
      expect(await db.select().from(documents)).toEqual([]);
      expect(jobs).toEqual([]);
    });

    it('explains a WebVTT file with a cue it cannot read', async () => {
      const agent = await signedIn();

      const res = await upload(
        agent,
        ['WEBVTT', '', '00:00:01.000 --> 00:00:04.000', 'No speaker here.'].join('\n'),
        'a.vtt',
      );

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('invalid_transcript');
      expect(res.body.error.message).toMatch(/^Line 3: the cue has no speaker/);
    });

    it('refuses a file over the size limit', async () => {
      const agent = await signedIn();

      const res = await upload(agent, `[00:00:05] Alice: ${'a'.repeat(5000)}\n[00:00:09] Bob: hi`);

      expect(res.status).toBe(413);
      expect(res.body.error.code).toBe('file_too_large');
      expect(await db.select().from(documents)).toEqual([]);
    });

    it('refuses a transcript with too many characters, even if the file is small enough', async () => {
      const agent = await signedIn();

      const res = await upload(agent, `[00:00:05] Alice: ${'a'.repeat(1600)}\n[00:00:09] Bob: hi`);

      expect(res.status).toBe(413);
      expect(res.body.error.code).toBe('file_too_large');
      expect(res.body.error.message).toMatch(/limit 1,500 characters/);
    });

    it('refuses a transcript with too many turns', async () => {
      const agent = await signedIn();
      const turns = Array.from(
        { length: 7 },
        (_, i) => `[00:00:${String(i + 10)}] ${i % 2 ? 'Alice' : 'Bob'}: ok`,
      );

      const res = await upload(agent, turns.join('\n'));

      expect(res.status).toBe(400);
      expect(res.body.error).toMatchObject({
        code: 'invalid_transcript',
        message: 'The transcript has too many turns (limit 6)',
      });
    });

    it('refuses a transcript with too many speakers', async () => {
      const agent = await signedIn();
      const turns = ['Alice', 'Bob', 'Carol', 'Dan'].map(
        (name, i) => `[00:00:${String(i + 10)}] ${name}: ok`,
      );

      const res = await upload(agent, turns.join('\n'));

      expect(res.status).toBe(400);
      expect(res.body.error).toMatchObject({
        code: 'invalid_transcript',
        message: 'The transcript has too many speakers (limit 3)',
      });
    });

    it('refuses once the user has reached the document limit, counting every kind of source', async () => {
      const agent = await signedIn();
      await agent.post('/meetings').attach('file', Buffer.from(standup), 'one.txt');
      await agent.post('/meetings').attach('file', Buffer.from(standup), 'two.txt');

      const res = await upload(agent, standup, 'three.txt');

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('document_limit');
      expect(jobs).toHaveLength(2);
    });
  });
});
