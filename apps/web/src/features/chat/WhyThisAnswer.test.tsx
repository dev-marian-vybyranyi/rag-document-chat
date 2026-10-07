import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import { App } from '../../App';
import { jsonResponse, stubApi } from '../../test/fetch';
import { AuthProvider } from '../auth/AuthProvider';
import type { WhyData } from './source-viewer-context';
import { WhyContent } from './WhyThisAnswer';
import type { ChatRetrieval, ChatSource } from './types';

const retrieval: ChatRetrieval = {
  query: 'What is HNSW?',
  rewritten: false,
  mode: 'hybrid',
  bestScore: 0.78,
  threshold: 0.65,
  outcome: 'answered',
  timings: { rewriteMs: 0, retrievalMs: 142 },
  closest: [],
};

function source(id: number, overrides: Partial<ChatSource> = {}): ChatSource {
  return {
    id,
    chunkId: `k${id}`,
    documentId: 'd1',
    filename: 'handbook.pdf',
    page: 4,
    ordinal: id,
    excerpt: 'text',
    score: 0.78,
    vectorRank: 1,
    keywordScore: 0.4,
    keywordRank: 2,
    fusedScore: 0.0323,
    ...overrides,
  };
}

function data(overrides: Partial<WhyData> = {}): WhyData {
  return {
    question: 'What is HNSW?',
    answer: 'A layered graph [1].',
    sources: [source(1), source(2, { filename: 'notes.txt', page: null, score: 0.7 })],
    retrieval,
    ...overrides,
  };
}

describe('WhyContent', () => {
  it('says the question was searched as written when it was not rewritten', () => {
    render(<WhyContent data={data()} />);

    expect(screen.getByText('It was searched exactly as you wrote it.')).toBeInTheDocument();
    expect(screen.queryByText(/Searched for:/)).not.toBeInTheDocument();
  });

  it('shows what a rewritten question was turned into, and why', () => {
    render(
      <WhyContent
        data={data({
          question: 'How fast is it?',
          retrieval: { ...retrieval, rewritten: true, query: 'How fast is HNSW search?' },
        })}
      />,
    );

    expect(screen.getByText('How fast is it?')).toBeInTheDocument();
    expect(screen.getByText('How fast is HNSW search?')).toBeInTheDocument();
    expect(screen.getByText(/rewritten using the earlier conversation/)).toBeInTheDocument();
  });

  it('explains the search mode and how long things took', () => {
    render(<WhyContent data={data()} />);

    expect(screen.getByText(/by meaning and by keywords, combined/)).toBeInTheDocument();
    expect(screen.getByText(/Rewriting took 0 ms, searching took 142 ms/)).toBeInTheDocument();
  });

  it('explains a keyword-only search and does not pretend to have measured relevance', () => {
    render(
      <WhyContent
        data={data({ retrieval: { ...retrieval, mode: 'keyword-only', bestScore: null } })}
      />,
    );

    expect(screen.getByText(/by keywords only/)).toBeInTheDocument();
    expect(screen.getByText(/Relevance could not be measured/)).toBeInTheDocument();
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });

  describe('for an answer', () => {
    it('compares the best match with the required one', () => {
      render(<WhyContent data={data()} />);

      expect(screen.getByRole('img')).toHaveAccessibleName('Best similarity 78%, required 65%');
      expect(screen.getByText(/Best match 78%, at least 65% is needed/)).toBeInTheDocument();
      expect(screen.getByText(/enough to ask the model/)).toBeInTheDocument();
    });

    it('lists every passage with its scores and ranks', () => {
      render(<WhyContent data={data()} />);

      const items = within(
        screen.getByText('Passages the model was given').closest('section')!,
      ).getAllByRole('listitem');
      expect(items[0]).toHaveTextContent('[1] handbook.pdf · page 4');
      expect(items[0]).toHaveTextContent('Similarity 78% (rank 1)');
      expect(items[0]).toHaveTextContent('Keyword match 0.40 (rank 2)');
      expect(items[0]).toHaveTextContent('Combined 0.0323');
    });

    it('marks which passages the answer actually cites', () => {
      render(<WhyContent data={data({ answer: 'Only the first [1].' })} />);

      const items = screen.getAllByRole('listitem');
      expect(items[0]).toHaveTextContent('Cited');
      expect(items[0]).not.toHaveTextContent('Not cited');
      expect(items[1]).toHaveTextContent('Not cited');
    });

    it('omits what a passage never had, such as a keyword score', () => {
      render(
        <WhyContent
          data={data({ sources: [source(1, { keywordScore: null, keywordRank: null })] })}
        />,
      );

      const item = screen.getAllByRole('listitem')[0]!;
      expect(item).toHaveTextContent('Similarity 78% (rank 1)');
      expect(item).not.toHaveTextContent('Keyword match');
    });

    it('copes with an answer saved before scores were recorded', () => {
      const old = source(1, {
        vectorRank: undefined,
        keywordScore: undefined,
        keywordRank: undefined,
        fusedScore: undefined,
        score: null,
      });
      render(
        <WhyContent
          data={data({
            sources: [old],
            retrieval: { ...retrieval, threshold: undefined, timings: undefined },
          })}
        />,
      );

      expect(screen.getByText('Detailed scores were not recorded.')).toBeInTheDocument();
      expect(screen.getByText(/Best match 78%/)).toBeInTheDocument();
      expect(screen.queryByText(/Rewriting took/)).not.toBeInTheDocument();
    });
  });

  describe('for a refusal', () => {
    const declined = data({
      answer: "I couldn't find this in your documents.",
      sources: [],
      retrieval: {
        ...retrieval,
        bestScore: 0.44,
        outcome: 'declined',
        closest: [
          { filename: 'handbook.pdf', page: 4, score: 0.44 },
          { filename: 'notes.txt', page: null, score: 0.4 },
        ],
      },
    });

    it('says why the model was not asked', () => {
      render(<WhyContent data={declined} />);

      expect(screen.getByText(/Best match 44%, at least 65% is needed/)).toBeInTheDocument();
      expect(
        screen.getByText(/the model was not asked and no sources were shown/),
      ).toBeInTheDocument();
      expect(screen.queryByText('Passages the model was given')).not.toBeInTheDocument();
    });

    it('shows the closest passages that were set aside', () => {
      render(<WhyContent data={declined} />);

      const items = screen.getAllByRole('listitem');
      expect(items[0]).toHaveTextContent('handbook.pdf · page 4');
      expect(items[0]).toHaveTextContent('Similarity 44%');
      expect(items[1]).toHaveTextContent('notes.txt');
    });

    it('says so when nothing was found at all', () => {
      render(
        <WhyContent
          data={data({
            sources: [],
            retrieval: { ...retrieval, bestScore: null, outcome: 'declined', closest: [] },
          })}
        />,
      );

      expect(
        screen.getByText('Nothing in your documents matched the question.'),
      ).toBeInTheDocument();
      expect(screen.getByText('No passages were found at all.')).toBeInTheDocument();
    });
  });
});

describe('the "Why this answer?" panel in the chat', () => {
  const ada = { id: 'u1', email: 'ada@example.com' };
  const chat = {
    id: 'c1',
    title: 'Budget',
    createdAt: '2026-10-07T10:00:00Z',
    updatedAt: '2026-10-07T11:00:00Z',
  };

  function setup() {
    stubApi({
      'GET /api/auth/me': jsonResponse(200, { user: ada }),
      'GET /api/chats': jsonResponse(200, { chats: [chat] }),
      'GET /api/chats/c1': jsonResponse(200, {
        chat,
        messages: [
          {
            id: 'm1',
            role: 'user',
            content: 'What is HNSW?',
            sources: [],
            retrieval: null,
            createdAt: 'x',
          },
          {
            id: 'm2',
            role: 'assistant',
            content: 'A layered graph [1].',
            sources: [source(1)],
            retrieval,
            createdAt: 'x',
          },
          {
            id: 'm3',
            role: 'user',
            content: 'Who won?',
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
              ...retrieval,
              query: 'Who won?',
              bestScore: 0.4,
              outcome: 'declined',
              closest: [],
            },
            createdAt: 'x',
          },
        ],
      }),
      'GET /api/documents/d1/passages?ordinal=1&radius=2': jsonResponse(200, {
        document: { id: 'd1', filename: 'handbook.pdf', pageCount: 3 },
        target: 1,
        passages: [{ ordinal: 1, page: 4, content: 'Passage text.' }],
      }),
    });
    render(
      <MemoryRouter initialEntries={['/chats/c1']}>
        <AuthProvider>
          <App />
        </AuthProvider>
      </MemoryRouter>,
    );
  }

  const panel = () => screen.findByRole('complementary', { name: 'Why this answer' });

  it('is offered under every answer, but not under a question', async () => {
    setup();

    expect(await screen.findAllByRole('button', { name: 'Why this answer?' })).toHaveLength(2);
  });

  it('explains the answer it was opened from, with the question that led to it', async () => {
    setup();
    const user = userEvent.setup();
    const buttons = await screen.findAllByRole('button', { name: 'Why this answer?' });

    await user.click(buttons[1]!);

    const opened = await panel();
    expect(within(opened).getByText('Who won?')).toBeInTheDocument();
    expect(within(opened).getByText(/the model was not asked/)).toBeInTheDocument();
  });

  it('shows one panel at a time, whether it is an explanation or a source', async () => {
    setup();
    const user = userEvent.setup();
    await user.click((await screen.findAllByRole('button', { name: 'Why this answer?' }))[0]!);
    await panel();

    await user.click(screen.getByLabelText(/Source 1: handbook.pdf/));
    expect(await screen.findByRole('complementary', { name: 'Source viewer' })).toBeInTheDocument();
    expect(
      screen.queryByRole('complementary', { name: 'Why this answer' }),
    ).not.toBeInTheDocument();

    await user.click(screen.getAllByRole('button', { name: 'Why this answer?' })[0]!);
    expect(await panel()).toBeInTheDocument();
    expect(screen.queryByRole('complementary', { name: 'Source viewer' })).not.toBeInTheDocument();
  });

  it('closes with the button and with Escape, and takes focus when it opens', async () => {
    setup();
    const user = userEvent.setup();
    await user.click((await screen.findAllByRole('button', { name: 'Why this answer?' }))[0]!);
    await panel();
    expect(screen.getByRole('button', { name: 'Close explanation' })).toHaveFocus();

    await user.keyboard('{Escape}');
    expect(
      screen.queryByRole('complementary', { name: 'Why this answer' }),
    ).not.toBeInTheDocument();

    await user.click(screen.getAllByRole('button', { name: 'Why this answer?' })[0]!);
    await user.click(await screen.findByRole('button', { name: 'Close explanation' }));
    expect(
      screen.queryByRole('complementary', { name: 'Why this answer' }),
    ).not.toBeInTheDocument();
  });
});
