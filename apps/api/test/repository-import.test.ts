import { describe, expect, it } from 'vitest';
import { defaultImportLimits } from '../src/repositories/filter.js';
import { createGithubImporter } from '../src/repositories/github.js';
import { importZipArchive } from '../src/repositories/zip.js';
import {
  SAMPLE_INDEXED_PATHS,
  SAMPLE_SKIPPED,
  SECRET_MARKERS,
  sampleRepoEntries,
} from './helpers/sample-repo.js';
import { buildZip, type ZipEntrySpec } from './helpers/zip.js';

const SHA = '0123456789abcdef0123456789abcdef01234567';

const wrapped = (entries: ZipEntrySpec[], folder = `shop-api-${SHA.slice(0, 7)}`) =>
  entries.map((entry) => ({ ...entry, name: `${folder}/${entry.name}` }));

const skippedOf = (result: Awaited<ReturnType<typeof importZipArchive>>) =>
  Object.fromEntries(result.skipped.map((s) => [s.path, s.reason]));

const sorted = (paths: string[]) => [...paths].sort();

async function viaGithub(zip: Buffer) {
  const fetchStub = (async (input: string | URL | Request) =>
    String(input).startsWith('https://api.github.com')
      ? new Response(SHA)
      : new Response(new Uint8Array(zip))) as typeof fetch;
  return createGithubImporter({ fetch: fetchStub }).importFromUrl(
    'https://github.com/acme/shop-api',
  );
}

describe('importing a realistic repository', () => {
  const zip = buildZip(wrapped(sampleRepoEntries()));

  it('indexes exactly the source, documentation and configuration files', async () => {
    const result = await importZipArchive(zip);

    expect(sorted(result.files.map((f) => f.path))).toEqual(sorted(SAMPLE_INDEXED_PATHS));
  });

  it('reports every other file with the reason it was left out', async () => {
    const result = await importZipArchive(zip);

    expect(skippedOf(result)).toEqual(SAMPLE_SKIPPED);
  });

  it('never lets the content of a secret out', async () => {
    const result = await importZipArchive(zip);

    const everything = JSON.stringify(result.files);
    for (const marker of SECRET_MARKERS) expect(everything).not.toContain(marker);
  });

  it('gives each file the language the chunker will need', async () => {
    const result = await importZipArchive(zip);
    const languages = Object.fromEntries(result.files.map((f) => [f.path, f.language]));

    expect(languages).toMatchObject({
      'src/app.ts': 'typescript',
      'src/payments/charge.py': 'python',
      'package.json': 'json',
      'deploy/helm/values.yaml': 'yaml',
      Dockerfile: 'dockerfile',
      'README.md': 'markdown',
    });
  });

  it('keeps the text as written, so line numbers stay true', async () => {
    const result = await importZipArchive(zip);
    const charge = result.files.find((f) => f.path === 'src/payments/charge.py');

    expect(charge?.content).toBe('def charge(order):\n    return order.total\r\n');
  });

  it('keeps unusual but legitimate paths', async () => {
    const result = await importZipArchive(zip);

    expect(result.files.map((f) => f.path)).toContain('src/ünïcode/naïve café.ts');
  });

  it('gives the same result from an upload, a bare archive and a GitHub download', async () => {
    const upload = await importZipArchive(zip);
    const bare = await importZipArchive(buildZip(sampleRepoEntries()));
    const github = await viaGithub(zip);

    expect(bare).toEqual(upload);
    expect(github.repository).toEqual(upload);
    expect(github.source.commitSha).toBe(SHA);
  });
});

describe('the limits, exactly at their edge', () => {
  const small = { ...defaultImportLimits, maxFiles: 3, maxFileBytes: 50, maxTotalBytes: 120 };

  it('accepts a repository with exactly the allowed number of files', async () => {
    const zip = buildZip(['a.ts', 'b.ts', 'c.ts']);

    expect((await importZipArchive(zip, small)).files).toHaveLength(3);
  });

  it('refuses one file more', async () => {
    const zip = buildZip(['a.ts', 'b.ts', 'c.ts', 'd.ts']);

    await expect(importZipArchive(zip, small)).rejects.toThrow(/4 indexable files; the limit is 3/);
  });

  it('accepts a file of exactly the size limit and skips one byte more', async () => {
    const zip = buildZip([
      { name: 'exact.ts', data: 'x'.repeat(50) },
      { name: 'over.ts', data: 'x'.repeat(51) },
    ]);

    const result = await importZipArchive(zip, small);

    expect(result.files.map((f) => f.path)).toEqual(['exact.ts']);
    expect(skippedOf(result)).toEqual({ 'over.ts': 'too-large' });
  });

  it('accepts files that add up to exactly the total limit', async () => {
    const zip = buildZip([
      { name: 'a.ts', data: 'a'.repeat(50) },
      { name: 'b.ts', data: 'b'.repeat(50) },
      { name: 'c.ts', data: 'c'.repeat(20) },
    ]);

    expect((await importZipArchive(zip, small)).files).toHaveLength(3);
  });

  it('refuses a total one byte over the limit', async () => {
    const zip = buildZip([
      { name: 'a.ts', data: 'a'.repeat(50) },
      { name: 'b.ts', data: 'b'.repeat(50) },
      { name: 'c.ts', data: 'c'.repeat(21) },
    ]);

    await expect(importZipArchive(zip, small)).rejects.toThrow(/add up to 121 bytes/);
  });

  it('counts a skipped file towards neither limit', async () => {
    const zip = buildZip([
      'a.ts',
      'b.ts',
      'c.ts',
      { name: 'node_modules/x/huge.js', data: 'x'.repeat(5_000) },
      { name: '.env', data: 'x'.repeat(5_000) },
    ]);

    expect((await importZipArchive(zip, small)).files).toHaveLength(3);
  });
});

describe('hostile variants of an otherwise ordinary repository', () => {
  const withExtra = (extra: ZipEntrySpec) => buildZip(wrapped([...sampleRepoEntries(), extra]));

  it.each([
    ['a path that climbs out of the repository', '../../../etc/cron.d/job.ts'],
    ['a path that climbs out from inside a folder', 'src/../../../outside.ts'],
    ['an absolute path', '/root/.ssh/authorized_keys'],
    ['a Windows drive path', 'C:\\Users\\victim\\.ssh\\id_rsa'],
  ])('refuses the whole import for %s', async (_label, name) => {
    const hostile = buildZip([...sampleRepoEntries(), { name, data: 'x' }]);

    await expect(importZipArchive(hostile)).rejects.toThrow(/path that is not allowed/);
  });

  it('refuses an entry that inflates beyond the size it declares', async () => {
    const zip = withExtra({ name: 'src/lie.ts', data: 'x'.repeat(150_000), declaredSize: 20 });

    await expect(importZipArchive(zip)).rejects.toThrow(/not a valid zip archive/);
  });

  it('does not inflate a gigantic entry that is skipped anyway', async () => {
    const zip = withExtra({ name: 'data/dump.sql', data: Buffer.alloc(80_000_000, '0') });
    expect(zip.length).toBeLessThan(defaultImportLimits.maxArchiveBytes);

    const result = await importZipArchive(zip);

    expect(skippedOf(result)['data/dump.sql']).toBe('too-large');
    expect(result.files).toHaveLength(SAMPLE_INDEXED_PATHS.length);
  });

  it('still hides secrets that sit beside a hostile-looking but harmless entry', async () => {
    const zip = withExtra({ name: 'src/..hidden.ts', data: 'export const a = 1;\n' });

    const result = await importZipArchive(zip);

    expect(result.files.map((f) => f.path)).toContain('src/..hidden.ts');
    expect(skippedOf(result)['.env']).toBe('secret');
  });
});
