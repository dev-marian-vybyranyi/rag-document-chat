import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { SegmentedControl } from './SegmentedControl';

const OPTIONS = [
  { value: 'a', label: 'First' },
  { value: 'b', label: 'Second' },
  { value: 'c', label: 'Third' },
] as const;

function Harness({
  onChange = () => {},
  disabled = false,
}: {
  onChange?: (v: string) => void;
  disabled?: boolean;
}) {
  const [value, setValue] = useState<'a' | 'b' | 'c'>('a');
  return (
    <SegmentedControl
      label="Pick one"
      value={value}
      options={OPTIONS}
      disabled={disabled}
      onChange={(next) => {
        setValue(next);
        onChange(next);
      }}
    />
  );
}

const radio = (name: string) => screen.getByRole('radio', { name });

describe('SegmentedControl', () => {
  it('is a group of radios with the chosen one checked', () => {
    render(<Harness />);

    expect(screen.getByRole('radiogroup', { name: 'Pick one' })).toBeInTheDocument();
    expect(radio('First')).toBeChecked();
    expect(radio('Second')).not.toBeChecked();
  });

  it('is one stop for Tab, on the checked radio', async () => {
    const user = userEvent.setup();
    render(
      <>
        <button type="button">Before</button>
        <Harness />
        <button type="button">After</button>
      </>,
    );

    await user.tab();
    await user.tab();
    expect(radio('First')).toHaveFocus();

    await user.tab();
    expect(screen.getByRole('button', { name: 'After' })).toHaveFocus();
  });

  it('moves and chooses with the arrow keys, and wraps around', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    radio('First').focus();

    await user.keyboard('{ArrowRight}');
    expect(radio('Second')).toHaveFocus();
    expect(radio('Second')).toBeChecked();

    await user.keyboard('{ArrowDown}{ArrowDown}');
    expect(radio('First')).toHaveFocus();
    expect(radio('First')).toBeChecked();

    await user.keyboard('{ArrowLeft}');
    expect(radio('Third')).toHaveFocus();
    expect(onChange.mock.calls.map(([value]) => value)).toEqual(['b', 'c', 'a', 'c']);
  });

  it('jumps to the first and last with Home and End', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    radio('First').focus();

    await user.keyboard('{End}');
    expect(radio('Third')).toBeChecked();

    await user.keyboard('{Home}');
    expect(radio('First')).toBeChecked();
  });

  it('chooses with a click', async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.click(radio('Third'));

    expect(radio('Third')).toBeChecked();
  });

  it('can be switched off as a whole', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness disabled onChange={onChange} />);

    await user.click(radio('Second'));

    expect(onChange).not.toHaveBeenCalled();
    expect(radio('Second')).toBeDisabled();
  });
});
