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
  limits: CareerLimits;
  maxDocumentsPerUser: number;
  uploadLimiter?: RequestHandler;
}

export function createCareerRouter({
  documents,
  ingestion,
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

  return router;
}
