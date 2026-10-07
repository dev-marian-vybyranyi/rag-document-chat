import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { App } from '../../App';
import { jsonResponse, stubApi } from '../../test/fetch';
import { AuthProvider } from '../auth/AuthProvider';

const ada = { id: 'u1', email: 'ada@example.com' };
const budget = chat('c1', 'Budget 2026');
const handbookChat = chat('c2', 'Onboarding handbook');

function chat(id: string, title: string) {
  return { id, title, createdAt: '2026-10-07T10:00:00Z', updatedAt: '2026-10-07T11:00:00Z' };
}

function source(id: number, overrides = {}) {
  return {
    id,
    chunkId: `k${id}`,
    documentId: 'd1',
    filename: 'handbook.pdf',
    page: 4,
    ordinal: 7,
    excerpt: 'HNSW builds a layered graph.',
    score: 0.78,
    ...overrides,
  };
}

const answered = {
  query: 'What is HNSW?',
  rewritten: false,
  mode: 'hybrid',
  bestScore: 0.78,
  outcome: 'answered',
};

function savedChat(sources: object[], content = 'HNSW is a layered graph [1][2].') {
  return {
    chat: budget,
    messages: [
      {
        id: 'm1',
        role: 'user',
        content: 'What is HNSW?',
        sources: [],
        retrieval: null,
        createdAt: 'x',
      },
      { id: 'm2', role: 'assistant', content, sources, retrieval: answered, createdAt: 'x' },
    ],
  };
}

const passages = {
  document: { id: 'd1', filename: 'handbook.pdf', pageCount: 12 },
  target: 7,
  passages: [
    { ordinal: 5, page: 3, content: 'Earlier text about indexes.' },
    { ordinal: 6, page: 4, content: 'The previous passage.' },
    {
      ordinal: 7,
      page: 4,
      content: 'HNSW builds a layered graph. Search starts at the top layer.',
    },
    { ordinal: 8, page: 5, content: 'The next passage.' },
    { ordinal: 9, page: 5, content: 'Later text about recall.' },
  ],
};

type Routes = Parameters<typeof stubApi>[0];

function setup(routes: Routes) {
  const api = stubApi({
    'GET /api/auth/me': jsonResponse(200, { user: ada }),
    'GET /api/chats': jsonResponse(200, { chats: [budget, handbookChat] }),
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

const PASSAGES_ROUTE = 'GET /api/documents/d1/passages?ordinal=7&radius=2';
const viewer = () => screen.findByRole('complementary', { name: 'Source viewer' });

describe('source viewer', () => {
  it('is closed until a citation is clicked', async () => {
    setup({
      'GET /api/chats/c1': jsonResponse(
        200,
        savedChat([source(1)], 'HNSW is a layered graph [1].'),
      ),
    });

    await screen.findByLabelText(/Source 1/);

    expect(screen.queryByRole('complementary', { name: 'Source viewer' })).not.toBeInTheDocument();
  });

  it('opens from a citation marker and shows the cited passage with its surroundings', async () => {
    const api = setup({
      'GET /api/chats/c1': jsonResponse(
        200,
        savedChat([source(1)], 'HNSW is a layered graph [1].'),
      ),
      [PASSAGES_ROUTE]: jsonResponse(200, passages),
    });
    const user = userEvent.setup();

    await user.click(await screen.findByLabelText(/Source 1: handbook.pdf, page 4/));

    const panel = await viewer();
    expect(within(panel).getByRole('heading', { name: 'handbook.pdf' })).toBeInTheDocument();
    expect(within(panel).getByText(/Source \[1\] · Page 4 · Similarity 78%/)).toBeInTheDocument();
    const items = await within(panel).findAllByRole('listitem');
    expect(items.map((li) => li.textContent)).toEqual([
      expect.stringContaining('Earlier text about indexes.'),
      expect.stringContaining('The previous passage.'),
      expect.stringContaining('HNSW builds a layered graph. Search starts at the top layer.'),
      expect.stringContaining('The next passage.'),
      expect.stringContaining('Later text about recall.'),
    ]);
    expect(api.calls.filter((c) => c.route === PASSAGES_ROUTE)).toHaveLength(1);
  });

  it('marks the cited passage and nothing else', async () => {
    setup({
      'GET /api/chats/c1': jsonResponse(
        200,
        savedChat([source(1)], 'HNSW is a layered graph [1].'),
      ),
      [PASSAGES_ROUTE]: jsonResponse(200, passages),
    });
    const user = userEvent.setup();
    await user.click(await screen.findByLabelText(/Source 1/));

    const panel = await viewer();
    const items = await within(panel).findAllByRole('listitem');

    const cited = items.filter((li) => li.getAttribute('aria-current') === 'true');
    expect(cited).toHaveLength(1);
    expect(cited[0]).toHaveTextContent('Cited passage');
    expect(cited[0]).toHaveTextContent('HNSW builds a layered graph.');
    expect(items[0]).toHaveTextContent('Nearby');
  });

  it('brings the cited passage into view', async () => {
    const scrolled = vi.fn();
    Element.prototype.scrollIntoView = scrolled;
    setup({
      'GET /api/chats/c1': jsonResponse(
        200,
        savedChat([source(1)], 'HNSW is a layered graph [1].'),
      ),
      [PASSAGES_ROUTE]: jsonResponse(200, passages),
    });
    const user = userEvent.setup();

    await user.click(await screen.findByLabelText(/Source 1/));

    await waitFor(() => expect(scrolled).toHaveBeenCalled());
    const target = scrolled.mock.contexts.at(-1) as HTMLElement;
    expect(target).toHaveAttribute('aria-current', 'true');
  });

  it('also opens from the source chips under the answer', async () => {
    setup({
      'GET /api/chats/c1': jsonResponse(200, savedChat([source(1)], 'HNSW is a layered graph.')),
      [PASSAGES_ROUTE]: jsonResponse(200, passages),
    });
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: /\[1\] handbook\.pdf/ }));

    expect(await viewer()).toBeInTheDocument();
  });

  it('switches to another source without closing', async () => {
    setup({
      'GET /api/chats/c1': jsonResponse(
        200,
        savedChat([
          source(1),
          source(2, { documentId: 'd2', filename: 'notes.txt', page: null, ordinal: 1 }),
        ]),
      ),
      [PASSAGES_ROUTE]: jsonResponse(200, passages),
      'GET /api/documents/d2/passages?ordinal=1&radius=2': jsonResponse(200, {
        document: { id: 'd2', filename: 'notes.txt', pageCount: null },
        target: 1,
        passages: [{ ordinal: 1, page: null, content: 'Plain notes about rate limits.' }],
      }),
    });
    const user = userEvent.setup();
    await user.click(await screen.findByLabelText(/Source 1/));
    await screen.findByText(/The previous passage\./);

    await user.click(screen.getByLabelText(/Source 2: notes\.txt/));

    expect(await screen.findByText('Plain notes about rate limits.')).toBeInTheDocument();
    expect(screen.queryByText(/The previous passage\./)).not.toBeInTheDocument();
    expect(within(await viewer()).getByRole('heading', { name: 'notes.txt' })).toBeInTheDocument();
  });

  it('does not keep showing the previous source while the next one loads', async () => {
    setup({
      'GET /api/chats/c1': jsonResponse(
        200,
        savedChat([source(1), source(2, { documentId: 'd2', filename: 'notes.txt', ordinal: 1 })]),
      ),
      [PASSAGES_ROUTE]: jsonResponse(200, passages),
      'GET /api/documents/d2/passages?ordinal=1&radius=2': () => new Promise<Response>(() => {}),
    });
    const user = userEvent.setup();
    await user.click(await screen.findByLabelText(/Source 1/));
    await screen.findByText(/The previous passage\./);

    await user.click(screen.getByLabelText(/Source 2: notes\.txt/));

    expect(await screen.findByText('Loading the passage…')).toBeInTheDocument();
    expect(screen.queryByText(/The previous passage\./)).not.toBeInTheDocument();
  });

  it('closes with the button and with Escape', async () => {
    setup({
      'GET /api/chats/c1': jsonResponse(
        200,
        savedChat([source(1)], 'HNSW is a layered graph [1].'),
      ),
      [PASSAGES_ROUTE]: jsonResponse(200, passages),
    });
    const user = userEvent.setup();
    await user.click(await screen.findByLabelText(/Source 1/));
    await viewer();

    await user.click(screen.getByRole('button', { name: 'Close source viewer' }));
    expect(screen.queryByRole('complementary', { name: 'Source viewer' })).not.toBeInTheDocument();

    await user.click(screen.getByLabelText(/Source 1/));
    await viewer();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('complementary', { name: 'Source viewer' })).not.toBeInTheDocument();
  });

  it('moves focus into the panel when it opens', async () => {
    setup({
      'GET /api/chats/c1': jsonResponse(
        200,
        savedChat([source(1)], 'HNSW is a layered graph [1].'),
      ),
      [PASSAGES_ROUTE]: jsonResponse(200, passages),
    });
    const user = userEvent.setup();

    await user.click(await screen.findByLabelText(/Source 1/));

    expect(await screen.findByRole('button', { name: 'Close source viewer' })).toHaveFocus();
  });

  it('shows a loading state while the passage is fetched', async () => {
    setup({
      'GET /api/chats/c1': jsonResponse(
        200,
        savedChat([source(1)], 'HNSW is a layered graph [1].'),
      ),
      [PASSAGES_ROUTE]: () => new Promise<Response>(() => {}),
    });
    const user = userEvent.setup();

    await user.click(await screen.findByLabelText(/Source 1/));

    expect(await screen.findByText('Loading the passage…')).toBeInTheDocument();
  });

  it('falls back to the saved excerpt when the document has been deleted', async () => {
    setup({
      'GET /api/chats/c1': jsonResponse(
        200,
        savedChat([source(1)], 'HNSW is a layered graph [1].'),
      ),
      [PASSAGES_ROUTE]: jsonResponse(404, {
        error: { code: 'not_found', message: 'Passage not found' },
      }),
    });
    const user = userEvent.setup();

    await user.click(await screen.findByLabelText(/Source 1/));

    expect(await screen.findByText(/no longer available/)).toBeInTheDocument();
    expect(within(await viewer()).getByText('HNSW builds a layered graph.')).toBeInTheDocument();
  });

  it('offers another try when the server fails', async () => {
    let attempts = 0;
    setup({
      'GET /api/chats/c1': jsonResponse(
        200,
        savedChat([source(1)], 'HNSW is a layered graph [1].'),
      ),
      [PASSAGES_ROUTE]: () =>
        ++attempts === 1
          ? new Response('Bad Gateway', { status: 502 })
          : jsonResponse(200, passages),
    });
    const user = userEvent.setup();
    await user.click(await screen.findByLabelText(/Source 1/));

    expect(await screen.findByText('Could not load the passage.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Try again' }));

    expect(await screen.findByText(/The previous passage\./)).toBeInTheDocument();
  });

  it('closes when the user moves to another conversation', async () => {
    setup({
      'GET /api/chats/c1': jsonResponse(
        200,
        savedChat([source(1)], 'HNSW is a layered graph [1].'),
      ),
      'GET /api/chats/c2': jsonResponse(200, { chat: handbookChat, messages: [] }),
      [PASSAGES_ROUTE]: jsonResponse(200, passages),
    });
    const user = userEvent.setup();
    await user.click(await screen.findByLabelText(/Source 1/));
    await viewer();

    await user.click(screen.getByRole('link', { name: 'Onboarding handbook' }));

    await screen.findByRole('textbox', { name: 'Your question' });
    expect(screen.queryByRole('complementary', { name: 'Source viewer' })).not.toBeInTheDocument();
  });
});
