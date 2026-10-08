import { buffer as readAll } from 'node:stream/consumers';
import yauzl from 'yauzl';
import { ImportRejectedError } from './errors.js';
import {
  checkFileContent,
  defaultImportLimits,
  normalizeRepoPath,
  planImport,
  type CandidateFile,
  type ImportLimits,
  type SkippedFile,
} from './filter.js';

export interface ImportedFile {
  path: string;
  language: string;
  content: string;
}

export interface ImportedRepository {
  files: ImportedFile[];
  skipped: SkippedFile[];
}

interface ArchiveEntry extends CandidateFile {
  entry: yauzl.Entry;
}

const UNIX_MADE_BY = 3;
const UNIX_TYPE_MASK = 0xf000;
const UNIX_SYMLINK = 0xa000;
const UNSAFE_PATH_ERROR = /absolute path|invalid relative path|invalid characters in fileName/;

const withoutBom = (text: string) => (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);

function isSymlink(entry: yauzl.Entry): boolean {
  if (entry.versionMadeBy >>> 8 !== UNIX_MADE_BY) return false;
  return ((entry.externalFileAttributes >>> 16) & UNIX_TYPE_MASK) === UNIX_SYMLINK;
}

function invalidArchive(cause: unknown): ImportRejectedError {
  const message = cause instanceof Error ? cause.message : '';
  if (UNSAFE_PATH_ERROR.test(message)) {
    return new ImportRejectedError('The archive contains a file path that is not allowed');
  }
  return new ImportRejectedError('The file is not a valid zip archive');
}

function stripSingleRoot(entries: ArchiveEntry[]): ArchiveEntry[] {
  const roots = new Set(entries.map((e) => e.path.split('/')[0]));
  const everythingIsNested = entries.every((e) => e.path.includes('/'));
  if (roots.size !== 1 || !everythingIsNested) return entries;
  return entries.map((e) => ({ ...e, path: e.path.slice(e.path.indexOf('/') + 1) }));
}

async function listEntries(
  zip: yauzl.ZipFile,
  limits: ImportLimits,
): Promise<{ entries: ArchiveEntry[]; skipped: SkippedFile[] }> {
  const entries: ArchiveEntry[] = [];
  const skipped: SkippedFile[] = [];
  const seen = new Set<string>();
  let count = 0;

  for await (const entry of zip.eachEntry()) {
    if (++count > limits.maxEntries) {
      throw new ImportRejectedError(
        `The archive has more than ${limits.maxEntries} entries, which is the limit`,
      );
    }
    if (entry.fileName.endsWith('/')) continue;

    const path = normalizeRepoPath(entry.fileName);
    if (!path) {
      throw new ImportRejectedError('The archive contains a file path that is not allowed');
    }
    if (seen.has(path)) {
      throw new ImportRejectedError(`The archive lists "${path}" more than once`);
    }
    seen.add(path);

    if (path.toLowerCase().startsWith('__macosx/')) {
      skipped.push({ path, reason: 'ignored-directory' });
      continue;
    }
    if (isSymlink(entry)) {
      skipped.push({ path, reason: 'symlink' });
      continue;
    }
    if (!entry.canDecodeFileData()) {
      skipped.push({ path, reason: 'unsupported-type' });
      continue;
    }
    entries.push({ path, size: entry.uncompressedSize, entry });
  }
  return { entries, skipped };
}

async function readEntry(zip: yauzl.ZipFile, entry: yauzl.Entry): Promise<Buffer> {
  const stream = await zip.openReadStreamPromise(entry);
  return readAll(stream);
}

export async function importZipArchive(
  archive: Buffer,
  limits: ImportLimits = defaultImportLimits,
): Promise<ImportedRepository> {
  if (archive.length > limits.maxArchiveBytes) {
    throw new ImportRejectedError(
      `The archive is larger than the ${limits.maxArchiveBytes} byte limit`,
    );
  }

  let zip: yauzl.ZipFile;
  try {
    zip = await yauzl.fromBufferPromise(archive, { lazyEntries: true });
  } catch (cause) {
    throw invalidArchive(cause);
  }

  try {
    const listed = await listEntries(zip, limits);
    const skipped = [...listed.skipped];

    const rooted = stripSingleRoot(listed.entries);
    const plan = planImport(rooted, limits);
    skipped.push(...plan.skipped);

    const entryByPath = new Map(rooted.map((e) => [e.path, e.entry]));
    const files: ImportedFile[] = [];
    for (const accepted of plan.accepted) {
      const content = await readEntry(zip, entryByPath.get(accepted.path)!);
      const reason = checkFileContent(accepted.path, content);
      if (reason) {
        skipped.push({ path: accepted.path, reason });
        continue;
      }
      files.push({
        path: accepted.path,
        language: accepted.language,
        content: withoutBom(content.toString('utf8')),
      });
    }

    if (files.length === 0) {
      throw new ImportRejectedError(
        'The archive has no source, documentation or configuration files to index',
      );
    }
    return { files, skipped };
  } catch (cause) {
    if (cause instanceof ImportRejectedError) throw cause;
    throw invalidArchive(cause);
  } finally {
    zip.close();
  }
}
