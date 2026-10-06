import { extractText as extractPdfPages, getDocumentProxy } from 'unpdf';
import type { FileType } from './file-types.js';

/** A run of text that sits on one page of its document (page is null for plain text). */
export interface TextSegment {
  page: number | null;
  text: string;
}

export interface ExtractedText {
  segments: TextSegment[];
  pageCount: number | null;
}

/** A failure whose message is safe to show to the user as the reason a document cannot be used. */
export class ExtractionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExtractionError';
  }
}

export interface ExtractOptions {
  /** Refuse PDFs longer than this; guards the free instance against huge documents. */
  maxPages?: number;
}

export const DEFAULT_MAX_PAGES = 500;

/** Turns an uploaded file into plain text, remembering which page each piece came from. */
export async function extractText(
  type: FileType,
  content: Buffer,
  options: ExtractOptions = {},
): Promise<ExtractedText> {
  if (type.kind === 'pdf') return extractFromPdf(content, options.maxPages ?? DEFAULT_MAX_PAGES);

  const text = normalizeText(stripBom(content.toString('utf8')));
  if (text.length === 0) throw new ExtractionError('The document contains no text');
  return { segments: [{ page: null, text }], pageCount: null };
}

async function extractFromPdf(content: Buffer, maxPages: number): Promise<ExtractedText> {
  let pdf: Awaited<ReturnType<typeof getDocumentProxy>>;
  try {
    // PDF.js takes ownership of the bytes it is given, so hand it a copy.
    pdf = await getDocumentProxy(new Uint8Array(content));
  } catch (error) {
    if (error instanceof Error && error.name === 'PasswordException') {
      throw new ExtractionError('The PDF is password-protected');
    }
    throw new ExtractionError('The PDF could not be read; it may be damaged');
  }

  try {
    if (pdf.numPages > maxPages) {
      throw new ExtractionError(`The PDF has too many pages (limit ${maxPages})`);
    }

    const { text: pages } = await extractPdfPages(pdf, { mergePages: false });
    const segments = pages
      .map((text, index) => ({ page: index + 1, text: normalizePdfText(text) }))
      .filter((segment) => segment.text.length > 0);

    if (segments.length === 0) {
      // Scanned documents are images; reading them would need OCR, which is out of scope.
      throw new ExtractionError('The PDF has no selectable text (it may be a scan)');
    }
    return { segments, pageCount: pdf.numPages };
  } catch (error) {
    if (error instanceof ExtractionError) throw error;
    throw new ExtractionError('The PDF could not be read; it may be damaged');
  } finally {
    await pdf.loadingTask.destroy();
  }
}

/** A byte order mark is invisible but would otherwise end up as the first character of the text. */
function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** Unifies line endings and whitespace; paragraph breaks (blank lines) are kept. */
export function normalizeText(raw: string): string {
  return (
    raw
      .replace(/\r\n?/g, '\n')
      // eslint-disable-next-line no-control-regex -- stripping control characters is the point
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
      .replace(/[^\S\n]+/g, ' ')
      .replace(/ ?\n ?/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  );
}

/**
 * PDF text arrives hard-wrapped at the end of every visual line, so a paragraph is a run of
 * single line breaks. Words split across lines ("inter-\nnational") are joined, and the
 * remaining soft breaks become spaces so sentences can be recognised later.
 */
function normalizePdfText(raw: string): string {
  return normalizeText(raw)
    .replace(/([a-z])-\n([a-z])/g, '$1$2')
    .replace(/(?<!\n)\n(?!\n)/g, ' ');
}
