import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { App } from '../../App';
import { deferredResponse, jsonResponse, stubApi } from '../../test/fetch';
import { AuthProvider } from '../auth/AuthProvider';
import type { DocumentItem } from './api';
import { MAX_FIT_POLLS } from './DocumentsProvider';

vi.mock('./polling', () => ({ pollDelay: () => 10 }));

const ada = { id: 'u1', email: 'ada@example.com' };

function base(overrides: Partial<DocumentItem>): DocumentItem {
  return {
    id: 'd1',
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
    profile: {
      role: 'resume',
      skills: ['Go', 'Rust', 'Docker'],
      totalExperienceYears: 5.3,
    },
    ...overrides,
  });

const job = (overrides: Partial<DocumentItem> = {}) =>
  base({
    id: 'j2',
    kind: 'job_posting',
    filename: 'Platform Engineer at Acme',
    jobNumber: 2,
    profile: { role: 'job', title: 'Platform Engineer', company: 'Acme', requirementCount: 4 },
    fit: { coverage: 72, mustCoverage: 80 },
    ...overrides,
  });

type Routes = Parameters<typeof stubApi>[0];

function setup(documents: DocumentItem[], routes: Routes = {}) {
  const api = stubApi({
    'GET /api/auth/me': jsonResponse(200, { user: ada }),
    'GET /api/chats': jsonResponse(200, { chats: [] }),
    'GET /api/documents': jsonResponse(200, { documents }),
    ...routes,
  });
  render(
    <MemoryRouter initialEntries={['/documents']}>
      <AuthProvider>
        <App />
      </AuthProvider>
    </MemoryRouter>,
  );
  return api;
}

const card = async (name: string) =>
  within(await screen.findByRole('list', { name: 'Documents', hidden: true }))
    .getByText(name)
    .closest('li')!;

const listCalls = (api: ReturnType<typeof setup>) =>
  api.calls.filter((c) => c.route === 'GET /api/documents').length;

describe('the card of a resume', () => {
  it('is called Resume and tells the years, the number of skills and shows the skills', async () => {
    setup([resume()]);

    const li = await card('Resume');

    expect(li).toHaveTextContent('6 passages · 5.3 years of experience · 3 skills');
    expect(li).not.toHaveTextContent('alex-cv');
    expect(li).not.toHaveTextContent('KB');
    const skills = within(li).getByRole('list', { name: 'Skills in the resume' });
    expect(
      within(skills)
        .getAllByRole('listitem')
        .map((s) => s.textContent),
    ).toEqual(['Go', 'Rust', 'Docker']);
  });

  it('shows only the first skills of a long list and counts the others', async () => {
    const skills = Array.from({ length: 12 }, (_, i) => `Skill${i}`);
    setup([resume({ profile: { role: 'resume', skills, totalExperienceYears: null } })]);

    const li = await card('Resume');

    const list = within(li).getByRole('list', { name: 'Skills in the resume' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(9);
    expect(list).toHaveTextContent('+4 more');
    expect(list).not.toHaveTextContent('Skill8');
  });

  it('says so when no skills were found', async () => {
    setup([resume({ profile: { role: 'resume', skills: [], totalExperienceYears: null } })]);

    const li = await card('Resume');

    expect(li).toHaveTextContent('No skills were found in the resume.');
    expect(within(li).queryByRole('list')).not.toBeInTheDocument();
  });

  it('shows the progress while it is processed, with a bar and no skills', async () => {
    setup([
      resume({
        status: 'processing',
        chunkCount: 0,
        profile: null,
        progress: { phase: 'analyzing', done: 0, total: 0 },
      }),
    ]);

    const li = await card('Resume');

    expect(li).toHaveTextContent('Analysing the resume…');
    expect(within(li).getByRole('progressbar', { name: 'Processing Resume' })).toBeInTheDocument();
    expect(within(li).queryByRole('button', { name: /Analyze/ })).not.toBeInTheDocument();
  });

  it('shows why it failed', async () => {
    setup([resume({ status: 'failed', error: 'The PDF has no text we can read.', profile: null })]);

    const li = await card('Resume');

    expect(li).toHaveTextContent('Failed');
    expect(li).toHaveTextContent('The PDF has no text we can read.');
    expect(within(li).queryByRole('button', { name: /Analyze/ })).not.toBeInTheDocument();
  });

  describe('when it could not be analysed', () => {
    it('says so and offers to analyse it, then shows what the analysis found', async () => {
      const api = setup([resume({ profile: null })], {
        'POST /api/career/r1/analysis': jsonResponse(200, { document: resume() }),
      });
      const user = userEvent.setup();
      const li = await card('Resume');
      expect(li).toHaveTextContent('Not analysed yet');

      await user.click(within(li).getByRole('button', { name: 'Analyze Resume' }));

      expect(await within(li).findByRole('list', { name: 'Skills in the resume' })).toBeVisible();
      expect(api.calls.filter((c) => c.route === 'POST /api/career/r1/analysis')).toHaveLength(1);
      expect(li).not.toHaveTextContent('Not analysed yet');
    });

    it('shows that it is working and blocks a second click', async () => {
      const pending = deferredResponse();
      setup([resume({ profile: null })], { 'POST /api/career/r1/analysis': pending.handler });
      const user = userEvent.setup();
      const li = await card('Resume');

      await user.click(within(li).getByRole('button', { name: 'Analyze Resume' }));

      await waitFor(() =>
        expect(within(li).getByRole('button', { name: 'Analyze Resume' })).toBeDisabled(),
      );
      pending.release(jsonResponse(200, { document: resume() }));
      await within(li).findByRole('list', { name: 'Skills in the resume' });
    });

    it('says what the server says when the analysis cannot be made now', async () => {
      setup([resume({ profile: null })], {
        'POST /api/career/r1/analysis': jsonResponse(503, {
          error: {
            code: 'ai_busy',
            message: 'The analysis could not be made right now. Try again in a minute.',
          },
        }),
      });
      const user = userEvent.setup();
      const li = await card('Resume');

      await user.click(within(li).getByRole('button', { name: 'Analyze Resume' }));

      expect(await within(li).findByRole('alert')).toHaveTextContent('Try again in a minute');
      expect(within(li).getByRole('button', { name: 'Analyze Resume' })).toBeEnabled();
    });
  });

  it('can be deleted by its new name', async () => {
    setup([resume()], { 'DELETE /api/documents/r1': jsonResponse(204) });
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: 'Delete Resume' }));
    await user.click(screen.getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(screen.queryByText('Resume')).not.toBeInTheDocument());
  });
});

describe('the card of a job posting', () => {
  it('is numbered like the questions about it, and counts the requirements', async () => {
    setup([job()]);

    const li = await card('Job #2 · Platform Engineer at Acme');

    expect(li).toHaveTextContent('6 passages · 4 requirements');
    expect(li).not.toHaveTextContent('KB');
  });

  it('shows how much of it the resume covers, as a meter and in words', async () => {
    setup([resume(), job()]);

    const li = await card('Job #2 · Platform Engineer at Acme');

    const meter = within(li).getByRole('meter', {
      name: 'Fit with Job #2 · Platform Engineer at Acme',
    });
    expect(meter).toHaveAttribute('aria-valuenow', '72');
    expect(meter.firstElementChild).toHaveStyle({ width: '72%' });
    expect(meter).toHaveAttribute(
      'aria-valuetext',
      '72% of the requirements shown in the resume · 80% of the must-haves',
    );
    expect(li).toHaveTextContent(
      '72% of the requirements shown in the resume · 80% of the must-haves',
    );
  });

  it('leaves out the must-haves when there are none', async () => {
    setup([resume(), job({ fit: { coverage: 40, mustCoverage: null } })]);

    const li = await card('Job #2 · Platform Engineer at Acme');

    expect(li).toHaveTextContent('40% of the requirements shown in the resume');
    expect(li).not.toHaveTextContent('must-haves');
  });

  it('shows 0% as a fit like any other', async () => {
    setup([resume(), job({ fit: { coverage: 0, mustCoverage: 0 } })]);

    const li = await card('Job #2 · Platform Engineer at Acme');

    expect(within(li).getByRole('meter')).toHaveAttribute('aria-valuenow', '0');
  });

  it('shows the progress while it is processed', async () => {
    setup([
      job({
        status: 'processing',
        chunkCount: 0,
        profile: null,
        fit: null,
        progress: { phase: 'embedding', done: 2, total: 5 },
      }),
    ]);

    const li = await card('Job #2 · Platform Engineer at Acme');

    expect(li).toHaveTextContent('Indexing: 2 of 5 passages');
    expect(within(li).queryByRole('meter')).not.toBeInTheDocument();
  });

  describe('without a resume', () => {
    it('says to add one', async () => {
      setup([job({ fit: null })]);

      const li = await card('Job #2 · Platform Engineer at Acme');

      expect(li).toHaveTextContent('Add your resume to see how well it fits this posting.');
      expect(within(li).queryByRole('button', { name: /Compare/ })).not.toBeInTheDocument();
    });

    it('says to wait while the resume is being processed, and does not poll for a comparison', async () => {
      const api = setup([
        resume({ status: 'processing', profile: null, chunkCount: 0 }),
        job({ fit: null }),
      ]);

      const li = await card('Job #2 · Platform Engineer at Acme');

      expect(li).toHaveTextContent('Waiting for your resume to be indexed…');
      expect(within(li).queryByRole('button', { name: /Compare/ })).not.toBeInTheDocument();
      await waitFor(() => expect(listCalls(api)).toBeGreaterThan(2));
    });
  });

  describe('while the comparison is being made', () => {
    it('says so, keeps asking, and shows the fit when it arrives', async () => {
      let calls = 0;
      setup([], {
        'GET /api/documents': () => {
          calls++;
          return jsonResponse(200, {
            documents: [resume(), calls >= 4 ? job() : job({ fit: null })],
          });
        },
      });

      const li = await card('Job #2 · Platform Engineer at Acme');
      expect(li).toHaveTextContent('Comparing with your resume…');
      expect(within(li).queryByRole('button', { name: /Compare/ })).not.toBeInTheDocument();

      expect(await within(li).findByRole('meter')).toHaveAttribute('aria-valuenow', '72');
      expect(li).not.toHaveTextContent('Comparing');
      const settled = calls;
      await new Promise((resolve) => setTimeout(resolve, 80));
      expect(calls).toBe(settled);
    });

    it('gives up after a while, stops asking, and offers to compare', async () => {
      const api = setup([resume(), job({ fit: null })]);

      const li = await card('Job #2 · Platform Engineer at Acme');
      expect(li).toHaveTextContent('Comparing with your resume…');

      await waitFor(() => expect(li).toHaveTextContent('Not compared with your resume yet.'), {
        timeout: 3000,
      });
      expect(
        within(li).getByRole('button', { name: 'Compare Job #2 · Platform Engineer at Acme' }),
      ).toBeEnabled();
      const settled = listCalls(api);
      expect(settled).toBe(1 + MAX_FIT_POLLS);
      await new Promise((resolve) => setTimeout(resolve, 80));
      expect(listCalls(api)).toBe(settled);
    });

    it('compares on request and shows the result', async () => {
      const api = setup([resume(), job({ fit: null })], {
        'POST /api/career/jobs/j2/fit': jsonResponse(200, { document: job() }),
      });
      const user = userEvent.setup();
      const li = await card('Job #2 · Platform Engineer at Acme');
      await waitFor(() => expect(li).toHaveTextContent('Not compared with your resume yet.'), {
        timeout: 3000,
      });

      await user.click(within(li).getByRole('button', { name: /^Compare/ }));

      expect(await within(li).findByRole('meter')).toHaveAttribute('aria-valuenow', '72');
      expect(api.calls.filter((c) => c.route === 'POST /api/career/jobs/j2/fit')).toHaveLength(1);
      expect(within(li).queryByRole('button', { name: /^Compare/ })).not.toBeInTheDocument();
    });

    it('says what the server says when it cannot compare now, and lets the user try again', async () => {
      setup([resume(), job({ fit: null })], {
        'POST /api/career/jobs/j2/fit': jsonResponse(503, {
          error: {
            code: 'ai_busy',
            message: 'The comparison could not be made right now. Try again in a minute.',
          },
        }),
      });
      const user = userEvent.setup();
      const li = await card('Job #2 · Platform Engineer at Acme');
      await waitFor(() => expect(li).toHaveTextContent('Not compared with your resume yet.'), {
        timeout: 3000,
      });

      await user.click(within(li).getByRole('button', { name: /^Compare/ }));

      expect(await within(li).findByRole('alert')).toHaveTextContent('Try again in a minute');
      expect(within(li).getByRole('button', { name: /^Compare/ })).toBeEnabled();
    });
  });

  describe('when it could not be analysed', () => {
    const unanalysed = () => job({ profile: null, fit: null });

    it('says so and offers to analyse it', async () => {
      setup([resume(), unanalysed()], {
        'POST /api/career/j2/analysis': jsonResponse(200, {
          document: job({ fit: null }),
        }),
      });
      const user = userEvent.setup();
      const li = await card('Job #2 · Platform Engineer at Acme');
      expect(li).toHaveTextContent('Not analysed yet, so it cannot be compared with your resume.');

      await user.click(
        within(li).getByRole('button', { name: 'Analyze Job #2 · Platform Engineer at Acme' }),
      );

      await waitFor(() => expect(li).toHaveTextContent('4 requirements'));
      expect(li).toHaveTextContent('Comparing with your resume…');
    });

    it('says what the server says when the resume or posting is not ready', async () => {
      setup([resume(), unanalysed()], {
        'POST /api/career/j2/analysis': jsonResponse(409, {
          error: { code: 'conflict', message: 'The file is still being processed' },
        }),
      });
      const user = userEvent.setup();
      const li = await card('Job #2 · Platform Engineer at Acme');

      await user.click(within(li).getByRole('button', { name: /^Analyze/ }));

      expect(await within(li).findByRole('alert')).toHaveTextContent('still being processed');
    });

    it('says when a posting has no requirements, and offers to analyse it again', async () => {
      setup(
        [
          resume(),
          job({
            fit: null,
            profile: { role: 'job', title: null, company: null, requirementCount: 0 },
          }),
        ],
        {},
      );

      const li = await card('Job #2 · Platform Engineer at Acme');

      expect(li).toHaveTextContent('No requirements were found in this posting.');
      expect(within(li).getByRole('button', { name: /^Analyze again/ })).toBeEnabled();
      expect(li).not.toHaveTextContent('Comparing');
    });
  });
});

describe('a library with documents, a resume and postings', () => {
  it('keeps the other cards as they were', async () => {
    setup([
      base({ id: 'd1', kind: 'document', filename: 'handbook.pdf', pageCount: 3, chunkCount: 9 }),
      resume(),
      job(),
    ]);

    const handbook = await card('handbook.pdf');

    expect(handbook).toHaveTextContent('1 KB · Ready · 3 pages · 9 passages');
    expect(within(handbook).queryByRole('meter')).not.toBeInTheDocument();
  });
});
