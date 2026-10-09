import type { CodeChunk } from './chunker.js';
import { OVERVIEW_PATH } from './overview.js';
import type { ImportedFile } from './zip.js';

export const MAX_REPOSITORY_SUGGESTIONS = 4;

const MANIFEST_NAMES = new Set([
  'package.json',
  'requirements.txt',
  'pyproject.toml',
  'pipfile',
  'go.mod',
  'cargo.toml',
  'gemfile',
  'composer.json',
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
  'mix.exs',
]);

const IDENTIFIER = /^[A-Za-z_$][\w$]{2,39}$/;
const CONSTANT = /^[A-Z][A-Z0-9_]*$/;
const GENERIC_NAMES = new Set([
  'main',
  'index',
  'init',
  'run',
  'test',
  'default',
  'handler',
  'app',
]);

const filenameOf = (path: string) => (path.split('/').pop() ?? path).toLowerCase();

function depthOf(path: string): number {
  return path.split('/').length;
}

export function prominentSymbols(chunks: CodeChunk[], limit: number): string[] {
  const seen = new Set<string>();
  const candidates: Array<{ name: string; depth: number; order: number }> = [];

  chunks.forEach((chunk, order) => {
    if (chunk.path === OVERVIEW_PATH || chunk.language === 'markdown') return;
    for (const symbol of chunk.symbol?.split(', ') ?? []) {
      const name = symbol.includes('.') ? symbol.split('.').at(-1)! : symbol;
      const lower = name.toLowerCase();
      if (!IDENTIFIER.test(name) || CONSTANT.test(name) || GENERIC_NAMES.has(lower)) continue;
      if (/\.(test|spec)\./.test(chunk.path) || /(^|\/)(tests?|__tests__)\//.test(chunk.path))
        continue;
      if (seen.has(name)) continue;
      seen.add(name);
      candidates.push({ name, depth: depthOf(chunk.path), order });
    }
  });

  return candidates
    .sort((a, b) => a.depth - b.depth || a.order - b.order)
    .slice(0, limit)
    .map((candidate) => candidate.name);
}

export function repositorySuggestions(files: ImportedFile[], chunks: CodeChunk[]): string[] {
  const questions = ['How is this project structured?'];
  if (files.some((file) => MANIFEST_NAMES.has(filenameOf(file.path)))) {
    questions.push('What dependencies does this project use?');
  }
  questions.push('What are the main entry points?');

  const room = MAX_REPOSITORY_SUGGESTIONS - questions.length;
  for (const name of prominentSymbols(chunks, room)) {
    questions.push(`How does ${name} work?`);
  }
  return questions.slice(0, MAX_REPOSITORY_SUGGESTIONS);
}
