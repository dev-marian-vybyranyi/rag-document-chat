import { eq } from 'drizzle-orm';
import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import type { CareerJob } from '../../src/career/ingest.js';
import type { CareerLimits } from '../../src/career/limits.js';
import { createCareerRouter } from '../../src/career/routes.js';
import { documents } from '../../src/db/schema.js';
import type { DocumentRepository } from '../../src/documents/repository.js';
import { errorHandler } from '../../src/http/errors.js';
import { defaultUsageLimits } from '../../src/http/limits.js';
import { buildTestApp, useTestDb } from './helpers.js';

const credentials = { email: 'ada@example.com', password: 'correct horse battery' };

const resumeText = [
  'Alex Morgan',
  'EXPERIENCE',
  'Engineer, Acme (2020 – 2023)',
  '- Built APIs',
].join('\n');
const jobText = ['Backend Engineer', 'Requirements', '- 5+ years of Node'].join('\n');
const pdf = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\n');

const limits: CareerLimits = {
  maxResumeBytes: 4096,
  maxResumeCharacters: 1500,
  maxResumePages: 10,
  maxJobBytes: 2048,
  maxJobPages: 10,
  maxJobCharacters: 800,
  maxJobs: 3,
};

describe('resume and job posting endpoints', () => {
  const db = useTestDb();
  const jobs: CareerJob[] = [];
  const careerIngestion = { enqueue: (job: CareerJob) => jobs.push(job), idle: async () => {} };
  const app = buildTestApp(db, {
    careerIngestion,
    careerLimits: limits,
    usageLimits: { ...defaultUsageLimits, maxDocumentsPerUser: 10 },
  });

  async function signedIn(email = credentials.email, target = app) {
    jobs.length = 0;
    const agent = request.agent(target);
    await agent.post('/auth/register').send({ ...credentials, email });
    return agent;
  }

  type Agent = Awaited<ReturnType<typeof signedIn>>;

  const uploadResume = (agent: Agent, content: string | Buffer = resumeText, name = 'cv.txt') =>
    agent.post('/career/resume').attach('file', Buffer.from(content), name);

  const uploadJob = (agent: Agent, content: string | Buffer = jobText, name = 'backend.txt') =>
    agent.post('/career/jobs').attach('file', Buffer.from(content), name);

  describe('access', () => {
    it('requires a signed-in user', async () => {
      const resume = await request(app)
        .post('/career/resume')
        .attach('file', Buffer.from(resumeText), 'cv.txt');
      const job = await request(app)
        .post('/career/jobs')
        .attach('file', Buffer.from(jobText), 'job.txt');

      expect(resume.status).toBe(401);
      expect(job.status).toBe(401);
      expect(await db.select().from(documents)).toEqual([]);
    });
  });

  describe('adding a resume', () => {
    it('stores it for the user and starts indexing it', async () => {
      const agent = await signedIn();
      const me = await agent.get('/auth/me');

      const res = await uploadResume(agent);

      expect(res.status).toBe(202);
      expect(res.body.document).toMatchObject({
        kind: 'resume',
        filename: 'cv',
        mimeType: 'text/plain',
        sizeBytes: Buffer.byteLength(resumeText),
        status: 'processing',
        jobNumber: null,
        profile: null,
        fit: null,
        chunkCount: 0,
      });
      const [row] = await db.select().from(documents).where(eq(documents.id, res.body.document.id));
      expect(row?.userId).toBe(me.body.user.id);
      expect(jobs).toHaveLength(1);
      expect(jobs[0]?.document).toMatchObject({ id: res.body.document.id, kind: 'resume' });
      expect(jobs[0]?.type).toEqual({ kind: 'text', mimeType: 'text/plain' });
      expect(jobs[0]?.content.toString()).toBe(resumeText);
    });

    it.each([
      ['cv.pdf', 'pdf', 'application/pdf'],
      ['cv.md', 'markdown', 'text/markdown'],
      ['CV.TXT', 'text', 'text/plain'],
    ])('accepts %s', async (name, kind, mimeType) => {
      const agent = await signedIn();

      const res = await uploadResume(agent, kind === 'pdf' ? pdf : resumeText, name);

      expect(res.status).toBe(202);
      expect(res.body.document.mimeType).toBe(mimeType);
      expect(jobs[0]?.type.kind).toBe(kind);
    });

    it('uses a cleaned title when one is given, and the file name otherwise', async () => {
      const agent = await signedIn();

      const titled = await agent
        .post('/career/resume')
        .field('title', '  Alex​ Morgan\n(backend)  ')
        .attach('file', Buffer.from(resumeText), 'export-1.txt');
      expect(titled.body.document.filename).toBe('Alex Morgan (backend)');

      await agent.delete(`/documents/${titled.body.document.id}`);
      const blank = await agent
        .post('/career/resume')
        .field('title', '   ')
        .attach('file', Buffer.from(resumeText), 'My CV.v2.txt');
      expect(blank.body.document.filename).toBe('My CV.v2');
    });

    it('allows one resume only and says how to replace it', async () => {
      const agent = await signedIn();
      await uploadResume(agent);

      const second = await uploadResume(agent, resumeText, 'other.txt');

      expect(second.status).toBe(409);
      expect(second.body.error.code).toBe('resume_exists');
      expect(jobs).toHaveLength(1);
      expect(await db.select().from(documents)).toHaveLength(1);
    });

    it('lets each user have a resume, and a new one after the old one is deleted', async () => {
      const ada = await signedIn('ada@example.com');
      const grace = await signedIn('grace@example.com');
      const first = await uploadResume(ada);
      const other = await uploadResume(grace);
      expect(other.status).toBe(202);

      await ada.delete(`/documents/${first.body.document.id}`);
      const again = await uploadResume(ada);

      expect(again.status).toBe(202);
    });

    it('answers a clash found by the database like one found by the check', async () => {
      jobs.length = 0;
      const clash = Object.assign(new Error('insert failed'), {
        cause: { code: '23505' },
      });
      const stub = {
        countByKind: async () => 0,
        countByUser: async () => 0,
        create: async () => {
          throw clash;
        },
      } as unknown as DocumentRepository;
      const racing = express();
      racing.use((req, _res, next) => {
        req.user = { id: 'u1', email: 'ada@example.com' };
        next();
      });
      racing.use(
        '/career',
        createCareerRouter({
          documents: stub,
          ingestion: careerIngestion,
          limits,
          maxDocumentsPerUser: 10,
        }),
      );
      racing.use(errorHandler);

      const res = await request(racing)
        .post('/career/resume')
        .attach('file', Buffer.from(resumeText), 'cv.txt');

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('resume_exists');
      expect(jobs).toEqual([]);
    });

    it('lets only one of two simultaneous uploads through', async () => {
      const agent = await signedIn();

      const results = await Promise.all([uploadResume(agent), uploadResume(agent)]);

      expect(results.map((r) => r.status).sort()).toEqual([202, 409]);
      expect(await db.select().from(documents)).toHaveLength(1);
      expect(jobs).toHaveLength(1);
    });
  });

  describe('adding a job posting', () => {
    it('stores it, numbers it and starts indexing it', async () => {
      const agent = await signedIn();

      const res = await uploadJob(agent);

      expect(res.status).toBe(202);
      expect(res.body.document).toMatchObject({
        kind: 'job_posting',
        filename: 'backend',
        jobNumber: 1,
        status: 'processing',
        profile: null,
        fit: null,
      });
      expect(jobs[0]?.document).toMatchObject({ kind: 'job_posting', jobNumber: 1 });
      expect(jobs[0]?.content.toString()).toBe(jobText);
    });

    it('numbers postings one after another, per user', async () => {
      const ada = await signedIn('ada@example.com');
      const grace = await signedIn('grace@example.com');

      const numbers = [];
      for (const agent of [ada, ada, grace, ada]) {
        numbers.push((await uploadJob(agent)).body.document.jobNumber);
      }

      expect(numbers).toEqual([1, 2, 1, 3]);
    });

    it('gives the next number after the highest one, even when an earlier one was deleted', async () => {
      const agent = await signedIn();
      const first = await uploadJob(agent);
      await uploadJob(agent);
      await agent.delete(`/documents/${first.body.document.id}`);

      const third = await uploadJob(agent);

      expect(third.body.document.jobNumber).toBe(3);
    });

    it('numbers postings that arrive at the same moment without a clash', async () => {
      const agent = await signedIn();

      const results = await Promise.all([1, 2, 3].map(() => uploadJob(agent)));

      expect(results.map((r) => r.status)).toEqual([202, 202, 202]);
      expect(results.map((r) => r.body.document.jobNumber).sort()).toEqual([1, 2, 3]);
    });

    it('names the posting after the title and the company', async () => {
      const agent = await signedIn();

      const both = await agent
        .post('/career/jobs')
        .field({ title: 'Staff Engineer', company: ' Stripe ' })
        .attach('file', Buffer.from(jobText), 'x.txt');
      const titleOnly = await agent
        .post('/career/jobs')
        .field({ title: 'Data Engineer' })
        .attach('file', Buffer.from(jobText), 'x.txt');
      const companyOnly = await agent
        .post('/career/jobs')
        .field({ company: 'Acme' })
        .attach('file', Buffer.from(jobText), 'platform-role.md');

      expect(both.body.document.filename).toBe('Staff Engineer at Stripe');
      expect(titleOnly.body.document.filename).toBe('Data Engineer');
      expect(companyOnly.body.document.filename).toBe('platform-role at Acme');
    });

    it('allows a limited number of postings', async () => {
      const agent = await signedIn();
      for (let i = 0; i < limits.maxJobs; i++) await uploadJob(agent);

      const res = await uploadJob(agent);

      expect(res.status).toBe(409);
      expect(res.body.error).toMatchObject({
        code: 'job_limit',
        message: 'You can keep up to 3 job postings. Delete one to add another.',
      });
      expect(jobs).toHaveLength(3);
    });

    it('does not count a resume towards the limit of postings', async () => {
      const agent = await signedIn();
      await uploadResume(agent);
      for (let i = 0; i < limits.maxJobs; i++) await uploadJob(agent);

      expect(await db.select().from(documents)).toHaveLength(4);
    });
  });

  describe.each([
    ['resume', '/career/resume', resumeText],
    ['job posting', '/career/jobs', jobText],
  ])('refusing a %s that is not acceptable', (_what, path, content) => {
    const send = (agent: Agent, body: string | Buffer, name: string) =>
      agent.post(path).attach('file', Buffer.from(body), name);

    it('asks for a file when none is sent', async () => {
      const agent = await signedIn();

      const res = await agent.post(path).field('title', 'x');

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('file_required');
    });

    it('refuses more than one file', async () => {
      const agent = await signedIn();

      const res = await agent
        .post(path)
        .attach('file', Buffer.from(content), 'a.txt')
        .attach('file', Buffer.from(content), 'b.txt');

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('invalid_upload');
    });

    it('refuses fields it does not know about', async () => {
      const agent = await signedIn();

      const res = await agent
        .post(path)
        .field({ title: 'a', company: 'b', extra: 'c' })
        .attach('file', Buffer.from(content), 'a.txt');

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('invalid_upload');
    });

    it.each(['cv.docx', 'cv.png', 'cv', 'cv.txt.exe', 'cv.html'])(
      'refuses a file named %s',
      async (name) => {
        const agent = await signedIn();

        const res = await send(agent, content, name);

        expect(res.status).toBe(415);
        expect(res.body.error.code).toBe('unsupported_file_type');
        expect(await db.select().from(documents)).toEqual([]);
      },
    );

    it.each([
      ['an empty file', Buffer.alloc(0), 'a.txt'],
      ['a file with only blanks', Buffer.from(' \n \n'), 'a.txt'],
      ['a binary file with a text name', Buffer.from([0x25, 0x50, 0x00, 0x01]), 'a.txt'],
      ['text that is not UTF-8', Buffer.from([0x41, 0xff, 0xfe]), 'a.txt'],
      ['a file that is not a PDF', Buffer.from('plain text'), 'a.pdf'],
    ])('refuses %s', async (_label, body, name) => {
      const agent = await signedIn();

      const res = await send(agent, body, name);

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('invalid_file');
      expect(jobs).toEqual([]);
    });

    it('refuses a title that is too long', async () => {
      const agent = await signedIn();

      const res = await agent
        .post(path)
        .field({ title: 'x'.repeat(121) })
        .attach('file', Buffer.from(content), 'a.txt');

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('validation_error');
      expect(jobs).toEqual([]);
    });
  });

  it('refuses a company that is too long', async () => {
    const agent = await signedIn();

    const res = await agent
      .post('/career/jobs')
      .field({ company: 'x'.repeat(81) })
      .attach('file', Buffer.from(jobText), 'a.txt');

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('validation_error');
    expect(jobs).toEqual([]);
  });

  describe('size limits', () => {
    it('refuses a resume over the size limit', async () => {
      const agent = await signedIn();

      const res = await uploadResume(agent, `${resumeText}\n${'a'.repeat(5000)}`);

      expect(res.status).toBe(413);
      expect(res.body.error.code).toBe('file_too_large');
    });

    it('refuses a resume with too many characters even if the file is small enough', async () => {
      const agent = await signedIn();

      const res = await uploadResume(agent, `${resumeText}\n${'a'.repeat(1600)}`);

      expect(res.status).toBe(413);
      expect(res.body.error.message).toBe('The resume is too long (limit 1,500 characters)');
      expect(jobs).toEqual([]);
    });

    it('refuses a posting with too many characters', async () => {
      const agent = await signedIn();

      const res = await uploadJob(agent, `${jobText}\n${'a'.repeat(900)}`);

      expect(res.status).toBe(413);
      expect(res.body.error.message).toBe('The job posting is too long (limit 800 characters)');
    });

    it('leaves the length of a PDF to the indexing step', async () => {
      const agent = await signedIn();

      const res = await uploadResume(
        agent,
        Buffer.concat([pdf, Buffer.alloc(3000, 0x20)]),
        'cv.pdf',
      );

      expect(res.status).toBe(202);
    });
  });

  describe('the shared limit on sources', () => {
    const tight = buildTestApp(db, {
      careerIngestion,
      careerLimits: limits,
      usageLimits: { ...defaultUsageLimits, maxDocumentsPerUser: 2 },
    });

    it('counts resumes and postings with every other kind of source', async () => {
      const agent = await signedIn(credentials.email, tight);
      await agent
        .post('/meetings')
        .attach(
          'file',
          Buffer.from('[00:00:05] Alice: Hello.\n[00:00:09] Bob: Hi.'),
          'standup.txt',
        );
      await uploadJob(agent);

      const resume = await uploadResume(agent);
      const job = await uploadJob(agent);

      expect(resume.status).toBe(409);
      expect(resume.body.error.code).toBe('document_limit');
      expect(job.status).toBe(409);
      expect(job.body.error.code).toBe('document_limit');
    });
  });
});
