import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { extractText, ExtractionError, normalizeText } from '../src/documents/extract.js';
import type { FileType } from '../src/documents/file-types.js';
import { buildPdf } from './helpers/pdf.js';

const pdf: FileType = { kind: 'pdf', mimeType: 'application/pdf' };
const text: FileType = { kind: 'text', mimeType: 'text/plain' };
const markdown: FileType = { kind: 'markdown', mimeType: 'text/markdown' };

const bytes = (value: string) => Buffer.from(value, 'utf8');

describe('normalizeText', () => {
  it('unifies line endings', () => {
    expect(normalizeText('a\r\nb\rc')).toBe('a\nb\nc');
  });

  it('collapses runs of spaces and tabs and trims the lines', () => {
    expect(normalizeText('a \t  b  \n   c')).toBe('a b\nc');
  });

  it('keeps one blank line between paragraphs but no more', () => {
    expect(normalizeText('one\n\n\n\n\ntwo')).toBe('one\n\ntwo');
  });

  it('removes control characters but keeps tabs and newlines as whitespace', () => {
    expect(normalizeText('a\u0000b\u0007c\td\ne')).toBe('abc d\ne');
  });
});

describe('extractText', () => {
  describe('plain text and Markdown', () => {
    it('returns the text as one unpaged segment', async () => {
      const result = await extractText(text, bytes('First line.\n\nSecond paragraph.'));

      expect(result).toEqual({
        segments: [{ page: null, text: 'First line.\n\nSecond paragraph.' }],
        pageCount: null,
      });
    });

    it('drops a byte order mark and normalises Windows line endings', async () => {
      const result = await extractText(text, bytes('﻿hello\r\nworld'));

      expect(result.segments[0]?.text).toBe('hello\nworld');
    });

    it('keeps Markdown syntax, which later helps to find section titles', async () => {
      const result = await extractText(markdown, bytes('# Title\n\nSome *emphasis* here.'));

      expect(result.segments[0]?.text).toBe('# Title\n\nSome *emphasis* here.');
    });

    it('refuses a file that holds no text after cleaning', async () => {
      const blank = extractText(text, bytes('\u0000 \n\t'));

      await expect(blank).rejects.toThrow(new ExtractionError('The document contains no text'));
    });
  });

  describe('PDF', () => {
    it('returns one segment per page and remembers the page numbers', async () => {
      const result = await extractText(pdf, buildPdf([['Hello from page one'], ['And page two']]));

      expect(result.pageCount).toBe(2);
      expect(result.segments).toEqual([
        { page: 1, text: 'Hello from page one' },
        { page: 2, text: 'And page two' },
      ]);
    });

    it('joins the lines of a wrapped paragraph into running text', async () => {
      const result = await extractText(
        pdf,
        buildPdf([['The quick brown fox jumps', 'over the lazy dog.']]),
      );

      expect(result.segments[0]?.text).toBe('The quick brown fox jumps over the lazy dog.');
    });

    it('rejoins a word that was hyphenated across lines', async () => {
      const result = await extractText(
        pdf,
        buildPdf([['It crosses the inter-', 'national border.']]),
      );

      expect(result.segments[0]?.text).toBe('It crosses the international border.');
    });

    it('leaves a real hyphen alone when the next line starts a new capitalised word', async () => {
      const result = await extractText(pdf, buildPdf([['Retrieval-', 'Augmented Generation']]));

      expect(result.segments[0]?.text).toBe('Retrieval- Augmented Generation');
    });

    it('keeps page numbers true when a page has no text', async () => {
      const result = await extractText(pdf, buildPdf([['First'], [], ['Third']]));

      expect(result.pageCount).toBe(3);
      expect(result.segments.map((s) => s.page)).toEqual([1, 3]);
    });

    it('reads special characters such as parentheses', async () => {
      const result = await extractText(pdf, buildPdf([['Cost (approx.) is 5\\6']]));

      expect(result.segments[0]?.text).toBe('Cost (approx.) is 5\\6');
    });

    it('explains that a PDF without selectable text is probably a scan', async () => {
      const scanned = extractText(pdf, buildPdf([[], []]));

      await expect(scanned).rejects.toThrow('The PDF has no selectable text (it may be a scan)');
    });

    it('refuses a PDF that is damaged', async () => {
      const damaged = extractText(pdf, Buffer.from('%PDF-1.4\nthis is not really a pdf'));

      await expect(damaged).rejects.toBeInstanceOf(ExtractionError);
      await expect(damaged).rejects.toThrow('could not be read');
    });

    it('refuses a PDF with more pages than allowed', async () => {
      const long = extractText(pdf, buildPdf([['a'], ['b'], ['c']]), { maxPages: 2 });

      await expect(long).rejects.toThrow('too many pages (limit 2)');
    });

    it('does not alter the buffer it was given', async () => {
      const original = buildPdf([['Some text']]);
      const copy = Buffer.from(original);

      await extractText(pdf, original);

      expect(original.equals(copy)).toBe(true);
    });
  });

  it('reads the PDF produced by a real converter, not just our own builder', async () => {
    const fixture = process.env.REAL_PDF_FIXTURE;
    if (!fixture) return; // optional smoke test: point REAL_PDF_FIXTURE at any text PDF

    const result = await extractText(pdf, readFileSync(fixture));

    expect(result.segments.length).toBeGreaterThan(0);
  });
});
