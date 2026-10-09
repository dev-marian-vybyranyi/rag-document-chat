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

export const MAX_ARCHIVE_BYTES = 20 * 1024 * 1024;

export function validateArchive(file: File): string | null {
  if (!file.name.toLowerCase().endsWith('.zip')) return 'Choose a zip archive (.zip).';
  if (file.size === 0) return 'The archive is empty.';
  if (file.size > MAX_ARCHIVE_BYTES) {
    return `The archive is too large (limit ${formatBytes(MAX_ARCHIVE_BYTES)}).`;
  }
  return null;
}

const GITHUB_ADDRESS = /^https:\/\/(?:www\.)?github\.com\/[^/\s]+\/[^/\s]+(?:\/tree\/\S+)?\/?$/i;

export function validateGithubAddress(address: string): string | null {
  const trimmed = address.trim();
  if (trimmed.length === 0) return 'Enter the address of a GitHub repository.';
  if (!GITHUB_ADDRESS.test(trimmed)) {
    return 'Enter the address of a public repository, like https://github.com/owner/repo.';
  }
  return null;
}
