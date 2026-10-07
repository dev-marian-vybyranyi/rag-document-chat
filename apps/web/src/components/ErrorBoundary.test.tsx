import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ErrorBoundary } from './ErrorBoundary';

function Broken(): never {
  throw new Error('render failed');
}

describe('ErrorBoundary', () => {
  afterEach(() => vi.restoreAllMocks());

  it('shows its children while nothing fails', () => {
    render(
      <ErrorBoundary>
        <p>All good</p>
      </ErrorBoundary>,
    );

    expect(screen.getByText('All good')).toBeInTheDocument();
  });

  it('replaces a crashed page with a message and a way to reload', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const reload = vi.fn();
    Object.defineProperty(window, 'location', { value: { reload }, configurable: true });
    const user = userEvent.setup();

    render(
      <ErrorBoundary>
        <Broken />
      </ErrorBoundary>,
    );

    expect(screen.getByRole('heading', { name: 'Something went wrong' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Reload the page' }));
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
