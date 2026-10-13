import { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import { requireAuth, userOf } from '../auth/middleware.js';
import { PG_UNIQUE_VIOLATION, pgErrorCode } from '../db/errors.js';
import {
  checkContent,
  detectFileType,
  sanitizeFilename,
  type FileType,
} from '../documents/file-types.js';
import { toPublicDocument } from '../documents/public.js';
import type { DocumentRepository } from '../documents/repository.js';
import { singleFileUpload } from '../documents/upload.js';
import { AppError } from '../http/errors.js';
import { plural } from '../http/limits.js';
import type { CareerIngestionService } from './ingest.js';
import { cleanLabel } from './labels.js';
import type { CareerLimits } from './limits.js';
import type { FitService } from './fit-service.js';
import type { CareerProfileService } from './regenerate.js';

const MAX_TITLE_LENGTH = 120;
const MAX_COMPANY_LENGTH = 80;
const EXTENSION = /\.[^.]+$/;

const blankAsMissing = (value: unknown) =>
  typeof value === 'string' && value.trim() === '' ? undefined : value;

const resumeDetails = z.object({
  title: z.preprocess(blankAsMissing, z.string().max(MAX_TITLE_LENGTH).optional()),
});

const jobDetails = resumeDetails.extend({
  company: z.preprocess(blankAsMissing, z.string().max(MAX_COMPANY_LENGTH).optional()),
});

interface CareerRouterDeps {
  documents: DocumentRepository;
  ingestion: CareerIngestionService;
  profiles: CareerProfileService;
  fits: FitService;
  limits: CareerLimits;
  maxDocumentsPerUser: number;
  uploadLimiter?: RequestHandler;
}

export function createCareerRouter({
  documents,
  ingestion,
  profiles,
  fits,
  limits,
  maxDocumentsPerUser,
  uploadLimiter = (_req, _res, next) => next(),
}: CareerRouterDeps) {
  const router = Router();
  router.use(requireAuth);

  function readDetails<Schema extends z.ZodType>(schema: Schema, body: unknown): z.infer<Schema> {
    const details = schema.safeParse(body ?? {});
    if (!details.success) {
      throw new AppError(
        400,
        'validation_error',
        `Give a title of up to ${MAX_TITLE_LENGTH} characters and a company of up to ${MAX_COMPANY_LENGTH}`,
      );
    }
    return details.data;
  }

  function readFile(
    file: Express.Multer.File | undefined,
    maxCharacters: number,
    what: string,
  ): { filename: string; type: FileType } {
    if (!file) throw new AppError(400, 'file_required', `Choose a file for the ${what}`);

    const filename = sanitizeFilename(file.originalname);
    const type = detectFileType(filename);
    if (!type) {
      throw new AppError(
        415,
        'unsupported_file_type',
        'Only PDF, TXT and Markdown files are supported',
      );
    }
    const problem = checkContent(type, file.buffer);
    if (problem) throw new AppError(400, 'invalid_file', problem);
    if (type.kind !== 'pdf' && file.buffer.toString('utf8').length > maxCharacters) {
      throw new AppError(
        413,
        'file_too_large',
        `The ${what} is too long (limit ${maxCharacters.toLocaleString('en-US')} characters)`,
      );
    }
    return { filename, type };
  }

  async function requireRoom(userId: string) {
    if ((await documents.countByUser(userId)) >= maxDocumentsPerUser) {
      throw new AppError(
        409,
        'document_limit',
        `You have reached the limit of ${plural(maxDocumentsPerUser, 'document')}. Delete one to add another.`,
      );
    }
  }

  const resumeExists = () =>
    new AppError(
      409,
      'resume_exists',
      'You already have a resume. Delete it to add a different one.',
    );

  router.post(
    '/resume',
    uploadLimiter,
    singleFileUpload(limits.maxResumeBytes, { textFields: 1 }),
    async (req, res) => {
      const { filename, type } = readFile(req.file, limits.maxResumeCharacters, 'resume');
      const details = readDetails(resumeDetails, req.body);
      const file = req.file!;

      const userId = userOf(req).id;
      if ((await documents.countByKind(userId, 'resume')) > 0) throw resumeExists();
      await requireRoom(userId);

      const title =
        cleanLabel(details.title ?? '', MAX_TITLE_LENGTH) || filename.replace(EXTENSION, '');
      let document;
      try {
        document = await documents.create({
          userId,
          kind: 'resume',
          filename: title,
          mimeType: type.mimeType,
          sizeBytes: file.size,
        });
      } catch (error) {
        if (pgErrorCode(error) === PG_UNIQUE_VIOLATION) throw resumeExists();
        throw error;
      }
      ingestion.enqueue({ document, type, content: file.buffer });
      res.status(202).json({ document: toPublicDocument({ ...document, chunkCount: 0 }) });
    },
  );

  router.post(
    '/jobs',
    uploadLimiter,
    singleFileUpload(limits.maxJobBytes, { textFields: 2 }),
    async (req, res) => {
      const { filename, type } = readFile(req.file, limits.maxJobCharacters, 'job posting');
      const details = readDetails(jobDetails, req.body);
      const file = req.file!;

      const userId = userOf(req).id;
      if ((await documents.countByKind(userId, 'job_posting')) >= limits.maxJobs) {
        throw new AppError(
          409,
          'job_limit',
          `You can keep up to ${plural(limits.maxJobs, 'job posting')}. Delete one to add another.`,
        );
      }
      await requireRoom(userId);

      const title =
        cleanLabel(details.title ?? '', MAX_TITLE_LENGTH) || filename.replace(EXTENSION, '');
      const company = cleanLabel(details.company ?? '', MAX_COMPANY_LENGTH);
      const document = await documents.createJobPosting({
        userId,
        filename: company === '' ? title : `${title} at ${company}`,
        mimeType: type.mimeType,
        sizeBytes: file.size,
      });
      ingestion.enqueue({ document, type, content: file.buffer });
      res.status(202).json({ document: toPublicDocument({ ...document, chunkCount: 0 }) });
    },
  );

  router.post('/:id/analysis', uploadLimiter, async (req, res) => {
    const id = z.uuid().safeParse(req.params.id);
    const userId = userOf(req).id;
    const result = id.success
      ? await profiles.regenerate(id.data, userId)
      : ({ status: 'not_found' } as const);

    switch (result.status) {
      case 'not_found':
        throw new AppError(404, 'not_found', 'Resume or job posting not found');
      case 'not_ready':
        throw new AppError(409, 'conflict', 'The file is still being processed');
      case 'other_model':
        throw new AppError(
          409,
          'conflict',
          'This file was indexed with a different embedding model. Upload it again.',
        );
      case 'unavailable':
        throw new AppError(
          503,
          'ai_busy',
          'The analysis could not be made right now. Try again in a minute.',
        );
      case 'done': {
        fits.schedule(id.data!, userId, { force: true });
        const document = await documents.findForUser(id.data!, userId);
        res.json({ document: toPublicDocument(document!) });
      }
    }
  });

  router.post('/jobs/:id/fit', uploadLimiter, async (req, res) => {
    const id = z.uuid().safeParse(req.params.id);
    const userId = userOf(req).id;
    const { status } = id.success
      ? await fits.analyze(id.data, userId, { force: true, buildProfile: true })
      : { status: 'not_found' as const };

    switch (status) {
      case 'not_found':
        throw new AppError(404, 'not_found', 'Job posting not found');
      case 'not_ready':
        throw new AppError(409, 'conflict', 'The file is still being processed');
      case 'no_resume':
        throw new AppError(
          409,
          'conflict',
          'Add your resume first, then compare it with the posting',
        );
      case 'other_model':
        throw new AppError(
          409,
          'conflict',
          'These files were indexed with a different embedding model. Upload them again.',
        );
      case 'no_profile':
        throw new AppError(409, 'conflict', 'The posting lists no requirements to compare');
      case 'unavailable':
        throw new AppError(
          503,
          'ai_busy',
          'The comparison could not be made right now. Try again in a minute.',
        );
      case 'done':
      case 'fresh': {
        const document = await documents.findForUser(id.data!, userId);
        res.json({ document: toPublicDocument(document!) });
      }
    }
  });

  router.get('/overview', async (req, res) => {
    res.json(await fits.overview(userOf(req).id));
  });

  return router;
}
