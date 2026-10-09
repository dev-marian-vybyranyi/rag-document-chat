export type TokenKind = 'keyword' | 'string' | 'comment' | 'number' | 'plain';

export interface Token {
  kind: TokenKind;
  text: string;
}

interface Syntax {
  lineComments: string[];
  blockComments: Array<[string, string]>;
  quotes: string[];
  tripleQuotes: boolean;
  keywords: Set<string>;
  caseInsensitive: boolean;
}

const words = (list: string) => new Set(list.split(' '));

const JS =
  'abstract as async await break case catch class const continue default delete do else enum export extends false finally for from function if implements import in instanceof interface let new null of private protected public readonly return static super switch this throw true try type typeof undefined var void while yield';
const PYTHON =
  'and as assert async await break class continue def del elif else except False finally for from global if import in is lambda None nonlocal not or pass raise return True try while with yield';
const GO =
  'break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var nil true false';
const RUST =
  'as async await break const continue crate dyn else enum extern false fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait true type unsafe use where while';
const C_LIKE =
  'abstract bool boolean break case catch char class const continue default do double else enum extends false final finally float for fun func if implements import in int interface internal long namespace new null override package private protected public return short static string struct super switch this throw throws true try typedef using val var virtual void while';
const SHELL =
  'if then else elif fi for while do done case esac function in return export local readonly set unset exit';
const SQL =
  'select from where join left right inner outer on group by order having limit offset insert into values update set delete create table alter drop index primary key foreign references and or not null as distinct union all case when then else end like in is exists true false';
const DOCKER =
  'FROM RUN CMD COPY ADD ENTRYPOINT ENV EXPOSE WORKDIR USER ARG VOLUME LABEL HEALTHCHECK AS';
const DATA = 'true false null yes no';

function syntax(keywords: string, options: Partial<Omit<Syntax, 'keywords'>> = {}): Syntax {
  return {
    lineComments: ['//'],
    blockComments: [['/*', '*/']],
    quotes: ['"', "'"],
    tripleQuotes: false,
    caseInsensitive: false,
    ...options,
    keywords: words(keywords),
  };
}

const hashed = { lineComments: ['#'], blockComments: [] as Array<[string, string]> };

const SYNTAXES: Record<string, Syntax> = {
  typescript: syntax(JS, { quotes: ['"', "'", '`'] }),
  javascript: syntax(JS, { quotes: ['"', "'", '`'] }),
  vue: syntax(JS, { quotes: ['"', "'", '`'] }),
  svelte: syntax(JS, { quotes: ['"', "'", '`'] }),
  python: syntax(PYTHON, { ...hashed, tripleQuotes: true }),
  ruby: syntax(PYTHON, { ...hashed }),
  go: syntax(GO, { quotes: ['"', '`', "'"] }),
  rust: syntax(RUST, { quotes: ['"'] }),
  java: syntax(C_LIKE),
  kotlin: syntax(C_LIKE),
  scala: syntax(C_LIKE),
  swift: syntax(C_LIKE),
  csharp: syntax(C_LIKE),
  c: syntax(C_LIKE),
  cpp: syntax(C_LIKE),
  php: syntax(C_LIKE, { lineComments: ['//', '#'] }),
  shell: syntax(SHELL, { ...hashed, quotes: ['"', "'", '`'] }),
  sql: syntax(SQL, { lineComments: ['--'], quotes: ["'", '"'], caseInsensitive: true }),
  dockerfile: syntax(DOCKER, { ...hashed }),
  json: syntax(DATA, { lineComments: [], blockComments: [], quotes: ['"'] }),
  yaml: syntax(DATA, { ...hashed }),
  toml: syntax(DATA, { ...hashed }),
  css: syntax('', { lineComments: [], quotes: ['"', "'"] }),
  scss: syntax('', { quotes: ['"', "'"] }),
};

const NUMBER = /^(?:0[xX][0-9a-fA-F_]+|\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?)/;
const WORD_START = /[A-Za-z_$]/;
const WORD_PART = /[\w$]/;

function readString(code: string, start: number, quote: string, triple: boolean): number {
  if (triple && code.startsWith(quote.repeat(3), start)) {
    const end = code.indexOf(quote.repeat(3), start + 3);
    return end === -1 ? code.length : end + 3;
  }
  let i = start + 1;
  while (i < code.length) {
    const char = code[i]!;
    if (char === '\\') {
      i += 2;
      continue;
    }
    if (char === quote) return i + 1;
    if (char === '\n' && quote !== '`') return i;
    i++;
  }
  return code.length;
}

function scan(code: string, syn: Syntax): Token[] {
  const tokens: Token[] = [];
  let plain = '';
  const flush = () => {
    if (plain) tokens.push({ kind: 'plain', text: plain });
    plain = '';
  };
  const push = (kind: TokenKind, text: string) => {
    flush();
    tokens.push({ kind, text });
  };

  let i = 0;
  while (i < code.length) {
    const rest = code.slice(i, i + 3);

    const lineComment = syn.lineComments.find((marker) => code.startsWith(marker, i));
    if (lineComment) {
      const end = code.indexOf('\n', i);
      const stop = end === -1 ? code.length : end;
      push('comment', code.slice(i, stop));
      i = stop;
      continue;
    }

    const block = syn.blockComments.find(([open]) => code.startsWith(open, i));
    if (block) {
      const end = code.indexOf(block[1], i + block[0].length);
      const stop = end === -1 ? code.length : end + block[1].length;
      push('comment', code.slice(i, stop));
      i = stop;
      continue;
    }

    const quote = syn.quotes.find((q) => rest.startsWith(q));
    if (quote) {
      const stop = readString(code, i, quote, syn.tripleQuotes);
      push('string', code.slice(i, stop));
      i = stop;
      continue;
    }

    const char = code[i]!;
    const previous = code[i - 1] ?? '';
    if (/\d/.test(char) && !WORD_PART.test(previous)) {
      const match = NUMBER.exec(code.slice(i));
      if (match) {
        push('number', match[0]);
        i += match[0].length;
        continue;
      }
    }

    if (WORD_START.test(char)) {
      let stop = i + 1;
      while (stop < code.length && WORD_PART.test(code[stop]!)) stop++;
      const word = code.slice(i, stop);
      const key = syn.caseInsensitive ? word.toLowerCase() : word;
      if (syn.keywords.has(key)) push('keyword', word);
      else plain += word;
      i = stop;
      continue;
    }

    plain += char;
    i++;
  }
  flush();
  return tokens;
}

function splitLines(tokens: Token[]): Token[][] {
  const lines: Token[][] = [[]];
  for (const token of tokens) {
    const parts = token.text.split('\n');
    parts.forEach((part, index) => {
      if (index > 0) lines.push([]);
      if (part) lines.at(-1)!.push({ kind: token.kind, text: part });
    });
  }
  return lines;
}

export function highlight(code: string, language: string | null): Token[][] {
  const syn = language ? SYNTAXES[language] : undefined;
  const tokens = syn ? scan(code, syn) : [{ kind: 'plain' as const, text: code }];
  return splitLines(tokens);
}
