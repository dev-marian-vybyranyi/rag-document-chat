import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { App } from '../../App';
import { answerChunks, jsonResponse, sseResponse, stubApi } from '../../test/fetch';
import { AuthProvider } from '../auth/AuthProvider';
import type { DocumentItem } from '../documents/api';
import type { CareerOverview } from './api';

vi.mock('../documents/polling', () => ({ pollDelay: () => 15 }));

const ada = { id: 'u1', email: 'ada@example.com' };
const CHAT = {
  id: 'c9',
  title: 'New chat',
  createdAt: '2026-10-14T10:00:00Z',
  updatedAt: '2026-10-14T10:00:00Z',
};
const QUESTION = 'How does my experience align with Job #1?';
const ANSWER = 'You have Go and PostgreSQL [1]; Kubernetes is not shown [2].';

function base(overrides: Partial<DocumentItem>): DocumentItem {
  return {
    id: 'd',
    kind: 'document',
    filename: 'file',
    mimeType: 'text/plain',
    sizeBytes: 1200,
    status: 'ready',
    error: null,
    pageCount: null,
    chunkCount: 6,
    fileCount: null,
    repoUrl: null,
    repoRef: null,
    commitSha: null,
    meetingHeldOn: null,
    participants: null,
    durationMs: null,
    notes: null,
    jobNumber: null,
    profile: null,
    fit: null,
    progress: null,
    suggestions: [],
    createdAt: '2026-10-14T10:00:00Z',
    ...overrides,
  };
}

const resume = (overrides: Partial<DocumentItem> = {}) =>
  base({
    id: 'r1',
    kind: 'resume',
    filename: 'alex-cv',
    mimeType: 'application/pdf',
    ...overrides,
  });
const resumeReady = () =>
  resume({
    profile: { role: 'resume', skills: ['Go', 'PostgreSQL', 'Docker'], totalExperienceYears: 5.3 },
  });

const job = (overrides: Partial<DocumentItem> = {}) =>
  base({
    id: 'j1',
    kind: 'job_posting',
    filename: 'Backend Engineer at Globex',
    jobNumber: 1,
    ...overrides,
  });
const jobProfile = {
  role: 'job',
  title: 'Backend Engineer',
  company: 'Globex',
  requirementCount: 3,
} as const;
const jobProcessing = (phase: 'reading' | 'analyzing') =>
  job({ status: 'processing', chunkCount: 0, progress: { phase, done: 0, total: 0 } });
const jobCompared = () => job({ profile: jobProfile, fit: { coverage: 67, mustCoverage: 67 } });

const overview: CareerOverview = {
  resume: {
    id: 'r1',
    filename: 'alex-cv',
    status: 'ready',
    error: null,
    profile: { role: 'resume', skills: ['Go', 'PostgreSQL', 'Docker'], totalExperienceYears: 5.3 },
  },
  postings: [
    {
      id: 'j1',
      jobNumber: 1,
      filename: 'Backend Engineer at Globex',
      status: 'ready',
      error: null,
      profile: jobProfile,
      fit: {
        resumeId: 'r1',
        analyzedAt: '2026-10-14T10:00:00Z',
        coverage: 67,
        mustCoverage: 67,
        requirements: [
          {
            requirementId: 'r1',
            text: 'Go',
            skill: 'Go',
            importance: 'must',
            status: 'met',
            quote: 'Built Go services on Docker and PostgreSQL.',
            note: '',
          },
          {
            requirementId: 'r2',
            text: 'PostgreSQL',
            skill: 'PostgreSQL',
            importance: 'must',
            status: 'met',
            quote: 'Built Go services on Docker and PostgreSQL.',
            note: '',
          },
          {
            requirementId: 'r3',
            text: 'Kubernetes',
            skill: 'Kubernetes',
            importance: 'must',
            status: 'not_shown',
            quote: null,
            note: '',
          },
        ],
      },
    },
  ],
  compared: 1,
  gaps: [],
};

const resumeSource = {
  id: 1,
  chunkId: 'k1',
  documentId: 'r1',
  filename: 'alex-cv',
  page: null,
  career: { role: 'resume', section: 'experience', jobNumber: null },
  ordinal: 1,
  excerpt: 'Resume · Experience\nBuilt Go services on Docker and PostgreSQL.',
  score: 0.7,
};
const gapSource = {
  id: 2,
  chunkId: 'k2',
  documentId: 'j1',
  filename: 'Backend Engineer at Globex',
  page: null,
  career: { role: 'job_posting', section: 'fit', jobNumber: 1 },
  ordinal: 4,
  excerpt: 'Job #1 · Backend Engineer at Globex · Fit analysis · Gaps\n- Not shown: Kubernetes',
  score: 0.62,
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
    jobs: ['Job #1 · Backend Engineer at Globex'],
    relaxed: false,
  },
};

const server = { documents: [] as DocumentItem[] };

function setup(routes: Parameters<typeof stubApi>[0] = {}, path = '/documents') {
  const api = stubApi({
    'GET /api/auth/me': jsonResponse(200, { user: ada }),
    'GET /api/chats': jsonResponse(200, { chats: [] }),
    'GET /api/documents': () => jsonResponse(200, { documents: server.documents }),
    'GET /api/career/overview': jsonResponse(200, overview),
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

const library = async () => screen.findByRole('list', { name: 'Documents', hidden: true });
const cardOf = async (name: string) =>
  within(await library())
    .getByText(name)
    .closest('li')!;
const cv = (name = 'alex-cv.pdf') => new File(['Alex Morgan'], name, { type: 'application/pdf' });

describe('from a resume and a job posting to an answer with its sources', () => {
  it('follows the resume and the posting from the upload to the comparison, then asks and reads the source', async () => {
    server.documents = [];
    const api = setup({
      'POST /api/career/resume': () => {
        server.documents = [
          resume({
            status: 'processing',
            chunkCount: 0,
            progress: { phase: 'reading', done: 0, total: 0 },
          }),
        ];
        return jsonResponse(202, { document: server.documents[0] });
      },
      'POST /api/career/jobs': () => {
        server.documents = [resumeReady(), jobProcessing('reading')];
        return jsonResponse(202, { document: server.documents[1] });
      },
      'POST /api/chats': jsonResponse(201, { chat: CHAT }),
      'GET /api/chats/c9': jsonResponse(200, { chat: CHAT, messages: [] }),
      'POST /api/chats/c9/messages': () =>
        sseResponse(answerChunks([ANSWER], [resumeSource, gapSource], retrieval)),
      'GET /api/documents/r1/passages?ordinal=1&radius=2': jsonResponse(200, {
        document: {
          id: 'r1',
          filename: 'alex-cv',
          pageCount: null,
          kind: 'resume',
          repoUrl: null,
          commitSha: null,
        },
        target: 1,
        passages: [
          {
            ordinal: 0,
            page: null,
            content: 'Resume · Summary\nBackend engineer with five years.',
          },
          {
            ordinal: 1,
            page: null,
            content: 'Resume · Experience\nBuilt Go services on Docker and PostgreSQL.',
          },
        ],
      }),
    });
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: 'Add a resume' }));
    await user.upload(await screen.findByLabelText('File with the resume'), cv());
    await user.click(screen.getByRole('button', { name: 'Add resume' }));

    const resumeCard = await cardOf('Resume');
    await waitFor(() => expect(resumeCard).toHaveTextContent('Reading the file…'));
    server.documents = [
      resume({
        status: 'processing',
        chunkCount: 0,
        progress: { phase: 'analyzing', done: 0, total: 0 },
      }),
    ];
    await waitFor(() => expect(resumeCard).toHaveTextContent('Analysing the resume…'));
    server.documents = [resumeReady()];
    await waitFor(() =>
      expect(resumeCard).toHaveTextContent('6 passages · 5.3 years of experience · 3 skills'),
    );
    expect(
      within(resumeCard).getByRole('list', { name: 'Skills in the resume' }),
    ).toHaveTextContent('GoPostgreSQLDocker');
    expect(screen.getByRole('button', { name: 'Add a resume' })).toBeDisabled();

    await user.click(screen.getByRole('button', { name: 'Add a job posting' }));
    await user.click(await screen.findByRole('radio', { name: 'Paste text' }));
    fireEvent.change(screen.getByLabelText('Text of the job posting'), {
      target: { value: 'Backend Engineer\nRequirements\n- Go\n- PostgreSQL\n- Kubernetes' },
    });
    await user.type(screen.getByLabelText('Job title (optional)'), 'Backend Engineer');
    await user.type(screen.getByLabelText('Company (optional)'), 'Globex');
    await user.click(screen.getByRole('button', { name: 'Add job posting' }));

    const form = api.calls.find((c) => c.route === 'POST /api/career/jobs')?.form;
    expect(form?.get('title')).toBe('Backend Engineer');
    expect(form?.get('company')).toBe('Globex');
    expect((form?.get('file') as File).name).toBe('Job posting.txt');
    const jobCard = await cardOf('Job #1 · Backend Engineer at Globex');
    await waitFor(() => expect(jobCard).toHaveTextContent('Reading the file…'));
    server.documents = [resumeReady(), jobProcessing('analyzing')];
    await waitFor(() => expect(jobCard).toHaveTextContent('Analysing the job posting…'));
    server.documents = [resumeReady(), job({ profile: jobProfile })];
    await waitFor(() => expect(jobCard).toHaveTextContent('Comparing with your resume…'));
    expect(jobCard).toHaveTextContent('6 passages · 3 requirements');
    server.documents = [resumeReady(), jobCompared()];
    const meter = await within(jobCard).findByRole('meter');
    expect(meter).toHaveAttribute('aria-valuenow', '67');
    expect(jobCard).toHaveTextContent(
      '67% of the requirements shown in the resume · 67% of the must-haves',
    );
    expect(jobCard).not.toHaveTextContent('Comparing');

    await user.click(screen.getByRole('link', { name: 'Career' }));
    const board = within(await screen.findByRole('region', { name: 'Job postings' }));
    expect(board.getByRole('button', { name: /Job #1/ })).toHaveTextContent('67%');
    const details = within(screen.getByRole('region', { name: /Details of Job #1/ }));
    expect(
      details
        .getAllByRole('row')
        .slice(1)
        .map((r) => r.textContent),
    ).toEqual([
      'KubernetesMust haveNot shown in the resume',
      'GoMust haveShownBuilt Go services on Docker and PostgreSQL.',
      'PostgreSQLMust haveShownBuilt Go services on Docker and PostgreSQL.',
    ]);

    await user.click(details.getByRole('button', { name: 'Ask about this job' }));

    expect(await screen.findByText(/You have Go and PostgreSQL/)).toBeInTheDocument();
    expect(api.calls.find((c) => c.route === 'POST /api/chats')?.body).toEqual({
      sourceIds: ['r1', 'j1'],
    });
    expect(api.calls.find((c) => c.route === 'POST /api/chats/c9/messages')?.body).toEqual({
      content: QUESTION,
    });
    const citation = await screen.findByRole('button', { name: 'Source 1: Resume · Experience' });
    expect(
      screen.getByRole('button', {
        name: /\[2\] Job #1 · Backend Engineer at Globex · Fit analysis/,
      }),
    ).toBeInTheDocument();

    await user.click(citation);
    const viewer = await screen.findByRole('complementary', { name: 'Source viewer' });
    expect(within(viewer).getByRole('heading', { name: 'Resume' })).toBeInTheDocument();
    const cited = (await within(viewer).findAllByRole('listitem')).find(
      (row) => row.getAttribute('aria-current') === 'true',
    )!;
    expect(cited).toHaveTextContent('Built Go services on Docker and PostgreSQL.');
    await user.click(within(viewer).getByRole('button', { name: /Close/ }));
    expect(citation).toHaveFocus();
  });

  it('compares a posting that came first once the resume arrives', async () => {
    server.documents = [job({ profile: jobProfile })];
    setup({
      'POST /api/career/resume': () => {
        server.documents = [
          job({ profile: jobProfile }),
          resume({
            status: 'processing',
            chunkCount: 0,
            progress: { phase: 'reading', done: 0, total: 0 },
          }),
        ];
        return jsonResponse(202, { document: server.documents[1] });
      },
    });
    const user = userEvent.setup();
    const jobCard = await cardOf('Job #1 · Backend Engineer at Globex');
    expect(jobCard).toHaveTextContent('Add your resume to see how well it fits this posting.');

    await user.click(screen.getByRole('button', { name: 'Add a resume' }));
    await user.upload(await screen.findByLabelText('File with the resume'), cv());
    await user.click(screen.getByRole('button', { name: 'Add resume' }));
    await waitFor(() =>
      expect(jobCard).toHaveTextContent('Waiting for your resume to be indexed…'),
    );
    server.documents = [job({ profile: jobProfile }), resumeReady()];
    await waitFor(() => expect(jobCard).toHaveTextContent('Comparing with your resume…'));
    server.documents = [jobCompared(), resumeReady()];

    expect(await within(jobCard).findByRole('meter')).toHaveAttribute('aria-valuenow', '67');
  });

  it('offers to analyse a resume that could not be analysed, and shows what it finds', async () => {
    server.documents = [resume({ profile: null })];
    setup({
      'POST /api/career/r1/analysis': () => {
        server.documents = [resumeReady()];
        return jsonResponse(200, { document: resumeReady() });
      },
    });
    const user = userEvent.setup();
    const card = await cardOf('Resume');
    expect(card).toHaveTextContent('Not analysed yet');

    await user.click(within(card).getByRole('button', { name: 'Analyze Resume' }));

    expect(
      await within(card).findByRole('list', { name: 'Skills in the resume' }),
    ).toHaveTextContent('Go');
    expect(card).toHaveTextContent('5.3 years of experience');
  });

  it('says why a second resume cannot be added, and allows one once the first is deleted', async () => {
    server.documents = [resumeReady()];
    const api = setup({
      'DELETE /api/documents/r1': () => {
        server.documents = [];
        return jsonResponse(204);
      },
      'POST /api/career/resume': () =>
        jsonResponse(202, { document: resume({ id: 'r2', status: 'processing', chunkCount: 0 }) }),
    });
    const user = userEvent.setup();
    const add = await screen.findByRole('button', { name: 'Add a resume' });
    await waitFor(() => expect(add).toBeDisabled());
    expect(add).toHaveAttribute('title', 'Delete your resume to add a different one');

    await user.click(screen.getByRole('button', { name: 'Delete Resume' }));
    await user.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(add).toBeEnabled());
    await user.click(add);
    await user.upload(await screen.findByLabelText('File with the resume'), cv('new-cv.pdf'));
    await user.click(screen.getByRole('button', { name: 'Add resume' }));

    await waitFor(() =>
      expect(
        (api.calls.find((c) => c.route === 'POST /api/career/resume')?.form?.get('file') as File)
          .name,
      ).toBe('new-cv.pdf'),
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });
});
