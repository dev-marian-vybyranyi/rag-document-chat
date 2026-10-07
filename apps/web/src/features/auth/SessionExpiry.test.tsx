import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import { App } from '../../App';
import { jsonResponse, stubApi } from '../../test/fetch';
import { AuthProvider } from './AuthProvider';

const ada = { id: 'u1', email: 'ada@example.com' };
const chat = {
  id: 'c1',
  title: 'Budget 2026',
  createdAt: '2026-10-07T10:00:00Z',
  updatedAt: '2026-10-07T11:00:00Z',
};
const expired = () =>
  jsonResponse(401, {
    error: { code: 'unauthenticated', message: 'Sign in to continue' },
  });

function renderApp(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AuthProvider>
        <App />
      </AuthProvider>
    </MemoryRouter>,
  );
}

describe('when the session ends while the app is open', () => {
  it('sends the user to sign in with an explanation, when a question is refused', async () => {
    stubApi({
      'GET /api/auth/me': jsonResponse(200, { user: ada }),
      'GET /api/chats': jsonResponse(200, { chats: [chat] }),
      'GET /api/chats/c1': jsonResponse(200, { chat, messages: [] }),
      'POST /api/chats/c1/messages': expired,
    });
    const user = userEvent.setup();
    renderApp('/chats/c1');

    await user.type(await screen.findByRole('textbox', { name: 'Your question' }), 'Hello?{Enter}');

    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
    expect(screen.getByText(/Your session has expired/)).toBeInTheDocument();
  });

  it('does the same when the conversation list is refused', async () => {
    stubApi({
      'GET /api/auth/me': jsonResponse(200, { user: ada }),
      'GET /api/chats': expired,
    });

    renderApp('/');

    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
    expect(screen.getByText(/Your session has expired/)).toBeInTheDocument();
  });

  it('brings the user back to the conversation after signing in again', async () => {
    let signedIn = false;
    stubApi({
      'GET /api/auth/me': () => jsonResponse(200, { user: ada }),
      'GET /api/chats': () => (signedIn ? jsonResponse(200, { chats: [chat] }) : expired()),
      'GET /api/chats/c1': jsonResponse(200, { chat, messages: [] }),
      'POST /api/auth/login': () => {
        signedIn = true;
        return jsonResponse(200, { user: ada });
      },
    });
    const user = userEvent.setup();
    renderApp('/chats/c1');
    await screen.findByRole('heading', { name: 'Sign in' });

    await user.type(screen.getByLabelText('Email'), 'ada@example.com');
    await user.type(screen.getByLabelText('Password'), 'correct horse battery');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByRole('textbox', { name: 'Your question' })).toBeInTheDocument();
  });

  it('does not show the notice to someone who simply was not signed in', async () => {
    stubApi({ 'GET /api/auth/me': expired });

    renderApp('/');

    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
    expect(screen.queryByText(/Your session has expired/)).not.toBeInTheDocument();
  });
});
