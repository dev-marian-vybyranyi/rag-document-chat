import { Router } from 'express';
import { requireAuth, userOf } from '../auth/middleware.js';
import { AppError } from '../http/errors.js';
import { checkContent, detectFileType, sanitizeFilename } from './file-types.js';
import type { DocumentRecord, DocumentRepository } from './repository.js';
import { singleFileUpload } from './upload.js';

function toPublicDocument(document: DocumentRecord) {
  return {
    id: document.id,
    filename: document.filename,
    mimeType: document.mimeType,
    sizeBytes: document.sizeBytes,
    status: document.status,
    error: document.error,
    pageCount: document.pageCount,
    createdAt: document.createdAt,
  };
}

interface DocumentsRouterDeps {
  documents: DocumentRepository;
  maxUploadBytes: number;
}

export function createDocumentsRouter({ documents, maxUploadBytes }: DocumentsRouterDeps) {
  const router = Router();

  router.use(requireAuth);

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
    res.status(202).json({ document: toPublicDocument(document) });
  });

  return router;
}
