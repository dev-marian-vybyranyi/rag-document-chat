import { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import { requireAuth, userOf } from '../auth/middleware.js';
import { checkContent, sanitizeFilename } from '../documents/file-types.js';
import { toPublicDocument } from '../documents/public.js';
import type { DocumentRepository } from '../documents/repository.js';
import { MAX_PENDING_UPLOADS, requireQueueRoom, singleFileUpload } from '../documents/upload.js';
import { AppError } from '../http/errors.js';
import { plural } from '../http/limits.js';
import { stripInvisibleCharacters } from '../rag/sanitize.js';
import { AUDIO_EXTENSION, checkAudio } from './audio.js';
import { MAX_PENDING_RECORDINGS, type MeetingIngestionService } from './ingest.js';
import type { MeetingNotesService } from './regenerate.js';
import { transcriptLimitProblem, type TranscriptLimits } from './limits.js';
import { parseTranscript } from './parser.js';
import { TranscriptParseError, type ParsedTranscript } from './transcript.js';

const MAX_TITLE_LENGTH = 120;
const TEXT_FIELDS = 2;

const blankAsMissing = (value: unknown) =>
  typeof value === 'string' && value.trim() === '' ? undefined : value;

const detailsSchema = z.object({
  title: z.preprocess(blankAsMissing, z.string().max(MAX_TITLE_LENGTH).optional()),
  heldOn: z.preprocess(blankAsMissing, z.iso.date().optional()),
});

const EXTENSION = /\.(txt|vtt)$/i;

interface MeetingsRouterDeps {
  documents: DocumentRepository;
  ingestion: MeetingIngestionService;
  notes: MeetingNotesService;
  limits: TranscriptLimits;
  maxDocumentsPerUser: number;
  uploadLimiter?: RequestHandler;
}

function cleanTitle(raw: string): string {
  return stripInvisibleCharacters(raw).replace(/\s+/g, ' ').trim();
}

export function createMeetingsRouter({
  documents,
  ingestion,
  notes,
  limits,
  maxDocumentsPerUser,
  uploadLimiter = (_req, _res, next) => next(),
}: MeetingsRouterDeps) {
  const router = Router();
  router.use(requireAuth);

  function readTranscript(text: string): ParsedTranscript {
    if (text.length > limits.maxCharacters) {
      throw new AppError(
        413,
        'file_too_large',
        `The transcript is too long (limit ${limits.maxCharacters.toLocaleString('en-US')} characters)`,
      );
    }
    let transcript: ParsedTranscript;
    try {
      transcript = parseTranscript(text);
    } catch (error) {
      if (error instanceof TranscriptParseError) {
        throw new AppError(400, 'invalid_transcript', error.message);
      }
      throw error;
    }
    const problem = transcriptLimitProblem(transcript, limits);
    if (problem) throw new AppError(400, 'invalid_transcript', problem);
    return transcript;
  }

  function readDetails(body: unknown) {
    const details = detailsSchema.safeParse(body ?? {});
    if (!details.success) {
      throw new AppError(
        400,
        'validation_error',
        `Give a title of up to ${MAX_TITLE_LENGTH} characters and a date like 2026-10-01`,
      );
    }
    return details.data;
  }

  async function requireRoom(userId: string) {
    if ((await documents.countByUser(userId)) >= maxDocumentsPerUser) {
      throw new AppError(
        409,
        'document_limit',
        `You have reached the limit of ${plural(maxDocumentsPerUser, 'document')}. Delete one to add another.`,
      );
    }
    requireQueueRoom(ingestion, MAX_PENDING_UPLOADS.meetings);
  }

  router.post(
    '/',
    uploadLimiter,
    singleFileUpload(limits.maxBytes, { textFields: TEXT_FIELDS }),
    async (req, res) => {
      const file = req.file;
      if (!file) throw new AppError(400, 'file_required', 'Choose a transcript file to upload');

      const filename = sanitizeFilename(file.originalname);
      const extension = EXTENSION.exec(filename)?.[1]?.toLowerCase();
      if (!extension) {
        throw new AppError(
          415,
          'unsupported_file_type',
          'Only .txt and .vtt transcripts are supported',
        );
      }
      const mimeType = extension === 'vtt' ? 'text/vtt' : 'text/plain';
      const problem = checkContent({ kind: 'text', mimeType }, file.buffer);
      if (problem) throw new AppError(400, 'invalid_file', problem);

      const details = readDetails(req.body);
      const transcript = readTranscript(file.buffer.toString('utf8'));

      const userId = userOf(req).id;
      await requireRoom(userId);

      const title = cleanTitle(details.title ?? '') || filename.replace(EXTENSION, '');
      const document = await documents.create({
        userId,
        kind: 'transcript',
        filename: title,
        mimeType,
        sizeBytes: file.size,
        participants: transcript.participants,
        durationMs: transcript.durationMs,
        ...(details.heldOn && { meetingHeldOn: details.heldOn }),
      });
      ingestion.enqueue({ document, transcript, heldOn: details.heldOn ?? null });
      res.status(202).json({ document: toPublicDocument({ ...document, chunkCount: 0 }) });
    },
  );

  router.post(
    '/audio',
    uploadLimiter,
    singleFileUpload(limits.maxAudioBytes, { textFields: TEXT_FIELDS }),
    async (req, res) => {
      const file = req.file;
      if (!file) throw new AppError(400, 'file_required', 'Choose a recording to upload');

      const filename = sanitizeFilename(file.originalname);
      if (!AUDIO_EXTENSION.test(filename)) {
        throw new AppError(
          415,
          'unsupported_file_type',
          'Only .mp3, .wav, .m4a and .webm recordings are supported',
        );
      }
      const audio = checkAudio(filename, file.buffer);
      if (!audio.ok) throw new AppError(400, 'invalid_file', audio.problem);

      const details = readDetails(req.body);

      const userId = userOf(req).id;
      await requireRoom(userId);
      if (ingestion.pendingRecordings() >= MAX_PENDING_RECORDINGS) {
        throw new AppError(
          503,
          'ai_busy',
          'Other recordings are being transcribed. Try again in a few minutes.',
        );
      }

      const title = cleanTitle(details.title ?? '') || filename.replace(AUDIO_EXTENSION, '');
      const document = await documents.create({
        userId,
        kind: 'transcript',
        filename: title,
        mimeType: audio.mediaType,
        sizeBytes: file.size,
        ...(details.heldOn && { meetingHeldOn: details.heldOn }),
      });
      ingestion.enqueue({
        document,
        audio: { data: new Uint8Array(file.buffer), mediaType: audio.mediaType },
        heldOn: details.heldOn ?? null,
      });
      res.status(202).json({ document: toPublicDocument({ ...document, chunkCount: 0 }) });
    },
  );

  router.post('/:id/notes', uploadLimiter, async (req, res) => {
    const id = z.uuid().safeParse(req.params.id);
    const userId = userOf(req).id;
    const result = id.success
      ? await notes.regenerate(id.data, userId)
      : ({ status: 'not_found' } as const);

    switch (result.status) {
      case 'not_found':
        throw new AppError(404, 'not_found', 'Meeting not found');
      case 'not_ready':
        throw new AppError(409, 'conflict', 'The meeting is still being processed');
      case 'other_model':
        throw new AppError(
          409,
          'conflict',
          'This meeting was indexed with a different embedding model. Upload it again.',
        );
      case 'unavailable':
        throw new AppError(
          503,
          'ai_busy',
          'The notes could not be generated right now. Try again in a minute.',
        );
      case 'done': {
        const document = await documents.findForUser(id.data!, userId);
        res.json({ document: toPublicDocument(document!) });
      }
    }
  });

  return router;
}
