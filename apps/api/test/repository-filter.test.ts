import { describe, expect, it } from 'vitest';
import {
  checkFileContent,
  classifyFile,
  defaultImportLimits,
  ImportRejectedError,
  isSecretPath,
  languageOf,
  normalizeRepoPath,
  planImport,
  type ImportLimits,
} from '../src/repositories/filter.js';

const reasonOf = (path: string, size = 100, limits?: ImportLimits) => {
  const verdict = classifyFile({ path, size }, limits);
  return 'reason' in verdict ? verdict.reason : undefined;
};

describe('normalizeRepoPath', () => {
  it.each([
    ['src/app.ts', 'src/app.ts'],
    ['./src/app.ts', 'src/app.ts'],
    ['src//util/./date.ts', 'src/util/date.ts'],
    ['src\\win\\file.ts', 'src/win/file.ts'],
    ['dir/', 'dir'],
  ])('turns %s into %s', (raw, expected) => {
    expect(normalizeRepoPath(raw)).toBe(expected);
  });

  it.each([
    '../etc/passwd',
    'src/../../etc/passwd',
    'a/b/../../../c',
    '/etc/passwd',
    '\\windows\\system32',
    'C:/Windows/system32',
    'c:evil.txt',
    'src/app\u0000.ts',
    'src/ap\u202ep.ts',
    '',
    '.',
    './',
    `${'a/'.repeat(200)}b.ts`,
  ])('rejects %j', (raw) => {
    expect(normalizeRepoPath(raw)).toBeUndefined();
  });
});

describe('languageOf', () => {
  it.each([
    ['src/server.ts', 'typescript'],
    ['web/App.TSX', 'typescript'],
    ['main.py', 'python'],
    ['cmd/api/main.go', 'go'],
    ['docs/guide.md', 'markdown'],
    ['Dockerfile', 'dockerfile'],
    ['deploy/dockerfile', 'dockerfile'],
    ['Makefile', 'makefile'],
    ['config/settings.yml', 'yaml'],
  ])('knows %s', (path, language) => {
    expect(languageOf(path)).toBe(language);
  });

  it.each(['logo.png', 'archive.zip', 'LICENSE', 'noextension', '.gitignore', 'app.exe'])(
    'does not know %s',
    (path) => {
      expect(languageOf(path)).toBeUndefined();
    },
  );
});

describe('isSecretPath', () => {
  it.each([
    '.env',
    '.env.local',
    '.env.production',
    '.env.example',
    'apps/api/.env',
    'certs/server.pem',
    'deploy/tls.KEY',
    'keystore.jks',
    'home/.ssh/config',
    'id_rsa',
    'keys/id_ed25519.pub',
    '.npmrc',
    '.netrc',
    'infra/terraform.tfstate',
    'infra/prod.tfvars',
    'config/secrets.yml',
    'gcp/service-account-prod.json',
    '.aws/credentials',
    'credentials.json',
  ])('flags %s', (path) => {
    expect(isSecretPath(path)).toBe(true);
  });

  it.each(['src/environment.ts', 'src/env.ts', 'docs/secret-santa.md', 'src/keys.ts', 'README.md'])(
    'does not flag %s',
    (path) => {
      expect(isSecretPath(path)).toBe(false);
    },
  );
});

describe('classifyFile', () => {
  it('accepts source files with their language', () => {
    expect(classifyFile({ path: 'src/auth/login.ts', size: 1200 })).toEqual({
      language: 'typescript',
    });
  });

  it.each([
    ['.env', 'secret'],
    ['server/.env.production', 'secret'],
    ['certs/ca.pem', 'secret'],
    ['node_modules/left-pad/index.js', 'ignored-directory'],
    ['packages/web/node_modules/react/index.js', 'ignored-directory'],
    ['dist/bundle.js', 'ignored-directory'],
    ['.git/config', 'ignored-directory'],
    ['src/__pycache__/app.py', 'ignored-directory'],
    ['package-lock.json', 'lockfile'],
    ['apps/web/pnpm-lock.yaml', 'lockfile'],
    ['Cargo.lock', 'lockfile'],
    ['go.sum', 'lockfile'],
    ['logo.png', 'unsupported-type'],
    ['fonts/inter.woff2', 'unsupported-type'],
    ['LICENSE', 'unsupported-type'],
  ])('skips %s (%s)', (path, reason) => {
    expect(reasonOf(path)).toBe(reason);
  });

  it('keeps manifests and lock-free dependency lists', () => {
    for (const path of [
      'package.json',
      'requirements.txt',
      'go.mod',
      'Cargo.toml',
      'pyproject.toml',
    ]) {
      expect(reasonOf(path)).toBeUndefined();
    }
  });

  it('checks for secrets before anything else', () => {
    expect(reasonOf('node_modules/pkg/.env')).toBe('secret');
  });

  it('skips empty files and files over the size limit', () => {
    expect(reasonOf('src/empty.ts', 0)).toBe('empty');
    expect(reasonOf('src/big.ts', defaultImportLimits.maxFileBytes + 1)).toBe('too-large');
    expect(reasonOf('src/ok.ts', defaultImportLimits.maxFileBytes)).toBeUndefined();
  });

  it('honours custom limits', () => {
    const limits = { ...defaultImportLimits, maxFileBytes: 10 };

    expect(reasonOf('src/a.ts', 11, limits)).toBe('too-large');
  });
});

describe('checkFileContent', () => {
  const buf = (text: string) => Buffer.from(text, 'utf8');

  it('accepts ordinary source', () => {
    expect(checkFileContent('src/a.ts', buf('export const a = 1;\n'))).toBeUndefined();
  });

  it('rejects empty files, binary data and invalid UTF-8', () => {
    expect(checkFileContent('a.ts', Buffer.alloc(0))).toBe('empty');
    expect(checkFileContent('a.ts', Buffer.from([0x47, 0x49, 0x00, 0x46]))).toBe('binary');
    expect(checkFileContent('a.ts', Buffer.from([0xff, 0xfe, 0x41]))).toBe('not-utf8');
  });

  it('rejects a file that embeds a private key', () => {
    const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA\n-----END RSA PRIVATE KEY-----';
    const code = `const key = \`${pem}\`;\nexport default key;\n`;

    expect(checkFileContent('src/keys.ts', buf(code))).toBe('secret');
    expect(checkFileContent('docs/notes.md', buf(pem))).toBe('secret');
  });

  it('allows a public key or a mention of the words', () => {
    const text = 'Never commit a PRIVATE KEY. -----BEGIN PUBLIC KEY-----';

    expect(checkFileContent('docs/security.md', buf(text))).toBeUndefined();
  });

  it('rejects minified source', () => {
    const minified = `${'var a=function(){return 1};'.repeat(100)}\n`;

    expect(checkFileContent('static/app.js', buf(minified))).toBe('minified');
  });

  it('does not treat long lines of prose as minified', () => {
    const paragraph = `${'A long paragraph written on a single line. '.repeat(60)}\n`;

    expect(checkFileContent('docs/guide.md', buf(paragraph))).toBeUndefined();
    expect(checkFileContent('notes.txt', buf(paragraph))).toBeUndefined();
  });

  it('does not treat short files with a long line as minified', () => {
    const line = `const s = "${'x'.repeat(900)}";\n`;

    expect(checkFileContent('src/a.ts', buf(line))).toBeUndefined();
  });
});

describe('planImport', () => {
  const file = (path: string, size = 100) => ({ path, size });

  it('splits files into accepted and skipped with reasons', () => {
    const plan = planImport([
      file('src/index.ts'),
      file('README.md'),
      file('.env'),
      file('node_modules/x/index.js'),
      file('assets/logo.png'),
    ]);

    expect(plan.accepted).toEqual([
      { path: 'src/index.ts', size: 100, language: 'typescript' },
      { path: 'README.md', size: 100, language: 'markdown' },
    ]);
    expect(plan.skipped).toEqual([
      { path: '.env', reason: 'secret' },
      { path: 'node_modules/x/index.js', reason: 'ignored-directory' },
      { path: 'assets/logo.png', reason: 'unsupported-type' },
    ]);
  });

  it('rejects a repository with nothing to index', () => {
    expect(() => planImport([file('logo.png'), file('.env')])).toThrow(ImportRejectedError);
  });

  it('rejects a repository with too many indexable files', () => {
    const limits = { ...defaultImportLimits, maxFiles: 2 };
    const files = [file('a.ts'), file('b.ts'), file('c.ts')];

    expect(() => planImport(files, limits)).toThrow(/3 indexable files; the limit is 2/);
  });

  it('does not count skipped files towards the limits', () => {
    const limits = { ...defaultImportLimits, maxFiles: 2 };
    const files = [file('a.ts'), file('b.ts'), file('pkg/node_modules/c.ts'), file('d.png')];

    expect(planImport(files, limits).accepted).toHaveLength(2);
  });

  it('rejects a repository whose indexable files are too big together', () => {
    const limits = { ...defaultImportLimits, maxTotalBytes: 150 };

    expect(() => planImport([file('a.ts', 100), file('b.ts', 100)], limits)).toThrow(
      /add up to 200 bytes/,
    );
  });
});
