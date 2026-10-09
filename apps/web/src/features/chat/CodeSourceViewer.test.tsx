import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import { App } from '../../App';
import { jsonResponse, stubApi } from '../../test/fetch';
import { AuthProvider } from '../auth/AuthProvider';
import type { PassagesResponse } from '../documents/api';

const ada = { id: 'u1', email: 'ada@example.com' };
const budget = {
  id: 'c1',
  title: 'Shop',
  createdAt: '2026-10-07T10:00:00Z',
  updatedAt: '2026-10-07T11:00:00Z',
};
const SHA = '7fd1a60b01f91b314f59955a4e4d4e80d8edf11d';

const loginCode = {
  path: 'src/auth/login.ts',
  language: 'typescript',
  startLine: 12,
  endLine: 14,
  symbol: 'loginHandler',
};

function codeSource(overrides = {}) {
  return {
    id: 1,
    chunkId: 'k1',
    documentId: 'r1',
    filename: 'acme/shop',
    page: null,
    code: loginCode,
    ordinal: 7,
    excerpt: 'export async function loginHandler(req, res) {',
    score: 0.71,
    ...overrides,
  };
}

const answered = {
  query: 'Where is login?',
  rewritten: false,
  mode: 'hybrid',
  bestScore: 0.71,
  outcome: 'answered',
};

function savedChat(sources: object[], content = 'Login is handled in the login file [1].') {
  return {
    chat: budget,
    messages: [
      {
        id: 'm1',
        role: 'user',
        content: 'Where is login?',
        sources: [],
        retrieval: null,
        createdAt: 'x',
      },
      { id: 'm2', role: 'assistant', content, sources, retrieval: answered, createdAt: 'x' },
    ],
  };
}

const repository: PassagesResponse['document'] = {
  id: 'r1',
  filename: 'acme/shop',
  pageCount: null,
  kind: 'repository',
  repoUrl: 'https://github.com/acme/shop',
  commitSha: SHA,
};

const filePassages = (document = repository) => ({
  document,
  target: 7,
  passages: [
    {
      ordinal: 5,
      page: null,
      content: 'import { db } from "../db";',
      code: {
        path: 'src/other.ts',
        language: 'typescript',
        startLine: 1,
        endLine: 1,
        symbol: null,
      },
    },
    {
      ordinal: 6,
      page: null,
      content: 'const MAX = 5; // attempts',
      code: {
        path: 'src/auth/login.ts',
        language: 'typescript',
        startLine: 8,
        endLine: 8,
        symbol: 'MAX',
      },
    },
    {
      ordinal: 7,
      page: null,
      content:
        'export async function loginHandler(req, res) {\n  const user = await find(req.body.email, "x");\n  return res.json({ ok: 1 });',
      code: loginCode,
    },
    {
      ordinal: 8,
      page: null,
      content: '}',
      code: {
        path: 'src/auth/login.ts',
        language: 'typescript',
        startLine: 15,
        endLine: 15,
        symbol: null,
      },
    },
  ],
});

type Routes = Parameters<typeof stubApi>[0];

function setup(routes: Routes) {
  stubApi({
    'GET /api/auth/me': jsonResponse(200, { user: ada }),
    'GET /api/chats': jsonResponse(200, { chats: [budget] }),
    ...routes,
  });
  render(
    <MemoryRouter initialEntries={['/chats/c1']}>
      <AuthProvider>
        <App />
      </AuthProvider>
    </MemoryRouter>,
  );
}

const PASSAGES = 'GET /api/documents/r1/passages?ordinal=7&radius=2';
const viewer = () => screen.findByRole('complementary', { name: 'Source viewer' });

async function openViewer(passages: Response | (() => Response), sources = [codeSource()]) {
  setup({
    'GET /api/chats/c1': jsonResponse(200, savedChat(sources)),
    [PASSAGES]: passages,
  });
  const user = userEvent.setup();
  await user.click(await screen.findByLabelText(/Source 1/));
  return { user, panel: await viewer() };
}

describe('a source that is a piece of code', () => {
  describe('in the answer', () => {
    it('is named by its file and lines on the citation and in the list of sources', async () => {
      setup({ 'GET /api/chats/c1': jsonResponse(200, savedChat([codeSource()])) });

      expect(await screen.findByLabelText('Source 1: src/auth/login.ts:12-14')).toBeInTheDocument();
      const buttons = screen.getAllByRole('button', { name: /src\/auth\/login\.ts:12-14/ });
      expect(buttons.map((b) => b.textContent)).toContain('[1] src/auth/login.ts:12-14');
    });

    it('says which repository the lines are from when the citation is hovered', async () => {
      setup({ 'GET /api/chats/c1': jsonResponse(200, savedChat([codeSource()])) });
      const user = userEvent.setup();

      await user.hover(await screen.findByLabelText(/Source 1/));

      expect(await screen.findByText('Lines 12-14 · Similarity 71%')).toBeInTheDocument();
    });
  });

  describe('the viewer', () => {
    it('is titled with the file, and says which repository and source it is', async () => {
      const { panel } = await openViewer(jsonResponse(200, filePassages()));

      expect(within(panel).getByRole('heading', { name: 'src/auth/login.ts' })).toBeInTheDocument();
      expect(panel).toHaveTextContent('acme/shop · Source [1] · Similarity 71%');
      expect(await within(panel).findByText('loginHandler')).toBeInTheDocument();
      expect(within(panel).getByText('typescript')).toBeInTheDocument();
    });

    it('shows the cited lines with their real line numbers, marked as the cited passage', async () => {
      const { panel } = await openViewer(jsonResponse(200, filePassages()));

      const cited = await within(panel).findByRole('region', { name: 'Cited code, lines 12-14' });

      expect(
        [...cited.querySelectorAll('[data-line]')].map((l) => l.getAttribute('data-line')),
      ).toEqual(['12', '13', '14']);
      expect(cited.closest('li')).toHaveAttribute('aria-current', 'true');
      expect(cited.closest('li')).toHaveTextContent('Cited lines · lines 12-14');
      expect(cited).toHaveTextContent('export async function loginHandler(req, res) {');
    });

    it('colours the code', async () => {
      const { panel } = await openViewer(jsonResponse(200, filePassages()));

      const cited = await within(panel).findByRole('region', { name: 'Cited code, lines 12-14' });

      expect(within(cited).getByText('export').className).toMatch(/violet/);
      expect(within(cited).getByText('"x"').className).toMatch(/emerald/);
      expect(within(cited).getByText('1').className).toMatch(/amber/);
    });

    it('shows the nearby lines of the same file and leaves out other files', async () => {
      const { panel } = await openViewer(jsonResponse(200, filePassages()));

      await within(panel).findByRole('region', { name: 'Cited code, lines 12-14' });

      expect(within(panel).getByRole('region', { name: 'Nearby code, lines 8' })).toHaveTextContent(
        'const MAX = 5; // attempts',
      );
      expect(
        within(panel).getByRole('region', { name: 'Nearby code, lines 15' }),
      ).toBeInTheDocument();
      expect(panel).not.toHaveTextContent('import { db }');
    });

    it('keeps the numbers out of what is copied', async () => {
      const { panel } = await openViewer(jsonResponse(200, filePassages()));

      const cited = await within(panel).findByRole('region', { name: 'Cited code, lines 12-14' });

      for (const gutter of cited.querySelectorAll('[data-line] > span:first-child')) {
        expect(gutter).toHaveAttribute('aria-hidden', 'true');
        expect(gutter.className).toMatch(/select-none/);
      }
    });

    it('links to the same lines of the same commit on GitHub', async () => {
      const { panel } = await openViewer(jsonResponse(200, filePassages()));

      const link = await within(panel).findByRole('link', { name: /View these lines on GitHub/ });

      expect(link).toHaveAttribute(
        'href',
        `https://github.com/acme/shop/blob/${SHA}/src/auth/login.ts#L12-L14`,
      );
      expect(link).toHaveAttribute('target', '_blank');
      expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    });

    it.each([
      ['an uploaded archive', { ...repository, repoUrl: null, commitSha: null }],
      [
        'an address that is not GitHub',
        { ...repository, repoUrl: 'https://evil.example/acme/shop' },
      ],
    ])('has no link for %s', async (_label, document) => {
      const { panel } = await openViewer(jsonResponse(200, filePassages(document)));

      await within(panel).findByRole('region', { name: 'Cited code, lines 12-14' });

      expect(within(panel).queryByRole('link')).not.toBeInTheDocument();
    });

    it('shows the generated summary of the repository as text, not as a file', async () => {
      const overview = {
        path: 'REPOSITORY_OVERVIEW',
        language: 'markdown',
        startLine: 1,
        endLine: 4,
        symbol: null,
      };
      const { panel } = await openViewer(
        jsonResponse(200, {
          document: repository,
          target: 7,
          passages: [
            {
              ordinal: 7,
              page: null,
              content: '# Repository overview: acme/shop\n\nLanguages: typescript 12',
              code: overview,
            },
          ],
        }),
        [codeSource({ code: overview })],
      );

      expect(
        within(panel).getByRole('heading', { name: 'Overview of acme/shop' }),
      ).toBeInTheDocument();
      expect(await within(panel).findByText(/Languages: typescript 12/)).toBeInTheDocument();
      expect(within(panel).queryByRole('link')).not.toBeInTheDocument();
      expect(panel.querySelector('[data-line]')).toBeNull();
    });

    it('falls back to the saved excerpt when the repository has been deleted', async () => {
      const { panel } = await openViewer(
        jsonResponse(404, { error: { code: 'not_found', message: 'Passage not found' } }),
      );

      expect(await within(panel).findByText(/no longer available/)).toBeInTheDocument();
      expect(panel).toHaveTextContent('export async function loginHandler(req, res) {');
    });

    it('offers to try again when loading fails', async () => {
      const { panel } = await openViewer(new Response('bad', { status: 502 }));

      expect(await within(panel).findByRole('alert')).toHaveTextContent(
        'Could not load the passage.',
      );
    });

    it('is closed with the close button and with Escape', async () => {
      const { user, panel } = await openViewer(jsonResponse(200, filePassages()));
      await within(panel).findByRole('region', { name: 'Cited code, lines 12-14' });

      await user.keyboard('{Escape}');

      expect(
        screen.queryByRole('complementary', { name: 'Source viewer' }),
      ).not.toBeInTheDocument();
    });
  });

  describe('a mixed answer', () => {
    it('opens a document passage the way it always did', async () => {
      const documentSource = {
        id: 2,
        chunkId: 'k2',
        documentId: 'd1',
        filename: 'handbook.pdf',
        page: 4,
        ordinal: 3,
        excerpt: 'Remote work is allowed.',
        score: 0.8,
      };
      setup({
        'GET /api/chats/c1': jsonResponse(
          200,
          savedChat([codeSource(), documentSource], 'See [1] and [2].'),
        ),
        'GET /api/documents/d1/passages?ordinal=3&radius=2': jsonResponse(200, {
          document: {
            id: 'd1',
            filename: 'handbook.pdf',
            pageCount: 12,
            kind: 'document',
            repoUrl: null,
            commitSha: null,
          },
          target: 3,
          passages: [{ ordinal: 3, page: 4, content: 'Remote work is allowed.' }],
        }),
      });
      const user = userEvent.setup();

      await user.click(await screen.findByLabelText(/Source 2/));

      const panel = await viewer();
      expect(within(panel).getByRole('heading', { name: 'handbook.pdf' })).toBeInTheDocument();
      expect(await within(panel).findByText('Remote work is allowed.')).toBeInTheDocument();
      expect(panel.querySelector('[data-line]')).toBeNull();
    });
  });
});
