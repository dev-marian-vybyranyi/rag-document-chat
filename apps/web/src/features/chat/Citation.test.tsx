import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { Citation } from './Citation';
import { describeMatch, describeSource } from './source-format';
import type { ChatSource } from './types';

const source: ChatSource = {
  id: 2,
  chunkId: 'k2',
  documentId: 'd1',
  filename: 'handbook.pdf',
  page: 4,
  ordinal: 7,
  excerpt: 'HNSW builds a layered graph.\nSearch starts at the top layer.',
  score: 0.784,
};

function renderCitation(overrides: Partial<ChatSource> = {}) {
  render(
    <p>
      Claim <Citation source={{ ...source, ...overrides }}>[2]</Citation>.
    </p>,
  );
  return screen.getByLabelText(/Source 2/);
}

describe('Citation', () => {
  it('shows only the marker until someone asks for more', () => {
    renderCitation();

    expect(screen.getByText('[2]')).toBeInTheDocument();
    expect(screen.queryByText('handbook.pdf')).not.toBeInTheDocument();
  });

  it('can be reached with the keyboard and opens a preview on focus', async () => {
    const user = userEvent.setup();
    const marker = renderCitation();

    await user.tab();
    expect(marker).toHaveFocus();

    expect(await screen.findByText('handbook.pdf')).toBeInTheDocument();
    expect(screen.getByText(/Page 4/)).toBeInTheDocument();
    expect(screen.getByText(/Similarity 78%/)).toBeInTheDocument();
    expect(screen.getByText(/HNSW builds a layered graph\./)).toBeInTheDocument();
  });

  it('opens on hover and closes when the pointer leaves', async () => {
    const user = userEvent.setup();
    const marker = renderCitation();

    await user.hover(marker);
    expect(await screen.findByText('handbook.pdf')).toBeInTheDocument();

    await user.unhover(marker);
    await waitFor(() => expect(screen.queryByText('handbook.pdf')).not.toBeInTheDocument());
  });

  it('closes on Escape', async () => {
    const user = userEvent.setup();
    renderCitation();
    await user.tab();
    await screen.findByText('handbook.pdf');

    await user.keyboard('{Escape}');

    await waitFor(() => expect(screen.queryByText('handbook.pdf')).not.toBeInTheDocument());
  });

  it('leaves the page out for a text file and says how a keyword-only match was found', async () => {
    const user = userEvent.setup();
    renderCitation({ page: null, score: null });

    await user.tab();

    expect(await screen.findByText('Found by keyword match')).toBeInTheDocument();
    expect(screen.queryByText(/Page/)).not.toBeInTheDocument();
  });
});

describe('describeSource', () => {
  it('names the file and the page', () => {
    expect(describeSource(source)).toBe('handbook.pdf, page 4');
    expect(describeSource({ ...source, page: null })).toBe('handbook.pdf');
  });
});

describe('describeMatch', () => {
  it.each([
    [0.784, 'Similarity 78%'],
    [1, 'Similarity 100%'],
    [0.655, 'Similarity 66%'],
    [null, 'Found by keyword match'],
  ])('describes %s as %s', (score, text) => {
    expect(describeMatch(score)).toBe(text);
  });
});
