import { describe, expect, it } from 'vitest';
import { highlight, type Token } from './highlight';

const kinds = (line: Token[]) => line.map((t) => [t.kind, t.text]);
const flat = (lines: Token[][]) => lines.map((line) => line.map((t) => t.text).join('')).join('\n');

describe('highlight', () => {
  describe('what it recognises', () => {
    it('marks keywords, strings, numbers and comments in TypeScript', () => {
      const [line] = highlight('const a = "x"; // note 5', 'typescript');

      expect(kinds(line!)).toEqual([
        ['keyword', 'const'],
        ['plain', ' a = '],
        ['string', '"x"'],
        ['plain', '; '],
        ['comment', '// note 5'],
      ]);
    });

    it('marks numbers, including decimals, exponents and hex', () => {
      const [line] = highlight('x = 42 + 3.14 + 1e-3 + 0xFF', 'python');

      expect(line!.filter((t) => t.kind === 'number').map((t) => t.text)).toEqual([
        '42',
        '3.14',
        '1e-3',
        '0xFF',
      ]);
    });

    it('does not take digits inside a name for a number', () => {
      const [line] = highlight('const x2 = id3 + 7', 'typescript');

      expect(line!.filter((t) => t.kind === 'number').map((t) => t.text)).toEqual(['7']);
    });

    it('does not take a keyword that is part of a longer name', () => {
      const [line] = highlight('const classes = interfaceName + returned', 'typescript');

      expect(line!.filter((t) => t.kind === 'keyword').map((t) => t.text)).toEqual(['const']);
    });

    it('uses # for comments in Python and shell, and not // as a comment', () => {
      expect(kinds(highlight('x = 1  # one', 'python')[0]!).at(-1)).toEqual(['comment', '# one']);
      expect(kinds(highlight('echo hi # one', 'shell')[0]!).at(-1)).toEqual(['comment', '# one']);
      expect(highlight('a // b', 'python')[0]!.some((t) => t.kind === 'comment')).toBe(false);
    });

    it('uses -- for comments in SQL and ignores keyword case', () => {
      const [line] = highlight('SELECT id FROM users -- all', 'sql');

      expect(line!.filter((t) => t.kind === 'keyword').map((t) => t.text)).toEqual([
        'SELECT',
        'FROM',
      ]);
      expect(line!.at(-1)).toEqual({ kind: 'comment', text: '-- all' });
    });

    it('treats a Go back-quoted string and a Rust lifetime sensibly', () => {
      expect(highlight('s := `raw`', 'go')[0]!.some((t) => t.kind === 'string')).toBe(true);
      expect(highlight("fn f<'a>(x: &'a str)", 'rust')[0]!.some((t) => t.kind === 'string')).toBe(
        false,
      );
    });

    it('highlights JSON strings, numbers and literals', () => {
      const [line] = highlight('{ "a": 1, "b": true, "c": null }', 'json');

      expect(line!.filter((t) => t.kind === 'string').map((t) => t.text)).toEqual([
        '"a"',
        '"b"',
        '"c"',
      ]);
      expect(line!.filter((t) => t.kind === 'keyword').map((t) => t.text)).toEqual([
        'true',
        'null',
      ]);
    });

    it('highlights Dockerfile instructions and # comments', () => {
      const lines = highlight('FROM node:24\n# build\nRUN npm ci', 'dockerfile');

      expect(lines[0]![0]).toEqual({ kind: 'keyword', text: 'FROM' });
      expect(lines[1]![0]).toEqual({ kind: 'comment', text: '# build' });
      expect(lines[2]![0]).toEqual({ kind: 'keyword', text: 'RUN' });
    });
  });

  describe('strings and comments', () => {
    it('keeps an escaped quote inside the string', () => {
      const [line] = highlight(String.raw`s = "a \" b" + 1`, 'typescript');

      expect(line!.find((t) => t.kind === 'string')!.text).toBe(String.raw`"a \" b"`);
      expect(line!.at(-1)).toEqual({ kind: 'number', text: '1' });
    });

    it('ends an unclosed quote at the end of the line, so one bad line does not colour the file', () => {
      const lines = highlight('const a = "oops\nconst b = 1;', 'typescript');

      expect(lines[1]![0]).toEqual({ kind: 'keyword', text: 'const' });
    });

    it('lets a template literal run over several lines', () => {
      const lines = highlight('const t = `one\ntwo`;\nreturn 1', 'typescript');

      expect(lines[1]).toEqual([
        { kind: 'string', text: 'two`' },
        { kind: 'plain', text: ';' },
      ]);
      expect(lines[2]![0]).toEqual({ kind: 'keyword', text: 'return' });
    });

    it('splits a block comment over lines and carries the colour to each', () => {
      const lines = highlight('/* a\n * b\n */ x', 'typescript');

      expect(lines.map((l) => l[0]!.kind)).toEqual(['comment', 'comment', 'comment']);
      expect(lines[2]!.at(-1)).toEqual({ kind: 'plain', text: ' x' });
    });

    it('does not treat a comment marker inside a string as a comment', () => {
      const [line] = highlight('const u = "http://x"; // real', 'typescript');

      expect(line!.filter((t) => t.kind === 'comment').map((t) => t.text)).toEqual(['// real']);
      expect(line!.find((t) => t.kind === 'string')!.text).toBe('"http://x"');
    });

    it('treats a Python docstring as one string over several lines', () => {
      const lines = highlight('def f():\n    """one\n    two"""\n    return 1', 'python');

      expect(lines[1]!.some((t) => t.kind === 'string')).toBe(true);
      expect(lines[2]!.some((t) => t.kind === 'string')).toBe(true);
      expect(lines[3]!.some((t) => t.kind === 'keyword')).toBe(true);
    });

    it('survives an unclosed block comment and an unclosed triple quote', () => {
      expect(flat(highlight('a /* never closed\nmore', 'typescript'))).toBe(
        'a /* never closed\nmore',
      );
      expect(flat(highlight('x = """never', 'python'))).toBe('x = """never');
    });
  });

  describe('the text itself', () => {
    it.each([
      ['typescript', 'export async function f(a: number) {\n  return `${a}` + "x"; // c\n}\n'],
      ['python', 'class A:\n    def f(self):\n        return {"a": [1, 2.5]}  # c\n'],
      ['go', 'func (s *S) F() error {\n\treturn nil\n}\n'],
      ['rust', "impl<'a> T for S<'a> {\n    fn f(&self) -> u8 { 0 }\n}\n"],
      ['sql', "select * from t where a = 'x';\n"],
      ['yaml', 'a: 1\nb:\n  - "x"\n'],
      ['markdown', '# Title\n\nText with `code`.\n'],
      ['unknown-language', 'anything <at> all\n'],
      ['typescript', ''],
      ['typescript', '\n\n'],
    ])('is never changed, only coloured (%s)', (language, code) => {
      expect(flat(highlight(code, language))).toBe(code);
    });

    it('returns one list of tokens per line', () => {
      expect(highlight('a\nb\nc', 'typescript')).toHaveLength(3);
      expect(highlight('a\n', 'typescript')).toHaveLength(2);
      expect(highlight('', 'typescript')).toHaveLength(1);
    });

    it('leaves a language it does not know, and null, uncoloured', () => {
      for (const language of ['markdown', 'text', 'nonsense', null]) {
        const lines = highlight('const a = "x"; // c', language);

        expect(lines).toHaveLength(1);
        expect(lines[0]).toEqual([{ kind: 'plain', text: 'const a = "x"; // c' }]);
      }
    });

    it('copes with a very long line quickly', () => {
      const code = `const s = "${'a'.repeat(200_000)}";`;
      const started = Date.now();

      const lines = highlight(code, 'typescript');

      expect(flat(lines)).toBe(code);
      expect(Date.now() - started).toBeLessThan(2000);
    });
  });
});
