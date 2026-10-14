import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import { App } from '../../App';
import { jsonResponse, stubApi } from '../../test/fetch';
import { AuthProvider } from '../auth/AuthProvider';
import type { DocumentItem } from '../documents/api';

const ada = { id: 'u1', email: 'ada@example.com' };
const QUESTION = 'What skills am I missing for Job #2?';

const CHAT = {
  id: 'c9',
  title: 'Skills for Job #2',
  createdAt: '2026-10-14T10:00:00Z',
  updatedAt: '2026-10-14T10:00:00Z',
};

const resumePassage = {
  id: 1,
  chunkId: 'k1',
  documentId: 'r1',
  filename: 'alex-cv.pdf',
  page: null,
  career: { role: 'resume', section: 'skills', jobNumber: null },
  ordinal: 2,
  excerpt: 'Resume · Skills\nGo, Rust, Docker, PostgreSQL',
  score: 0.61,
};

const requirementPassage = {
  id: 2,
  chunkId: 'k2',
  documentId: 'j2',
  filename: 'Platform Engineer at Acme',
  page: null,
  career: { role: 'job_posting', section: 'requirements', jobNumber: 2 },
  ordinal: 1,
  excerpt: 'Job #2 · Platform Engineer at Acme · Requirements\n- Kubernetes\n- Terraform',
  score: 0.58,
};

const gapsPassage = {
  id: 3,
  chunkId: 'k3',
  documentId: 'j2',
  filename: 'Platform Engineer at Acme',
  page: null,
  career: { role: 'job_posting', section: 'fit', jobNumber: 2 },
  ordinal: 5,
  excerpt:
    'Job #2 · Platform Engineer at Acme · Fit analysis · Gaps\n- Not shown in the resume: Kubernetes',
  score: 0.7,
};

const retrieval = {
  query: QUESTION,
  rewritten: false,
  mode: 'hybrid',
  bestScore: 0.7,
  threshold: 0.3,
  outcome: 'answered',
  filters: {
    speakers: [],
    time: null,
    jobs: ['Job #2 · Platform Engineer at Acme'],
    relaxed: false,
  },
};

const ANSWER =
  'Your skills are Go and Docker [1]. The posting wants Kubernetes [2], not shown [3].';

function conversation(overrides: object = {}) {
  return {
    chat: CHAT,
    messages: [
      { id: 'm1', role: 'user', content: QUESTION, sources: [], retrieval: null, createdAt: 'x' },
      {
        id: 'm2',
        role: 'assistant',
        content: ANSWER,
        sources: [resumePassage, requirementPassage, gapsPassage],
        retrieval,
        createdAt: 'x',
        ...overrides,
      },
    ],
  };
}

function passagesOf(
  document: { id: string; filename: string; kind: string },
  target: number,
  rows: Array<{ ordinal: number; content: string }>,
) {
  return {
    document: { ...document, pageCount: null, repoUrl: null, commitSha: null },
    target,
    passages: rows.map((row) => ({ ...row, page: null })),
  };
}

function library(): DocumentItem[] {
  const base = {
    mimeType: 'text/plain',
    sizeBytes: 100,
    status: 'ready' as const,
    error: null,
    pageCount: null,
    chunkCount: 5,
    fileCount: null,
    repoUrl: null,
    repoRef: null,
    commitSha: null,
    meetingHeldOn: null,
    participants: null,
    durationMs: null,
    notes: null,
    progress: null,
    suggestions: [],
    createdAt: '2026-10-14T10:00:00Z',
    fit: null,
  };
  return [
    { ...base, id: 'r1', kind: 'resume', filename: 'alex-cv.pdf', jobNumber: null, profile: null },
    {
      ...base,
      id: 'j2',
      kind: 'job_posting',
      filename: 'Platform Engineer at Acme',
      jobNumber: 2,
      profile: null,
    },
  ];
}

function setup(routes: Parameters<typeof stubApi>[0] = {}) {
  const api = stubApi({
    'GET /api/auth/me': jsonResponse(200, { user: ada }),
    'GET /api/chats': jsonResponse(200, { chats: [CHAT] }),
    'GET /api/chats/c9': jsonResponse(200, conversation()),
    'GET /api/documents': jsonResponse(200, { documents: library() }),
    ...routes,
  });
  render(
    <MemoryRouter initialEntries={['/chats/c9']}>
      <AuthProvider>
        <App />
      </AuthProvider>
    </MemoryRouter>,
  );
  return api;
}

describe('citations of a resume and job postings', () => {
  it('name the part of the resume or of the posting, the way the user refers to it', async () => {
    setup();

    expect(
      await screen.findByRole('button', { name: 'Source 1: Resume · Skills' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', {
        name: 'Source 2: Job #2 · Platform Engineer at Acme · Requirements',
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', {
        name: 'Source 3: Job #2 · Platform Engineer at Acme · Fit analysis',
      }),
    ).toBeInTheDocument();
  });

  it('are listed under the answer by part, not by file name', async () => {
    setup();

    expect(
      await screen.findByRole('button', { name: /\[1\] Resume · Skills/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', {
        name: /\[2\] Job #2 · Platform Engineer at Acme · Requirements/,
      }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/alex-cv\.pdf/)).not.toBeInTheDocument();
  });

  it('show the name, the part and the text when the pointer rests on them', async () => {
    setup();
    const user = userEvent.setup();

    await user.hover(
      await screen.findByRole('button', {
        name: 'Source 2: Job #2 · Platform Engineer at Acme · Requirements',
      }),
    );

    const hint = await screen.findByText('Click to read it in context.');
    const content = hint.parentElement!;
    expect(within(content).getByText('Job #2 · Platform Engineer at Acme')).toBeInTheDocument();
    expect(content).toHaveTextContent('Requirements · Similarity 58%');
    expect(content).toHaveTextContent('- Kubernetes');
  });

  it('call the resume Resume in the hint, not by the name of its file', async () => {
    setup();
    const user = userEvent.setup();

    await user.hover(await screen.findByRole('button', { name: 'Source 1: Resume · Skills' }));

    const hint = await screen.findByText('Click to read it in context.');
    expect(within(hint.parentElement!).getByText('Resume')).toBeInTheDocument();
    expect(hint.parentElement).not.toHaveTextContent('alex-cv.pdf');
    expect(hint.parentElement).toHaveTextContent('Skills · Similarity 61%');
  });
});

describe('reading a passage of a resume or a posting', () => {
  it('opens the resume with its passage marked, and does not call it generated', async () => {
    setup({
      'GET /api/documents/r1/passages?ordinal=2&radius=2': jsonResponse(
        200,
        passagesOf({ id: 'r1', filename: 'alex-cv.pdf', kind: 'resume' }, 2, [
          { ordinal: 1, content: 'Resume · Experience\nBuilt Go services.' },
          { ordinal: 2, content: 'Resume · Skills\nGo, Rust, Docker, PostgreSQL' },
        ]),
      ),
    });
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: 'Source 1: Resume · Skills' }));

    const viewer = await screen.findByRole('complementary', { name: 'Source viewer' });
    expect(within(viewer).getByRole('heading', { name: 'Resume' })).toBeInTheDocument();
    expect(viewer).toHaveTextContent('Source [1] · Skills');
    const list = await within(viewer).findByRole('list');
    const cited = within(list)
      .getAllByRole('listitem')
      .find((row) => row.getAttribute('aria-current') === 'true')!;
    expect(cited).toHaveTextContent('Cited passage');
    expect(cited).toHaveTextContent('Go, Rust, Docker, PostgreSQL');
    expect(viewer).not.toHaveTextContent('was generated');
  });

  it('opens a posting under its number, with the part in the subtitle', async () => {
    setup({
      'GET /api/documents/j2/passages?ordinal=1&radius=2': jsonResponse(
        200,
        passagesOf({ id: 'j2', filename: 'Platform Engineer at Acme', kind: 'job_posting' }, 1, [
          {
            ordinal: 1,
            content: 'Job #2 · Platform Engineer at Acme · Requirements\n- Kubernetes',
          },
        ]),
      ),
    });
    const user = userEvent.setup();

    await user.click(
      await screen.findByRole('button', {
        name: 'Source 2: Job #2 · Platform Engineer at Acme · Requirements',
      }),
    );

    const viewer = await screen.findByRole('complementary', { name: 'Source viewer' });
    expect(
      within(viewer).getByRole('heading', { name: 'Job #2 · Platform Engineer at Acme' }),
    ).toBeInTheDocument();
    expect(viewer).toHaveTextContent('Source [2] · Requirements');
    expect(await within(viewer).findByText(/- Kubernetes/)).toBeInTheDocument();
  });

  it('says that an analysis was generated, and not written by the user', async () => {
    setup({
      'GET /api/documents/j2/passages?ordinal=5&radius=2': jsonResponse(
        200,
        passagesOf({ id: 'j2', filename: 'Platform Engineer at Acme', kind: 'job_posting' }, 5, [
          {
            ordinal: 5,
            content:
              'Job #2 · Platform Engineer at Acme · Fit analysis · Gaps\n- Not shown: Kubernetes',
          },
        ]),
      ),
    });
    const user = userEvent.setup();

    await user.click(
      await screen.findByRole('button', {
        name: 'Source 3: Job #2 · Platform Engineer at Acme · Fit analysis',
      }),
    );

    const viewer = await screen.findByRole('complementary', { name: 'Source viewer' });
    expect(viewer).toHaveTextContent('Source [3] · Fit analysis');
    expect(viewer).toHaveTextContent(
      'This passage was generated from your resume and the job postings',
    );
    expect(await within(viewer).findByText(/Not shown: Kubernetes/)).toBeInTheDocument();
  });

  it('shows the saved text when the document is gone', async () => {
    setup({
      'GET /api/documents/r1/passages?ordinal=2&radius=2': jsonResponse(404, {
        error: { code: 'not_found', message: 'Not found' },
      }),
    });
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: 'Source 1: Resume · Skills' }));

    const viewer = await screen.findByRole('complementary', { name: 'Source viewer' });
    expect(await within(viewer).findByText(/no longer available/)).toBeInTheDocument();
    expect(viewer).toHaveTextContent('Go, Rust, Docker, PostgreSQL');
  });
});

describe('explaining an answer about a resume and a posting', () => {
  it('names which posting the question was limited to, and what the model was given', async () => {
    setup();
    const user = userEvent.setup();

    await user.click((await screen.findAllByRole('button', { name: 'Why this answer?' }))[0]!);

    const panel = await screen.findByRole('complementary', { name: 'Why this answer' });
    expect(panel).toHaveTextContent(
      'Limited to Job #2 · Platform Engineer at Acme and your resume, as your question asked.',
    );
    const given = within(panel).getByText('Passages the model was given').closest('section')!;
    expect(given).toHaveTextContent('[1] Resume · Skills');
    expect(given).toHaveTextContent('[2] Job #2 · Platform Engineer at Acme · Requirements');
    expect(given).toHaveTextContent('[3] Job #2 · Platform Engineer at Acme · Fit analysis');
  });

  it('names the closest passages of a refusal the same way', async () => {
    const declined = {
      ...retrieval,
      outcome: 'declined',
      bestScore: 0.12,
      filters: undefined,
      closest: [
        { filename: 'alex-cv.pdf', page: null, career: resumePassage.career, score: 0.12 },
        {
          filename: 'Platform Engineer at Acme',
          page: null,
          career: gapsPassage.career,
          score: 0.1,
        },
      ],
    };
    setup({
      'GET /api/chats/c9': jsonResponse(200, conversation({ sources: [], retrieval: declined })),
    });
    const user = userEvent.setup();

    await user.click((await screen.findAllByRole('button', { name: 'Why this answer?' }))[0]!);

    const panel = await screen.findByRole('complementary', { name: 'Why this answer' });
    const closest = within(panel).getByText('Closest passages (not used)').closest('section')!;
    expect(closest).toHaveTextContent('Resume · Skills');
    expect(closest).toHaveTextContent('Job #2 · Platform Engineer at Acme · Fit analysis');
    expect(closest).not.toHaveTextContent('alex-cv.pdf');
  });
});
