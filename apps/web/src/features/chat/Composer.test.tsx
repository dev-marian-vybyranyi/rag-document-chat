import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { COUNTER_FROM, Composer, MAX_QUESTION_LENGTH } from './Composer';

function setup() {
  render(<Composer busy={false} onSend={vi.fn()} onStop={vi.fn()} />);
  return screen.getByRole('textbox', { name: 'Your question' });
}

describe('Composer', () => {
  it('is ready to type in as soon as it appears', () => {
    expect(setup()).toHaveFocus();
  });

  it('says that it takes questions about documents and about code', () => {
    expect(setup()).toHaveAttribute('placeholder', 'Ask about your documents or code…');
  });

  it('uses a 16px font on a phone, so iOS does not zoom the page when it is focused', () => {
    const classes = setup().className.split(' ');

    expect(classes).toContain('text-base');
    expect(classes).toContain('md:text-sm');
    expect(classes).not.toContain('text-sm');
  });

  it('shows no counter for a short question', async () => {
    const user = userEvent.setup();
    await user.type(setup(), 'short');

    expect(screen.queryByText(/\/ 2000/)).not.toBeInTheDocument();
  });

  it('counts characters when the question nears the limit', async () => {
    const user = userEvent.setup();
    const box = setup();

    await user.click(box);
    await user.paste('x'.repeat(COUNTER_FROM - 1));
    expect(screen.queryByText(/\/ 2000/)).not.toBeInTheDocument();
    await user.paste('x');

    expect(screen.getByText(`${COUNTER_FROM} / ${MAX_QUESTION_LENGTH}`)).toBeInTheDocument();
  });
});
