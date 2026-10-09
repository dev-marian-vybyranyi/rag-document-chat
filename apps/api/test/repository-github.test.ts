import { describe, expect, it } from 'vitest';
import { ImportRejectedError, ImportUnavailableError } from '../src/repositories/errors.js';
import { defaultImportLimits } from '../src/repositories/filter.js';
import { createGithubImporter, parseGithubUrl } from '../src/repositories/github.js';
import { buildZip } from './helpers/zip.js';

const SHA = '7fd1a60b01f91b314f59955a4e4d4e80d8edf11d';

describe('parseGithubUrl', () => {
  it.each([
    ['https://github.com/acme/api/tree/a/../b', 'b'],
    ['https://github.com/acme/api/tree/a/%2e%2e/b', 'b'],
  ])('resolves dot segments in %s before the ref is read', (input, ref) => {
    expect(parseGithubUrl(input).ref).toBe(ref);
  });

  it.each([
    ['https://github.com/acme/api', { owner: 'acme', name: 'api', ref: null }],
    ['https://github.com/acme/api/', { owner: 'acme', name: 'api', ref: null }],
    ['  https://github.com/acme/api  ', { owner: 'acme', name: 'api', ref: null }],
    ['https://github.com/acme/api.git', { owner: 'acme', name: 'api', ref: null }],
    ['https://www.github.com/acme/api', { owner: 'acme', name: 'api', ref: null }],
    ['https://GitHub.com/acme/api?tab=readme#top', { owner: 'acme', name: 'api', ref: null }],
    ['https://github.com/acme/api/tree/main', { owner: 'acme', name: 'api', ref: 'main' }],
    ['https://github.com/acme/api/tree/v1.2.0', { owner: 'acme', name: 'api', ref: 'v1.2.0' }],
    [
      'https://github.com/acme/api/tree/feature/login',
      { owner: 'acme', name: 'api', ref: 'feature/login' },
    ],
    ['https://github.com/acme/api.js', { owner: 'acme', name: 'api.js', ref: null }],
  ])('accepts %s', (input, expected) => {
    expect(parseGithubUrl(input)).toEqual(expected);
  });

  it.each([
    ['another host', 'https://gitlab.com/acme/api'],
    ['a look-alike host', 'https://github.com.evil.example/acme/api'],
    ['a host with github.com as a user name', 'https://github.com@evil.example/acme/api'],
    ['a sub-domain', 'https://gist.github.com/acme/api'],
    ['an API host', 'https://api.github.com/repos/acme/api'],
    ['plain http', 'http://github.com/acme/api'],
    ['an SSH address', 'git@github.com:acme/api.git'],
    ['a non-default port', 'https://github.com:8443/acme/api'],
    ['credentials', 'https://user:pass@github.com/acme/api'],
    ['a local address', 'https://127.0.0.1/acme/api'],
    ['an internal address', 'https://169.254.169.254/latest/meta-data'],
    ['a file URL', 'file:///etc/passwd'],
    ['only an owner', 'https://github.com/acme'],
    ['no path', 'https://github.com/'],
    ['a page that is not a repository root', 'https://github.com/acme/api/issues/3'],
    ['a pull request', 'https://github.com/acme/api/pull/7'],
    ['a path in place of a name', 'https://github.com/acme/..'],
    ['an invalid owner', 'https://github.com/-acme/api'],
    ['not a URL', 'acme/api'],
    ['an empty string', ''],
  ])('rejects %s', (_label, input) => {
    expect(() => parseGithubUrl(input)).toThrow(ImportRejectedError);
  });

  it.each([
    ['spaces', 'https://github.com/acme/api/tree/a%20b'],
    ['a query-like character', 'https://github.com/acme/api/tree/a%3Fb'],
    ['a broken escape', 'https://github.com/acme/api/tree/%E0%A4%A'],
    ['a tree without a ref', 'https://github.com/acme/api/tree'],
  ])('rejects a ref with %s', (_label, input) => {
    expect(() => parseGithubUrl(input)).toThrow(ImportRejectedError);
  });
});

interface Call {
  url: string;
  init: RequestInit | undefined;
}

type Handler = (url: URL, init: RequestInit | undefined) => Response | Promise<Response>;

function stubFetch(handler: Handler) {
  const calls: Call[] = [];
  const stub = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    return handler(new URL(url), init);
  }) as typeof fetch;
  return { fetch: stub, calls };
}

const shaResponse = (sha = SHA) =>
  new Response(sha, { headers: { 'content-type': 'application/vnd.github.sha' } });

const zipResponse = (zip: Buffer) =>
  new Response(new Uint8Array(zip), {
    headers: { 'content-type': 'application/zip', 'content-length': String(zip.length) },
  });

const sampleZip = () => buildZip(['api-7fd1a60/src/index.ts', 'api-7fd1a60/README.md']);

function happyPath() {
  return stubFetch((url) =>
    url.hostname === 'api.github.com' ? shaResponse() : zipResponse(sampleZip()),
  );
}

describe('createGithubImporter', () => {
  describe('a successful import', () => {
    it('resolves the commit, downloads that exact commit and unpacks it', async () => {
      const { fetch, calls } = happyPath();

      const result = await createGithubImporter({ fetch }).importFromUrl(
        'https://github.com/acme/api',
      );

      expect(result.source).toEqual({
        owner: 'acme',
        name: 'api',
        ref: null,
        url: 'https://github.com/acme/api',
        commitSha: SHA,
      });
      expect(result.repository.files.map((f) => f.path).sort()).toEqual([
        'README.md',
        'src/index.ts',
      ]);
      expect(calls.map((c) => c.url)).toEqual([
        'https://api.github.com/repos/acme/api/commits/HEAD',
        `https://codeload.github.com/acme/api/zip/${SHA}`,
      ]);
    });

    it('asks for the requested branch, tag or commit', async () => {
      const { fetch, calls } = happyPath();

      const result = await createGithubImporter({ fetch }).importFromUrl(
        'https://github.com/acme/api/tree/feature/login',
      );

      expect(calls[0]?.url).toBe('https://api.github.com/repos/acme/api/commits/feature/login');
      expect(result.source.ref).toBe('feature/login');
    });

    it('sends the user agent and the sha media type, and never a token by default', async () => {
      const { fetch, calls } = happyPath();

      await createGithubImporter({ fetch }).importFromUrl('https://github.com/acme/api');

      const headers = calls[0]?.init?.headers as Record<string, string>;
      expect(headers['Accept']).toBe('application/vnd.github.sha');
      expect(headers['User-Agent']).toBeTruthy();
      expect(headers['Authorization']).toBeUndefined();
    });

    it('uses a configured token for the API call only', async () => {
      const { fetch, calls } = happyPath();

      await createGithubImporter({ fetch, token: 'test-token' }).importFromUrl(
        'https://github.com/acme/api',
      );

      const apiHeaders = calls[0]?.init?.headers as Record<string, string>;
      const archiveHeaders = calls[1]?.init?.headers as Record<string, string>;
      expect(apiHeaders['Authorization']).toBe('Bearer test-token');
      expect(archiveHeaders['Authorization']).toBeUndefined();
    });

    it('does not follow redirects', async () => {
      const { fetch, calls } = happyPath();

      await createGithubImporter({ fetch }).importFromUrl('https://github.com/acme/api');

      expect(calls.every((c) => c.init?.redirect === 'manual')).toBe(true);
    });
  });

  describe('only GitHub is ever contacted', () => {
    it('rejects foreign addresses before any request', async () => {
      const { fetch, calls } = happyPath();

      await expect(
        createGithubImporter({ fetch }).importFromUrl('https://169.254.169.254/acme/api'),
      ).rejects.toThrow(ImportRejectedError);
      expect(calls).toEqual([]);
    });

    it('keeps odd characters in a name or ref inside the URL path', async () => {
      const { fetch, calls } = happyPath();

      await createGithubImporter({ fetch }).importFromUrl(
        'https://github.com/acme/api/tree/release%2F1.0',
      );

      const hosts = calls.map((c) => new URL(c.url).hostname);
      expect(hosts).toEqual(['api.github.com', 'codeload.github.com']);
      expect(calls[0]?.url).toBe('https://api.github.com/repos/acme/api/commits/release/1.0');
    });

    it('refuses an answer that is not a commit hash, so nothing odd reaches the download URL', async () => {
      const { fetch, calls } = stubFetch(() => shaResponse('../../evil'));

      await expect(
        createGithubImporter({ fetch }).importFromUrl('https://github.com/acme/api'),
      ).rejects.toThrow(ImportUnavailableError);
      expect(calls).toHaveLength(1);
    });
  });

  describe('when GitHub says no', () => {
    const importWith = (handler: Handler, options = {}) =>
      createGithubImporter({ fetch: stubFetch(handler).fetch, ...options }).importFromUrl(
        'https://github.com/acme/api/tree/dev',
      );

    it('explains a missing or private repository', async () => {
      await expect(importWith(() => new Response('{}', { status: 404 }))).rejects.toThrow(
        new ImportRejectedError('The repository was not found, or it is private'),
      );
    });

    it('explains an unknown branch', async () => {
      await expect(importWith(() => new Response('{}', { status: 422 }))).rejects.toThrow(
        new ImportRejectedError('The branch, tag or commit "dev" was not found'),
      );
    });

    it('explains an empty repository', async () => {
      await expect(importWith(() => new Response('{}', { status: 409 }))).rejects.toThrow(
        new ImportRejectedError('The repository is empty'),
      );
    });

    it('treats a moved repository as something to fix in the address', async () => {
      const moved = () => new Response(null, { status: 301, headers: { location: 'https://x' } });

      await expect(importWith(moved)).rejects.toThrow(/has moved/);
    });

    it.each([
      ['403 with no requests left', 403, { 'x-ratelimit-remaining': '0' }],
      ['429', 429, {}],
    ])('reports the rate limit (%s) as temporary', async (_label, status, headers) => {
      const limited = () => new Response('{}', { status, headers });

      await expect(importWith(limited)).rejects.toThrow(ImportUnavailableError);
      await expect(importWith(limited)).rejects.toThrow(/limiting requests/);
    });

    it('reports a GitHub outage as temporary', async () => {
      await expect(importWith(() => new Response('oops', { status: 503 }))).rejects.toThrow(
        ImportUnavailableError,
      );
    });

    it('reports a network failure as temporary', async () => {
      const broken = () => {
        throw new TypeError('fetch failed');
      };

      await expect(importWith(broken)).rejects.toThrow(
        new ImportUnavailableError('Could not reach GitHub. Try again in a moment'),
      );
    });

    it('gives up when GitHub is too slow', async () => {
      const slow: Handler = (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        });

      await expect(importWith(slow, { apiTimeoutMs: 20 })).rejects.toThrow(ImportUnavailableError);
    });
  });

  describe('the download', () => {
    const withArchive = (archive: () => Response, limits = defaultImportLimits) =>
      createGithubImporter({
        fetch: stubFetch((url) => (url.hostname === 'api.github.com' ? shaResponse() : archive()))
          .fetch,
        limits,
      }).importFromUrl('https://github.com/acme/api');

    it('is refused up front when GitHub announces a size over the limit', async () => {
      const limits = { ...defaultImportLimits, maxArchiveBytes: 100 };
      const big = () =>
        new Response('x', {
          headers: { 'content-length': '5000', 'content-type': 'application/zip' },
        });

      await expect(withArchive(big, limits)).rejects.toThrow(/larger than the 100 byte limit/);
    });

    it('is cut off when it turns out larger than the limit without announcing it', async () => {
      const limits = { ...defaultImportLimits, maxArchiveBytes: 100 };
      const unannounced = () => new Response(new Uint8Array(5000));

      await expect(withArchive(unannounced, limits)).rejects.toThrow(
        /larger than the 100 byte limit/,
      );
    });

    it('fails clearly when the body is not a zip archive', async () => {
      await expect(withArchive(() => new Response('<html>nope</html>'))).rejects.toThrow(
        new ImportRejectedError('The file is not a valid zip archive'),
      );
    });

    it('reports a download that breaks off as temporary', async () => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(10));
          controller.error(new Error('connection reset'));
        },
      });

      await expect(withArchive(() => new Response(stream))).rejects.toThrow(
        new ImportUnavailableError('The download from GitHub was interrupted'),
      );
    });

    it('applies the same safety checks as an uploaded archive', async () => {
      const hostile = buildZip(['api-x/src/a.ts', { name: 'api-x/../../etc/x.ts', data: 'x' }]);

      await expect(withArchive(() => zipResponse(hostile))).rejects.toThrow(
        /path that is not allowed/,
      );
    });
  });
});
