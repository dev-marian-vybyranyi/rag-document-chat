import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { App } from '../../App';
import { answerChunks, jsonResponse, sseResponse, stubApi } from '../../test/fetch';
import { AuthProvider } from '../auth/AuthProvider';
import type { DocumentItem } from '../documents/api';

vi.mock('../documents/polling', () => ({ pollDelay: () => 15 }));

const ada = { id: 'u1', email: 'ada@example.com' };
const SHA = '7fd1a60b01f91b314f59955a4e4d4e80d8edf11d';
const QUESTION = 'How does loginHandler work?';

function repository(overrides: Partial<DocumentItem> = {}): DocumentItem {
  return {
    id: 'r1',
    kind: 'repository',
    filename: 'acme/shop',
    mimeType: 'application/zip',
    sizeBytes: 0,
    status: 'ready',
    error: null,
    pageCount: null,
    chunkCount: 18,
    fileCount: 6,
    repoUrl: 'https://github.com/acme/shop',
    repoRef: null,
    commitSha: SHA,
    progress: null,
    suggestions: [
      'How is this project structured?',
      'What dependencies does this project use?',
      'What are the main entry points?',
      QUESTION,
    ],
    createdAt: '2026-10-07T10:00:00Z',
    ...overrides,
  };
}

const importing = (progress: DocumentItem['progress']) =>
  repository({
    status: 'processing',
    progress,
    chunkCount: 0,
    fileCount: null,
    commitSha: null,
    suggestions: [],
  });

const location = {
  path: 'src/auth/login.ts',
  language: 'typescript',
  startLine: 12,
  endLine: 15,
  symbol: 'loginHandler',
};

const codeSource = {
  id: 1,
  chunkId: 'k1',
  documentId: 'r1',
  filename: 'acme/shop',
  page: null,
  code: location,
  ordinal: 7,
  excerpt: 'export async function loginHandler(req, res) {',
  score: 0.74,
};

const retrieval = {
  query: QUESTION,
  rewritten: false,
  mode: 'hybrid',
  bestScore: 0.74,
  threshold: 0.6,
  outcome: 'answered',
};

const loginCode = [
  'export async function loginHandler(req, res) {',
  '  const user = await findUser(req.body.email); // may be null',
  '  if (!user) return res.status(401).json({ error: "Invalid credentials" });',
  '}',
].join('\n');

const passages = {
  document: {
    id: 'r1',
    filename: 'acme/shop',
    pageCount: null,
    kind: 'repository',
    repoUrl: 'https://github.com/acme/shop',
    commitSha: SHA,
  },
  target: 7,
  passages: [
    {
      ordinal: 6,
      page: null,
      content: 'import { findUser } from "./users";',
      code: {
        path: 'src/auth/login.ts',
        language: 'typescript',
        startLine: 1,
        endLine: 1,
        symbol: null,
      },
    },
    { ordinal: 7, page: null, content: loginCode, code: location },
  ],
};

const PASSAGES = 'GET /api/documents/r1/passages?ordinal=7&radius=2';
const CHAT = {
  id: 'c9',
  title: 'New chat',
  createdAt: '2026-10-07T10:00:00Z',
  updatedAt: '2026-10-07T10:00:00Z',
};

function sequence(...responses: Array<() => Response>) {
  let index = 0;
  return () => responses[Math.min(index++, responses.length - 1)]!();
}

const times = (count: number, response: () => Response) =>
  Array.from({ length: count }, () => response);
const listOf = (documents: DocumentItem[]) => () => jsonResponse(200, { documents });

function setup(routes: Parameters<typeof stubApi>[0], path = '/documents') {
  const api = stubApi({
    'GET /api/auth/me': jsonResponse(200, { user: ada }),
    'GET /api/chats': jsonResponse(200, { chats: [] }),
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

describe('from a repository address to the lines that answer a question', () => {
  it('imports a repository, asks a suggested question and reads the cited code', async () => {
    const api = setup({
      'GET /api/documents': sequence(
        listOf([]),
        ...times(8, listOf([importing({ phase: 'downloading', done: 0, total: 0 })])),
        ...times(8, listOf([importing({ phase: 'embedding', done: 100, total: 180 })])),
        listOf([repository()]),
      ),
      'POST /api/repositories': () => jsonResponse(202, { document: importing(null) }),
      'POST /api/chats': jsonResponse(201, { chat: CHAT }),
      'GET /api/chats/c9': jsonResponse(200, { chat: CHAT, messages: [] }),
      'POST /api/chats/c9/messages': () =>
        sseResponse(
          answerChunks(
            ['`loginHandler` looks the user up and rejects unknown ones [1].'],
            [codeSource],
            retrieval,
          ),
        ),
      [PASSAGES]: jsonResponse(200, passages),
    });
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: 'Add a code repository' }));
    await user.type(
      await screen.findByLabelText('GitHub address'),
      'https://github.com/acme/shop{Enter}',
    );

    const library = await screen.findByRole('list', { name: 'Documents' });
    const card = within(library).getByText('acme/shop').closest('li')!;
    await waitFor(() => expect(card).toHaveTextContent('Indexing: 100 of 180 passages'));
    await waitFor(() => expect(card).toHaveTextContent('6 files · 18 passages · commit 7fd1a60'));
    expect(api.calls.find((c) => c.route === 'POST /api/repositories')?.body).toEqual({
      url: 'https://github.com/acme/shop',
    });

    await user.click(within(card).getByRole('button', { name: QUESTION }));

    const citation = await screen.findByRole('button', {
      name: 'Source 1: src/auth/login.ts:12-15',
    });
    expect(
      screen.getByRole('button', { name: /\[1\] src\/auth\/login\.ts:12-15/ }),
    ).toBeInTheDocument();

    await user.click(citation);
    const viewer = await screen.findByRole('complementary', { name: 'Source viewer' });
    const cited = await within(viewer).findByRole('region', { name: 'Cited code, lines 12-15' });
    expect(within(viewer).getByRole('heading', { name: 'src/auth/login.ts' })).toBeInTheDocument();
    expect(
      [...cited.querySelectorAll('[data-line]')].map((l) => l.getAttribute('data-line')),
    ).toEqual(['12', '13', '14', '15']);
    expect(within(cited).getByText('export').className).toMatch(/violet/);
    expect(within(cited).getByText('// may be null').className).toMatch(/italic/);
    expect(
      within(viewer).getByRole('link', { name: /View these lines on GitHub/ }),
    ).toHaveAttribute('href', `https://github.com/acme/shop/blob/${SHA}/src/auth/login.ts#L12-L15`);

    await user.click(within(viewer).getByRole('button', { name: /Close/ }));

    expect(screen.queryByRole('complementary', { name: 'Source viewer' })).not.toBeInTheDocument();
    expect(citation).toHaveFocus();
  });

  it('shows the same citation, and the same lines, when the conversation is opened again', async () => {
    setup(
      {
        'GET /api/documents': jsonResponse(200, { documents: [repository()] }),
        'GET /api/chats': jsonResponse(200, { chats: [CHAT] }),
        'GET /api/chats/c9': jsonResponse(200, {
          chat: CHAT,
          messages: [
            {
              id: 'm1',
              role: 'user',
              content: QUESTION,
              sources: [],
              retrieval: null,
              createdAt: 'x',
            },
            {
              id: 'm2',
              role: 'assistant',
              content: 'It rejects unknown users [1].',
              sources: [codeSource],
              retrieval,
              createdAt: 'x',
            },
          ],
        }),
        [PASSAGES]: jsonResponse(200, passages),
      },
      '/chats/c9',
    );
    const user = userEvent.setup();

    await user.click(
      await screen.findByRole('button', { name: 'Source 1: src/auth/login.ts:12-15' }),
    );

    const viewer = await screen.findByRole('complementary', { name: 'Source viewer' });
    expect(
      await within(viewer).findByRole('region', { name: 'Cited code, lines 12-15' }),
    ).toBeInTheDocument();
  });

  it('names the files in the explanation of an answer, and in the closest passages of a refusal', async () => {
    setup(
      {
        'GET /api/documents': jsonResponse(200, { documents: [repository()] }),
        'GET /api/chats': jsonResponse(200, { chats: [CHAT] }),
        'GET /api/chats/c9': jsonResponse(200, {
          chat: CHAT,
          messages: [
            {
              id: 'm1',
              role: 'user',
              content: QUESTION,
              sources: [],
              retrieval: null,
              createdAt: 'x',
            },
            {
              id: 'm2',
              role: 'assistant',
              content: 'It rejects unknown users [1].',
              sources: [codeSource],
              retrieval,
              createdAt: 'x',
            },
            {
              id: 'm3',
              role: 'user',
              content: 'What is the weather?',
              sources: [],
              retrieval: null,
              createdAt: 'x',
            },
            {
              id: 'm4',
              role: 'assistant',
              content: "I couldn't find this in your documents.",
              sources: [],
              retrieval: {
                query: 'What is the weather?',
                rewritten: false,
                mode: 'hybrid',
                bestScore: 0.31,
                threshold: 0.6,
                outcome: 'declined',
                closest: [{ filename: 'acme/shop', page: null, code: location, score: 0.31 }],
              },
              createdAt: 'x',
            },
          ],
        }),
      },
      '/chats/c9',
    );
    const user = userEvent.setup();

    const [answerWhy, refusalWhy] = await screen.findAllByRole('button', {
      name: 'Why this answer?',
    });
    await user.click(answerWhy!);
    const panel = await screen.findByRole('complementary', { name: 'Why this answer' });
    expect(panel).toHaveTextContent('[1] src/auth/login.ts:12-15');

    await user.click(refusalWhy!);
    const refusal = await screen.findByRole('complementary', { name: 'Why this answer' });
    expect(refusal).toHaveTextContent('src/auth/login.ts:12-15');
    expect(refusal).toHaveTextContent('31%');
  });
});
