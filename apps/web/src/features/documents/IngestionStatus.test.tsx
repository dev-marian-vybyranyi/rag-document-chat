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

function doc(overrides: Partial<DocumentItem> = {}): DocumentItem {
  return {
    id: 'd1',
    filename: 'handbook.pdf',
    mimeType: 'application/pdf',
    sizeBytes: 150 * 1024,
    status: 'processing',
    error: null,
    pageCount: null,
    chunkCount: 0,
    kind: 'document',
    fileCount: null,
    repoUrl: null,
    repoRef: null,
    commitSha: null,
    progress: null,
    suggestions: [],
    createdAt: '2026-10-07T10:00:00Z',
    ...overrides,
  };
}

const ready = (overrides: Partial<DocumentItem> = {}) =>
  doc({ status: 'ready', pageCount: 12, chunkCount: 30, ...overrides });

type Routes = Parameters<typeof stubApi>[0];

function setup(routes: Routes, path = '/documents') {
  const api = stubApi({
    'GET /api/auth/me': jsonResponse(200, { user: ada }),
    'GET /api/chats': jsonResponse(200, { chats: [] }),
    ...routes,
  });
  render(
    <MemoryRouter initialEntries={[path]}>
      <AuthProvider>
        <App />
      </AuthProvider>
    </MemoryRouter>,
  );
  return api;
}

function sequence(...responses: Array<() => Response>) {
  let index = 0;
  return () => responses[Math.min(index++, responses.length - 1)]!();
}

const documentFetches = (api: ReturnType<typeof setup>) =>
  api.calls.filter((c) => c.route === 'GET /api/documents').length;
const row = async (name: string) => (await screen.findByText(name)).closest('li')!;

describe('document processing status', () => {
  it('shows an indeterminate progress bar while a document is being processed', async () => {
    setup({ 'GET /api/documents': jsonResponse(200, { documents: [doc()] }) });

    expect(
      await screen.findByRole('progressbar', { name: 'Processing handbook.pdf' }),
    ).toBeInTheDocument();
    expect(await row('handbook.pdf')).toHaveTextContent('Processing…');
  });

  it('shows no progress bar for documents that are done or failed', async () => {
    setup({
      'GET /api/documents': jsonResponse(200, {
        documents: [
          ready(),
          doc({ id: 'd2', filename: 'bad.pdf', status: 'failed', error: 'No text' }),
        ],
      }),
    });

    await screen.findByText('bad.pdf');
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
  });

  it('summarises a finished document by pages and passages', async () => {
    setup({
      'GET /api/documents': jsonResponse(200, {
        documents: [
          ready(),
          ready({ id: 'd2', filename: 'note.txt', pageCount: null, chunkCount: 1 }),
        ],
      }),
    });

    expect(await row('handbook.pdf')).toHaveTextContent('Ready · 12 pages · 30 passages');
    expect(await row('note.txt')).toHaveTextContent('Ready · 1 passage');
  });

  describe('polling', () => {
    it('updates a document to ready by itself, and says so for screen readers', async () => {
      setup({
        'GET /api/documents': sequence(
          () => jsonResponse(200, { documents: [doc()] }),
          () => jsonResponse(200, { documents: [doc()] }),
          () => jsonResponse(200, { documents: [ready()] }),
        ),
      });

      await waitFor(async () =>
        expect(await row('handbook.pdf')).toHaveTextContent('Ready · 12 pages · 30 passages'),
      );
      expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
      expect(screen.getByRole('status')).toHaveTextContent('handbook.pdf is ready.');
    });

    it('shows the reason when processing fails', async () => {
      setup({
        'GET /api/documents': sequence(
          () => jsonResponse(200, { documents: [doc()] }),
          () =>
            jsonResponse(200, {
              documents: [doc({ status: 'failed', error: 'This PDF has no readable text.' })],
            }),
        ),
      });

      expect(await screen.findByText('This PDF has no readable text.')).toBeInTheDocument();
      expect(screen.getByRole('status')).toHaveTextContent('handbook.pdf could not be processed.');
    });

    it('stops asking once nothing is processing any more', async () => {
      const api = setup({
        'GET /api/documents': sequence(
          () => jsonResponse(200, { documents: [doc()] }),
          () => jsonResponse(200, { documents: [ready()] }),
        ),
      });
      await screen.findByText(/Ready · 12 pages/);
      const settled = documentFetches(api);

      await new Promise((resolve) => setTimeout(resolve, 150));

      expect(documentFetches(api)).toBe(settled);
    });

    it('does not ask at all when everything is already done', async () => {
      const api = setup({ 'GET /api/documents': jsonResponse(200, { documents: [ready()] }) });
      await screen.findByText(/Ready · 12 pages/);

      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(documentFetches(api)).toBe(1);
    });

    it('keeps trying after a failed check, without alarming the user', async () => {
      setup({
        'GET /api/documents': sequence(
          () => jsonResponse(200, { documents: [doc()] }),
          () => new Response('Bad Gateway', { status: 502 }),
          () => jsonResponse(200, { documents: [ready()] }),
        ),
      });

      expect(await screen.findByText(/Ready · 12 pages/)).toBeInTheDocument();
      expect(screen.queryByText('Could not load your documents.')).not.toBeInTheDocument();
    });

    it('does not bring back a document the user has deleted while it was still processing', async () => {
      setup({
        'GET /api/documents': jsonResponse(200, {
          documents: [doc(), ready({ id: 'd2', filename: 'other.txt' })],
        }),
        'DELETE /api/documents/d1': jsonResponse(204),
      });
      const user = userEvent.setup();
      await screen.findByText('handbook.pdf');

      await user.click(screen.getByRole('button', { name: 'Delete handbook.pdf' }));
      await user.click(screen.getByRole('button', { name: 'Delete' }));
      await waitFor(() => expect(screen.queryByText('handbook.pdf')).not.toBeInTheDocument());
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(screen.queryByText('handbook.pdf')).not.toBeInTheDocument();
      expect(screen.getByText('other.txt')).toBeInTheDocument();
    });

    it('follows a newly uploaded file from upload to ready', async () => {
      setup({
        'GET /api/documents': sequence(
          () => jsonResponse(200, { documents: [] }),
          () => jsonResponse(200, { documents: [doc({ id: 'n', filename: 'new.txt' })] }),
          () =>
            jsonResponse(200, {
              documents: [ready({ id: 'n', filename: 'new.txt', chunkCount: 3, pageCount: null })],
            }),
        ),
        'POST /api/documents': () =>
          jsonResponse(202, { document: doc({ id: 'n', filename: 'new.txt' }) }),
      });
      const user = userEvent.setup();
      await screen.findByText(/No documents yet/);

      await user.upload(
        screen.getByLabelText('Choose files to upload'),
        new File(['hello'], 'new.txt'),
      );

      expect(
        await screen.findByRole('progressbar', { name: 'Processing new.txt' }),
      ).toBeInTheDocument();
      expect(await screen.findByText(/Ready · 3 passages/)).toBeInTheDocument();
    });
  });

  describe('the sidebar', () => {
    it('shows that something is being processed from any page, and clears it when done', async () => {
      setup(
        {
          'GET /api/documents': sequence(
            () => jsonResponse(200, { documents: [doc()] }),
            () => jsonResponse(200, { documents: [doc()] }),
            () => jsonResponse(200, { documents: [doc()] }),
            () => jsonResponse(200, { documents: [ready()] }),
          ),
        },
        '/',
      );

      const link = await screen.findByRole('link', { name: /Documents/ });
      await waitFor(() => expect(link).toHaveTextContent('(processing)'));
      await waitFor(() => expect(within(link).queryByText('(processing)')).not.toBeInTheDocument());
    });
  });
});
