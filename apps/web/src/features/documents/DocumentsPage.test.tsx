import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import { App } from '../../App';
import { jsonResponse, stubApi } from '../../test/fetch';
import { AuthProvider } from '../auth/AuthProvider';
import type { DocumentItem } from './api';

const ada = { id: 'u1', email: 'ada@example.com' };

function doc(overrides: Partial<DocumentItem> = {}): DocumentItem {
  return {
    id: 'd1',
    filename: 'handbook.pdf',
    mimeType: 'application/pdf',
    sizeBytes: 150 * 1024,
    status: 'ready',
    error: null,
    pageCount: 12,
    chunkCount: 30,
    createdAt: '2026-10-07T10:00:00Z',
    ...overrides,
  };
}

type Routes = Parameters<typeof stubApi>[0];

function setup(routes: Routes = {}) {
  const api = stubApi({
    'GET /api/auth/me': jsonResponse(200, { user: ada }),
    'GET /api/chats': jsonResponse(200, { chats: [] }),
    ...routes,
  });
  render(
    <MemoryRouter initialEntries={['/documents']}>
      <AuthProvider>
        <App />
      </AuthProvider>
    </MemoryRouter>,
  );
  return api;
}

const list = () => screen.findByRole('list', { name: 'Documents' });
const fileInput = () => screen.getByLabelText('Choose files to upload') as HTMLInputElement;
const uploadsOf = (api: ReturnType<typeof setup>) =>
  api.calls.filter((c) => c.route === 'POST /api/documents');

function dropOn(target: Element, files: File[]) {
  fireEvent.drop(target, { dataTransfer: { files } });
}

describe('documents page', () => {
  it('is reached from the sidebar', async () => {
    stubApi({
      'GET /api/auth/me': jsonResponse(200, { user: ada }),
      'GET /api/chats': jsonResponse(200, { chats: [] }),
    });
    render(
      <MemoryRouter initialEntries={['/']}>
        <AuthProvider>
          <App />
        </AuthProvider>
      </MemoryRouter>,
    );
    const user = userEvent.setup();

    await user.click(await screen.findByRole('link', { name: 'Documents' }));

    expect(await screen.findByRole('heading', { name: 'Your documents' })).toBeInTheDocument();
  });

  describe('listing', () => {
    it('shows a skeleton while loading, then the documents with size and status', async () => {
      let release: (response: Response) => void = () => {};
      setup({
        'GET /api/documents': () => new Promise<Response>((resolve) => (release = resolve)),
      });

      expect(await screen.findByText('Loading documents…')).toBeInTheDocument();
      release(
        jsonResponse(200, {
          documents: [
            doc(),
            doc({ id: 'd2', filename: 'notes.txt', sizeBytes: 900, status: 'processing' }),
          ],
        }),
      );

      const rows = within(await list()).getAllByRole('listitem');
      expect(rows[0]).toHaveTextContent('handbook.pdf');
      expect(rows[0]).toHaveTextContent('150 KB');
      expect(rows[0]).toHaveTextContent('Ready');
      expect(rows[1]).toHaveTextContent('900 B');
      expect(rows[1]).toHaveTextContent('Processing…');
    });

    it('invites the user to add a first document', async () => {
      setup();

      expect(await screen.findByText(/No documents yet/)).toBeInTheDocument();
    });

    it('shows why a document failed', async () => {
      setup({
        'GET /api/documents': jsonResponse(200, {
          documents: [doc({ status: 'failed', error: 'This PDF has no readable text.' })],
        }),
      });

      expect(await screen.findByText('This PDF has no readable text.')).toBeInTheDocument();
      expect(screen.getByText(/Failed/)).toBeInTheDocument();
    });

    it('offers another try when the list cannot be loaded', async () => {
      let attempts = 0;
      setup({
        'GET /api/documents': () =>
          ++attempts === 1
            ? new Response('Bad Gateway', { status: 502 })
            : jsonResponse(200, { documents: [doc()] }),
      });
      const user = userEvent.setup();

      expect(await screen.findByText('Could not load your documents.')).toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: 'Try again' }));

      expect(await screen.findByText('handbook.pdf')).toBeInTheDocument();
    });
  });

  describe('uploading', () => {
    it('sends a chosen file as multipart form data and puts it on top of the list', async () => {
      const api = setup({
        'GET /api/documents': jsonResponse(200, { documents: [doc()] }),
        'POST /api/documents': () =>
          jsonResponse(202, {
            document: doc({ id: 'd2', filename: 'notes.txt', status: 'processing', chunkCount: 0 }),
          }),
      });
      const user = userEvent.setup();
      await list();

      await user.upload(
        fileInput(),
        new File(['hello world'], 'notes.txt', { type: 'text/plain' }),
      );

      await waitFor(() =>
        expect(
          within(screen.getByRole('list', { name: 'Documents' })).getAllByRole('listitem')[0],
        ).toHaveTextContent('notes.txt'),
      );
      expect(uploadsOf(api)).toHaveLength(1);
      const [, init] = (api.fetchMock.mock.calls.find((call) => call[1]?.method === 'POST') ??
        []) as [unknown, RequestInit];
      expect(init.body).toBeInstanceOf(FormData);
      expect((init.body as FormData).get('file')).toBeInstanceOf(File);
      expect(init.headers).toBeUndefined();
    });

    it('accepts files dropped on the drop area, several at once', async () => {
      const api = setup({
        'POST /api/documents': () =>
          jsonResponse(202, { document: doc({ id: 'x', status: 'processing' }) }),
      });
      await screen.findByText(/No documents yet/);

      dropOn(screen.getByText('Drop files here to add them').closest('div')!.parentElement!, [
        new File(['a'], 'a.txt'),
        new File(['b'], 'b.md'),
      ]);

      await waitFor(() => expect(uploadsOf(api)).toHaveLength(2));
    });

    it('highlights the drop area while a file is dragged over it', async () => {
      setup();
      await screen.findByText(/No documents yet/);
      const zone = screen.getByText('Drop files here to add them').closest('[data-dragging]')!;

      fireEvent.dragOver(zone);
      expect(zone).toHaveAttribute('data-dragging', 'true');
      fireEvent.dragLeave(zone);

      expect(zone).toHaveAttribute('data-dragging', 'false');
    });

    it('shows an uploading line while the server is receiving the file', async () => {
      let release: (response: Response) => void = () => {};
      setup({
        'POST /api/documents': () => new Promise<Response>((resolve) => (release = resolve)),
      });
      const user = userEvent.setup();
      await screen.findByText(/No documents yet/);

      await user.upload(fileInput(), new File(['x'], 'slow.txt'));

      expect(await screen.findByText('Uploading slow.txt…')).toBeInTheDocument();
      release(
        jsonResponse(202, {
          document: doc({ id: 's', filename: 'slow.txt', status: 'processing' }),
        }),
      );
      await waitFor(() =>
        expect(screen.queryByText('Uploading slow.txt…')).not.toBeInTheDocument(),
      );
      expect(screen.getByText('slow.txt')).toBeInTheDocument();
    });

    it('refuses an unsupported or oversized file without contacting the server', async () => {
      const api = setup();
      await screen.findByText(/No documents yet/);

      dropOn(screen.getByText('Drop files here to add them').closest('[data-dragging]')!, [
        new File(['x'], 'photo.png'),
        new File([new Uint8Array(10 * 1024 * 1024 + 1)], 'huge.pdf'),
      ]);

      const alerts = await screen.findAllByRole('alert');
      expect(alerts[0]).toHaveTextContent('photo.png: Only PDF, TXT and Markdown');
      expect(alerts[1]).toHaveTextContent('huge.pdf: The file is too large');
      expect(uploadsOf(api)).toHaveLength(0);
    });

    it.each([
      [
        'an error the server explains',
        jsonResponse(400, { error: { code: 'invalid_file', message: 'This PDF is damaged' } }),
        'This PDF is damaged',
      ],
      [
        'a file the proxy turned away',
        new Response('<html>413</html>', { status: 413 }),
        'too large (limit 10.0 MB)',
      ],
      ['an unreachable server', new Response('Bad Gateway', { status: 502 }), 'not responding'],
    ])('explains %s and lets the user dismiss it', async (_name, response, text) => {
      setup({ 'POST /api/documents': () => response });
      const user = userEvent.setup();
      await screen.findByText(/No documents yet/);

      await user.upload(fileInput(), new File(['x'], 'a.txt'));

      expect(await screen.findByRole('alert')).toHaveTextContent(text);
      await user.click(screen.getByRole('button', { name: 'Dismiss a.txt' }));
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });
  });

  describe('deleting', () => {
    it('asks first, then removes the document', async () => {
      const api = setup({
        'GET /api/documents': jsonResponse(200, {
          documents: [doc(), doc({ id: 'd2', filename: 'notes.txt' })],
        }),
        'DELETE /api/documents/d1': jsonResponse(204),
      });
      const user = userEvent.setup();
      await list();

      await user.click(screen.getByRole('button', { name: 'Delete handbook.pdf' }));
      expect(api.calls.some((c) => c.route.startsWith('DELETE'))).toBe(false);
      await user.click(screen.getByRole('button', { name: 'Delete' }));

      await waitFor(() => expect(screen.queryByText('handbook.pdf')).not.toBeInTheDocument());
      expect(screen.getByText('notes.txt')).toBeInTheDocument();
    });

    it('keeps the document when the user cancels', async () => {
      const api = setup({ 'GET /api/documents': jsonResponse(200, { documents: [doc()] }) });
      const user = userEvent.setup();
      await list();

      await user.click(screen.getByRole('button', { name: 'Delete handbook.pdf' }));
      await user.click(screen.getByRole('button', { name: 'Cancel' }));

      expect(screen.getByText('handbook.pdf')).toBeInTheDocument();
      expect(api.calls.some((c) => c.route.startsWith('DELETE'))).toBe(false);
    });

    it('says so and keeps the document when the server fails', async () => {
      setup({
        'GET /api/documents': jsonResponse(200, { documents: [doc()] }),
        'DELETE /api/documents/d1': jsonResponse(500, {
          error: { code: 'internal_error', message: 'x' },
        }),
      });
      const user = userEvent.setup();
      await list();

      await user.click(screen.getByRole('button', { name: 'Delete handbook.pdf' }));
      await user.click(screen.getByRole('button', { name: 'Delete' }));

      expect(await screen.findByRole('alert')).toHaveTextContent('Could not delete the document');
      expect(screen.getByText('handbook.pdf')).toBeInTheDocument();
    });
  });
});
