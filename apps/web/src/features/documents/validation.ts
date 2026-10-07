export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
export const ACCEPTED_EXTENSIONS = ['.pdf', '.txt', '.md', '.markdown'];

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function validateFile(file: File): string | null {
  const name = file.name.toLowerCase();
  if (!ACCEPTED_EXTENSIONS.some((extension) => name.endsWith(extension))) {
    return 'Only PDF, TXT and Markdown files are supported.';
  }
  if (file.size === 0) return 'The file is empty.';
  if (file.size > MAX_UPLOAD_BYTES) {
    return `The file is too large (limit ${formatBytes(MAX_UPLOAD_BYTES)}).`;
  }
  return null;
}
