export const REFERENCE_REPOSITORY = {
  owner: 'koajs',
  name: 'koa',
  commit: '2fecd029c6ce6b79d65158d28a76538f7f6b0378',
} as const;

export const REFERENCE_ADDRESS = `https://github.com/${REFERENCE_REPOSITORY.owner}/${REFERENCE_REPOSITORY.name}/tree/${REFERENCE_REPOSITORY.commit}`;

const INCLUDED_FILES = new Set([
  'LICENSE',
  'Readme.md',
  'package.json',
  'docs/error-handling.md',
  'docs/guide.md',
]);

export function isReferenceFile(path: string): boolean {
  if (INCLUDED_FILES.has(path)) return true;
  return /^lib\/[^/]+\.js$/.test(path);
}

export function selectReferenceFiles<T extends { path: string }>(files: T[]): T[] {
  return files.filter((file) => isReferenceFile(file.path));
}
