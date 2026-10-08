export interface ImportLimits {
  maxFiles: number;
  maxFileBytes: number;
  maxTotalBytes: number;
}

export const defaultImportLimits: ImportLimits = {
  maxFiles: 300,
  maxFileBytes: 200_000,
  maxTotalBytes: 5_000_000,
};

export type SkipReason =
  | 'ignored-directory'
  | 'secret'
  | 'lockfile'
  | 'unsupported-type'
  | 'too-large'
  | 'empty'
  | 'binary'
  | 'not-utf8'
  | 'minified';

export interface CandidateFile {
  path: string;
  size: number;
}

export interface AcceptedFile extends CandidateFile {
  language: string;
}

export interface SkippedFile {
  path: string;
  reason: SkipReason;
}

export interface ImportPlan {
  accepted: AcceptedFile[];
  skipped: SkippedFile[];
}

export class ImportRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImportRejectedError';
  }
}

const MAX_PATH_LENGTH = 300;
const MAX_LINE_LENGTH_OF_SOURCE = 1_000;
const MINIFIED_CHECK_FROM_BYTES = 1_024;

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.py': 'python',
  '.go': 'go',
  '.rs': 'rust',
  '.java': 'java',
  '.kt': 'kotlin',
  '.kts': 'kotlin',
  '.scala': 'scala',
  '.swift': 'swift',
  '.rb': 'ruby',
  '.php': 'php',
  '.cs': 'csharp',
  '.c': 'c',
  '.h': 'c',
  '.cc': 'cpp',
  '.cpp': 'cpp',
  '.hpp': 'cpp',
  '.sh': 'shell',
  '.bash': 'shell',
  '.sql': 'sql',
  '.graphql': 'graphql',
  '.gql': 'graphql',
  '.proto': 'protobuf',
  '.html': 'html',
  '.css': 'css',
  '.scss': 'scss',
  '.vue': 'vue',
  '.svelte': 'svelte',
  '.json': 'json',
  '.yaml': 'yaml',
  '.yml': 'yaml',
  '.toml': 'toml',
  '.ini': 'ini',
  '.xml': 'xml',
  '.gradle': 'gradle',
  '.tf': 'terraform',
  '.md': 'markdown',
  '.mdx': 'markdown',
  '.markdown': 'markdown',
  '.rst': 'restructuredtext',
  '.txt': 'text',
};

const LANGUAGE_BY_FILENAME: Record<string, string> = {
  dockerfile: 'dockerfile',
  makefile: 'makefile',
  procfile: 'procfile',
  'go.mod': 'go',
  gemfile: 'ruby',
  pipfile: 'toml',
};

const PROSE_LANGUAGES = new Set(['markdown', 'restructuredtext', 'text']);

const IGNORED_DIRECTORIES = new Set([
  '.git',
  '.hg',
  '.svn',
  'node_modules',
  'bower_components',
  'vendor',
  'dist',
  'build',
  'out',
  'target',
  'coverage',
  '.next',
  '.nuxt',
  '.turbo',
  '.cache',
  '.gradle',
  '.idea',
  '.vscode',
  '__pycache__',
  '.venv',
  'venv',
  'site-packages',
]);

const SECRET_DIRECTORIES = new Set(['.ssh', '.aws', '.gnupg', '.kube', '.docker']);

const SECRET_EXTENSIONS = new Set([
  '.pem',
  '.key',
  '.p12',
  '.pfx',
  '.jks',
  '.keystore',
  '.crt',
  '.cer',
  '.der',
  '.tfstate',
  '.tfvars',
]);

const SECRET_FILENAMES = new Set([
  '.npmrc',
  '.pypirc',
  '.netrc',
  '.htpasswd',
  '.git-credentials',
  'credentials',
  'credentials.json',
  'kubeconfig',
]);

const SECRET_FILENAME_PATTERNS = [
  /^\.env(?:\..*)?$/,
  /^id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?$/,
  /^secrets?\.[a-z]+$/,
  /^service[-_]account.*\.json$/,
];

const LOCKFILE_NAMES = new Set([
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'bun.lockb',
  'cargo.lock',
  'poetry.lock',
  'pipfile.lock',
  'uv.lock',
  'composer.lock',
  'gemfile.lock',
  'go.sum',
]);

const PRIVATE_KEY_BLOCK = /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/;

export function normalizeRepoPath(raw: string): string | undefined {
  if (/[\p{Cc}\p{Cf}]/u.test(raw)) return undefined;
  const slashed = raw.replace(/\\/g, '/');
  if (slashed.startsWith('/') || /^[a-zA-Z]:/.test(slashed)) return undefined;

  const segments: string[] = [];
  for (const segment of slashed.split('/')) {
    if (segment === '..') return undefined;
    if (segment === '' || segment === '.') continue;
    segments.push(segment);
  }
  const path = segments.join('/');
  if (path.length === 0 || path.length > MAX_PATH_LENGTH) return undefined;
  return path;
}

function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf('.');
  return dot > 0 ? filename.slice(dot).toLowerCase() : '';
}

export function languageOf(path: string): string | undefined {
  const filename = (path.split('/').pop() ?? '').toLowerCase();
  return LANGUAGE_BY_FILENAME[filename] ?? LANGUAGE_BY_EXTENSION[extensionOf(filename)];
}

export function isSecretPath(path: string): boolean {
  const segments = path.toLowerCase().split('/');
  const filename = segments.pop() ?? '';
  if (segments.some((segment) => SECRET_DIRECTORIES.has(segment))) return true;
  if (SECRET_FILENAMES.has(filename)) return true;
  if (SECRET_EXTENSIONS.has(extensionOf(filename))) return true;
  return SECRET_FILENAME_PATTERNS.some((pattern) => pattern.test(filename));
}

export function classifyFile(
  file: CandidateFile,
  limits: ImportLimits = defaultImportLimits,
): { language: string } | { reason: SkipReason } {
  const segments = file.path.split('/');
  const filename = (segments.pop() ?? '').toLowerCase();

  if (isSecretPath(file.path)) return { reason: 'secret' };
  if (segments.some((segment) => IGNORED_DIRECTORIES.has(segment.toLowerCase()))) {
    return { reason: 'ignored-directory' };
  }
  if (LOCKFILE_NAMES.has(filename)) return { reason: 'lockfile' };

  const language = languageOf(file.path);
  if (!language) return { reason: 'unsupported-type' };
  if (file.size === 0) return { reason: 'empty' };
  if (file.size > limits.maxFileBytes) return { reason: 'too-large' };
  return { language };
}

export function checkFileContent(path: string, content: Buffer): SkipReason | undefined {
  if (content.length === 0) return 'empty';
  if (content.includes(0)) return 'binary';

  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(content);
  } catch {
    return 'not-utf8';
  }

  if (PRIVATE_KEY_BLOCK.test(text)) return 'secret';

  const language = languageOf(path);
  const isProse = language !== undefined && PROSE_LANGUAGES.has(language);
  if (!isProse && content.length >= MINIFIED_CHECK_FROM_BYTES) {
    const longestLine = text.split('\n').reduce((max, line) => Math.max(max, line.length), 0);
    if (longestLine > MAX_LINE_LENGTH_OF_SOURCE) return 'minified';
  }
  return undefined;
}

export function planImport(
  files: CandidateFile[],
  limits: ImportLimits = defaultImportLimits,
): ImportPlan {
  const accepted: AcceptedFile[] = [];
  const skipped: SkippedFile[] = [];
  let totalBytes = 0;

  for (const file of files) {
    const verdict = classifyFile(file, limits);
    if ('reason' in verdict) {
      skipped.push({ path: file.path, reason: verdict.reason });
      continue;
    }
    accepted.push({ ...file, language: verdict.language });
    totalBytes += file.size;
  }

  if (accepted.length === 0) {
    throw new ImportRejectedError(
      'The repository has no source, documentation or configuration files to index',
    );
  }
  if (accepted.length > limits.maxFiles) {
    throw new ImportRejectedError(
      `The repository has ${accepted.length} indexable files; the limit is ${limits.maxFiles}`,
    );
  }
  if (totalBytes > limits.maxTotalBytes) {
    throw new ImportRejectedError(
      `The indexable files add up to ${totalBytes} bytes; the limit is ${limits.maxTotalBytes}`,
    );
  }
  return { accepted, skipped };
}
