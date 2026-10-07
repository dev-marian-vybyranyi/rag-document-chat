import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import { App } from '../../App';
import { jsonResponse, stubApi } from '../../test/fetch';
import { AuthProvider } from '../auth/AuthProvider';

const ada = { id: 'u1', email: 'ada@example.com' };

function chat(id: string, title: string) {
  return { id, title, createdAt: '2026-10-07T10:00:00Z', updatedAt: '2026-10-07T10:00:00Z' };
}

const budget = chat('c1', 'Budget 2026');
const onboarding = chat('c2', 'Onboarding handbook');

function renderApp(path = '/') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AuthProvider>
        <App />
      </AuthProvider>
    </MemoryRouter>,
  );
}

const withChats = (chats: unknown[], extra: Parameters<typeof stubApi>[0] = {}) =>
  stubApi({
    'GET /api/auth/me': jsonResponse(200, { user: ada }),
    'GET /api/chats': jsonResponse(200, { chats }),
    ...extra,
  });

const conversations = () => screen.findByRole('navigation', { name: 'Conversations' });

describe('chat sidebar', () => {
  it('says it is loading while the list is on its way', async () => {
    stubApi({
      'GET /api/auth/me': jsonResponse(200, { user: ada }),
      'GET /api/chats': () => new Promise<Response>(() => {}),
    });

    renderApp();

    expect(await screen.findByText('Loading conversations…')).toBeInTheDocument();
  });

  it('lists the conversations in the order the server gives them', async () => {
    withChats([budget, onboarding]);

    renderApp();

    const nav = await conversations();
    const links = await within(nav).findAllByRole('link');
    expect(links.map((l) => l.textContent)).toEqual(['Budget 2026', 'Onboarding handbook']);
    expect(links[0]).toHaveAttribute('href', '/chats/c1');
  });

  it('invites the user to start a conversation when there are none', async () => {
    withChats([]);

    renderApp();

    expect(await screen.findByText(/No conversations yet/)).toBeInTheDocument();
  });

  it('marks the open conversation', async () => {
    withChats([budget, onboarding]);

    renderApp('/chats/c2');

    const nav = await conversations();
    expect(await within(nav).findByRole('link', { name: 'Onboarding handbook' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(within(nav).getByRole('link', { name: 'Budget 2026' })).not.toHaveAttribute(
      'aria-current',
    );
  });

  it('opens a conversation from the list', async () => {
    withChats([budget, onboarding]);
    const user = userEvent.setup();
    renderApp();

    await user.click(await screen.findByRole('link', { name: 'Onboarding handbook' }));

    expect(await screen.findByRole('textbox', { name: 'Your question' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Onboarding handbook' })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  it('sends the user home when the address points at a conversation they do not have', async () => {
    withChats([budget]);

    renderApp('/chats/someone-elses');

    expect(
      await screen.findByRole('heading', { name: 'Ask questions about your documents' }),
    ).toBeInTheDocument();
  });

  describe('when the list cannot be loaded', () => {
    it('explains that the server may be waking up and offers another try', async () => {
      let attempts = 0;
      stubApi({
        'GET /api/auth/me': jsonResponse(200, { user: ada }),
        'GET /api/chats': () =>
          ++attempts === 1
            ? new Response('Bad Gateway', { status: 502 })
            : jsonResponse(200, { chats: [budget] }),
      });
      const user = userEvent.setup();
      renderApp();

      expect(await screen.findByRole('alert')).toHaveTextContent(/not responding/);
      await user.click(screen.getByRole('button', { name: 'Try again' }));

      expect(await screen.findByRole('link', { name: 'Budget 2026' })).toBeInTheDocument();
    });

    it('keeps the page usable', async () => {
      withChats([], {
        'GET /api/chats': jsonResponse(500, { error: { code: 'internal_error', message: 'x' } }),
      });

      renderApp();

      expect(await screen.findByRole('alert')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'New chat' })).toBeEnabled();
      expect(screen.getByText(ada.email)).toBeInTheDocument();
    });
  });

  describe('starting a new chat', () => {
    it('creates it, puts it first in the list and opens it', async () => {
      const created = chat('c3', 'New chat');
      const { calls } = withChats([budget], {
        'POST /api/chats': jsonResponse(201, { chat: created }),
      });
      const user = userEvent.setup();
      renderApp();
      await screen.findByRole('link', { name: 'Budget 2026' });

      await user.click(screen.getByRole('button', { name: 'New chat' }));

      const nav = await conversations();
      const links = await within(nav).findAllByRole('link');
      expect(links.map((l) => l.textContent)).toEqual(['New chat', 'Budget 2026']);
      expect(links[0]).toHaveAttribute('aria-current', 'page');
      expect(calls.filter((c) => c.route === 'POST /api/chats')).toHaveLength(1);
    });

    it('cannot be clicked twice while it is being created', async () => {
      let release: (response: Response) => void = () => {};
      withChats([], {
        'POST /api/chats': () => new Promise<Response>((resolve) => (release = resolve)),
      });
      const user = userEvent.setup();
      renderApp();
      const button = await screen.findByRole('button', { name: 'New chat' });

      await user.click(button);

      expect(button).toBeDisabled();
      release(jsonResponse(201, { chat: chat('c3', 'New chat') }));
      expect(await screen.findByRole('textbox', { name: 'Your question' })).toBeInTheDocument();
    });

    it('says so and stays where it is when creating fails', async () => {
      withChats([budget], {
        'POST /api/chats': jsonResponse(500, { error: { code: 'internal_error', message: 'x' } }),
      });
      const user = userEvent.setup();
      renderApp();
      await screen.findByRole('link', { name: 'Budget 2026' });

      await user.click(screen.getByRole('button', { name: 'New chat' }));

      expect(await screen.findByText('Could not start a new chat. Try again.')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'New chat' })).toBeEnabled();
      expect(screen.getAllByRole('link')).toHaveLength(1);
    });
  });

  describe('on a narrow screen', () => {
    it('hides and shows the sidebar with the menu button, and closes it after navigating', async () => {
      withChats([budget, onboarding]);
      const user = userEvent.setup();
      renderApp();
      const toggle = await screen.findByRole('button', { name: 'Show conversations' });
      expect(toggle).toHaveAttribute('aria-expanded', 'false');

      await user.click(toggle);
      expect(toggle).toHaveAttribute('aria-expanded', 'true');

      await user.click(screen.getByRole('link', { name: 'Budget 2026' }));
      expect(screen.getByRole('button', { name: 'Show conversations' })).toHaveAttribute(
        'aria-expanded',
        'false',
      );
    });
  });
});
