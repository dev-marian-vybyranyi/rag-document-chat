import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, userOf } from '../auth/middleware.js';
import { AppError } from '../http/errors.js';
import { parseQuery } from '../http/validate.js';
import { checkContent, detectFileType, sanitizeFilename } from './file-types.js';
import type { IngestionService } from './ingest.js';
import type { DocumentRepository, DocumentWithChunkCount } from './repository.js';
import { singleFileUpload } from './upload.js';

function toPublicDocument(document: DocumentWithChunkCount) {
  return {
    id: document.id,
    filename: document.filename,
    mimeType: document.mimeType,
    sizeBytes: document.sizeBytes,
    status: document.status,
    error: document.error,
    pageCount: document.pageCount,
    chunkCount: document.chunkCount,
    suggestions: document.suggestions,
    createdAt: document.createdAt,
  };
}

export const MAX_PASSAGE_RADIUS = 3;
export const DEFAULT_PASSAGE_RADIUS = 1;

const passagesQuerySchema = z.object({
  ordinal: z.coerce.number().int().min(0),
  radius: z.coerce.number().int().min(0).max(MAX_PASSAGE_RADIUS).default(DEFAULT_PASSAGE_RADIUS),
});

interface DocumentsRouterDeps {
  documents: DocumentRepository;
  ingestion: IngestionService;
  maxUploadBytes: number;
}

export function createDocumentsRouter({
  documents,
  ingestion,
  maxUploadBytes,
}: DocumentsRouterDeps) {
  const router = Router();

  router.use(requireAuth);

  const notFound = () => new AppError(404, 'not_found', 'Document not found');
  const idParam = (value: unknown): string => {
    const parsed = z.uuid().safeParse(value);
    if (!parsed.success) throw notFound();
    return parsed.data;
  };

  router.get('/', async (req, res) => {
    const list = await documents.listByUser(userOf(req).id);
    res.json({ documents: list.map(toPublicDocument) });
  });

  router.get('/:id', async (req, res) => {
    const document = await documents.findForUser(idParam(req.params.id), userOf(req).id);
    if (!document) throw notFound();
    res.json({ document: toPublicDocument(document) });
  });

  router.get('/:id/passages', async (req, res) => {
    const id = idParam(req.params.id);
    const { ordinal, radius } = parseQuery(passagesQuerySchema, req.query);
    const found = await documents.passagesAround(id, userOf(req).id, ordinal, radius);
    if (!found || !found.passages.some((passage) => passage.ordinal === ordinal)) {
      throw new AppError(404, 'not_found', 'Passage not found');
    }
    res.json({
      document: {
        id: found.document.id,
        filename: found.document.filename,
        pageCount: found.document.pageCount,
      },
      target: ordinal,
      passages: found.passages,
    });
  });

  router.delete('/:id', async (req, res) => {
    const deleted = await documents.deleteForUser(idParam(req.params.id), userOf(req).id);
    if (!deleted) throw notFound();
    res.status(204).end();
  });

  router.post('/', singleFileUpload(maxUploadBytes), async (req, res) => {
    const file = req.file;
    if (!file) throw new AppError(400, 'file_required', 'Choose a file to upload');

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

    const document = await documents.create({
      userId: userOf(req).id,
      filename,
      mimeType: type.mimeType,
      sizeBytes: file.size,
    });
    ingestion.enqueue({ document, type, content: file.buffer });
    res.status(202).json({ document: toPublicDocument({ ...document, chunkCount: 0 }) });
  });

  return router;
}
