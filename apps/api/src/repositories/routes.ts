import { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import { requireAuth, userOf } from '../auth/middleware.js';
import { sanitizeFilename } from '../documents/file-types.js';
import { toPublicDocument } from '../documents/public.js';
import type { DocumentRepository } from '../documents/repository.js';
import { singleFileUpload } from '../documents/upload.js';
import { AppError } from '../http/errors.js';
import { plural } from '../http/limits.js';
import { ImportRejectedError } from './errors.js';
import { parseGithubUrl } from './github.js';
import type { RepositoryIngestionService } from './ingest.js';

const bodySchema = z.object({ url: z.string().trim().min(1).max(300) });

const ZIP_SIGNATURES = [
  Buffer.from([0x50, 0x4b, 0x03, 0x04]),
  Buffer.from([0x50, 0x4b, 0x05, 0x06]),
];

interface RepositoriesRouterDeps {
  documents: DocumentRepository;
  ingestion: RepositoryIngestionService;
  maxArchiveBytes: number;
  maxDocumentsPerUser: number;
  uploadLimiter?: RequestHandler;
}

export function createRepositoriesRouter({
  documents,
  ingestion,
  maxArchiveBytes,
  maxDocumentsPerUser,
  uploadLimiter = (_req, _res, next) => next(),
}: RepositoriesRouterDeps) {
  const router = Router();
  router.use(requireAuth);

  async function ensureRoom(userId: string) {
    if ((await documents.countByUser(userId)) >= maxDocumentsPerUser) {
      throw new AppError(
        409,
        'document_limit',
        `You have reached the limit of ${plural(maxDocumentsPerUser, 'document')}. Delete one to add another.`,
      );
    }
  }

  router.post('/', uploadLimiter, async (req, res) => {
    const body = bodySchema.safeParse(req.body);
    if (!body.success) {
      throw new AppError(400, 'invalid_repository_url', 'Enter the address of a GitHub repository');
    }

    let target: ReturnType<typeof parseGithubUrl>;
    try {
      target = parseGithubUrl(body.data.url);
    } catch (error) {
      if (error instanceof ImportRejectedError) {
        throw new AppError(400, 'invalid_repository_url', error.message);
      }
      throw error;
    }

    const userId = userOf(req).id;
    await ensureRoom(userId);

    const url = `https://github.com/${target.owner}/${target.name}`;
    const document = await documents.create({
      userId,
      kind: 'repository',
      filename: `${target.owner}/${target.name}`,
      mimeType: 'application/zip',
      sizeBytes: 0,
      repoUrl: url,
      repoRef: target.ref,
    });
    ingestion.enqueue({
      document,
      source: { kind: 'github', url: target.ref ? `${url}/tree/${target.ref}` : url },
    });
    res.status(202).json({ document: toPublicDocument({ ...document, chunkCount: 0 }) });
  });

  router.post('/upload', uploadLimiter, singleFileUpload(maxArchiveBytes), async (req, res) => {
    const file = req.file;
    if (!file) throw new AppError(400, 'file_required', 'Choose a zip archive to upload');

    const filename = sanitizeFilename(file.originalname);
    if (!/\.zip$/i.test(filename)) {
      throw new AppError(415, 'unsupported_file_type', 'Only zip archives are supported');
    }
    if (!ZIP_SIGNATURES.some((signature) => file.buffer.subarray(0, 4).equals(signature))) {
      throw new AppError(400, 'invalid_file', 'The file is not a valid zip archive');
    }

    const userId = userOf(req).id;
    await ensureRoom(userId);

    const document = await documents.create({
      userId,
      kind: 'repository',
      filename: filename.replace(/\.zip$/i, ''),
      mimeType: 'application/zip',
      sizeBytes: file.size,
    });
    ingestion.enqueue({ document, source: { kind: 'zip', archive: file.buffer } });
    res.status(202).json({ document: toPublicDocument({ ...document, chunkCount: 0 }) });
  });

  return router;
}
