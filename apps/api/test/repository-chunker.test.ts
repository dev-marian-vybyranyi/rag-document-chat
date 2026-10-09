import { describe, expect, it } from 'vitest';
import {
  chunkSourceFile,
  toEmbeddingText,
  type CodeChunk,
  type SourceFile,
} from '../src/repositories/chunker.js';
import { expectFaithfulToSource } from './helpers/chunk-invariants.js';
import {
  bigClass,
  bigFunction,
  GO,
  MARKDOWN,
  PYTHON,
  RUST,
  TYPESCRIPT,
} from './fixtures/code-samples.js';

const file = (language: string, content: string, path = `src/sample.${language}`): SourceFile => ({
  path,
  language,
  content,
});

const symbols = (chunks: CodeChunk[]) => chunks.flatMap((c) => c.symbol?.split(', ') ?? []);

describe('chunkSourceFile', () => {
  describe('small files', () => {
    it.each([
      ['typescript', TYPESCRIPT],
      ['python', PYTHON],
      ['go', GO],
      ['rust', RUST],
      ['markdown', MARKDOWN],
    ])('keep a %s file that fits in one chunk whole', (language, content) => {
      const chunks = chunkSourceFile(file(language, content));

      expect(chunks).toHaveLength(1);
      expect(chunks[0]).toMatchObject({ startLine: 1, content: content.trim() });
      expectFaithfulToSource(file(language, content), chunks);
    });

    it('name every declaration of a file in the chunk that holds them', () => {
      const [chunk] = chunkSourceFile(file('typescript', TYPESCRIPT));

      expect(chunk?.symbol).toBe('createAuthRouter, MAX_ATTEMPTS, verifyPassword');
    });

    it('produce nothing for an empty or blank file', () => {
      expect(chunkSourceFile(file('typescript', ''))).toEqual([]);
      expect(chunkSourceFile(file('typescript', '\n\n   \n'))).toEqual([]);
    });

    it('handle a file without a trailing newline and with Windows line endings', () => {
      const chunks = chunkSourceFile(file('typescript', 'const a = 1;\r\nconst b = 2;'));

      expect(chunks).toHaveLength(1);
      expect(chunks[0]).toMatchObject({
        startLine: 1,
        endLine: 2,
        content: 'const a = 1;\nconst b = 2;',
      });
    });

    it('count line numbers from the first line even after blank lines', () => {
      const [chunk] = chunkSourceFile(file('typescript', '\n\n\nexport const a = 1;\n\n'));

      expect(chunk).toMatchObject({ startLine: 4, endLine: 4, content: 'export const a = 1;' });
    });

    it('carry the path, the language and a token estimate', () => {
      const [chunk] = chunkSourceFile(file('go', GO, 'internal/orders/service.go'));

      expect(chunk).toMatchObject({ path: 'internal/orders/service.go', language: 'go' });
      expect(chunk?.tokenCount).toBe(Math.ceil(chunk!.content.length / 4));
    });
  });

  describe('where it cuts', () => {
    const small = { maxTokens: 60 };

    const whole = (chunks: CodeChunk[], from: string, to: string) =>
      chunks.some((c) => c.content.includes(from) && c.content.includes(to));

    it('never cuts a TypeScript declaration that fits in a chunk', () => {
      const chunks = chunkSourceFile(file('typescript', TYPESCRIPT), { maxTokens: 100 });

      expect(chunks.length).toBeGreaterThan(1);
      expect(whole(chunks, 'export function createAuthRouter', 'return router;\n}')).toBe(true);
      expect(whole(chunks, 'export const verifyPassword', '=== stored;\n};')).toBe(true);
    });

    it('cuts a declaration that does not fit, at its members', () => {
      const chunks = chunkSourceFile(file('typescript', TYPESCRIPT), { maxTokens: 100 });

      expect(whole(chunks, 'async create(userId', 'return session;\n  }')).toBe(true);
      expect(whole(chunks, 'export class SessionStore', 'return session;')).toBe(false);
    });

    it('keeps a doc comment together with the function it describes', () => {
      const chunks = chunkSourceFile(file('typescript', TYPESCRIPT), small);
      const router = chunks.find((c) => c.content.includes('export function createAuthRouter'));

      expect(router?.content).toContain('Creates the router for sign-in and sign-up');
    });

    it('keeps a decorator together with its class', () => {
      const chunks = chunkSourceFile(file('typescript', TYPESCRIPT), { maxTokens: 120 });
      const store = chunks.find((c) => c.content.includes('export class SessionStore'));

      expect(store?.content.startsWith('@Injectable()')).toBe(true);
    });

    it('keeps Python decorators and the class they decorate together', () => {
      const chunks = chunkSourceFile(file('python', PYTHON), small);
      const settings = chunks.find((c) => c.content.includes('class Settings'));

      expect(settings?.content).toContain('@dataclass');
    });

    it('never cuts a Go function that fits in a chunk', () => {
      const chunks = chunkSourceFile(file('go', GO), { maxTokens: 60 });

      expect(chunks.length).toBeGreaterThan(1);
      expect(whole(chunks, 'func (s *Service) Total', 'return order.Total, nil\n}')).toBe(true);
    });

    it.each([
      ['typescript', TYPESCRIPT],
      ['python', PYTHON],
      ['go', GO],
      ['rust', RUST],
      ['markdown', MARKDOWN],
    ])('loses no line of a %s file when it has to cut', (language, content) => {
      const source = file(language, content);

      for (const maxTokens of [20, 40, 80]) {
        expectFaithfulToSource(source, chunkSourceFile(source, { maxTokens }));
      }
    });

    it('never makes a chunk larger than the limit', () => {
      for (const content of [TYPESCRIPT, bigFunction(300), bigClass(40)]) {
        const chunks = chunkSourceFile(file('typescript', content), { maxTokens: 100 });

        for (const chunk of chunks) expect(chunk.content.length).toBeLessThanOrEqual(400);
      }
    });
  });

  describe('symbols', () => {
    const names = (language: string, content: string) =>
      symbols(chunkSourceFile(file(language, content), { maxTokens: 25 }));

    it('names TypeScript functions, constants, classes, interfaces and their methods', () => {
      expect(names('typescript', TYPESCRIPT)).toEqual(
        expect.arrayContaining([
          'createAuthRouter',
          'MAX_ATTEMPTS',
          'verifyPassword',
          'SessionStore',
          'SessionStore.create',
          'SessionStore.get',
          'Session',
        ]),
      );
    });

    it('names Python functions, classes and methods', () => {
      expect(names('python', PYTHON)).toEqual(
        expect.arrayContaining(['Settings', 'Settings.from_env', 'connect', 'fetch_orders']),
      );
    });

    it('names Go functions and methods with their receiver type', () => {
      expect(names('go', GO)).toEqual(
        expect.arrayContaining(['Service', 'NewService', 'Service.Total', 'Service.Name']),
      );
    });

    it('names Rust types and impl blocks, including trait implementations', () => {
      expect(names('rust', RUST)).toEqual(
        expect.arrayContaining(['Cache', 'impl Cache', 'impl Cache.new', 'impl Cache.get']),
      );
    });

    it('names Markdown sections by their heading, ignoring # inside code fences', () => {
      const found = names('markdown', MARKDOWN);

      expect(found).toEqual(expect.arrayContaining(['Shop API', 'Install', 'Configure']));
      expect(found).not.toContain('not a heading');
    });

    it('names the top-level keys of JSON and YAML', () => {
      const json = '{\n  "name": "shop",\n  "dependencies": {\n    "express": "^5"\n  }\n}\n';
      const yaml = 'services:\n  api:\n    image: shop\nvolumes:\n  data: {}\n';

      expect(symbols(chunkSourceFile(file('json', json), { maxTokens: 12 }))).toContain(
        'dependencies',
      );
      expect(symbols(chunkSourceFile(file('yaml', yaml), { maxTokens: 10 }))).toEqual(
        expect.arrayContaining(['services', 'volumes']),
      );
    });

    it('names C-family functions', () => {
      const c =
        'static int add(int a, int b) {\n  return a + b;\n}\n\nvoid run(void) {\n  add(1, 2);\n}\n';

      expect(symbols(chunkSourceFile(file('c', c), { maxTokens: 12 }))).toEqual(['add', 'run']);
    });

    it('does not mistake control flow or calls for symbols', () => {
      const code = bigFunction(40);
      const found = symbols(chunkSourceFile(file('typescript', code), { maxTokens: 60 }));

      expect(new Set(found)).toEqual(new Set(['aggregate']));
    });
  });

  describe('a unit that is too big', () => {
    it('splits a class into its methods and names each after the class', () => {
      const chunks = chunkSourceFile(file('typescript', bigClass(30)), { maxTokens: 80 });

      expect(chunks.length).toBeGreaterThan(3);
      expect(symbols(chunks)).toContain('Calculator.method7');
      expect(symbols(chunks).every((s) => s.startsWith('Calculator'))).toBe(true);
      expectFaithfulToSource(file('typescript', bigClass(30)), chunks);
    });

    it('does not cut a method of a big class in half when it fits', () => {
      const chunks = chunkSourceFile(file('typescript', bigClass(30)), { maxTokens: 80 });

      for (const chunk of chunks) {
        const opens = (chunk.content.match(/{/g) ?? []).length;
        const closes = (chunk.content.match(/}/g) ?? []).length;
        if (chunk.content.includes('method'))
          expect(Math.abs(opens - closes)).toBeLessThanOrEqual(1);
      }
    });

    it('splits one huge function at statement boundaries and keeps its name', () => {
      const source = file('typescript', bigFunction(400));
      const chunks = chunkSourceFile(source, { maxTokens: 150 });

      expect(chunks.length).toBeGreaterThan(5);
      expect(chunks.every((c) => c.symbol === 'aggregate')).toBe(true);
      for (const chunk of chunks.slice(0, -1)) {
        expect(chunk.content.endsWith(';') || chunk.content.endsWith('{')).toBe(true);
      }
      expectFaithfulToSource(source, chunks);
    });

    it('splits text with no structure by lines, repeating a few lines as overlap', () => {
      const flat = Array.from({ length: 200 }, (_, i) => `value_${i} = ${i}`).join('\n');
      const chunks = chunkSourceFile(file('text', flat), { maxTokens: 50, overlapLines: 2 });

      expect(chunks.length).toBeGreaterThan(3);
      for (let i = 1; i < chunks.length; i++) {
        expect(chunks[i]!.startLine).toBeLessThanOrEqual(chunks[i - 1]!.endLine);
        expect(chunks[i]!.startLine).toBeGreaterThan(chunks[i - 1]!.startLine);
      }
      expectFaithfulToSource(file('text', flat), chunks);
    });

    it('prefers to cut at a blank line when there is one nearby', () => {
      const paragraphs = Array.from({ length: 12 }, (_, i) => `line a${i}\nline b${i}\nline c${i}`);
      const chunks = chunkSourceFile(file('text', paragraphs.join('\n\n')), { maxTokens: 30 });

      for (const chunk of chunks.slice(0, -1)) expect(chunk.content).toMatch(/line c\d+$/);
    });

    it('cuts a single enormous line into pieces that all point at that line', () => {
      const long = `const data = "${'x'.repeat(5000)}";`;
      const chunks = chunkSourceFile(file('typescript', `a();\n${long}\nb();`), { maxTokens: 100 });
      const pieces = chunks.filter((c) => c.startLine === 2 && c.endLine === 2);

      expect(pieces.length).toBeGreaterThanOrEqual(13);
      expect(pieces.map((p) => p.content).join('')).toBe(long);
      for (const chunk of chunks) expect(chunk.content.length).toBeLessThanOrEqual(400);
    });

    it('understands tab indentation', () => {
      const source = file('go', GO.replace(/\t/g, '\t'));
      const chunks = chunkSourceFile(source, { maxTokens: 30 });

      expect(symbols(chunks)).toContain('Service.Total');
      expectFaithfulToSource(source, chunks);
    });
  });

  describe('prose and data', () => {
    it('splits a Markdown file by section and joins small neighbouring sections', () => {
      const chunks = chunkSourceFile(file('markdown', MARKDOWN), { maxTokens: 25 });

      expect(chunks.length).toBeGreaterThan(1);
      expect(chunks[0]?.content.startsWith('# Shop API')).toBe(true);
      expectFaithfulToSource(file('markdown', MARKDOWN), chunks);
    });

    it('splits a section that is longer than a chunk and keeps its heading as the symbol', () => {
      const text = `## Long section\n\n${'A sentence of documentation text. '.repeat(120)}`;
      const chunks = chunkSourceFile(file('markdown', text), { maxTokens: 100 });

      expect(chunks.length).toBeGreaterThan(1);
      expect(chunks.every((c) => c.symbol === 'Long section')).toBe(true);
    });

    it('splits a JSON file with a long array', () => {
      const items = Array.from(
        { length: 300 },
        (_, i) => `    { "id": ${i}, "name": "item ${i}" }`,
      );
      const json = `{\n  "items": [\n${items.join(',\n')}\n  ]\n}\n`;
      const chunks = chunkSourceFile(file('json', json), { maxTokens: 100 });

      expect(chunks.length).toBeGreaterThan(3);
      expect(chunks.every((c) => c.symbol === 'items')).toBe(true);
      expectFaithfulToSource(file('json', json), chunks);
    });
  });
});

describe('toEmbeddingText', () => {
  const chunk: CodeChunk = {
    path: 'src/auth/routes.ts',
    language: 'typescript',
    startLine: 10,
    endLine: 24,
    symbol: 'login',
    content: 'export function login() {}',
    tokenCount: 7,
  };

  it('puts the path, language, lines and symbol in front of the code', () => {
    expect(toEmbeddingText(chunk)).toBe(
      'src/auth/routes.ts (typescript), lines 10-24, login\n\nexport function login() {}',
    );
  });

  it('leaves out the symbol when there is none', () => {
    expect(toEmbeddingText({ ...chunk, symbol: null }).split('\n')[0]).toBe(
      'src/auth/routes.ts (typescript), lines 10-24',
    );
  });
});
