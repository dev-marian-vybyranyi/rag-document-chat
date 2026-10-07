import { describe, expect, it } from 'vitest';
import { MAX_UPLOAD_BYTES, formatBytes, validateFile } from './validation';

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
