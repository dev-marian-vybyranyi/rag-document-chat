import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { chunkSourceFile, type SourceFile } from '../src/repositories/chunker.js';
import { languageOf } from '../src/repositories/filter.js';
import {
  expectFaithfulToSource,
  expectInReadingOrder,
  expectWithinLimit,
  seededRandom,
} from './helpers/chunk-invariants.js';

const REPOSITORY_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const SKIPPED_DIRECTORIES = new Set(['node_modules', 'dist', '.git', 'coverage', 'drizzle']);
const SIZES = [15, 60, 200, 500];

function ownSources(directory: string, found: SourceFile[] = []): SourceFile[] {
  for (const name of readdirSync(directory)) {
    if (SKIPPED_DIRECTORIES.has(name)) continue;
    const path = join(directory, name);
    if (statSync(path).isDirectory()) {
      ownSources(path, found);
      continue;
    }
    const language = languageOf(name);
    if (!language || statSync(path).size > 200_000) continue;
    found.push({
      path: relative(REPOSITORY_ROOT, path),
      language,
      content: readFileSync(path, 'utf8'),
    });
  }
  return found;
}

const sources = ownSources(join(REPOSITORY_ROOT, 'apps'))
  .concat(ownSources(join(REPOSITORY_ROOT, 'docs')))
  .filter((source) => source.content.trim().length > 0);

describe('the chunker on this repository’s own files', () => {
  it('finds a meaningful sample of files in several languages', () => {
    const languages = new Set(sources.map((s) => s.language));

    expect(sources.length).toBeGreaterThan(150);
    expect(languages).toContain('typescript');
    expect(languages).toContain('markdown');
    expect(languages).toContain('json');
  });

  it.each(SIZES)('keeps every file faithful, covered and within %i tokens', (maxTokens) => {
    for (const source of sources) {
      const chunks = chunkSourceFile(source, { maxTokens });

      expect(chunks.length, source.path).toBeGreaterThan(0);
      expectFaithfulToSource(source, chunks);
      expectWithinLimit(chunks, maxTokens);
      expectInReadingOrder(chunks);
    }
  });

  it('gives the same chunks every time', () => {
    for (const source of sources.slice(0, 40)) {
      expect(chunkSourceFile(source, { maxTokens: 100 })).toEqual(
        chunkSourceFile(source, { maxTokens: 100 }),
      );
    }
  });

  it('makes a file that fits into a single chunk', () => {
    for (const source of sources) {
      const chunks = chunkSourceFile(source, { maxTokens: 100_000 });

      expect(chunks, source.path).toHaveLength(1);
    }
  });

  it('chunks more finely as the limit shrinks, never coarsely', () => {
    for (const source of sources.slice(0, 60)) {
      const counts = SIZES.map((maxTokens) => chunkSourceFile(source, { maxTokens }).length);

      for (let i = 1; i < counts.length; i++) {
        expect(counts[i - 1]!, source.path).toBeGreaterThanOrEqual(Math.floor(counts[i]! * 0.9));
      }
    }
  });
});

describe('the chunker on damaged input', () => {
  const typescripts = sources.filter((s) => s.language === 'typescript').slice(0, 25);

  function damage(content: string, random: () => number): string {
    const lines = content.split('\n');
    return lines
      .flatMap((line) => {
        const roll = random();
        if (roll < 0.05) return [];
        if (roll < 0.1) return [line, line];
        if (roll < 0.15) return [line.trimStart()];
        if (roll < 0.2) return [`${' '.repeat(Math.floor(random() * 9))}${line}`];
        if (roll < 0.23) return [`${line}${'x'.repeat(Math.floor(random() * 3000))}`];
        if (roll < 0.25) return [`\t${line}\r`];
        return [line];
      })
      .join('\n');
  }

  it.each([1, 2, 3, 4, 5])(
    'stays faithful when lines are dropped, indented or stretched (seed %i)',
    (seed) => {
      const random = seededRandom(seed);

      for (const source of typescripts) {
        const damaged = { ...source, content: damage(source.content, random) };
        for (const maxTokens of [30, 150]) {
          const chunks = chunkSourceFile(damaged, { maxTokens });

          expectFaithfulToSource(damaged, chunks);
          expectWithinLimit(chunks, maxTokens);
          expectInReadingOrder(chunks);
        }
      }
    },
  );

  it.each([
    ['only closing brackets', '}\n}\n)\n]\n}\n'],
    ['only comments', '// a\n// b\n/* c */\n'],
    ['one huge line', 'x'.repeat(100_000)],
    [
      'very deep nesting',
      Array.from({ length: 400 }, (_, i) => `${' '.repeat(i)}if (a) {`).join('\n'),
    ],
    ['mixed tabs and spaces', 'function f() {\n\tif (a) {\n        b();\n\t}\n}\n'],
    [
      'binary-looking noise',
      Array.from({ length: 300 }, (_, i) => String.fromCharCode(i % 250)).join(''),
    ],
    ['lone carriage returns', 'a\rb\rc\r'],
    ['unicode and emoji', 'const 名前 = "🙂🙂🙂";\nfunction ünï() {}\n'],
  ])('survives %s', (_label, content) => {
    for (const language of ['typescript', 'python', 'go', 'markdown', 'json', 'text']) {
      const source = { path: 'x', language, content };
      const chunks = chunkSourceFile(source, { maxTokens: 20 });

      expectFaithfulToSource(source, chunks);
      expectWithinLimit(chunks, 20);
    }
  });
});
