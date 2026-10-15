import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { App } from '../App';
import { MAX_OVERVIEW_POLLS } from '../features/career/useCareerOverview';
import type { CareerOverview, Fit, FitRequirement, Posting } from '../features/career/api';
import { AuthProvider } from '../features/auth/AuthProvider';
import { answerChunks, deferredResponse, jsonResponse, sseResponse, stubApi } from '../test/fetch';

vi.mock('../features/documents/polling', () => ({ pollDelay: () => 10 }));

const ada = { id: 'u1', email: 'ada@example.com' };
const chat = {
  id: 'c9',
  title: 'New chat',
  createdAt: '2026-10-14T10:00:00Z',
  updatedAt: '2026-10-14T10:00:00Z',
  sourceIds: null,
};

const requirement = (
  id: string,
  text: string,
  status: FitRequirement['status'],
  importance: FitRequirement['importance'] = 'must',
  quote: string | null = null,
  note = '',
): FitRequirement => ({ requirementId: id, text, skill: text, importance, status, quote, note });

const fit = (
  coverage: number,
  mustCoverage: number | null,
  requirements: FitRequirement[],
): Fit => ({
  resumeId: 'r1',
  analyzedAt: '2026-10-14T10:00:00Z',
  requirements,
  coverage,
  mustCoverage,
});

function posting(jobNumber: number, filename: string, overrides: Partial<Posting> = {}): Posting {
  return {
    id: `j${jobNumber}`,
    jobNumber,
    filename,
    status: 'ready',
    error: null,
    profile: { role: 'job', title: filename, company: null, requirementCount: 3 },
    fit: null,
    ...overrides,
  };
}

const backend = posting(1, 'Backend Engineer at Globex', {
  fit: fit(67, 67, [
    requirement('r1', 'Go', 'met', 'must', 'Built Go services on Docker.'),
    requirement('r2', 'PostgreSQL', 'met', 'must', 'PostgreSQL for billing.'),
    requirement('r3', 'Kubernetes', 'not_shown', 'must'),
  ]),
});
const platform = posting(2, 'Platform Engineer at Acme', {
  fit: fit(50, 50, [
    requirement('r1', 'Docker', 'met', 'must', 'Built Go services on Docker.'),
    requirement('r2', 'Terraform', 'not_shown', 'nice'),
    requirement('r3', 'Kubernetes', 'not_shown', 'must'),
    requirement('r4', 'Helm', 'partial', 'nice', 'Used Helm charts once.', 'Only a short mention.'),
  ]),
});
const frontend = posting(3, 'Frontend Engineer at Hooli', {
  fit: fit(0, 0, [requirement('r1', 'React', 'not_shown', 'must')]),
});

const overview = (overrides: Partial<CareerOverview> = {}): CareerOverview => ({
  resume: {
    id: 'r1',
    filename: 'cv',
    status: 'ready',
    error: null,
    profile: { role: 'resume', skills: ['Go', 'Rust', 'Docker'], totalExperienceYears: 5.3 },
  },
  postings: [backend, platform, frontend],
  compared: 3,
  gaps: [
    { label: 'Kubernetes', postings: 2, musts: 2 },
    { label: 'React', postings: 1, musts: 1 },
  ],
  ...overrides,
});

type Routes = Parameters<typeof stubApi>[0];

function setup(routes: Routes = {}, path = '/career') {
  const api = stubApi({
    'GET /api/auth/me': jsonResponse(200, { user: ada }),
    'GET /api/chats': jsonResponse(200, { chats: [] }),
    'GET /api/career/overview': jsonResponse(200, overview()),
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

const board = async () => within(await screen.findByRole('region', { name: 'Job postings' }));
const detail = (title: string) =>
  within(screen.getByRole('region', { name: `Details of ${title}` }));
const overviewCalls = (api: ReturnType<typeof setup>) =>
  api.calls.filter((c) => c.route === 'GET /api/career/overview').length;

describe('the Career page', () => {
  describe('getting there', () => {
    it('is in the navigation next to Documents', async () => {
      setup({ 'GET /api/documents': jsonResponse(200, { documents: [] }) }, '/documents');
      const user = userEvent.setup();

      await user.click(await screen.findByRole('link', { name: 'Career' }));

      expect(await screen.findByRole('heading', { name: 'Career' })).toBeInTheDocument();
    });
  });

  describe('loading', () => {
    it('shows that it is loading, then the page', async () => {
      const pending = deferredResponse();
      setup({ 'GET /api/career/overview': pending.handler });

      expect(await screen.findByText('Loading your career overview…')).toBeInTheDocument();
      pending.release(jsonResponse(200, overview()));

      expect(await screen.findByRole('region', { name: 'Your resume' })).toBeInTheDocument();
      expect(screen.queryByText('Loading your career overview…')).not.toBeInTheDocument();
    });

    it('says when it cannot load and tries again on request', async () => {
      let calls = 0;
      setup({
        'GET /api/career/overview': () => {
          calls++;
          return calls === 1 ? jsonResponse(500, {}) : jsonResponse(200, overview());
        },
      });
      const user = userEvent.setup();

      expect(await screen.findByRole('alert')).toHaveTextContent(
        'Could not load your career overview.',
      );
      await user.click(screen.getByRole('button', { name: 'Try again' }));

      expect(await screen.findByRole('region', { name: 'Your resume' })).toBeInTheDocument();
    });
  });

  describe('the resume', () => {
    it('shows the years and the skills', async () => {
      setup();

      const panel = within(await screen.findByRole('region', { name: 'Your resume' }));

      expect(panel.getByText('5.3 years of experience')).toBeInTheDocument();
      expect(
        within(panel.getByRole('list', { name: 'Skills in the resume' }))
          .getAllByRole('listitem')
          .map((item) => item.textContent),
      ).toEqual(['Go', 'Rust', 'Docker']);
    });

    it('invites the user to add one when there is none', async () => {
      setup({ 'GET /api/career/overview': jsonResponse(200, overview({ resume: null })) });

      const panel = within(await screen.findByRole('region', { name: 'Your resume' }));

      expect(panel.getByText('No resume yet')).toBeInTheDocument();
      expect(panel.getByRole('link', { name: 'Add your resume' })).toHaveAttribute(
        'href',
        '/documents',
      );
    });

    it.each([
      ['being processed', { status: 'processing' as const }, 'Being processed…'],
      ['failed', { status: 'failed' as const, error: 'No text found.' }, 'No text found.'],
      ['not analysed', { profile: null }, 'Not analysed yet.'],
      [
        'without years',
        { profile: { role: 'resume' as const, skills: [], totalExperienceYears: null } },
        'Years of experience not stated.',
      ],
    ])('says so when it is %s', async (_label, patch, text) => {
      const base = overview().resume!;
      setup({
        'GET /api/career/overview': jsonResponse(
          200,
          overview({ resume: { ...base, ...patch }, postings: [] }),
        ),
      });

      const panel = within(await screen.findByRole('region', { name: 'Your resume' }));

      expect(panel.getByText(text)).toBeInTheDocument();
    });
  });

  describe('the layout', () => {
    it('puts the details beside the board by the width of the page, not of the screen, because the sidebar takes room', async () => {
      setup();

      const columns = (await screen.findByRole('region', { name: 'Job postings' })).parentElement!;

      expect(columns.className).toContain('@3xl:grid-cols-');
      expect(columns.className).not.toMatch(/(^|\s)(sm|md|lg|xl):grid-cols-/);
      expect(columns.parentElement).toHaveClass('@container');
    });
  });

  describe('the board of postings', () => {
    it('lists the postings with the best fit first, and says the rank and the share', async () => {
      const strong = posting(3, 'Frontend Engineer at Hooli', {
        fit: fit(90, 100, [requirement('r1', 'React', 'met', 'must', 'React for four years.')]),
      });
      setup({
        'GET /api/career/overview': jsonResponse(
          200,
          overview({ postings: [platform, backend, strong] }),
        ),
      });

      const postings = await board();

      const rows = postings.getAllByRole('button', { name: /Job #/ });
      expect(rows.map((row) => row.textContent)).toEqual([
        expect.stringContaining('#1Job #3 · Frontend Engineer at Hooli90%'),
        expect.stringContaining('#2Job #1 · Backend Engineer at Globex67%'),
        expect.stringContaining('#3Job #2 · Platform Engineer at Acme50%'),
      ]);
      expect(rows[1]).toHaveTextContent('67% of the must-haves');
      expect(
        postings.getByRole('meter', { name: 'Fit with Job #2 · Platform Engineer at Acme' }),
      ).toHaveAttribute('aria-valuenow', '50');
      expect(screen.getByRole('region', { name: /^Details of Job #3/ })).toBeInTheDocument();
    });

    it('can be sorted by the number of the posting instead', async () => {
      const strong = posting(3, 'Frontend Engineer at Hooli', {
        fit: fit(90, 100, [requirement('r1', 'React', 'met', 'must', 'React for four years.')]),
      });
      setup({
        'GET /api/career/overview': jsonResponse(
          200,
          overview({ postings: [strong, backend, platform] }),
        ),
      });
      const user = userEvent.setup();
      const postings = await board();

      await user.click(postings.getByRole('radio', { name: 'Job number' }));
      expect(postings.getByRole('radio', { name: 'Job number' })).toBeChecked();
      expect(postings.getByRole('radio', { name: 'Best fit' })).not.toBeChecked();

      const numbered = postings.getAllByRole('button', { name: /Job #/ });
      expect(numbered.map((row) => row.textContent)).toEqual([
        expect.stringContaining('Job #1'),
        expect.stringContaining('Job #2'),
        expect.stringContaining('Job #3'),
      ]);
      await user.click(postings.getByRole('radio', { name: 'Best fit' }));
      expect(postings.getAllByRole('button', { name: /Job #/ })[0]).toHaveTextContent('Job #3');
    });

    it('puts a posting that was not compared last, and says why', async () => {
      const waiting = posting(4, 'Designer', { profile: null });
      setup({
        'GET /api/career/overview': jsonResponse(
          200,
          overview({ postings: [waiting, backend], compared: 1, gaps: [] }),
        ),
      });

      const postings = await board();

      const rows = postings.getAllByRole('button', { name: /Job #/ });
      expect(rows[1]).toHaveTextContent('Job #4 · Designer');
      expect(rows[1]).toHaveTextContent('Not analysed yet.');
      expect(rows[1]).not.toHaveTextContent('#2');
      expect(postings.getAllByRole('meter')).toHaveLength(1);
    });

    it.each([
      [
        'is being processed',
        { status: 'processing' as const, profile: null },
        undefined,
        'Being processed…',
      ],
      [
        'failed',
        { status: 'failed' as const, error: 'Could not read it.', profile: null },
        undefined,
        'Could not read it.',
      ],
      [
        'has no requirements',
        { profile: { role: 'job' as const, title: null, company: null, requirementCount: 0 } },
        undefined,
        'No requirements were found.',
      ],
      ['waits for the resume', {}, 'processing', 'Waiting for your resume…'],
      ['has no resume to be compared with', {}, 'none', 'Add your resume to compare.'],
      ['has a resume that failed', {}, 'failed', 'Add your resume to compare.'],
    ])('says so for a posting that %s', async (_label, patch, resumeState, text) => {
      const base = overview();
      const resume =
        resumeState === 'none'
          ? null
          : resumeState === 'processing'
            ? { ...base.resume!, status: 'processing' as const }
            : resumeState === 'failed'
              ? { ...base.resume!, status: 'failed' as const }
              : base.resume;
      setup({
        'GET /api/career/overview': jsonResponse(
          200,
          overview({ resume, postings: [posting(5, 'Role', patch)], compared: 0, gaps: [] }),
        ),
      });

      const postings = await board();

      expect(postings.getByRole('button', { name: /Job #5/ })).toHaveTextContent(text);
    });
  });

  describe('the details of a posting', () => {
    it('opens the best fit first, with the share and what each requirement shows', async () => {
      setup();
      await board();

      const panel = detail('Job #1 · Backend Engineer at Globex');

      expect(
        panel.getByText('67% of the requirements shown in the resume · 67% of the must-haves'),
      ).toBeInTheDocument();
      const rows = panel.getAllByRole('row').slice(1);
      expect(rows.map((row) => row.textContent)).toEqual([
        'KubernetesMust haveNot shown in the resume',
        'GoMust haveShownBuilt Go services on Docker.',
        'PostgreSQLMust haveShownPostgreSQL for billing.',
      ]);
    });

    it('lets a wide table of requirements be scrolled with the keyboard', async () => {
      setup();
      await board();

      const region = screen.getByRole('region', {
        name: 'Requirements of Job #1 · Backend Engineer at Globex',
      });

      expect(region).toHaveAttribute('tabindex', '0');
      expect(within(region).getByRole('table')).toBeInTheDocument();
    });

    it('shows another posting when it is chosen, with the quote and the note', async () => {
      setup();
      const user = userEvent.setup();
      const postings = await board();

      await user.click(postings.getByRole('button', { name: /Job #2/ }));

      const panel = detail('Job #2 · Platform Engineer at Acme');
      expect(postings.getByRole('button', { name: /Job #2/ })).toHaveAttribute(
        'aria-pressed',
        'true',
      );
      expect(postings.getByRole('button', { name: /Job #1/ })).toHaveAttribute(
        'aria-pressed',
        'false',
      );
      const rows = panel.getAllByRole('row').slice(1);
      expect(rows.map((row) => row.textContent)).toEqual([
        'KubernetesMust haveNot shown in the resume',
        'TerraformNice to haveNot shown in the resume',
        'HelmNice to havePartly shownUsed Helm charts once.Only a short mention.',
        'DockerMust haveShownBuilt Go services on Docker.',
      ]);
      expect(panel.queryByText('Details of Job #1')).not.toBeInTheDocument();
    });

    it('says that not shown does not mean the candidate lacks the skill', async () => {
      setup();
      await board();

      expect(
        detail('Job #1 · Backend Engineer at Globex').getByText(
          /does not mention it\. You may have the skill/,
        ),
      ).toBeInTheDocument();
    });

    it('labels the table for those who cannot see it', async () => {
      setup();
      await board();

      const table = detail('Job #1 · Backend Engineer at Globex').getByRole('table', {
        name: 'Requirements of Job #1 · Backend Engineer at Globex and what the resume shows',
      });

      expect(
        within(table)
          .getAllByRole('columnheader')
          .map((h) => h.textContent),
      ).toEqual(['Requirement', 'Importance', 'In the resume']);
    });

    it('says there is no comparison for a posting that has none', async () => {
      setup({
        'GET /api/career/overview': jsonResponse(
          200,
          overview({
            postings: [posting(4, 'Designer', { profile: null })],
            compared: 0,
            gaps: [],
          }),
        ),
      });
      await board();

      const panel = detail('Job #4 · Designer');

      expect(panel.getByText('There is no comparison with your resume yet.')).toBeInTheDocument();
      expect(panel.queryByRole('table')).not.toBeInTheDocument();
    });
  });

  describe('the gaps across postings', () => {
    it('lists what is missing in several postings', async () => {
      setup();

      const gaps = within(await screen.findByRole('region', { name: 'Gaps across postings' }));

      expect(gaps.getAllByRole('listitem').map((item) => item.textContent)).toEqual([
        'Kubernetes: not fully shown in 2 of 3 postings (a must in 2)',
        'React: not fully shown in 1 of 3 postings (a must in 1)',
      ]);
    });

    it('is shown when two postings were compared', async () => {
      setup({
        'GET /api/career/overview': jsonResponse(
          200,
          overview({
            postings: [backend, platform],
            compared: 2,
            gaps: [{ label: 'Kubernetes', postings: 2, musts: 2 }],
          }),
        ),
      });

      const gaps = within(await screen.findByRole('region', { name: 'Gaps across postings' }));

      expect(
        gaps.getByText('Kubernetes: not fully shown in 2 of 2 postings (a must in 2)'),
      ).toBeInTheDocument();
    });

    it('is left out when only one posting was compared, or nothing is missing', async () => {
      setup({
        'GET /api/career/overview': jsonResponse(
          200,
          overview({ postings: [backend], compared: 1 }),
        ),
      });
      await board();

      expect(
        screen.queryByRole('region', { name: 'Gaps across postings' }),
      ).not.toBeInTheDocument();
    });
  });

  describe('without postings', () => {
    it('invites the user to add some', async () => {
      setup({
        'GET /api/career/overview': jsonResponse(
          200,
          overview({ postings: [], compared: 0, gaps: [] }),
        ),
      });

      expect(await screen.findByText(/No job postings yet\./)).toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'Add some' })).toHaveAttribute('href', '/documents');
      expect(screen.queryByRole('region', { name: 'Job postings' })).not.toBeInTheDocument();
    });
  });

  describe('asking about a posting', () => {
    it('starts a chat limited to the resume and that posting, with the question asked', async () => {
      const api = setup({
        'POST /api/chats': jsonResponse(201, { chat }),
        'GET /api/chats/c9': jsonResponse(200, { chat, messages: [] }),
        'POST /api/chats/c9/messages': () => sseResponse(answerChunks(['It fits well'])),
      });
      const user = userEvent.setup();
      const postings = await board();
      await user.click(postings.getByRole('button', { name: /Job #2/ }));

      await user.click(
        within(screen.getByRole('region', { name: /Details of Job #2/ })).getByRole('button', {
          name: 'Ask about this job',
        }),
      );

      expect(await screen.findByText('It fits well')).toBeInTheDocument();
      expect(api.calls.find((c) => c.route === 'POST /api/chats')?.body).toEqual({
        sourceIds: ['r1', 'j2'],
      });
      expect(api.calls.find((c) => c.route === 'POST /api/chats/c9/messages')?.body).toEqual({
        content: 'How does my experience align with Job #2?',
      });
    });

    it('limits the chat to the posting alone when there is no resume', async () => {
      const api = setup({
        'GET /api/career/overview': jsonResponse(
          200,
          overview({ resume: null, postings: [posting(2, 'Role')], compared: 0, gaps: [] }),
        ),
        'POST /api/chats': jsonResponse(201, { chat }),
        'GET /api/chats/c9': jsonResponse(200, { chat, messages: [] }),
        'POST /api/chats/c9/messages': () => sseResponse(answerChunks(['Fine'])),
      });
      const user = userEvent.setup();
      await board();

      await user.click(screen.getByRole('button', { name: 'Ask about this job' }));

      await screen.findByText('Fine');
      expect(api.calls.find((c) => c.route === 'POST /api/chats')?.body).toEqual({
        sourceIds: ['j2'],
      });
    });

    it('says so when the chat cannot be started', async () => {
      setup({
        'POST /api/chats': jsonResponse(500, { error: { code: 'internal_error', message: 'x' } }),
      });
      const user = userEvent.setup();
      await board();

      await user.click(screen.getByRole('button', { name: 'Ask about this job' }));

      expect(await screen.findByRole('alert')).toHaveTextContent('Could not start a chat');
    });

    it('is not offered while the posting is still being processed', async () => {
      setup({
        'GET /api/career/overview': jsonResponse(
          200,
          overview({
            postings: [posting(2, 'Role', { status: 'processing', profile: null })],
            compared: 0,
            gaps: [],
          }),
        ),
      });
      await board();

      expect(screen.getByRole('button', { name: 'Ask about this job' })).toBeDisabled();
    });
  });

  describe('while the analysis is still going on', () => {
    it('keeps asking, and shows the fit when it arrives', async () => {
      let calls = 0;
      const api = setup({
        'GET /api/career/overview': () => {
          calls++;
          return jsonResponse(
            200,
            overview({
              postings: [calls >= 4 ? backend : posting(1, 'Backend Engineer at Globex')],
              compared: calls >= 4 ? 1 : 0,
              gaps: [],
            }),
          );
        },
      });

      const postings = await board();
      expect(postings.getByRole('button', { name: /Job #1/ })).toHaveTextContent(
        'Comparing with your resume…',
      );

      await waitFor(() => expect(postings.getByRole('meter')).toBeInTheDocument());
      const settled = overviewCalls(api);
      await new Promise((resolve) => setTimeout(resolve, 80));
      expect(overviewCalls(api)).toBe(settled);
    });

    it('gives up after a while, stops asking and says it was not compared', async () => {
      const api = setup({
        'GET /api/career/overview': jsonResponse(
          200,
          overview({ postings: [posting(1, 'Role')], compared: 0, gaps: [] }),
        ),
      });

      const postings = await board();
      await waitFor(
        () =>
          expect(postings.getByRole('button', { name: /Job #1/ })).toHaveTextContent(
            'Not compared yet.',
          ),
        { timeout: 3000 },
      );

      expect(overviewCalls(api)).toBe(1 + MAX_OVERVIEW_POLLS);
      await new Promise((resolve) => setTimeout(resolve, 80));
      expect(overviewCalls(api)).toBe(1 + MAX_OVERVIEW_POLLS);
    });

    it('does not ask again when nothing is going on', async () => {
      const api = setup();
      await board();

      await new Promise((resolve) => setTimeout(resolve, 80));

      expect(overviewCalls(api)).toBe(1);
    });
  });
});
