import { render, screen, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import { App } from '../../App';
import { answerChunks, jsonResponse, sseResponse, stubApi } from '../../test/fetch';
import { AuthProvider } from '../auth/AuthProvider';

const ada = { id: 'u1', email: 'ada@example.com' };
const chat = {
  id: 'c1',
  title: 'New chat',
  sourceIds: null,
  createdAt: '2026-10-07T10:00:00Z',
  updatedAt: '2026-10-07T10:00:00Z',
};

function setup(strict: boolean, messages: object[] = []) {
  const api = stubApi({
    'GET /api/auth/me': jsonResponse(200, { user: ada }),
    'GET /api/chats': jsonResponse(200, { chats: [chat] }),
    'GET /api/chats/c1': jsonResponse(200, { chat, messages }),
    'POST /api/chats/c1/messages': () => sseResponse(answerChunks(['The answer'])),
  });
  const app = (
    <MemoryRouter initialEntries={[{ pathname: '/chats/c1', state: { ask: 'How does it work?' } }]}>
      <AuthProvider>
        <App />
      </AuthProvider>
    </MemoryRouter>
  );
  render(strict ? <StrictMode>{app}</StrictMode> : app);
  return api;
}

const sent = (api: ReturnType<typeof setup>) =>
  api.calls.filter((c) => c.route === 'POST /api/chats/c1/messages');

describe('a question handed to a new chat', () => {
  it.each([
    ['in production', false],
    ['in development, where React runs every effect twice', true],
  ])('is asked once and answered %s', async (_label, strict) => {
    const api = setup(strict);

    expect(await screen.findByText('The answer')).toBeInTheDocument();
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(sent(api).map((c) => c.body)).toEqual([{ content: 'How does it work?' }]);
    expect(screen.getAllByText('How does it work?')).toHaveLength(1);
  });

  it('is not asked again when the chat is opened later without it', async () => {
    const api = stubApi({
      'GET /api/auth/me': jsonResponse(200, { user: ada }),
      'GET /api/chats': jsonResponse(200, { chats: [chat] }),
      'GET /api/chats/c1': jsonResponse(200, { chat, messages: [] }),
    });
    render(
      <StrictMode>
        <MemoryRouter initialEntries={['/chats/c1']}>
          <AuthProvider>
            <App />
          </AuthProvider>
        </MemoryRouter>
      </StrictMode>,
    );

    await screen.findByRole('textbox', { name: 'Your question' });
    await waitFor(() => expect(api.calls.some((c) => c.route === 'GET /api/chats/c1')).toBe(true));

    expect(api.calls.filter((c) => c.route.startsWith('POST'))).toEqual([]);
  });
});
