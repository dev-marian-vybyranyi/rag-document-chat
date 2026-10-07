import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import { App } from '../../App';
import { jsonResponse, stubApi } from '../../test/fetch';
import { AuthProvider } from '../auth/AuthProvider';

const ada = { id: 'u1', email: 'ada@example.com' };

function chat(id: string, title: string) {
  return { id, title, createdAt: '2026-10-07T10:00:00Z', updatedAt: '2026-10-07T11:00:00Z' };
}

const budget = chat('c1', 'Budget 2026');
const other = chat('c2', 'Onboarding handbook');

function setup(routes: Parameters<typeof stubApi>[0] = {}) {
  const api = stubApi({
    'GET /api/auth/me': jsonResponse(200, { user: ada }),
    'GET /api/chats': jsonResponse(200, { chats: [budget, other] }),
    'GET /api/chats/c1': jsonResponse(200, { chat: budget, messages: [] }),
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

const conversations = () => screen.findByRole('navigation', { name: 'Conversations' });
const titleBox = () => screen.findByRole('textbox', { name: 'Chat title' });
const calls = (api: ReturnType<typeof setup>, method: string) =>
  api.calls.filter((c) => c.route.startsWith(method));

describe('chat header', () => {
  it('shows the title of the open chat', async () => {
    setup();

    expect(await screen.findByRole('heading', { name: 'Budget 2026' })).toBeInTheDocument();
  });

  describe('renaming', () => {
    it('saves the new title and shows it in the header and the list', async () => {
      const api = setup({
        'PATCH /api/chats/c1': () => jsonResponse(200, { chat: chat('c1', 'Q4 budget') }),
      });
      const user = userEvent.setup();
      await user.click(await screen.findByRole('button', { name: 'Rename chat' }));

      const box = await titleBox();
      expect(box).toHaveValue('Budget 2026');
      await user.clear(box);
      await user.type(box, '  Q4 budget  {Enter}');

      expect(await screen.findByRole('heading', { name: 'Q4 budget' })).toBeInTheDocument();
      expect(
        within(await conversations()).getByRole('link', { name: 'Q4 budget' }),
      ).toBeInTheDocument();
      expect(calls(api, 'PATCH').map((c) => c.body)).toEqual([{ title: 'Q4 budget' }]);
    });

    it('does not ask the server when nothing changed', async () => {
      const api = setup();
      const user = userEvent.setup();
      await user.click(await screen.findByRole('button', { name: 'Rename chat' }));

      await user.type(await titleBox(), '{Enter}');

      expect(await screen.findByRole('heading', { name: 'Budget 2026' })).toBeInTheDocument();
      expect(calls(api, 'PATCH')).toHaveLength(0);
    });

    it('refuses a blank title without asking the server', async () => {
      const api = setup();
      const user = userEvent.setup();
      await user.click(await screen.findByRole('button', { name: 'Rename chat' }));

      await user.clear(await titleBox());
      await user.type(await titleBox(), '   {Enter}');

      expect(await screen.findByRole('alert')).toHaveTextContent('Enter a title.');
      expect(calls(api, 'PATCH')).toHaveLength(0);
    });

    it('leaves the title alone on Escape and on Cancel', async () => {
      const api = setup();
      const user = userEvent.setup();
      await user.click(await screen.findByRole('button', { name: 'Rename chat' }));
      await user.type(await titleBox(), ' changed{Escape}');

      expect(await screen.findByRole('heading', { name: 'Budget 2026' })).toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: 'Rename chat' }));
      await user.type(await titleBox(), ' again');
      await user.click(screen.getByRole('button', { name: 'Cancel' }));

      expect(await screen.findByRole('heading', { name: 'Budget 2026' })).toBeInTheDocument();
      expect(calls(api, 'PATCH')).toHaveLength(0);
    });

    it('keeps the editor open and says so when the server fails', async () => {
      setup({
        'PATCH /api/chats/c1': jsonResponse(500, {
          error: { code: 'internal_error', message: 'x' },
        }),
      });
      const user = userEvent.setup();
      await user.click(await screen.findByRole('button', { name: 'Rename chat' }));

      await user.type(await titleBox(), ' v2{Enter}');

      expect(await screen.findByRole('alert')).toHaveTextContent('Could not rename the chat');
      expect(await titleBox()).toHaveValue('Budget 2026 v2');
    });

    it('explains a title the server rejects', async () => {
      setup({
        'PATCH /api/chats/c1': jsonResponse(400, {
          error: { code: 'validation_error', message: 'Request validation failed' },
        }),
      });
      const user = userEvent.setup();
      await user.click(await screen.findByRole('button', { name: 'Rename chat' }));

      await user.type(await titleBox(), ' v2{Enter}');

      expect(await screen.findByRole('alert')).toHaveTextContent('between 1 and 120');
    });

    it('limits the title to what the server accepts', async () => {
      setup();
      const user = userEvent.setup();
      await user.click(await screen.findByRole('button', { name: 'Rename chat' }));

      expect(await titleBox()).toHaveAttribute('maxlength', '120');
    });
  });

  describe('deleting', () => {
    it('asks first, and cancelling keeps the chat', async () => {
      const api = setup();
      const user = userEvent.setup();

      await user.click(await screen.findByRole('button', { name: 'Delete chat' }));
      expect(screen.getByText('Delete this chat and its messages?')).toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: 'Cancel' }));

      expect(screen.queryByText('Delete this chat and its messages?')).not.toBeInTheDocument();
      expect(calls(api, 'DELETE')).toHaveLength(0);
    });

    it('removes the chat, takes the user home and drops it from the list', async () => {
      const api = setup({ 'DELETE /api/chats/c1': jsonResponse(204) });
      const user = userEvent.setup();
      await user.click(await screen.findByRole('button', { name: 'Delete chat' }));

      await user.click(screen.getByRole('button', { name: 'Delete' }));

      expect(
        await screen.findByRole('heading', { name: 'Ask questions about your documents' }),
      ).toBeInTheDocument();
      const nav = await conversations();
      await waitFor(() =>
        expect(within(nav).queryByRole('link', { name: 'Budget 2026' })).not.toBeInTheDocument(),
      );
      expect(within(nav).getByRole('link', { name: 'Onboarding handbook' })).toBeInTheDocument();
      expect(calls(api, 'DELETE')).toHaveLength(1);
    });

    it('stays on the chat and says so when deleting fails', async () => {
      setup({
        'DELETE /api/chats/c1': jsonResponse(500, {
          error: { code: 'internal_error', message: 'x' },
        }),
      });
      const user = userEvent.setup();
      await user.click(await screen.findByRole('button', { name: 'Delete chat' }));

      await user.click(screen.getByRole('button', { name: 'Delete' }));

      expect(await screen.findByRole('alert')).toHaveTextContent('Could not delete the chat');
      expect(screen.getByRole('textbox', { name: 'Your question' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Delete' })).toBeEnabled();
    });
  });
});
