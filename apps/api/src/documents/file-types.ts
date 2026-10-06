export interface FileType {
  kind: 'pdf' | 'text' | 'markdown';
  mimeType: string;
}

const BY_EXTENSION: Record<string, FileType> = {
  '.pdf': { kind: 'pdf', mimeType: 'application/pdf' },
  '.txt': { kind: 'text', mimeType: 'text/plain' },
  '.md': { kind: 'markdown', mimeType: 'text/markdown' },
  '.markdown': { kind: 'markdown', mimeType: 'text/markdown' },
};

export const SUPPORTED_EXTENSIONS = Object.keys(BY_EXTENSION);

export function detectFileType(filename: string): FileType | undefined {
  const dot = filename.lastIndexOf('.');
  if (dot < 0) return undefined;
  return BY_EXTENSION[filename.slice(dot).toLowerCase()];
}

const MAX_FILENAME_LENGTH = 200;

export function sanitizeFilename(raw: string): string {
  const base = raw.split(/[\\/]/).pop() ?? '';
  const cleaned = base
    .replace(/[\p{Cc}\p{Cf}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (cleaned.length === 0) return 'document';
  if (cleaned.length <= MAX_FILENAME_LENGTH) return cleaned;

  const dot = cleaned.lastIndexOf('.');
  const extension = dot > 0 ? cleaned.slice(dot) : '';
  return cleaned.slice(0, MAX_FILENAME_LENGTH - extension.length) + extension;
}

export function checkContent(type: FileType, content: Buffer): string | undefined {
  if (content.length === 0) return 'The file is empty';

  if (type.kind === 'pdf') {
    const looksLikePdf = content.subarray(0, 1024).includes('%PDF-');
    return looksLikePdf ? undefined : 'The file is not a valid PDF';
  }

  if (content.includes(0)) return 'The file does not look like a text document';
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(content);
  } catch {
    return 'The file is not valid UTF-8 text';
  }
  return text.trim().length === 0 ? 'The file contains no text' : undefined;
}
