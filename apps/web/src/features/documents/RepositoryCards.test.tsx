import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { App } from '../../App';
import { jsonResponse, stubApi } from '../../test/fetch';
import { AuthProvider } from '../auth/AuthProvider';
import type { DocumentItem } from './api';

vi.mock('./polling', () => ({ pollDelay: () => 15 }));

const ada = { id: 'u1', email: 'ada@example.com' };
const SHA = '7fd1a60b01f91b314f59955a4e4d4e80d8edf11d';

function repo(overrides: Partial<DocumentItem> = {}): DocumentItem {
  return {
    id: 'r1',
    kind: 'repository',
    filename: 'acme/shop',
    mimeType: 'application/zip',
    sizeBytes: 0,
    status: 'ready',
    error: null,
    pageCount: null,
    chunkCount: 40,
    fileCount: 12,
    repoUrl: 'https://github.com/acme/shop',
    repoRef: null,
    commitSha: SHA,
    progress: null,
    suggestions: [],
    createdAt: '2026-10-07T10:00:00Z',
    ...overrides,
  };
}

const note = (overrides: Partial<DocumentItem> = {}): DocumentItem =>
  repo({
    id: 'd1',
    kind: 'document',
    filename: 'handbook.pdf',
    mimeType: 'application/pdf',
    sizeBytes: 150 * 1024,
    pageCount: 12,
    fileCount: null,
    repoUrl: null,
    commitSha: null,
    ...overrides,
  });

type Routes = Parameters<typeof stubApi>[0];

function setup(documents: DocumentItem[] | (() => Response), extra: Routes = {}) {
  stubApi({
    'GET /api/auth/me': jsonResponse(200, { user: ada }),
    'GET /api/chats': jsonResponse(200, { chats: [] }),
    'GET /api/documents':
      typeof documents === 'function' ? documents : jsonResponse(200, { documents }),
    ...extra,
  });
  render(
    <MemoryRouter initialEntries={['/documents']}>
      <AuthProvider>
        <App />
      </AuthProvider>
    </MemoryRouter>,
  );
}

const cardOf = async (name: string) => {
  const list = await screen.findByRole('list', { name: 'Documents' });
  return within(list).getByText(name).closest('li')!;
};

function sequence(...responses: Array<() => Response>) {
  let index = 0;
  return () => responses[Math.min(index++, responses.length - 1)]!();
}

const listOf = (documents: DocumentItem[]) => () => jsonResponse(200, { documents });

const times = (count: number, response: () => Response) =>
  Array.from({ length: count }, () => response);

describe('a repository in the library', () => {
  describe('when it is ready', () => {
    it('shows how many files and passages were indexed, and the commit that was read', async () => {
      setup([repo()]);

      const card = await cardOf('acme/shop');

      expect(card).toHaveTextContent('12 files · 40 passages · commit 7fd1a60');
    });

    it('does not show a size, which a repository from GitHub does not have', async () => {
      setup([repo()]);

      const card = await cardOf('acme/shop');

      expect(card).not.toHaveTextContent(/\b0 B\b/);
    });

    it('links the name to the repository and the commit to that exact commit', async () => {
      setup([repo()]);
      const card = await cardOf('acme/shop');

      const name = within(card).getByRole('link', { name: 'acme/shop on GitHub' });
      const commit = within(card).getByRole('link', { name: 'commit 7fd1a60' });

      expect(name).toHaveAttribute('href', 'https://github.com/acme/shop');
      expect(commit).toHaveAttribute('href', `https://github.com/acme/shop/tree/${SHA}`);
      for (const link of [name, commit]) {
        expect(link).toHaveAttribute('target', '_blank');
        expect(link).toHaveAttribute('rel', 'noopener noreferrer');
      }
    });

    it('names the branch or tag that was asked for', async () => {
      setup([repo({ repoRef: 'release/1.0' })]);

      const card = await cardOf('acme/shop');

      expect(card).toHaveTextContent('commit 7fd1a60 on release/1.0');
    });

    it('shows an uploaded archive without a link, since there is nowhere to go', async () => {
      setup([repo({ filename: 'my-project', repoUrl: null, commitSha: null, sizeBytes: 2048 })]);

      const card = await cardOf('my-project');

      expect(within(card).queryByRole('link')).not.toBeInTheDocument();
      expect(card).toHaveTextContent('12 files · 40 passages');
      expect(card).not.toHaveTextContent('commit');
    });

    it('does not link an address that is not on github.com', async () => {
      setup([repo({ repoUrl: 'javascript:alert(1)' })]);

      const card = await cardOf('acme/shop');

      expect(within(card).queryByRole('link')).not.toBeInTheDocument();
      expect(card).toHaveTextContent('commit 7fd1a60');
    });

    it('is told apart from a document by its icon and by what it says', async () => {
      setup([repo(), note()]);

      const code = await cardOf('acme/shop');
      const doc = await cardOf('handbook.pdf');

      expect(code.querySelector('svg.lucide-folder-git-2')).not.toBeNull();
      expect(doc.querySelector('svg.lucide-file-text')).not.toBeNull();
      expect(doc).toHaveTextContent('150 KB · Ready · 12 pages · 40 passages');
    });
  });

  describe('while it is being imported', () => {
    it.each([
      [{ phase: 'downloading', done: 0, total: 0 }, 'Downloading from GitHub…'],
      [{ phase: 'reading', done: 0, total: 0 }, 'Reading files…'],
      [{ phase: 'embedding', done: 100, total: 380 }, 'Indexing: 100 of 380 passages'],
      [null, 'Processing…'],
    ] as const)('says what it is doing (%j)', async (progress, text) => {
      setup([
        repo({ status: 'processing', progress, chunkCount: 0, fileCount: null, commitSha: null }),
      ]);

      const card = await cardOf('acme/shop');

      expect(card).toHaveTextContent(text);
    });

    it('fills a bar while passages are embedded', async () => {
      setup([
        repo({
          status: 'processing',
          progress: { phase: 'embedding', done: 100, total: 400 },
          commitSha: null,
        }),
      ]);
      const card = await cardOf('acme/shop');

      const bar = within(card).getByRole('progressbar', { name: 'Processing acme/shop' });

      expect(bar).toHaveAttribute('aria-valuenow', '25');
      expect(bar).toHaveAttribute('aria-valuemax', '100');
    });

    it('shows a moving bar, with no value, while the size of the work is not known yet', async () => {
      setup([
        repo({
          status: 'processing',
          progress: { phase: 'reading', done: 0, total: 0 },
          commitSha: null,
        }),
      ]);
      const card = await cardOf('acme/shop');

      const bar = within(card).getByRole('progressbar', { name: 'Processing acme/shop' });

      expect(bar).not.toHaveAttribute('aria-valuenow');
    });

    it('does not show a commit before there is one', async () => {
      setup([repo({ status: 'processing', commitSha: null, progress: null })]);

      const card = await cardOf('acme/shop');

      expect(card).not.toHaveTextContent('commit');
    });

    it('follows the import from download to ready without reloading', async () => {
      const processing = (progress: DocumentItem['progress']) =>
        listOf([
          repo({ status: 'processing', progress, commitSha: null, chunkCount: 0, fileCount: null }),
        ]);
      setup(
        sequence(
          ...times(8, processing({ phase: 'downloading', done: 0, total: 0 })),
          ...times(8, processing({ phase: 'embedding', done: 100, total: 300 })),
          ...times(8, processing({ phase: 'embedding', done: 200, total: 300 })),
          listOf([repo()]),
        ),
      );

      const card = await cardOf('acme/shop');
      expect(card).toHaveTextContent('Downloading from GitHub…');
      await waitFor(() => expect(card).toHaveTextContent('Indexing: 100 of 300 passages'));
      await waitFor(() => expect(card).toHaveTextContent('Indexing: 200 of 300 passages'));
      await waitFor(() =>
        expect(card).toHaveTextContent('12 files · 40 passages · commit 7fd1a60'),
      );
      expect(within(card).queryByRole('progressbar')).not.toBeInTheDocument();
    });
  });

  describe('when the import fails', () => {
    it('shows the reason', async () => {
      setup([
        repo({
          status: 'failed',
          error: 'The repository was not found, or it is private',
          chunkCount: 0,
          fileCount: null,
          commitSha: null,
        }),
      ]);

      const card = await cardOf('acme/shop');

      expect(card).toHaveTextContent('Failed');
      expect(card).toHaveTextContent('The repository was not found, or it is private');
      expect(within(card).queryByRole('progressbar')).not.toBeInTheDocument();
    });
  });

  describe('managing it', () => {
    it('is deleted like a document, after a confirmation', async () => {
      setup([repo(), note()], { 'DELETE /api/documents/r1': jsonResponse(204) });
      const user = userEvent.setup();
      const card = await cardOf('acme/shop');

      await user.click(within(card).getByRole('button', { name: 'Delete acme/shop' }));
      await user.click(within(card).getByRole('button', { name: 'Delete' }));

      await waitFor(() => expect(screen.queryByText('acme/shop')).not.toBeInTheDocument());
      expect(screen.getByText('handbook.pdf')).toBeInTheDocument();
    });

    it('offers no suggested questions yet', async () => {
      setup([repo({ suggestions: [] })]);

      const card = await cardOf('acme/shop');

      expect(within(card).queryByRole('list')).not.toBeInTheDocument();
    });
  });
});
