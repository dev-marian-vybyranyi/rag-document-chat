import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import { App } from './App';
import { AuthProvider } from './features/auth/AuthProvider';
import { jsonResponse, stubApi, stubFetch } from './test/fetch';

const ada = { id: 'u1', email: 'ada@example.com' };
const signedIn = {
  'GET /api/auth/me': jsonResponse(200, { user: ada }),
  'GET /api/chats': jsonResponse(200, { chats: [] }),
};
const unauthenticated = { error: { code: 'unauthenticated', message: 'Sign in to continue' } };

function renderApp(path = '/') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AuthProvider>
        <App />
      </AuthProvider>
    </MemoryRouter>,
  );
}

describe('App routing', () => {
  it('shows a loading indicator while it finds out who is signed in', () => {
    stubFetch().mockReturnValue(new Promise(() => {}));

    renderApp();

    expect(screen.getByText('Loading…')).toBeInTheDocument();
  });

  describe('when signed out', () => {
    it('sends a visitor of a protected page to the sign-in page', async () => {
      stubFetch().mockResolvedValue(jsonResponse(401, unauthenticated));

      renderApp('/');

      expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
    });

    it('offers account creation on the register page', async () => {
      stubFetch().mockResolvedValue(jsonResponse(401, unauthenticated));

      renderApp('/register');

      expect(
        await screen.findByRole('heading', { name: 'Create your account' }),
      ).toBeInTheDocument();
    });

    it('moves between the sign-in and register pages through the footer link', async () => {
      stubFetch().mockResolvedValue(jsonResponse(401, unauthenticated));
      const user = userEvent.setup();
      renderApp('/login');

      await user.click(await screen.findByRole('link', { name: 'Create an account' }));

      expect(
        await screen.findByRole('heading', { name: 'Create your account' }),
      ).toBeInTheDocument();
    });

    it('sends unknown addresses to the sign-in page', async () => {
      stubFetch().mockResolvedValue(jsonResponse(401, unauthenticated));

      renderApp('/no/such/page');

      expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
    });
  });

  describe('when signed in', () => {
    it('shows the home page with the user and a sign-out button', async () => {
      stubApi(signedIn);

      renderApp('/');

      expect(
        await screen.findByRole('heading', { name: 'Ask questions about your documents' }),
      ).toBeInTheDocument();
      expect(screen.getByText(ada.email)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Sign out' })).toBeInTheDocument();
    });

    it.each(['/login', '/register'])('keeps the user away from %s', async (path) => {
      stubApi(signedIn);

      renderApp(path);

      expect(
        await screen.findByRole('heading', { name: 'Ask questions about your documents' }),
      ).toBeInTheDocument();
    });

    it('returns to the sign-in page after signing out', async () => {
      stubApi({ ...signedIn, 'POST /api/auth/logout': jsonResponse(204) });
      const user = userEvent.setup();
      renderApp('/');

      await user.click(await screen.findByRole('button', { name: 'Sign out' }));

      expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
    });

    it('stays on the page and says so when signing out fails', async () => {
      stubApi({
        ...signedIn,
        'POST /api/auth/logout': () => {
          throw new TypeError('Failed to fetch');
        },
      });
      const user = userEvent.setup();
      renderApp('/');

      await user.click(await screen.findByRole('button', { name: 'Sign out' }));

      expect(await screen.findByText('Could not sign out. Try again.')).toBeInTheDocument();
      expect(screen.getByText(ada.email)).toBeInTheDocument();
    });
  });

  describe('when the server is unreachable', () => {
    it('explains the outage instead of showing the sign-in page', async () => {
      stubFetch().mockResolvedValue(new Response('Bad Gateway', { status: 502 }));

      renderApp('/');

      expect(
        await screen.findByRole('heading', { name: 'The server is not responding' }),
      ).toBeInTheDocument();
      expect(screen.queryByRole('heading', { name: 'Sign in' })).not.toBeInTheDocument();
    });

    it('recovers once the server answers after "Try again"', async () => {
      stubFetch()
        .mockResolvedValueOnce(new Response('Bad Gateway', { status: 502 }))
        .mockResolvedValueOnce(jsonResponse(200, { user: ada }))
        .mockResolvedValueOnce(jsonResponse(200, { chats: [] }));
      const user = userEvent.setup();
      renderApp('/');

      await user.click(await screen.findByRole('button', { name: 'Try again' }));

      expect(
        await screen.findByRole('heading', { name: 'Ask questions about your documents' }),
      ).toBeInTheDocument();
    });
  });
});
