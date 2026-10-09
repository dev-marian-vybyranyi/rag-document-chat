import { describe, expect, it } from 'vitest';
import {
  MAX_ARCHIVE_BYTES,
  MAX_UPLOAD_BYTES,
  formatBytes,
  validateArchive,
  validateFile,
  validateGithubAddress,
} from './validation';

function file(name: string, size: number): File {
  return new File([new Uint8Array(size)], name);
}

describe('validateFile', () => {
  it.each(['report.pdf', 'notes.txt', 'readme.md', 'guide.markdown', 'SHOUT.PDF'])(
    'accepts %s',
    (name) => {
      expect(validateFile(file(name, 10))).toBeNull();
    },
  );

  it.each(['photo.png', 'sheet.xlsx', 'archive.zip', 'noextension', 'doc.pdf.exe'])(
    'refuses %s as an unsupported type',
    (name) => {
      expect(validateFile(file(name, 10))).toMatch(/Only PDF, TXT and Markdown/);
    },
  );

  it('refuses an empty file', () => {
    expect(validateFile(file('a.txt', 0))).toBe('The file is empty.');
  });

  it('allows exactly the size limit and refuses one byte more', () => {
    expect(validateFile(file('a.txt', MAX_UPLOAD_BYTES))).toBeNull();
    expect(validateFile(file('a.txt', MAX_UPLOAD_BYTES + 1))).toMatch(
      /too large \(limit 10\.0 MB\)/,
    );
  });
});

describe('formatBytes', () => {
  it.each([
    [0, '0 B'],
    [1023, '1023 B'],
    [1024, '1 KB'],
    [150 * 1024, '150 KB'],
    [1024 * 1024, '1.0 MB'],
    [2.5 * 1024 * 1024, '2.5 MB'],
  ])('formats %d bytes as %s', (bytes, text) => {
    expect(formatBytes(bytes)).toBe(text);
  });
});

describe('validateArchive', () => {
  it.each(['code.zip', 'Project.ZIP', 'my repo.main.zip'])('accepts %s', (name) => {
    expect(validateArchive(file(name, 10))).toBeNull();
  });

  it.each(['code.tar.gz', 'code.rar', 'code', 'code.zip.exe', 'notes.txt'])(
    'refuses %s',
    (name) => {
      expect(validateArchive(file(name, 10))).toBe('Choose a zip archive (.zip).');
    },
  );

  it('refuses an empty archive', () => {
    expect(validateArchive(file('a.zip', 0))).toBe('The archive is empty.');
  });

  it('allows exactly the size limit and refuses one byte more', () => {
    expect(validateArchive(file('a.zip', MAX_ARCHIVE_BYTES))).toBeNull();
    expect(validateArchive(file('a.zip', MAX_ARCHIVE_BYTES + 1))).toMatch(
      /too large \(limit 20\.0 MB\)/,
    );
  });
});

describe('validateGithubAddress', () => {
  it.each([
    'https://github.com/owner/repo',
    'https://github.com/owner/repo/',
    '  https://github.com/owner/repo  ',
    'https://github.com/owner/repo.git',
    'https://www.github.com/owner/repo',
    'https://GitHub.com/Owner/Repo',
    'https://github.com/owner/repo/tree/main',
    'https://github.com/owner/repo/tree/feature/login',
  ])('accepts %j', (address) => {
    expect(validateGithubAddress(address)).toBeNull();
  });

  it.each([
    'http://github.com/owner/repo',
    'https://gitlab.com/owner/repo',
    'https://github.com.evil.example/owner/repo',
    'https://github.com/owner',
    'https://github.com/',
    'github.com/owner/repo',
    'owner/repo',
    'git@github.com:owner/repo.git',
    'https://github.com/owner/repo/issues/1',
    'https://github.com/owner repo',
  ])('refuses %j with an example to follow', (address) => {
    expect(validateGithubAddress(address)).toMatch(/like https:\/\/github\.com\/owner\/repo/);
  });

  it('asks for an address when there is none', () => {
    expect(validateGithubAddress('')).toBe('Enter the address of a GitHub repository.');
    expect(validateGithubAddress('   ')).toBe('Enter the address of a GitHub repository.');
  });
});
