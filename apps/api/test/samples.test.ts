import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { chunkSegments } from '../src/documents/chunker.js';
import { extractText } from '../src/documents/extract.js';
import { detectFileType } from '../src/documents/file-types.js';
import { DEFAULT_MAX_CHUNKS } from '../src/documents/ingest.js';

const samplesDir = join(import.meta.dirname, '../../../samples');
const sources = readFileSync(join(samplesDir, 'SOURCES.md'), 'utf8');

const files = readdirSync(samplesDir).filter(
  (name) => statSync(join(samplesDir, name)).isFile() && name !== 'SOURCES.md',
);

describe('the sample corpus', () => {
  it('has files in it', () => {
    expect(files.length).toBeGreaterThanOrEqual(5);
  });

  describe.each(files)('%s', (name) => {
    const content = readFileSync(join(samplesDir, name));

    it('is listed in SOURCES.md with its source and the hash of this exact file', () => {
      const hash = createHash('sha256').update(content).digest('hex');

      expect(sources).toContain(`| \`${name}\` |`);
      expect(sources).toContain(`${hash}  ${name}`);
    });

    it('is a kind of document the app accepts', () => {
      expect(detectFileType(name)).toBeDefined();
    });

    it('can be read and cut into a sensible number of passages', async () => {
      const type = detectFileType(name)!;

      const extracted = await extractText(type, content);
      const chunks = chunkSegments(extracted.segments);

      expect(chunks.length).toBeGreaterThan(5);
      expect(chunks.length).toBeLessThan(DEFAULT_MAX_CHUNKS);
      expect(chunks.every((chunk) => chunk.content.trim().length > 0)).toBe(true);
      if (type.kind === 'pdf') {
        expect(extracted.pageCount).toBe(48);
        expect(new Set(chunks.map((chunk) => chunk.page)).size).toBeGreaterThan(30);
      } else {
        expect(extracted.pageCount).toBeNull();
      }
    });
  });

  it('keeps the license text of every licensed-by-copy source', () => {
    const licenses = readdirSync(join(samplesDir, 'licenses'));

    expect(licenses).toEqual(
      expect.arrayContaining(['rust-book-LICENSE-APACHE', 'rust-book-LICENSE-MIT']),
    );
  });
});
