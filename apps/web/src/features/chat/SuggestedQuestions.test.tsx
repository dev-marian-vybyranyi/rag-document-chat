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
const chat = {
  id: 'c1',
  title: 'New chat',
  createdAt: '2026-10-07T10:00:00Z',
  updatedAt: '2026-10-07T10:00:00Z',
};

function doc(overrides: Partial<DocumentItem> = {}): DocumentItem {
  return {
    id: 'd1',
    filename: 'handbook.pdf',
    mimeType: 'application/pdf',
    sizeBytes: 1000,
    status: 'ready',
    error: null,
    pageCount: 3,
    chunkCount: 5,
    kind: 'document',
    fileCount: null,
    repoUrl: null,
    repoRef: null,
    commitSha: null,
    progress: null,
    suggestions: ['What is HNSW?', 'How fast are queries?', 'What does recall mean?'],
    createdAt: '2026-10-07T10:00:00Z',
    ...overrides,
  };
}

type Routes = Parameters<typeof stubApi>[0];

function setup(path: string, routes: Routes) {
  const api = stubApi({
    'GET /api/auth/me': jsonResponse(200, { user: ada }),
    'GET /api/chats': jsonResponse(200, { chats: [chat] }),
    'GET /api/chats/c1': jsonResponse(200, { chat, messages: [] }),
    'POST /api/chats/c1/messages': () => sseResponse(answerChunks(['An answer'])),
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

const posts = (api: ReturnType<typeof setup>, route: string) =>
  api.calls.filter((c) => c.route === route);

describe('suggested questions in an empty chat', () => {
  it('offers questions from the finished documents', async () => {
    setup('/chats/c1', { 'GET /api/documents': jsonResponse(200, { documents: [doc()] }) });

    const list = await screen.findByRole('list', { name: 'Suggested questions' });

    expect(list).toHaveTextContent('What is HNSW?');
    expect(list).toHaveTextContent('How fast are queries?');
  });

  it('asks the question when one is clicked, and takes the suggestions away', async () => {
    const api = setup('/chats/c1', {
      'GET /api/documents': jsonResponse(200, { documents: [doc()] }),
    });
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: 'How fast are queries?' }));

    await waitFor(() =>
      expect(posts(api, 'POST /api/chats/c1/messages').map((c) => c.body)).toEqual([
        { content: 'How fast are queries?' },
      ]),
    );
    expect(await screen.findByText('An answer')).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'Suggested questions' })).not.toBeInTheDocument();
  });

  it('mixes questions from several documents', async () => {
    setup('/chats/c1', {
      'GET /api/documents': jsonResponse(200, {
        documents: [
          doc(),
          doc({ id: 'd2', filename: 'notes.txt', suggestions: ['What are the notes about?'] }),
        ],
      }),
    });

    const list = await screen.findByRole('list', { name: 'Suggested questions' });

    expect(list).toHaveTextContent('What is HNSW?');
    expect(list).toHaveTextContent('What are the notes about?');
  });

  it('points to the documents page when there are no documents, and mentions repositories', async () => {
    setup('/chats/c1', { 'GET /api/documents': jsonResponse(200, { documents: [] }) });

    expect(await screen.findByText(/You have no documents yet/)).toHaveTextContent(
      'import a code repository',
    );
    expect(screen.getByRole('link', { name: 'Add one' })).toHaveAttribute('href', '/documents');
  });

  it('says documents are still being processed when that is all there is', async () => {
    setup('/chats/c1', {
      'GET /api/documents': jsonResponse(200, {
        documents: [doc({ status: 'processing', suggestions: [] })],
      }),
    });

    expect(await screen.findByText(/still being processed/)).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'Suggested questions' })).not.toBeInTheDocument();
  });

  it('shows nothing extra for finished documents that came without suggestions', async () => {
    setup('/chats/c1', {
      'GET /api/documents': jsonResponse(200, { documents: [doc({ suggestions: [] })] }),
    });

    await screen.findByText(/Ask a question about your documents/);

    expect(screen.queryByRole('list', { name: 'Suggested questions' })).not.toBeInTheDocument();
    expect(screen.queryByText(/no documents yet/)).not.toBeInTheDocument();
  });

  it('shows nothing about documents until they are known', async () => {
    const pending = deferredResponse();
    setup('/chats/c1', { 'GET /api/documents': pending.handler });

    await screen.findByText(/Ask a question about your documents/);

    expect(screen.queryByText(/no documents yet/)).not.toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'Suggested questions' })).not.toBeInTheDocument();
  });

  it('is not offered in a conversation that already has messages', async () => {
    setup('/chats/c1', {
      'GET /api/documents': jsonResponse(200, { documents: [doc()] }),
      'GET /api/chats/c1': jsonResponse(200, {
        chat,
        messages: [
          {
            id: 'm1',
            role: 'user',
            content: 'Hello',
            sources: [],
            retrieval: null,
            createdAt: 'x',
          },
        ],
      }),
    });

    await screen.findByText('Hello');

    expect(screen.queryByRole('list', { name: 'Suggested questions' })).not.toBeInTheDocument();
  });
});

describe('suggested questions on the documents page', () => {
  it('starts a new chat and asks the question in it', async () => {
    const created = { ...chat, id: 'c9' };
    const api = setup('/documents', {
      'GET /api/documents': jsonResponse(200, { documents: [doc()] }),
      'POST /api/chats': jsonResponse(201, { chat: created }),
      'GET /api/chats/c9': jsonResponse(200, { chat: created, messages: [] }),
      'POST /api/chats/c9/messages': () => sseResponse(answerChunks(['Graph answer'])),
    });
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: 'What does recall mean?' }));

    expect(await screen.findByText('Graph answer')).toBeInTheDocument();
    expect(posts(api, 'POST /api/chats/c9/messages').map((c) => c.body)).toEqual([
      { content: 'What does recall mean?' },
    ]);
    expect(screen.getByText('What does recall mean?')).toBeInTheDocument();
  });

  it('shows suggestions only for documents that are ready', async () => {
    setup('/documents', {
      'GET /api/documents': jsonResponse(200, {
        documents: [doc({ status: 'processing', suggestions: ['Hidden question?'] })],
      }),
    });

    await screen.findByText('handbook.pdf');

    expect(screen.queryByText('Hidden question?')).not.toBeInTheDocument();
  });

  it('says so when the chat cannot be started', async () => {
    setup('/documents', {
      'GET /api/documents': jsonResponse(200, { documents: [doc()] }),
      'POST /api/chats': jsonResponse(500, { error: { code: 'internal_error', message: 'x' } }),
    });
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: 'What is HNSW?' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not start a chat');
  });
});

describe('suggested questions about a code repository', () => {
  const repository = (overrides: Partial<DocumentItem> = {}) =>
    doc({
      id: 'r1',
      kind: 'repository',
      filename: 'acme/shop',
      mimeType: 'application/zip',
      sizeBytes: 0,
      pageCount: null,
      fileCount: 12,
      repoUrl: 'https://github.com/acme/shop',
      suggestions: [
        'How is this project structured?',
        'What dependencies does this project use?',
        'What are the main entry points?',
        'How does loginHandler work?',
      ],
      ...overrides,
    });

  it('offers them in an empty chat', async () => {
    setup('/chats/c1', { 'GET /api/documents': jsonResponse(200, { documents: [repository()] }) });

    const list = await screen.findByRole('list', { name: 'Suggested questions' });

    expect(list).toHaveTextContent('How is this project structured?');
    expect(list).toHaveTextContent('What dependencies does this project use?');
    expect(list).toHaveTextContent('How does loginHandler work?');
  });

  it('takes turns with the questions of a document, so neither crowds the other out', async () => {
    setup('/chats/c1', {
      'GET /api/documents': jsonResponse(200, { documents: [repository(), doc()] }),
    });

    const list = await screen.findByRole('list', { name: 'Suggested questions' });

    expect(list).toHaveTextContent('How is this project structured?');
    expect(list).toHaveTextContent('What is HNSW?');
    expect(list.querySelectorAll('li')).toHaveLength(4);
  });

  it('asks the question about the code when one is clicked', async () => {
    const api = setup('/chats/c1', {
      'GET /api/documents': jsonResponse(200, { documents: [repository()] }),
    });
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: 'How does loginHandler work?' }));

    await waitFor(() =>
      expect(posts(api, 'POST /api/chats/c1/messages').map((c) => c.body)).toEqual([
        { content: 'How does loginHandler work?' },
      ]),
    );
  });

  it('are on the card of the repository, and start a chat from there', async () => {
    const created = { ...chat, id: 'c9' };
    const api = setup('/documents', {
      'GET /api/documents': jsonResponse(200, { documents: [repository()] }),
      'POST /api/chats': jsonResponse(201, { chat: created }),
      'GET /api/chats/c9': jsonResponse(200, { chat: created, messages: [] }),
      'POST /api/chats/c9/messages': () => sseResponse(answerChunks(['It is structured so'])),
    });
    const user = userEvent.setup();

    const questions = await screen.findByRole('list', {
      name: 'Questions to ask about acme/shop',
    });
    await user.click(
      within(questions).getByRole('button', { name: 'What are the main entry points?' }),
    );

    expect(await screen.findByText('It is structured so')).toBeInTheDocument();
    expect(posts(api, 'POST /api/chats/c9/messages').map((c) => c.body)).toEqual([
      { content: 'What are the main entry points?' },
    ]);
  });

  it('are not shown while the repository is still being imported', async () => {
    setup('/chats/c1', {
      'GET /api/documents': jsonResponse(200, {
        documents: [repository({ status: 'processing', suggestions: [] })],
      }),
    });

    expect(await screen.findByRole('status')).toHaveTextContent(
      'Your documents and repositories are still being processed.',
    );
    expect(screen.queryByRole('list', { name: 'Suggested questions' })).not.toBeInTheDocument();
  });
});
