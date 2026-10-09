import { describe, expect, it } from 'vitest';
import { buildOverview, OVERVIEW_PATH, overviewChunks } from '../src/repositories/overview.js';
import type { ImportedFile } from '../src/repositories/zip.js';
import { expectFaithfulToSource } from './helpers/chunk-invariants.js';

const file = (path: string, content = '', language = 'typescript'): ImportedFile => ({
  path,
  language,
  content,
});

const PACKAGE = JSON.stringify({
  name: 'shop-api',
  version: '2.1.0',
  description: 'Orders and payments',
  main: './dist/server.js',
  scripts: { start: 'node dist/server.js', test: 'vitest run' },
  dependencies: { express: '^5.0.0', zod: '^4.0.0' },
  devDependencies: { vitest: '^5.0.0' },
});

const shop = (): ImportedFile[] => [
  file('package.json', PACKAGE, 'json'),
  file('README.md', '# Shop\n', 'markdown'),
  file('src/server.ts'),
  file('src/app.ts'),
  file('src/orders/list.ts'),
  file('src/orders/create.ts'),
  file('src/payments/charge.py', 'def charge(): pass\n', 'python'),
  file('requirements.txt', 'stripe==9.0.0\nrequests>=2.31\n', 'text'),
  file(
    'go.mod',
    'module example.com/shop\n\ngo 1.22\n\nrequire github.com/gin-gonic/gin v1.10.0\n',
    'go',
  ),
];

describe('buildOverview', () => {
  const overview = buildOverview({
    name: 'acme/shop-api',
    url: 'https://github.com/acme/shop-api',
    commitSha: '7fd1a60b01f91b314f59955a4e4d4e80d8edf11d',
    files: shop(),
  });

  it('names the repository, where it came from and which commit', () => {
    expect(overview).toContain('# Repository overview: acme/shop-api');
    expect(overview).toContain('Source: https://github.com/acme/shop-api (commit 7fd1a60)');
  });

  it('counts the files and the languages, the most common first', () => {
    expect(overview).toContain('Indexed files: 9');
    expect(overview).toContain(
      'Languages: typescript 4, go 1, json 1, markdown 1, python 1, text 1',
    );
  });

  it('lists the dependencies of a package.json with their versions', () => {
    expect(overview).toContain('### package.json');
    expect(overview).toContain('Name: shop-api');
    expect(overview).toContain('- express ^5.0.0');
    expect(overview).toContain('- zod ^4.0.0');
    expect(overview).toContain('Development dependencies:\n- vitest ^5.0.0');
    expect(overview).toContain('- start: node dist/server.js');
  });

  it('includes other manifests as they are written', () => {
    expect(overview).toContain('### requirements.txt');
    expect(overview).toContain('stripe==9.0.0');
    expect(overview).toContain('### go.mod');
    expect(overview).toContain('github.com/gin-gonic/gin v1.10.0');
  });

  it('points at the entry points, including the main file of package.json', () => {
    const section = overview.split('## Entry points\n')[1]!.split('\n\n')[0]!;

    expect(section.split('\n')).toEqual(['- dist/server.js', '- src/app.ts', '- src/server.ts']);
  });

  it('draws the file tree with directories and nesting', () => {
    const tree = overview.split('## File tree\n')[1]!;

    expect(tree).toContain('README.md\n');
    expect(tree).toContain('src/\n  app.ts\n  server.ts\n  orders/\n    create.ts\n    list.ts\n');
    expect(tree).toContain('  payments/\n    charge.py\n');
  });

  it('puts root manifests before nested ones in a monorepo', () => {
    const monorepo = buildOverview({
      name: 'mono',
      files: [
        file('apps/web/package.json', '{"name":"web"}', 'json'),
        file('package.json', '{"name":"root"}', 'json'),
        file('apps/api/package.json', '{"name":"api"}', 'json'),
      ],
    });

    const order = [...monorepo.matchAll(/^### (.+)$/gm)].map((m) => m[1]);
    expect(order).toEqual(['package.json', 'apps/api/package.json', 'apps/web/package.json']);
  });

  it('works without a source address', () => {
    const text = buildOverview({ name: 'uploaded', files: [file('a.ts')] });

    expect(text).not.toContain('Source:');
    expect(text).toContain('Indexed files: 1');
  });

  it('shows a broken package.json as text instead of failing', () => {
    const text = buildOverview({ name: 'x', files: [file('package.json', '{ not json', 'json')] });

    expect(text).toContain('### package.json');
    expect(text).toContain('{ not json');
  });

  it('shows a package.json of an unexpected shape as text', () => {
    const text = buildOverview({
      name: 'x',
      files: [file('package.json', '{"dependencies": ["a"], "scripts": 5}', 'json')],
    });

    expect(text).toContain('"dependencies": ["a"]');
  });

  it('shortens long values and long dependency lists', () => {
    const dependencies = Object.fromEntries(
      Array.from({ length: 120 }, (_, i) => [`package-${i}`, '^1.0.0']),
    );
    const text = buildOverview({
      name: 'x',
      files: [
        file(
          'package.json',
          JSON.stringify({ description: 'd'.repeat(2000), dependencies }),
          'json',
        ),
      ],
    });

    expect(text).toContain('- package-79 ^1.0.0');
    expect(text).not.toContain('- package-80 ');
    expect(text).toContain('- … and 40 more');
    expect(text).not.toContain('d'.repeat(400));
  });

  it('cuts a very long manifest and a very large tree', () => {
    const longManifest = Array.from({ length: 200 }, (_, i) => `dep${i}==1.0`).join('\n');
    const many = Array.from({ length: 900 }, (_, i) => file(`pkg${i % 40}/sub${i}/file.ts`));
    const text = buildOverview({
      name: 'x',
      files: [file('requirements.txt', longManifest, 'text'), ...many],
    });

    expect(text).toContain('dep59==1.0');
    expect(text).not.toContain('dep60==1.0');
    expect(text).toContain('… 140 more lines');
    expect(text.split('\n').length).toBeLessThan(900);
    expect(text).toMatch(/… \d+ more lines\n$/);
  });

  it('lists only the first files of a directory that holds very many', () => {
    const files = Array.from({ length: 60 }, (_, i) =>
      file(`src/f${String(i).padStart(2, '0')}.ts`),
    );
    const text = buildOverview({ name: 'x', files });

    expect(text).toContain('f24.ts');
    expect(text).not.toContain('f25.ts');
    expect(text).toContain('… 35 more files');
  });

  it('lists a file path that happens to contain # without turning it into a heading', () => {
    const text = buildOverview({ name: 'x', files: [file('docs/#notes.md', '', 'markdown')] });

    expect(
      overviewChunks({ name: 'x', files: [file('docs/#notes.md', '', 'markdown')] }),
    ).not.toHaveLength(0);
    expect(text).toContain('#notes.md');
  });
});

describe('overviewChunks', () => {
  const input = { name: 'shop', files: shop() };

  it('produces chunks at a virtual path so the overview is searchable like any file', () => {
    const chunks = overviewChunks(input);

    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.every((c) => c.path === OVERVIEW_PATH && c.language === 'markdown')).toBe(true);
  });

  it('keeps the dependencies and the tree retrievable on their own', () => {
    const chunks = overviewChunks(input, { maxTokens: 120 });
    const withExpress = chunks.find((c) => c.content.includes('- express ^5.0.0'));
    const withTree = chunks.find((c) => c.content.includes('orders/'));

    expect(withExpress?.symbol).toContain('package.json');
    expect(withTree?.symbol).toContain('File tree');
  });

  it('does not turn comments inside a manifest into headings', () => {
    const chunks = overviewChunks({
      name: 'x',
      files: [
        file(
          'Dockerfile',
          '# build stage\nFROM node:24\n# run stage\nCMD ["node"]\n',
          'dockerfile',
        ),
      ],
    });
    const names = chunks.flatMap((c) => c.symbol?.split(', ') ?? []);

    expect(names).not.toContain('build stage');
    expect(names).not.toContain('run stage');
  });

  it('describes the same text that it chunks', () => {
    const chunks = overviewChunks(input, { maxTokens: 100 });

    expectFaithfulToSource(
      { path: OVERVIEW_PATH, language: 'markdown', content: buildOverview(input) },
      chunks,
    );
  });
});
