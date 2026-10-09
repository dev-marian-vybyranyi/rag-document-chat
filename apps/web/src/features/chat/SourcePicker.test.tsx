import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import { App } from '../../App';
import {
  answerChunks,
  deferredResponse,
  jsonResponse,
  sseResponse,
  stubApi,
} from '../../test/fetch';
import { AuthProvider } from '../auth/AuthProvider';
import type { DocumentItem } from '../documents/api';

const ada = { id: 'u1', email: 'ada@example.com' };

function source(
  id: string,
  filename: string,
  kind: DocumentItem['kind'] = 'document',
  overrides = {},
): DocumentItem {
  return {
    id,
    kind,
    filename,
    mimeType: 'text/plain',
    sizeBytes: 100,
    status: 'ready',
    error: null,
    pageCount: null,
    chunkCount: 5,
    fileCount: null,
    repoUrl: null,
    repoRef: null,
    commitSha: null,
    progress: null,
    suggestions: [`A question about ${filename}?`],
    createdAt: '2026-10-07T10:00:00Z',
    ...overrides,
  };
}

const handbook = source('d1', 'handbook.pdf');
const notes = source('d2', 'notes.txt');
const shop = source('r1', 'acme/shop', 'repository');
const tools = source('r2', 'acme/tools', 'repository');
const library = [handbook, notes, shop, tools];

function chatOf(sourceIds: string[] | null, title = 'HR') {
  return {
    id: 'c1',
    title,
    sourceIds,
    createdAt: '2026-10-07T10:00:00Z',
    updatedAt: '2026-10-07T11:00:00Z',
  };
}

type Routes = Parameters<typeof stubApi>[0];

function setup(
  sourceIds: string[] | null,
  routes: Routes = {},
  documents: DocumentItem[] = library,
) {
  const chat = chatOf(sourceIds);
  const api = stubApi({
    'GET /api/auth/me': jsonResponse(200, { user: ada }),
    'GET /api/chats': jsonResponse(200, { chats: [chat] }),
    'GET /api/chats/c1': jsonResponse(200, { chat, messages: [] }),
    'GET /api/documents': jsonResponse(200, { documents }),
    ...routes,
  });
  render(
    <MemoryRouter initialEntries={['/chats/c1']}>
      <AuthProvider>
        <App />
      </AuthProvider>
    </MemoryRouter>,
  );
  return api;
}

const trigger = () => screen.findByRole('button', { name: /Searching in:/ });
const patches = (api: ReturnType<typeof setup>) =>
  api.calls.filter((c) => c.route === 'PATCH /api/chats/c1');

async function openPicker(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await trigger());
  return screen.findByRole('list', { name: 'Sources to search' });
}

const respond = (ids: string[] | null) => () => jsonResponse(200, { chat: chatOf(ids) });

describe('choosing the sources of a chat', () => {
  describe('the button', () => {
    it('says the whole library is searched when nothing was chosen', async () => {
      setup(null);

      expect(await trigger()).toHaveTextContent('Searching in: All sources');
    });

    it('names one chosen source and counts several', async () => {
      setup(['r1']);
      expect(await trigger()).toHaveTextContent('Searching in: acme/shop');
    });

    it('counts several chosen sources', async () => {
      setup(['r1', 'd1']);
      expect(await trigger()).toHaveTextContent('Searching in: 2 sources');
    });

    it('warns when everything that was chosen has been deleted', async () => {
      setup(['gone']);

      expect(await trigger()).toHaveTextContent('Chosen sources deleted');
    });
  });

  describe('the list', () => {
    it('shows every source with a checkbox, ticked for those that are searched', async () => {
      setup(['r1', 'd1']);
      const user = userEvent.setup();

      const list = await openPicker(user);

      expect(within(list).getAllByRole('checkbox')).toHaveLength(4);
      expect(within(list).getByRole('checkbox', { name: /acme\/shop/ })).toBeChecked();
      expect(within(list).getByRole('checkbox', { name: /handbook\.pdf/ })).toBeChecked();
      expect(within(list).getByRole('checkbox', { name: /notes\.txt/ })).not.toBeChecked();
      expect(within(list).getByRole('checkbox', { name: /acme\/tools/ })).not.toBeChecked();
    });

    it('has everything ticked when the whole library is searched', async () => {
      setup(null);
      const user = userEvent.setup();

      const list = await openPicker(user);

      for (const box of within(list).getAllByRole('checkbox')) expect(box).toBeChecked();
    });

    it('marks a source that is still being indexed or that failed', async () => {
      setup(null, {}, [
        handbook,
        source('d3', 'slow.pdf', 'document', { status: 'processing' }),
        source('d4', 'broken.pdf', 'document', { status: 'failed' }),
      ]);
      const user = userEvent.setup();

      const list = await openPicker(user);

      expect(within(list).getByText('indexing…')).toBeInTheDocument();
      expect(within(list).getByText('failed')).toBeInTheDocument();
    });

    it('says so when the library is empty', async () => {
      setup(null, {}, []);
      const user = userEvent.setup();

      await user.click(await trigger());

      expect(await screen.findByText(/You have no sources yet/)).toBeInTheDocument();
    });
  });

  describe('changing the choice', () => {
    it('sends the new list when a source is ticked, and shows it', async () => {
      const api = setup(['r1'], { 'PATCH /api/chats/c1': respond(['r1', 'd1']) });
      const user = userEvent.setup();
      const list = await openPicker(user);

      await user.click(within(list).getByRole('checkbox', { name: /handbook\.pdf/ }));

      await waitFor(() =>
        expect(patches(api).map((c) => c.body)).toEqual([{ sourceIds: ['r1', 'd1'] }]),
      );
      await waitFor(() =>
        expect(screen.getByRole('button', { name: /Searching in:/ })).toHaveTextContent(
          '2 sources',
        ),
      );
    });

    it('sends the shorter list when a source is unticked', async () => {
      const api = setup(['r1', 'd1'], { 'PATCH /api/chats/c1': respond(['r1']) });
      const user = userEvent.setup();
      const list = await openPicker(user);

      await user.click(within(list).getByRole('checkbox', { name: /handbook\.pdf/ }));

      await waitFor(() => expect(patches(api).map((c) => c.body)).toEqual([{ sourceIds: ['r1'] }]));
    });

    it('does not let the last source be unticked', async () => {
      const api = setup(['r1']);
      const user = userEvent.setup();
      const list = await openPicker(user);

      const last = within(list).getByRole('checkbox', { name: /acme\/shop/ });

      expect(last).toBeDisabled();
      await user.click(last);
      expect(patches(api)).toEqual([]);
    });

    it('chooses "all" when every source is ticked, so sources added later are included', async () => {
      const api = setup(['r1', 'd1', 'd2'], { 'PATCH /api/chats/c1': respond(null) });
      const user = userEvent.setup();
      const list = await openPicker(user);

      await user.click(within(list).getByRole('checkbox', { name: /acme\/tools/ }));

      await waitFor(() => expect(patches(api).map((c) => c.body)).toEqual([{ sourceIds: null }]));
    });

    it.each([
      ['Documents only', ['d1', 'd2']],
      ['Code only', ['r1', 'r2']],
    ])('has the choice "%s"', async (name, ids) => {
      const api = setup(null, { 'PATCH /api/chats/c1': respond(ids) });
      const user = userEvent.setup();
      await openPicker(user);

      await user.click(screen.getByRole('button', { name }));

      await waitFor(() => expect(patches(api).map((c) => c.body)).toEqual([{ sourceIds: ids }]));
    });

    it('goes back to the whole library with "All sources"', async () => {
      const api = setup(['r1'], { 'PATCH /api/chats/c1': respond(null) });
      const user = userEvent.setup();
      await openPicker(user);

      await user.click(screen.getByRole('button', { name: 'All sources' }));

      await waitFor(() => expect(patches(api).map((c) => c.body)).toEqual([{ sourceIds: null }]));
      await waitFor(() =>
        expect(screen.getByRole('button', { name: /Searching in:/ })).toHaveTextContent(
          'All sources',
        ),
      );
    });

    it('disables a choice that has nothing to choose', async () => {
      setup(null, {}, [handbook, notes]);
      const user = userEvent.setup();
      await openPicker(user);

      expect(screen.getByRole('button', { name: 'Code only' })).toBeDisabled();
      expect(screen.getByRole('button', { name: 'Documents only' })).toBeEnabled();
      expect(screen.getByRole('button', { name: 'All sources' })).toBeDisabled();
    });

    it('blocks further changes while one is on its way', async () => {
      const slow = deferredResponse();
      const api = setup(['r1'], { 'PATCH /api/chats/c1': slow.handler });
      const user = userEvent.setup();
      const list = await openPicker(user);

      await user.click(within(list).getByRole('checkbox', { name: /handbook\.pdf/ }));

      await waitFor(() =>
        expect(within(list).getByRole('checkbox', { name: /notes\.txt/ })).toBeDisabled(),
      );
      expect(patches(api)).toHaveLength(1);
      slow.release(jsonResponse(200, { chat: chatOf(['r1', 'd1']) }));
      await waitFor(() =>
        expect(within(list).getByRole('checkbox', { name: /notes\.txt/ })).toBeEnabled(),
      );
    });

    it('says so when the change could not be saved, and keeps the old choice', async () => {
      setup(['r1'], { 'PATCH /api/chats/c1': () => jsonResponse(503, {}) });
      const user = userEvent.setup();
      const list = await openPicker(user);

      await user.click(within(list).getByRole('checkbox', { name: /handbook\.pdf/ }));

      expect(await screen.findByRole('alert')).toHaveTextContent('Could not change the sources');
      expect(within(list).getByRole('checkbox', { name: /handbook\.pdf/ })).not.toBeChecked();
      expect(screen.getByRole('button', { name: /Searching in:/ })).toHaveTextContent('acme/shop');
    });

    it('leaves out the ids of deleted sources when it changes the choice', async () => {
      const api = setup(['r1', 'gone'], { 'PATCH /api/chats/c1': respond(['r1', 'd1']) });
      const user = userEvent.setup();
      const list = await openPicker(user);

      await user.click(within(list).getByRole('checkbox', { name: /handbook\.pdf/ }));

      await waitFor(() =>
        expect(patches(api).map((c) => c.body)).toEqual([{ sourceIds: ['r1', 'd1'] }]),
      );
    });
  });

  describe('when chosen sources are gone', () => {
    it('tells the user that a chosen source was deleted and is ignored', async () => {
      setup(['r1', 'gone']);
      const user = userEvent.setup();

      await openPicker(user);

      expect(screen.getByText(/One chosen source was deleted and is ignored/)).toBeInTheDocument();
    });

    it('asks the user to choose again when nothing is left', async () => {
      setup(['gone']);
      const user = userEvent.setup();

      await user.click(await trigger());

      expect(await screen.findByRole('alert')).toHaveTextContent(
        'were deleted, so nothing can be found',
      );
    });
  });

  describe('the suggested questions', () => {
    it('come only from the chosen sources', async () => {
      setup(['r1']);

      const list = await screen.findByRole('list', { name: 'Suggested questions' });

      expect(list).toHaveTextContent('A question about acme/shop?');
      expect(list).not.toHaveTextContent('handbook.pdf');
      expect(list).not.toHaveTextContent('notes.txt');
    });

    it('come from the whole library when none were chosen', async () => {
      setup(null);

      const list = await screen.findByRole('list', { name: 'Suggested questions' });

      expect(list).toHaveTextContent('A question about handbook.pdf?');
      expect(list).toHaveTextContent('A question about acme/shop?');
    });

    it('say that the chosen sources are gone, instead of suggesting from others', async () => {
      setup(['gone']);

      expect(
        await screen.findByText(/The sources chosen for this chat are gone/),
      ).toBeInTheDocument();
      expect(screen.queryByRole('list', { name: 'Suggested questions' })).not.toBeInTheDocument();
    });

    it('wait for the chosen source when it is still being indexed', async () => {
      setup(['r1'], {}, [
        handbook,
        source('r1', 'acme/shop', 'repository', { status: 'processing', suggestions: [] }),
      ]);

      expect(await screen.findByRole('status')).toHaveTextContent('still being processed');
    });
  });

  describe('starting a chat from a card', () => {
    const CREATED = { ...chatOf(['r1'], 'New chat'), id: 'c9' };

    it('asks about that one source only', async () => {
      const api = stubApi({
        'GET /api/auth/me': jsonResponse(200, { user: ada }),
        'GET /api/chats': jsonResponse(200, { chats: [] }),
        'GET /api/documents': jsonResponse(200, { documents: library }),
        'POST /api/chats': jsonResponse(201, { chat: CREATED }),
        'GET /api/chats/c9': jsonResponse(200, { chat: CREATED, messages: [] }),
        'POST /api/chats/c9/messages': () => sseResponse(answerChunks(['It is a shop'])),
      });
      render(
        <MemoryRouter initialEntries={['/documents']}>
          <AuthProvider>
            <App />
          </AuthProvider>
        </MemoryRouter>,
      );
      const user = userEvent.setup();

      const questions = await screen.findByRole('list', {
        name: 'Questions to ask about acme/shop',
      });
      await user.click(
        within(questions).getByRole('button', { name: 'A question about acme/shop?' }),
      );

      expect(await screen.findByText('It is a shop')).toBeInTheDocument();
      expect(api.calls.find((c) => c.route === 'POST /api/chats')?.body).toEqual({
        sourceIds: ['r1'],
      });
      expect(await trigger()).toHaveTextContent('Searching in: acme/shop');
    });

    it('does the same for a document', async () => {
      const created = { ...chatOf(['d1'], 'New chat'), id: 'c9' };
      const api = stubApi({
        'GET /api/auth/me': jsonResponse(200, { user: ada }),
        'GET /api/chats': jsonResponse(200, { chats: [] }),
        'GET /api/documents': jsonResponse(200, { documents: library }),
        'POST /api/chats': jsonResponse(201, { chat: created }),
        'GET /api/chats/c9': jsonResponse(200, { chat: created, messages: [] }),
        'POST /api/chats/c9/messages': () => sseResponse(answerChunks(['It is a handbook'])),
      });
      render(
        <MemoryRouter initialEntries={['/documents']}>
          <AuthProvider>
            <App />
          </AuthProvider>
        </MemoryRouter>,
      );
      const user = userEvent.setup();

      const questions = await screen.findByRole('list', {
        name: 'Questions to ask about handbook.pdf',
      });
      await user.click(
        within(questions).getByRole('button', { name: 'A question about handbook.pdf?' }),
      );

      await screen.findByText('It is a handbook');
      expect(api.calls.find((c) => c.route === 'POST /api/chats')?.body).toEqual({
        sourceIds: ['d1'],
      });
    });

    it('is not what the "New chat" button does: that chat searches everything', async () => {
      const fresh = { ...chatOf(null, 'New chat'), id: 'c8' };
      const api = stubApi({
        'GET /api/auth/me': jsonResponse(200, { user: ada }),
        'GET /api/chats': jsonResponse(200, { chats: [] }),
        'GET /api/documents': jsonResponse(200, { documents: library }),
        'POST /api/chats': jsonResponse(201, { chat: fresh }),
        'GET /api/chats/c8': jsonResponse(200, { chat: fresh, messages: [] }),
      });
      render(
        <MemoryRouter initialEntries={['/documents']}>
          <AuthProvider>
            <App />
          </AuthProvider>
        </MemoryRouter>,
      );
      const user = userEvent.setup();

      await user.click(await screen.findByRole('button', { name: 'New chat' }));

      expect(await trigger()).toHaveTextContent('Searching in: All sources');
      expect(api.calls.find((c) => c.route === 'POST /api/chats')?.body).toEqual({});
    });

    it('is not reused by "New chat" when it is still empty, because it has a scope', async () => {
      const scoped = { ...chatOf(['r1'], 'New chat'), id: 'c5' };
      const fresh = { ...chatOf(null, 'New chat'), id: 'c6' };
      const api = stubApi({
        'GET /api/auth/me': jsonResponse(200, { user: ada }),
        'GET /api/chats': jsonResponse(200, {
          chats: [{ ...scoped, updatedAt: scoped.createdAt }],
        }),
        'GET /api/documents': jsonResponse(200, { documents: library }),
        'POST /api/chats': jsonResponse(201, { chat: fresh }),
        'GET /api/chats/c6': jsonResponse(200, { chat: fresh, messages: [] }),
      });
      render(
        <MemoryRouter initialEntries={['/documents']}>
          <AuthProvider>
            <App />
          </AuthProvider>
        </MemoryRouter>,
      );
      const user = userEvent.setup();

      await user.click(await screen.findByRole('button', { name: 'New chat' }));

      await waitFor(() => expect(api.calls.some((c) => c.route === 'POST /api/chats')).toBe(true));
      expect(await trigger()).toHaveTextContent('All sources');
    });
  });
});
