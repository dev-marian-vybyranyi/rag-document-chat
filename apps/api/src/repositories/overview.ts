import { z } from 'zod';
import { chunkSourceFile, type CodeChunk, type CodeChunkOptions } from './chunker.js';
import type { ImportedFile } from './zip.js';

export const OVERVIEW_PATH = 'REPOSITORY_OVERVIEW';

export interface OverviewInput {
  name: string;
  url?: string | null;
  commitSha?: string | null;
  files: ImportedFile[];
}

const MAX_MANIFESTS = 12;
const MAX_RAW_MANIFEST_LINES = 60;
const MAX_TREE_LINES = 500;
const MAX_FILES_PER_DIRECTORY = 25;
const MAX_ENTRY_POINTS = 15;
const MAX_ENTRY_POINT_DEPTH = 4;
const MAX_LISTED_DEPENDENCIES = 80;
const MAX_TEXT = 300;

const RAW_MANIFESTS = new Set([
  'requirements.txt',
  'pyproject.toml',
  'pipfile',
  'setup.py',
  'setup.cfg',
  'go.mod',
  'cargo.toml',
  'gemfile',
  'composer.json',
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
  'package.swift',
  'mix.exs',
  'dockerfile',
]);

const ENTRY_POINT_NAMES =
  /^(?:main|index|server|app|cli|__main__|manage|program|start)\.(?:[cm]?[jt]sx?|py|go|rs|java|kt|rb|php|cs|swift)$/i;

const stringRecord = z.record(z.string(), z.unknown()).optional();

const packageManifest = z.object({
  name: z.string().optional(),
  version: z.string().optional(),
  description: z.string().optional(),
  main: z.string().optional(),
  bin: z.union([z.string(), z.record(z.string(), z.string())]).optional(),
  scripts: stringRecord,
  dependencies: stringRecord,
  devDependencies: stringRecord,
  peerDependencies: stringRecord,
  workspaces: z.unknown().optional(),
});

type PackageManifest = z.infer<typeof packageManifest>;

const cut = (text: string, limit = MAX_TEXT) =>
  text.length > limit ? `${text.slice(0, limit)}…` : text;

const filenameOf = (path: string) => path.split('/').pop() ?? path;

function isManifest(path: string): boolean {
  const filename = filenameOf(path).toLowerCase();
  return filename === 'package.json' || RAW_MANIFESTS.has(filename);
}

function depthOf(path: string): number {
  return path.split('/').length;
}

function describeDependencies(title: string, entries: Record<string, unknown> | undefined) {
  const names = Object.entries(entries ?? {});
  if (names.length === 0) return [];
  const shown = names
    .slice(0, MAX_LISTED_DEPENDENCIES)
    .map(([name, range]) => `- ${cut(name, 100)} ${cut(String(range), 60)}`);
  const more = names.length - shown.length;
  return [`${title}:`, ...shown, ...(more > 0 ? [`- … and ${more} more`] : [])];
}

function describePackage(manifest: PackageManifest): string[] {
  const lines: string[] = [];
  if (manifest.name) lines.push(`Name: ${cut(manifest.name, 100)}`);
  if (manifest.version) lines.push(`Version: ${cut(manifest.version, 40)}`);
  if (manifest.description) lines.push(`Description: ${cut(manifest.description)}`);
  if (manifest.main) lines.push(`Main file: ${cut(manifest.main, 100)}`);
  if (typeof manifest.bin === 'string') lines.push(`Command: ${cut(manifest.bin, 100)}`);
  if (manifest.bin && typeof manifest.bin === 'object') {
    lines.push(
      `Commands: ${Object.keys(manifest.bin)
        .map((c) => cut(c, 60))
        .join(', ')}`,
    );
  }
  const scripts = Object.entries(manifest.scripts ?? {});
  if (scripts.length > 0) {
    lines.push('Scripts:');
    for (const [name, command] of scripts.slice(0, 30)) {
      lines.push(`- ${cut(name, 60)}: ${cut(String(command), 120)}`);
    }
  }
  lines.push(...describeDependencies('Dependencies', manifest.dependencies));
  lines.push(...describeDependencies('Development dependencies', manifest.devDependencies));
  lines.push(...describeDependencies('Peer dependencies', manifest.peerDependencies));
  return lines;
}

function describeManifest(file: ImportedFile): string[] {
  const heading = `### ${file.path}`;
  if (filenameOf(file.path).toLowerCase() === 'package.json') {
    try {
      const parsed = packageManifest.safeParse(JSON.parse(file.content));
      if (parsed.success) return [heading, ...describePackage(parsed.data), ''];
    } catch {
      // falls through to the raw text below
    }
  }
  const lines = file.content.split('\n');
  const shown = lines.slice(0, MAX_RAW_MANIFEST_LINES).map((line) => cut(line, 200));
  const more = lines.length - shown.length;
  const fenced = shown.map((line) => line.replaceAll('```', "'''"));
  return [heading, '```', ...fenced, '```', ...(more > 0 ? [`… ${more} more lines`] : []), ''];
}

function entryPoints(files: ImportedFile[], manifests: ImportedFile[]): string[] {
  const found = new Set<string>();
  for (const file of files) {
    if (
      depthOf(file.path) <= MAX_ENTRY_POINT_DEPTH &&
      ENTRY_POINT_NAMES.test(filenameOf(file.path))
    ) {
      found.add(file.path);
    }
  }
  for (const manifest of manifests) {
    if (filenameOf(manifest.path).toLowerCase() !== 'package.json') continue;
    try {
      const parsed = packageManifest.safeParse(JSON.parse(manifest.content));
      if (!parsed.success) continue;
      const directory = manifest.path.includes('/')
        ? manifest.path.slice(0, manifest.path.lastIndexOf('/') + 1)
        : '';
      const main = parsed.data.main?.replace(/^\.\//, '');
      if (main) found.add(`${directory}${main}`);
    } catch {
      continue;
    }
  }
  return [...found].sort((a, b) => depthOf(a) - depthOf(b) || a.localeCompare(b));
}

interface TreeNode {
  directories: Map<string, TreeNode>;
  files: string[];
}

function buildTree(paths: string[]): TreeNode {
  const root: TreeNode = { directories: new Map(), files: [] };
  for (const path of paths) {
    const parts = path.split('/');
    const filename = parts.pop()!;
    let node = root;
    for (const part of parts) {
      let child = node.directories.get(part);
      if (!child) {
        child = { directories: new Map(), files: [] };
        node.directories.set(part, child);
      }
      node = child;
    }
    node.files.push(filename);
  }
  return root;
}

function renderTree(node: TreeNode, indent: string, out: string[]): void {
  const files = [...node.files].sort((a, b) => a.localeCompare(b));
  for (const file of files.slice(0, MAX_FILES_PER_DIRECTORY)) out.push(`${indent}${file}`);
  if (files.length > MAX_FILES_PER_DIRECTORY) {
    out.push(`${indent}… ${files.length - MAX_FILES_PER_DIRECTORY} more files`);
  }
  const directories = [...node.directories.entries()].sort(([a], [b]) => a.localeCompare(b));
  for (const [name, child] of directories) {
    out.push(`${indent}${name}/`);
    renderTree(child, `${indent}  `, out);
  }
}

function languageSummary(files: ImportedFile[]): string {
  const counts = new Map<string, number>();
  for (const file of files) counts.set(file.language, (counts.get(file.language) ?? 0) + 1);
  return [...counts.entries()]
    .sort(([nameA, a], [nameB, b]) => b - a || nameA.localeCompare(nameB))
    .map(([language, count]) => `${language} ${count}`)
    .join(', ');
}

export function buildOverview(input: OverviewInput): string {
  const files = [...input.files].sort((a, b) => a.path.localeCompare(b.path));
  const manifests = files
    .filter((file) => isManifest(file.path))
    .sort((a, b) => depthOf(a.path) - depthOf(b.path) || a.path.localeCompare(b.path))
    .slice(0, MAX_MANIFESTS);

  const header = [`# Repository overview: ${cut(input.name, 100)}`, ''];
  if (input.url) {
    const commit = input.commitSha ? ` (commit ${input.commitSha.slice(0, 7)})` : '';
    header.push(`Source: ${input.url}${commit}`);
  }
  header.push(`Indexed files: ${files.length}`, `Languages: ${languageSummary(files)}`, '');

  const entries = entryPoints(files, manifests).slice(0, MAX_ENTRY_POINTS);
  const entrySection =
    entries.length > 0 ? ['## Entry points', ...entries.map((e) => `- ${e}`), ''] : [];

  const manifestSection =
    manifests.length > 0
      ? [
          '## Dependencies and build configuration',
          ...manifests.flatMap((manifest) => describeManifest(manifest)),
        ]
      : [];

  const tree: string[] = [];
  renderTree(buildTree(files.map((file) => file.path)), '', tree);
  const shownTree = tree.slice(0, MAX_TREE_LINES);
  if (tree.length > shownTree.length) {
    shownTree.push(`… ${tree.length - shownTree.length} more lines`);
  }
  const treeSection = ['## File tree', ...shownTree, ''];

  return [...header, ...entrySection, ...manifestSection, ...treeSection].join('\n');
}

export function overviewChunks(input: OverviewInput, options?: CodeChunkOptions): CodeChunk[] {
  return chunkSourceFile(
    { path: OVERVIEW_PATH, language: 'markdown', content: buildOverview(input) },
    options,
  );
}
