import { estimateTokens } from '../documents/chunker.js';

export interface SourceFile {
  path: string;
  language: string;
  content: string;
}

export interface CodeChunk {
  path: string;
  language: string;
  startLine: number;
  endLine: number;
  symbol: string | null;
  content: string;
  tokenCount: number;
}

export interface CodeChunkOptions {
  maxTokens?: number;
  overlapLines?: number;
}

export const CODE_MAX_TOKENS = 500;
export const CODE_OVERLAP_LINES = 3;

const CHARS_PER_TOKEN = 4;
const MAX_NESTING = 3;
const MAX_SYMBOLS_PER_CHUNK = 3;
const TAB_WIDTH = 4;

interface Piece {
  start: number;
  end: number;
  symbols: string[];
  text?: string;
}

interface Block {
  start: number;
  end: number;
}

interface Context {
  lines: string[];
  language: string;
  maxChars: number;
  overlapLines: number;
  offsets: number[];
}

const CONFIG_LANGUAGES = new Set(['json', 'yaml', 'toml', 'ini']);
const C_FAMILY = new Set(['c', 'cpp', 'java', 'csharp', 'kotlin', 'swift', 'php', 'scala']);
const MEMBER_LANGUAGES = new Set([
  'typescript',
  'javascript',
  'java',
  'csharp',
  'kotlin',
  'swift',
  'php',
  'scala',
  'vue',
  'svelte',
]);
const PROSE_LANGUAGES = new Set(['markdown', 'restructuredtext', 'text']);

const NOT_A_NAME = new Set([
  'if',
  'else',
  'for',
  'foreach',
  'while',
  'do',
  'switch',
  'case',
  'catch',
  'try',
  'finally',
  'return',
  'new',
  'throw',
  'typeof',
  'sizeof',
  'await',
  'yield',
  'function',
  'with',
  'using',
  'lock',
  'synchronized',
]);

const DECLARATION =
  /\b(?:function\*?|def|fn|func|class|struct|interface|enum|trait|type|impl|object|record|module|namespace|protocol|extension|mod)\s+([A-Za-z_$][\w$]*)/;
const CONSTANT_FUNCTION =
  /^(?:export\s+)?(?:default\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=/;
const GO_METHOD = /^func\s+\(\s*\w*\s*\*?\s*([A-Za-z_]\w*)[^)]*\)\s*([A-Za-z_]\w*)/;
const RUST_IMPL = /^impl(?:<[^>]*>)?\s+(?:[\w:<>,\s]+?\s+for\s+)?([A-Za-z_]\w*)/;
const MEMBER =
  /^(?:(?:public|private|protected|internal|static|async|readonly|override|abstract|final|virtual|get|set|export|default)\s+)*\*?\s*([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\(/;
const C_FUNCTION = /^(?:[\w:<>,*&[\]]+\s+)+\*?([A-Za-z_]\w*)\s*\(/;
const CONFIG_KEY = /^\s*["']?([A-Za-z_][\w.-]*)["']?\s*:/;
const CONFIG_SECTION = /^\s*\[+([^\]]+)\]+\s*$/;
const MARKDOWN_HEADING = /^#{1,6}\s+(.*\S)\s*$/;
const FENCE = /^\s*(?:```|~~~)/;
const COMMENT_OR_ANNOTATION = /^(?:\/\/|\/\*|\*|#|@|--|;|<!--|"""|''')/;

const isBlank = (line: string) => line.trim().length === 0;

function indentOf(line: string): number {
  let width = 0;
  for (const char of line) {
    if (char === ' ') width += 1;
    else if (char === '\t') width += TAB_WIDTH;
    else break;
  }
  return width;
}

function isCloser(line: string): boolean {
  const trimmed = line.trim();
  return /^[}\])]/.test(trimmed) || /^end\b;?$/.test(trimmed);
}

const isCommentLike = (line: string) => COMMENT_OR_ANNOTATION.test(line.trim());

function symbolOf(line: string, language: string, depth: number): string | null {
  const text = line.trim();
  if (depth >= MAX_NESTING) return null;

  if (CONFIG_LANGUAGES.has(language)) {
    if (depth > 1) return null;
    return CONFIG_SECTION.exec(text)?.[1] ?? CONFIG_KEY.exec(text)?.[1] ?? null;
  }

  if (language === 'go') {
    const method = GO_METHOD.exec(text);
    if (method) return `${method[1]}.${method[2]}`;
  }
  if (language === 'rust') {
    const impl = RUST_IMPL.exec(text);
    if (impl) return `impl ${impl[1]}`;
  }

  const declared = DECLARATION.exec(text)?.[1];
  if (declared) return declared;
  if (depth > 0) return memberName(text, language);

  const constant = CONSTANT_FUNCTION.exec(text)?.[1];
  if (constant) return constant;
  if (C_FAMILY.has(language)) {
    const name = C_FUNCTION.exec(text)?.[1];
    if (name && !NOT_A_NAME.has(name)) return name;
  }
  return null;
}

function memberName(text: string, language: string): string | null {
  if (!MEMBER_LANGUAGES.has(language) || !text.endsWith('{')) return null;
  const name = MEMBER.exec(text)?.[1];
  return name && !NOT_A_NAME.has(name) ? name : null;
}

function joinSymbol(parent: string | null, child: string | null): string | null {
  if (!child) return parent;
  return parent ? `${parent}.${child}` : child;
}

function charsBetween(ctx: Context, start: number, end: number): number {
  return ctx.offsets[end + 1]! - ctx.offsets[start]! - 1;
}

function findBlocks(ctx: Context, start: number, end: number, base: number): Block[] {
  const blocks: Block[] = [];
  let current: (Block & { headerOnly: boolean; blankSince: boolean }) | null = null;

  for (let i = start; i <= end; i++) {
    const line = ctx.lines[i]!;
    if (isBlank(line)) {
      if (current) current.blankSince = true;
      continue;
    }

    const startsBlock = indentOf(line) <= base && !isCloser(line);
    if (!startsBlock && current) {
      current.end = i;
      current.blankSince = false;
      continue;
    }

    const commentLike = isCommentLike(line);
    if (current && current.headerOnly && !current.blankSince && startsBlock) {
      current.end = i;
      current.headerOnly = commentLike;
      current.blankSince = false;
      continue;
    }
    if (current) blocks.push({ start: current.start, end: current.end });
    current = { start: i, end: i, headerOnly: commentLike, blankSince: false };
  }
  if (current) blocks.push({ start: current.start, end: current.end });
  return blocks;
}

function declarationLine(ctx: Context, block: Block, base: number): number {
  for (let i = block.start; i <= block.end; i++) {
    const line = ctx.lines[i]!;
    if (!isBlank(line) && indentOf(line) <= base && !isCommentLike(line)) return i;
  }
  return block.start;
}

function nestedIndent(ctx: Context, from: number, to: number, base: number): number | undefined {
  let nested: number | undefined;
  for (let i = from; i <= to; i++) {
    const line = ctx.lines[i]!;
    if (isBlank(line) || isCloser(line)) continue;
    const indent = indentOf(line);
    if (indent > base && (nested === undefined || indent < nested)) nested = indent;
  }
  return nested;
}

function splitRange(
  ctx: Context,
  start: number,
  end: number,
  base: number,
  parent: string | null,
  depth: number,
): Piece[] {
  const pieces: Piece[] = [];
  for (const block of findBlocks(ctx, start, end, base)) {
    const declaration = declarationLine(ctx, block, base);
    const symbol = joinSymbol(parent, symbolOf(ctx.lines[declaration]!, ctx.language, depth));

    if (charsBetween(ctx, block.start, block.end) <= ctx.maxChars) {
      pieces.push({ ...block, symbols: symbol ? [symbol] : [] });
      continue;
    }

    const nested =
      depth < MAX_NESTING ? nestedIndent(ctx, declaration + 1, block.end, base) : undefined;
    const members = nested === undefined ? [] : findBlocks(ctx, declaration + 1, block.end, nested);
    if (nested === undefined || members.length === 0) {
      pieces.push(...splitByLines(ctx, block.start, block.end, symbol));
      continue;
    }

    const first = members[0]!.start;
    if (first > block.start) {
      pieces.push(...splitByLines(ctx, block.start, first - 1, symbol));
    }
    pieces.push(...splitRange(ctx, first, block.end, nested, symbol, depth + 1));
  }
  return pieces;
}

function splitByLines(ctx: Context, start: number, end: number, symbol: string | null): Piece[] {
  const symbols = symbol ? [symbol] : [];
  const pieces: Piece[] = [];
  let from = start;

  while (from <= end) {
    const first = ctx.lines[from]!;
    if (first.length > ctx.maxChars) {
      for (let i = 0; i < first.length; i += ctx.maxChars) {
        pieces.push({ start: from, end: from, symbols, text: first.slice(i, i + ctx.maxChars) });
      }
      from++;
      continue;
    }

    let to = from;
    let length = first.length;
    let lastBlank = -1;
    while (to < end && length + 1 + ctx.lines[to + 1]!.length <= ctx.maxChars) {
      to++;
      length += 1 + ctx.lines[to]!.length;
      if (isBlank(ctx.lines[to]!)) lastBlank = to;
    }
    if (to < end && lastBlank > from + (to - from) / 2) to = lastBlank;

    pieces.push({ start: from, end: to, symbols });
    if (to >= end) break;
    from = Math.max(from + 1, to + 1 - ctx.overlapLines);
  }
  return pieces;
}

function markdownPieces(ctx: Context): Piece[] {
  const sections: Array<{ start: number; heading: string | null }> = [];
  let fenced = false;
  ctx.lines.forEach((line, i) => {
    if (FENCE.test(line)) fenced = !fenced;
    const heading = fenced ? null : MARKDOWN_HEADING.exec(line)?.[1];
    if (heading) sections.push({ start: i, heading });
  });
  if (sections.length === 0 || sections[0]!.start > 0) {
    sections.unshift({ start: 0, heading: null });
  }

  const pieces: Piece[] = [];
  sections.forEach((section, index) => {
    const end = (sections[index + 1]?.start ?? ctx.lines.length) - 1;
    const symbol = section.heading;
    if (charsBetween(ctx, section.start, end) <= ctx.maxChars) {
      pieces.push({ start: section.start, end, symbols: symbol ? [symbol] : [] });
    } else {
      pieces.push(...splitByLines(ctx, section.start, end, symbol));
    }
  });
  return pieces;
}

function pack(ctx: Context, pieces: Piece[]): Piece[] {
  const packed: Piece[] = [];
  let current: Piece | null = null;

  for (const piece of pieces) {
    const mergeable =
      current &&
      current.text === undefined &&
      piece.text === undefined &&
      piece.start > current.end &&
      charsBetween(ctx, current.start, piece.end) <= ctx.maxChars;
    if (current && mergeable) {
      current.end = piece.end;
      current.symbols.push(...piece.symbols);
      continue;
    }
    if (current) packed.push(current);
    current = { ...piece, symbols: [...piece.symbols] };
  }
  if (current) packed.push(current);
  return packed;
}

function toChunk(file: SourceFile, ctx: Context, piece: Piece): CodeChunk | undefined {
  let start = piece.start;
  let end = piece.end;
  while (start <= end && isBlank(ctx.lines[start]!)) start++;
  while (end >= start && isBlank(ctx.lines[end]!)) end--;
  if (start > end) return undefined;

  const content = piece.text ?? ctx.lines.slice(start, end + 1).join('\n');
  const names = [...new Set(piece.symbols)].slice(0, MAX_SYMBOLS_PER_CHUNK);
  return {
    path: file.path,
    language: file.language,
    startLine: start + 1,
    endLine: end + 1,
    symbol: names.length > 0 ? names.join(', ') : null,
    content,
    tokenCount: estimateTokens(content),
  };
}

export function chunkSourceFile(file: SourceFile, options: CodeChunkOptions = {}): CodeChunk[] {
  const lines = file.content.replace(/\r\n/g, '\n').split('\n');
  const offsets = [0];
  for (const line of lines) offsets.push(offsets.at(-1)! + line.length + 1);

  const ctx: Context = {
    lines,
    language: file.language,
    maxChars: Math.max(1, options.maxTokens ?? CODE_MAX_TOKENS) * CHARS_PER_TOKEN,
    overlapLines: Math.max(0, options.overlapLines ?? CODE_OVERLAP_LINES),
    offsets,
  };

  let pieces: Piece[];
  if (file.language === 'markdown') {
    pieces = markdownPieces(ctx);
  } else if (PROSE_LANGUAGES.has(file.language)) {
    pieces = splitByLines(ctx, 0, lines.length - 1, null);
  } else {
    const indents = lines.filter((line) => !isBlank(line)).map(indentOf);
    const base = indents.length > 0 ? Math.min(...indents) : 0;
    pieces = splitRange(ctx, 0, lines.length - 1, base, null, 0);
  }

  return pack(ctx, pieces)
    .map((piece) => toChunk(file, ctx, piece))
    .filter((chunk): chunk is CodeChunk => chunk !== undefined);
}

export function toEmbeddingText(chunk: CodeChunk): string {
  const location = `${chunk.path} (${chunk.language}), lines ${chunk.startLine}-${chunk.endLine}`;
  const header = chunk.symbol ? `${location}, ${chunk.symbol}` : location;
  return `${header}\n\n${chunk.content}`;
}
