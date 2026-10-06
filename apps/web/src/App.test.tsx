import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { App } from './App';

describe('App', () => {
  it('renders the app title and the landing prompt', () => {
    render(<App />);

    expect(screen.getByRole('heading', { level: 1, name: 'Document Chat' })).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: 'Ask questions about your documents' }),
    ).toBeInTheDocument();
  });
});
