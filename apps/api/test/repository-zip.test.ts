import { describe, expect, it } from 'vitest';
import { ImportRejectedError } from '../src/repositories/errors.js';
import { defaultImportLimits } from '../src/repositories/filter.js';
import { importZipArchive } from '../src/repositories/zip.js';
import { buildZip } from './helpers/zip.js';

const paths = (result: Awaited<ReturnType<typeof importZipArchive>>) =>
  result.files.map((f) => f.path).sort();

const reasons = (result: Awaited<ReturnType<typeof importZipArchive>>) =>
  Object.fromEntries(result.skipped.map((s) => [s.path, s.reason]));

describe('importZipArchive', () => {
  describe('reading a repository', () => {
    it('returns text, language and path of the source files', async () => {
      const zip = buildZip([
        { name: 'src/main.ts', data: 'export const answer = 42;\n' },
        { name: 'README.md', data: '# Project\n' },
      ]);

      const result = await importZipArchive(zip);

      expect(result.files).toEqual([
        { path: 'src/main.ts', language: 'typescript', content: 'export const answer = 42;\n' },
        { path: 'README.md', language: 'markdown', content: '# Project\n' },
      ]);
    });

    it('reads stored (uncompressed) entries as well', async () => {
      const zip = buildZip([{ name: 'a.py', data: 'print(1)\n', method: 'store' }]);

      expect((await importZipArchive(zip)).files[0]?.content).toBe('print(1)\n');
    });

    it('removes the single top-level folder that archive tools add', async () => {
      const zip = buildZip(['app-main/src/a.ts', 'app-main/package.json']);

      expect(paths(await importZipArchive(zip))).toEqual(['package.json', 'src/a.ts']);
    });

    it('keeps the layout when files sit at the top level next to a folder', async () => {
      const zip = buildZip(['src/a.ts', 'README.md']);

      expect(paths(await importZipArchive(zip))).toEqual(['README.md', 'src/a.ts']);
    });

    it('keeps the layout when there are several top-level folders', async () => {
      const zip = buildZip(['src/a.ts', 'docs/guide.md']);

      expect(paths(await importZipArchive(zip))).toEqual(['docs/guide.md', 'src/a.ts']);
    });

    it('drops a UTF-8 byte order mark', async () => {
      const zip = buildZip([{ name: 'a.ts', data: '\uFEFFconst a = 1;\n' }]);

      expect((await importZipArchive(zip)).files[0]?.content).toBe('const a = 1;\n');
    });

    it('ignores directory entries and macOS metadata', async () => {
      const zip = buildZip([
        { name: 'repo/' },
        { name: 'repo/src/' },
        'repo/src/a.ts',
        '__MACOSX/repo/._a.ts',
        'repo/.DS_Store',
      ]);

      const result = await importZipArchive(zip);

      expect(paths(result)).toEqual(['src/a.ts']);
    });
  });

  describe('what is left out', () => {
    it('reports every skipped file with its reason', async () => {
      const zip = buildZip([
        'src/a.ts',
        { name: '.env', data: 'API_KEY=hunter2\n' },
        { name: 'node_modules/x/index.js', data: 'module.exports = 1;\n' },
        { name: 'package-lock.json', data: '{}' },
        { name: 'logo.png', data: Buffer.from([0x89, 0x50, 0x4e, 0x47]) },
        { name: 'src/data.ts', data: Buffer.from([0x61, 0x00, 0x62]) },
      ]);

      const result = await importZipArchive(zip);

      expect(paths(result)).toEqual(['src/a.ts']);
      expect(reasons(result)).toEqual({
        '.env': 'secret',
        'node_modules/x/index.js': 'ignored-directory',
        'package-lock.json': 'lockfile',
        'logo.png': 'unsupported-type',
        'src/data.ts': 'binary',
      });
    });

    it('never returns the content of a secret', async () => {
      const zip = buildZip([
        'src/a.ts',
        { name: '.env', data: 'API_KEY=hunter2\n' },
        { name: 'deploy/key.pem', data: 'not really a key' },
        {
          name: 'src/embedded.ts',
          data: 'const k = `-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----`;\n',
        },
      ]);

      const result = await importZipArchive(zip);

      expect(JSON.stringify(result.files)).not.toMatch(/hunter2|PRIVATE KEY|not really a key/);
      expect(reasons(result)).toMatchObject({
        '.env': 'secret',
        'deploy/key.pem': 'secret',
        'src/embedded.ts': 'secret',
      });
    });

    it('skips symbolic links instead of following them', async () => {
      const zip = buildZip([
        'package.json',
        'src/a.ts',
        { name: 'src/link.ts', data: '../../etc/passwd', symlink: true },
      ]);

      const result = await importZipArchive(zip);

      expect(paths(result)).toEqual(['package.json', 'src/a.ts']);
      expect(reasons(result)['src/link.ts']).toBe('symlink');
    });

    it('skips encrypted entries', async () => {
      const zip = buildZip([
        'package.json',
        'src/a.ts',
        { name: 'src/secret.ts', data: 'xxxx', encrypted: true },
      ]);

      const result = await importZipArchive(zip);

      expect(paths(result)).toEqual(['package.json', 'src/a.ts']);
      expect(reasons(result)['src/secret.ts']).toBe('unsupported-type');
    });

    it('skips minified bundles', async () => {
      const bundle = `${'var a=function(){return 1};'.repeat(100)}\n`;
      const zip = buildZip(['src/a.ts', { name: 'static/app.js', data: bundle }]);

      expect(reasons(await importZipArchive(zip))['static/app.js']).toBe('minified');
    });
  });

  describe('hostile archives', () => {
    it.each([
      ['a parent directory', '../../etc/passwd.ts'],
      ['a nested parent directory', 'src/../../outside.ts'],
      ['an absolute path', '/etc/cron.d/job.ts'],
      ['a Windows drive', 'C:/Windows/a.ts'],
      ['backslashes', 'src\\..\\..\\outside.ts'],
    ])('rejects an archive with %s in a path', async (_label, name) => {
      const zip = buildZip(['src/a.ts', { name, data: 'x' }]);

      await expect(importZipArchive(zip)).rejects.toThrow(
        new ImportRejectedError('The archive contains a file path that is not allowed'),
      );
    });

    it('rejects two entries that end up at the same path', async () => {
      const zip = buildZip(['src/a.ts', 'src//a.ts']);

      await expect(importZipArchive(zip)).rejects.toThrow(/more than once/);
    });

    it('rejects an entry whose real size is larger than the size it declares', async () => {
      const lie = { name: 'src/bomb.ts', data: 'x'.repeat(100_000), declaredSize: 10 };
      const zip = buildZip(['src/a.ts', lie]);

      await expect(importZipArchive(zip)).rejects.toThrow(ImportRejectedError);
    });

    it('does not unpack a huge entry that is skipped for its size', async () => {
      const huge = Buffer.alloc(60_000_000, 'a');
      const zip = buildZip(['package.json', 'src/a.ts', { name: 'src/huge.ts', data: huge }]);
      expect(zip.length).toBeLessThan(defaultImportLimits.maxArchiveBytes);

      const before = process.memoryUsage().arrayBuffers;
      const result = await importZipArchive(zip);

      expect(paths(result)).toEqual(['package.json', 'src/a.ts']);
      expect(reasons(result)['src/huge.ts']).toBe('too-large');
      expect(process.memoryUsage().arrayBuffers - before).toBeLessThan(30_000_000);
    });

    it('rejects an archive that holds too many files to index', async () => {
      const limits = { ...defaultImportLimits, maxFiles: 3 };
      const zip = buildZip(['a.ts', 'b.ts', 'c.ts', 'd.ts']);

      await expect(importZipArchive(zip, limits)).rejects.toThrow(/4 indexable files/);
    });

    it('rejects indexable files that add up to more than the total limit', async () => {
      const limits = { ...defaultImportLimits, maxTotalBytes: 1_000 };
      const zip = buildZip([
        { name: 'a.ts', data: 'a'.repeat(600) },
        { name: 'b.ts', data: 'b'.repeat(600) },
      ]);

      await expect(importZipArchive(zip, limits)).rejects.toThrow(/add up to 1200 bytes/);
    });

    it('rejects an archive with too many entries, whatever they are', async () => {
      const limits = { ...defaultImportLimits, maxEntries: 5 };
      const zip = buildZip(Array.from({ length: 6 }, (_, i) => `assets/${i}.png`));

      await expect(importZipArchive(zip, limits)).rejects.toThrow(/more than 5 entries/);
    });

    it('rejects an archive over the size limit without reading it', async () => {
      const limits = { ...defaultImportLimits, maxArchiveBytes: 100 };
      const zip = buildZip(['src/a.ts']);

      await expect(importZipArchive(zip, limits)).rejects.toThrow(/larger than the 100 byte limit/);
    });

    it.each([
      ['empty input', Buffer.alloc(0)],
      ['text that is not a zip', Buffer.from('definitely not a zip file')],
      ['a truncated archive', buildZip(['src/a.ts']).subarray(0, 40)],
    ])('rejects %s', async (_label, input) => {
      await expect(importZipArchive(input)).rejects.toThrow(
        new ImportRejectedError('The file is not a valid zip archive'),
      );
    });

    it('rejects an archive with nothing worth indexing', async () => {
      const zip = buildZip([{ name: '.env', data: 'A=1' }, 'logo.png', 'node_modules/x/a.js']);

      await expect(importZipArchive(zip)).rejects.toThrow(ImportRejectedError);
    });

    it('rejects an archive whose files all turn out to be unreadable', async () => {
      const zip = buildZip([{ name: 'a.ts', data: Buffer.from([0x61, 0x00]) }]);

      await expect(importZipArchive(zip)).rejects.toThrow(/no source, documentation/);
    });
  });
});
