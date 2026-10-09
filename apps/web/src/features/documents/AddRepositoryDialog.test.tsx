import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import { App } from '../../App';
import { deferredResponse, jsonResponse, stubApi } from '../../test/fetch';
import { AuthProvider } from '../auth/AuthProvider';
import type { DocumentItem } from './api';
import { MAX_ARCHIVE_BYTES } from './validation';

const ada = { id: 'u1', email: 'ada@example.com' };

function repository(overrides: Partial<DocumentItem> = {}): DocumentItem {
  return {
    id: 'r1',
    kind: 'repository',
    filename: 'acme/shop',
    mimeType: 'application/zip',
    sizeBytes: 0,
    status: 'processing',
    error: null,
    pageCount: null,
    chunkCount: 0,
    fileCount: null,
    repoUrl: 'https://github.com/acme/shop',
    repoRef: null,
    commitSha: null,
    progress: null,
    suggestions: [],
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

const openDialog = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(await screen.findByRole('button', { name: 'Add a code repository' }));
  return screen.findByRole('dialog', { name: 'Add a code repository' });
};

const address = () => screen.getByLabelText('GitHub address');
const archiveInput = () => screen.getByLabelText('Choose a zip archive') as HTMLInputElement;
const repositoryCalls = (api: ReturnType<typeof setup>) =>
  api.calls.filter((c) => c.route.startsWith('POST /api/repositories'));

function zip(name = 'code.zip', size = 100) {
  return new File([new Uint8Array(size)], name, { type: 'application/zip' });
}

describe('adding a code repository', () => {
  describe('the dialog', () => {
    it('opens from the documents page and explains what it takes', async () => {
      setup();
      const user = userEvent.setup();

      const dialog = await openDialog(user);

      expect(within(dialog).getByLabelText('GitHub address')).toHaveAttribute(
        'placeholder',
        'https://github.com/owner/repo',
      );
      expect(within(dialog).getByText(/never read/)).toBeInTheDocument();
      expect(within(dialog).getByRole('button', { name: 'Import' })).toBeInTheDocument();
      expect(
        within(dialog).getByRole('button', { name: 'Choose a zip archive' }),
      ).toBeInTheDocument();
      expect(within(dialog).getByText('Up to 20.0 MB.')).toBeInTheDocument();
    });

    it('closes with Escape and forgets what was typed', async () => {
      setup();
      const user = userEvent.setup();
      await openDialog(user);
      await user.type(address(), 'https://github.com/acme/shop');

      await user.keyboard('{Escape}');
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      await openDialog(user);

      expect(address()).toHaveValue('');
    });

    it('does not appear until asked for', async () => {
      setup();

      await screen.findByRole('heading', { name: 'Your documents' });

      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
  });

  describe('from a GitHub address', () => {
    it('sends the trimmed address, closes, and shows the repository as processing', async () => {
      const api = setup({
        'POST /api/repositories': jsonResponse(202, { document: repository() }),
      });
      const user = userEvent.setup();
      await openDialog(user);

      await user.type(address(), '  https://github.com/acme/shop  ');
      await user.click(screen.getByRole('button', { name: 'Import' }));

      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
      expect(repositoryCalls(api)).toEqual([
        { route: 'POST /api/repositories', body: { url: 'https://github.com/acme/shop' } },
      ]);
      const list = await screen.findByRole('list', { name: 'Documents' });
      expect(within(list).getByText('acme/shop')).toBeInTheDocument();
      expect(
        within(list).getByRole('progressbar', { name: 'Processing acme/shop' }),
      ).toBeInTheDocument();
    });

    it('submits with Enter', async () => {
      const api = setup({
        'POST /api/repositories': jsonResponse(202, { document: repository() }),
      });
      const user = userEvent.setup();
      await openDialog(user);

      await user.type(address(), 'https://github.com/acme/shop{Enter}');

      await waitFor(() => expect(repositoryCalls(api)).toHaveLength(1));
    });

    it.each([
      ['nothing', '', 'Enter the address of a GitHub repository.'],
      ['another site', 'https://gitlab.com/acme/shop', /like https:\/\/github\.com\/owner\/repo/],
      ['an issue page', 'https://github.com/acme/shop/issues/3', /like https:\/\/github\.com/],
    ])(
      'explains an address that is %s, without asking the server',
      async (_label, text, message) => {
        const api = setup();
        const user = userEvent.setup();
        await openDialog(user);

        if (text) await user.type(address(), text);
        await user.click(screen.getByRole('button', { name: 'Import' }));

        expect(await screen.findByRole('alert')).toHaveTextContent(message);
        expect(address()).toHaveAttribute('aria-invalid', 'true');
        expect(repositoryCalls(api)).toEqual([]);
        expect(screen.getByRole('dialog')).toBeInTheDocument();
      },
    );

    it('clears the message as soon as the address is edited', async () => {
      setup();
      const user = userEvent.setup();
      await openDialog(user);
      await user.click(screen.getByRole('button', { name: 'Import' }));
      await screen.findByRole('alert');

      await user.type(address(), 'h');

      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });

    it('keeps the dialog open and shows the reason when the server refuses', async () => {
      setup({
        'POST /api/repositories': jsonResponse(409, {
          error: {
            code: 'document_limit',
            message: 'You have reached the limit of 20 documents. Delete one to add another.',
          },
        }),
      });
      const user = userEvent.setup();
      await openDialog(user);

      await user.type(address(), 'https://github.com/acme/shop');
      await user.click(screen.getByRole('button', { name: 'Import' }));

      expect(await screen.findByRole('alert')).toHaveTextContent('limit of 20 documents');
      expect(address()).toHaveValue('https://github.com/acme/shop');
      expect(screen.getByRole('button', { name: 'Import' })).toBeEnabled();
    });

    it('shows the server’s explanation of a bad address', async () => {
      setup({
        'POST /api/repositories': jsonResponse(400, {
          error: {
            code: 'invalid_repository_url',
            message: 'The branch, tag or commit in the address is not valid',
          },
        }),
      });
      const user = userEvent.setup();
      await openDialog(user);

      await user.type(address(), 'https://github.com/acme/shop/tree/a%20b');
      await user.click(screen.getByRole('button', { name: 'Import' }));

      expect(await screen.findByRole('alert')).toHaveTextContent('not valid');
    });

    it('says the server is not responding on a failure that is not the user’s', async () => {
      setup({ 'POST /api/repositories': jsonResponse(503, {}) });
      const user = userEvent.setup();
      await openDialog(user);

      await user.type(address(), 'https://github.com/acme/shop');
      await user.click(screen.getByRole('button', { name: 'Import' }));

      expect(await screen.findByRole('alert')).toHaveTextContent('The server is not responding');
    });

    it('shows that it is working, blocks a second submit and cannot be closed meanwhile', async () => {
      const pending = deferredResponse();
      const api = setup({ 'POST /api/repositories': pending.handler });
      const user = userEvent.setup();
      await openDialog(user);

      await user.type(address(), 'https://github.com/acme/shop');
      await user.click(screen.getByRole('button', { name: 'Import' }));

      const busy = await screen.findByRole('button', { name: 'Importing…' });
      expect(busy).toBeDisabled();
      expect(address()).toBeDisabled();
      await user.keyboard('{Escape}');
      expect(screen.getByRole('dialog')).toBeInTheDocument();
      expect(repositoryCalls(api)).toHaveLength(1);

      pending.release(jsonResponse(202, { document: repository() }));
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    });
  });

  describe('from a zip archive', () => {
    it('sends the archive, closes, and shows the repository as processing', async () => {
      const api = setup({
        'POST /api/repositories/upload': jsonResponse(202, {
          document: repository({ filename: 'code', repoUrl: null }),
        }),
      });
      const user = userEvent.setup();
      await openDialog(user);

      await user.upload(archiveInput(), zip());

      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
      expect(repositoryCalls(api).map((c) => c.route)).toEqual(['POST /api/repositories/upload']);
      const list = await screen.findByRole('list', { name: 'Documents' });
      expect(within(list).getByText('code')).toBeInTheDocument();
    });

    it.each([
      ['a file that is not a zip archive', zip('code.tar.gz'), 'Choose a zip archive (.zip).'],
      ['an empty archive', zip('code.zip', 0), 'The archive is empty.'],
      [
        'an archive over the limit',
        zip('code.zip', MAX_ARCHIVE_BYTES + 1),
        /too large \(limit 20\.0 MB\)/,
      ],
    ])('explains %s, without sending it', async (_label, file, message) => {
      const api = setup();
      const user = userEvent.setup({ applyAccept: false });
      await openDialog(user);

      await user.upload(archiveInput(), file);

      expect(await screen.findByRole('alert')).toHaveTextContent(message);
      expect(repositoryCalls(api)).toEqual([]);
      expect(screen.getByRole('dialog')).toBeInTheDocument();
    });

    it('shows the server’s reason when it refuses the archive', async () => {
      setup({
        'POST /api/repositories/upload': jsonResponse(400, {
          error: { code: 'invalid_file', message: 'The file is not a valid zip archive' },
        }),
      });
      const user = userEvent.setup();
      await openDialog(user);

      await user.upload(archiveInput(), zip());

      expect(await screen.findByRole('alert')).toHaveTextContent('not a valid zip archive');
      expect(screen.getByRole('dialog')).toBeInTheDocument();
    });

    it('explains an archive the server found too large', async () => {
      setup({
        'POST /api/repositories/upload': jsonResponse(413, {
          error: { code: 'file_too_large', message: 'The file is too large (limit 20 MB)' },
        }),
      });
      const user = userEvent.setup();
      await openDialog(user);

      await user.upload(archiveInput(), zip());

      expect(await screen.findByRole('alert')).toHaveTextContent('limit 20.0 MB');
    });

    it('lets the same archive be chosen again after a failure', async () => {
      let attempts = 0;
      const api = setup({
        'POST /api/repositories/upload': () => {
          attempts += 1;
          return attempts === 1
            ? jsonResponse(503, {})
            : jsonResponse(202, { document: repository({ filename: 'code', repoUrl: null }) });
        },
      });
      const user = userEvent.setup();
      await openDialog(user);

      await user.upload(archiveInput(), zip());
      await screen.findByRole('alert');
      await user.upload(archiveInput(), zip());

      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
      expect(repositoryCalls(api)).toHaveLength(2);
    });
  });
});
