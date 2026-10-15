import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Button, buttonVariants } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Composer } from '@/features/chat/Composer';
import { Citation } from '@/features/chat/Citation';
import { SourceList } from '@/features/chat/SourceList';
import type { ChatSource } from '@/features/chat/types';
import { WhyButton } from '@/features/chat/WhyButton';

const source: ChatSource = {
  id: 1,
  chunkId: 'k1',
  documentId: 'd1',
  filename: 'handbook.pdf',
  page: 4,
  ordinal: 7,
  excerpt: 'text',
  score: 0.8,
};

const sizes = ['default', 'xs', 'sm', 'lg', 'icon', 'icon-xs', 'icon-sm', 'icon-lg'] as const;

function coarseMinHeight(classes: string): number {
  const match = /pointer-coarse:min-h-(\d+)/.exec(classes);
  return match ? Number(match[1]) * 4 : 0;
}

describe('touch targets', () => {
  it.each(sizes)('grows a %s button on a touch screen', (size) => {
    const minimum = size.endsWith('xs') ? 36 : 44;

    expect(coarseMinHeight(buttonVariants({ size }))).toBeGreaterThanOrEqual(minimum);
  });

  it.each(['icon', 'icon-xs', 'icon-sm', 'icon-lg'] as const)(
    'grows the width of a %s button as well',
    (size) => {
      expect(buttonVariants({ size })).toMatch(/pointer-coarse:min-w-(9|11)/);
    },
  );

  it('keeps a button that sets its own height able to grow', () => {
    render(
      <Button size="xs" className="h-auto">
        A long suggested question
      </Button>,
    );

    expect(screen.getByRole('button').className).not.toMatch(/pointer-coarse:h-/);
  });

  it('makes a text field at least 44px tall on a touch screen', () => {
    render(<Input aria-label="Name" />);

    expect(coarseMinHeight(screen.getByRole('textbox').className)).toBe(44);
  });

  it('makes “Why this answer?” at least 24px tall with a mouse and 44px with a finger', () => {
    render(
      <WhyButton
        data={{
          question: 'q',
          answer: 'a',
          sources: [],
          retrieval: {
            query: 'q',
            rewritten: false,
            mode: 'hybrid',
            bestScore: 1,
            outcome: 'answered',
          },
        }}
      />,
    );
    const classes = screen.getByRole('button', { name: 'Why this answer?' }).className;

    expect(classes).toContain('py-1 ');
    expect(classes).toContain('pointer-coarse:py-3.5');
  });

  it('makes the question box at least 44px tall on a touch screen', () => {
    render(<Composer busy={false} onSend={() => {}} onStop={() => {}} />);

    expect(coarseMinHeight(screen.getByRole('textbox').className)).toBe(44);
  });

  it('makes a source in the list at least 24px tall with a mouse and 44px with a finger', () => {
    render(<SourceList sources={[source]} />);
    const classes = screen.getByRole('button', { name: /handbook\.pdf/ }).className;

    expect(classes).toContain('py-1 ');
    expect(classes).toContain('pointer-coarse:py-3.5');
  });

  it('widens the area that opens a citation on a touch screen without moving the text', () => {
    render(
      <p>
        Claim <Citation source={source}>[1]</Citation>.
      </p>,
    );
    const classes = screen.getByRole('button', { name: /Source 1/ }).className;

    expect(classes).toContain('relative');
    expect(classes).toContain('pointer-coarse:after:absolute');
    expect(classes).toContain('pointer-coarse:after:-inset-y-3');
  });
});
