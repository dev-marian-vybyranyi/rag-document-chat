import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LoadingScreen, SLOW_START_MS } from './AuthStatusScreens';

describe('LoadingScreen', () => {
  afterEach(() => vi.useRealTimers());

  it('first just says it is loading', () => {
    render(<LoadingScreen />);

    expect(screen.getByText('Loading…')).toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('explains a slow start once it has taken a while, as a free server waking up does', () => {
    vi.useFakeTimers();
    render(<LoadingScreen />);

    act(() => void vi.advanceTimersByTime(SLOW_START_MS - 1));
    expect(screen.queryByRole('status')).not.toBeInTheDocument();

    act(() => void vi.advanceTimersByTime(1));
    expect(screen.getByRole('status')).toHaveTextContent(/waking up/);
  });

  it('stops counting when it is replaced', () => {
    vi.useFakeTimers();
    const { unmount } = render(<LoadingScreen />);

    unmount();

    expect(vi.getTimerCount()).toBe(0);
  });
});
