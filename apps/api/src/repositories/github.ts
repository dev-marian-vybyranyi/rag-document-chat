import { ImportRejectedError, ImportUnavailableError } from './errors.js';
import { defaultImportLimits, type ImportLimits } from './filter.js';
import { importZipArchive, type ImportedRepository } from './zip.js';

export interface GithubRepositoryRef {
  owner: string;
  name: string;
  ref: string | null;
}

export interface GithubSource extends GithubRepositoryRef {
  url: string;
  commitSha: string;
}

export interface GithubImport {
  source: GithubSource;
  repository: ImportedRepository;
}

export interface GithubImporterOptions {
  fetch?: typeof fetch;
  token?: string | undefined;
  limits?: ImportLimits;
  apiTimeoutMs?: number;
  downloadTimeoutMs?: number;
}

const API_ORIGIN = 'https://api.github.com';
const ARCHIVE_ORIGIN = 'https://codeload.github.com';
const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const NAME = /^[A-Za-z0-9._-]{1,100}$/;
const REF = /^[A-Za-z0-9._/-]{1,200}$/;
const COMMIT_SHA = /^[0-9a-f]{40}$/;
const GITHUB_HOSTS = new Set(['github.com', 'www.github.com']);

const NOT_GITHUB = 'Enter the address of a public repository on github.com';

export function parseGithubUrl(input: string): GithubRepositoryRef {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new ImportRejectedError(NOT_GITHUB);
  }
  if (
    url.protocol !== 'https:' ||
    !GITHUB_HOSTS.has(url.hostname) ||
    url.port !== '' ||
    url.username !== '' ||
    url.password !== ''
  ) {
    throw new ImportRejectedError(NOT_GITHUB);
  }

  const [owner, rawName, kind, ...rest] = url.pathname.split('/').filter((s) => s.length > 0);
  const name = rawName?.replace(/\.git$/, '');
  if (!owner || !name || !OWNER.test(owner) || !NAME.test(name) || name === '.' || name === '..') {
    throw new ImportRejectedError(NOT_GITHUB);
  }

  if (kind === undefined) return { owner, name, ref: null };
  if (kind !== 'tree' || rest.length === 0) {
    throw new ImportRejectedError(NOT_GITHUB);
  }
  let ref: string;
  try {
    ref = decodeURIComponent(rest.join('/'));
  } catch {
    throw new ImportRejectedError(NOT_GITHUB);
  }
  if (!REF.test(ref) || ref.includes('..') || ref.includes('//')) {
    throw new ImportRejectedError('The branch, tag or commit in the address is not valid');
  }
  return { owner, name, ref };
}

const encodePath = (value: string) => value.split('/').map(encodeURIComponent).join('/');

function isRateLimited(response: Response): boolean {
  if (response.status === 429) return true;
  return response.status === 403 && response.headers.get('x-ratelimit-remaining') === '0';
}

export function createGithubImporter({
  fetch: fetchImpl = fetch,
  token,
  limits = defaultImportLimits,
  apiTimeoutMs = 15_000,
  downloadTimeoutMs = 60_000,
}: GithubImporterOptions = {}) {
  async function request(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
    try {
      return await fetchImpl(url, {
        ...init,
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new ImportUnavailableError('Could not reach GitHub. Try again in a moment');
    }
  }

  function failFor(response: Response): never {
    if (response.status >= 300 && response.status < 400) {
      throw new ImportRejectedError(
        'The repository has moved. Use its current address on github.com',
      );
    }
    if (isRateLimited(response)) {
      throw new ImportUnavailableError('GitHub is limiting requests right now. Try again later');
    }
    if (response.status === 404) {
      throw new ImportRejectedError('The repository was not found, or it is private');
    }
    throw new ImportUnavailableError(`GitHub could not be read (status ${response.status})`);
  }

  async function resolveCommit(target: GithubRepositoryRef): Promise<string> {
    const ref = target.ref ?? 'HEAD';
    const url = `${API_ORIGIN}/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(
      target.name,
    )}/commits/${encodePath(ref)}`;
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github.sha',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'rag-document-chat',
    };
    if (token) headers.Authorization = `Bearer ${token}`;

    const response = await request(url, { headers }, apiTimeoutMs);
    if (response.status === 422) {
      throw new ImportRejectedError(`The branch, tag or commit "${ref}" was not found`);
    }
    if (response.status === 409) throw new ImportRejectedError('The repository is empty');
    if (!response.ok) failFor(response);

    const sha = (await response.text()).trim();
    if (!COMMIT_SHA.test(sha)) {
      throw new ImportUnavailableError('GitHub returned an unexpected answer');
    }
    return sha;
  }

  async function download(target: GithubRepositoryRef, commitSha: string): Promise<Buffer> {
    const url = `${ARCHIVE_ORIGIN}/${encodeURIComponent(target.owner)}/${encodeURIComponent(
      target.name,
    )}/zip/${commitSha}`;
    const response = await request(
      url,
      { headers: { 'User-Agent': 'rag-document-chat' } },
      downloadTimeoutMs,
    );
    if (!response.ok) failFor(response);

    const tooLarge = () =>
      new ImportRejectedError(
        `The repository archive is larger than the ${limits.maxArchiveBytes} byte limit`,
      );
    const declared = Number(response.headers.get('content-length'));
    if (declared > limits.maxArchiveBytes) throw tooLarge();

    const parts: Buffer[] = [];
    let total = 0;
    try {
      for await (const part of response.body ?? []) {
        total += part.length;
        if (total > limits.maxArchiveBytes) throw tooLarge();
        parts.push(Buffer.from(part));
      }
    } catch (cause) {
      if (cause instanceof ImportRejectedError) throw cause;
      throw new ImportUnavailableError('The download from GitHub was interrupted');
    }
    return Buffer.concat(parts);
  }

  return {
    async importFromUrl(input: string): Promise<GithubImport> {
      const target = parseGithubUrl(input);
      const commitSha = await resolveCommit(target);
      const archive = await download(target, commitSha);
      const repository = await importZipArchive(archive, limits);
      return {
        source: {
          ...target,
          url: `https://github.com/${target.owner}/${target.name}`,
          commitSha,
        },
        repository,
      };
    },
  };
}

export type GithubImporter = ReturnType<typeof createGithubImporter>;
