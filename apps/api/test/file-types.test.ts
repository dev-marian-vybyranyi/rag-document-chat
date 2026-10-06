import { describe, expect, it } from 'vitest';
import {
  checkContent,
  detectFileType,
  sanitizeFilename,
  type FileType,
} from '../src/documents/file-types.js';

const pdf: FileType = { kind: 'pdf', mimeType: 'application/pdf' };
const text: FileType = { kind: 'text', mimeType: 'text/plain' };

describe('detectFileType', () => {
  it.each([
    ['report.pdf', 'pdf', 'application/pdf'],
    ['notes.txt', 'text', 'text/plain'],
    ['README.md', 'markdown', 'text/markdown'],
    ['guide.markdown', 'markdown', 'text/markdown'],
  ])('recognises %s', (filename, kind, mimeType) => {
    expect(detectFileType(filename)).toEqual({ kind, mimeType });
  });

  it('ignores the letter case of the extension', () => {
    expect(detectFileType('SCAN.PDF')?.kind).toBe('pdf');
  });

  it.each([
    'malware.exe',
    'letter.docx',
    'archive.pdf.zip',
    'noextension',
    '.hidden',
    'trailingdot.',
  ])('rejects %s', (filename) => {
    expect(detectFileType(filename)).toBeUndefined();
  });
});

describe('sanitizeFilename', () => {
  it('keeps an ordinary name, including non-ASCII letters', () => {
    expect(sanitizeFilename('Звіт за 2025.pdf')).toBe('Звіт за 2025.pdf');
  });

  it.each([
    ['../../etc/passwd.txt', 'passwd.txt'],
    ['C:\\Users\\ada\\notes.txt', 'notes.txt'],
    ['/var/tmp/a.md', 'a.md'],
  ])('drops directories from %s', (raw, expected) => {
    expect(sanitizeFilename(raw)).toBe(expected);
  });

  it('removes control and direction-override characters used to disguise extensions', () => {
    expect(sanitizeFilename('invoice\u202Etxt.exe\u0000.pdf')).toBe('invoicetxt.exe.pdf');
  });

  it('collapses runs of whitespace and trims', () => {
    expect(sanitizeFilename('  my   notes \n v2.txt ')).toBe('my notes v2.txt');
  });

  it.each(['', '   ', '../', '\u0000'])('falls back to a default for %j', (raw) => {
    expect(sanitizeFilename(raw)).toBe('document');
  });

  it('shortens a very long name but keeps its extension', () => {
    const result = sanitizeFilename(`${'a'.repeat(500)}.pdf`);

    expect(result).toHaveLength(200);
    expect(result.endsWith('.pdf')).toBe(true);
  });
});

describe('checkContent', () => {
  const bytes = (value: string) => Buffer.from(value, 'utf8');

  it('rejects an empty file', () => {
    expect(checkContent(text, Buffer.alloc(0))).toBe('The file is empty');
    expect(checkContent(pdf, Buffer.alloc(0))).toBe('The file is empty');
  });

  describe('pdf', () => {
    it('accepts a file with the PDF header', () => {
      expect(checkContent(pdf, bytes('%PDF-1.7\n...'))).toBeUndefined();
    });

    it('accepts a header after a few junk bytes, as the spec allows', () => {
      expect(checkContent(pdf, bytes('\n\n  %PDF-1.4'))).toBeUndefined();
    });

    it('rejects something that merely has a .pdf name', () => {
      expect(checkContent(pdf, bytes('<html>not a pdf</html>'))).toBe(
        'The file is not a valid PDF',
      );
    });
  });

  describe('text', () => {
    it('accepts UTF-8 text, including non-Latin scripts', () => {
      expect(checkContent(text, bytes('Привіт, світе'))).toBeUndefined();
    });

    it('accepts text with a byte order mark', () => {
      expect(checkContent(text, Buffer.from([0xef, 0xbb, 0xbf, 0x68, 0x69]))).toBeUndefined();
    });

    it('rejects binary content', () => {
      expect(checkContent(text, Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00]))).toBe(
        'The file does not look like a text document',
      );
    });

    it('rejects bytes that are not valid UTF-8', () => {
      expect(checkContent(text, Buffer.from([0xff, 0xfe, 0xfa, 0x41]))).toBe(
        'The file is not valid UTF-8 text',
      );
    });

    it('rejects a file with nothing but whitespace', () => {
      expect(checkContent(text, bytes(' \n\t  \n'))).toBe('The file contains no text');
    });

    it('applies the same rules to Markdown', () => {
      const markdown: FileType = { kind: 'markdown', mimeType: 'text/markdown' };

      expect(checkContent(markdown, bytes('# Title\n\nBody'))).toBeUndefined();
      expect(checkContent(markdown, Buffer.from([0x00, 0x01]))).toBeDefined();
    });
  });
});
