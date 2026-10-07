import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Markdown } from './Markdown';
import type { ChatSource } from './types';

function source(id: number, filename: string, page: number | null = null): ChatSource {
  return {
    id,
    chunkId: `k${id}`,
    documentId: 'd',
    filename,
    page,
    ordinal: 0,
    excerpt: '',
    score: 0.8,
  };
}

const sources = [source(1, 'handbook.pdf', 4), source(2, 'notes.txt')];

function renderMarkdown(text: string, available: ChatSource[] = sources) {
  return render(<Markdown sources={available}>{text}</Markdown>);
}

describe('Markdown', () => {
  describe('formatting', () => {
    it('renders emphasis, lists and headings', () => {
      renderMarkdown('## Title\n\nSome **bold** text\n\n- one\n- two\n\n1. first\n2. second');

      expect(screen.getByRole('heading', { name: 'Title' })).toBeInTheDocument();
      expect(screen.getByText('bold').tagName).toBe('STRONG');
      expect(screen.getAllByRole('listitem').map((li) => li.textContent)).toEqual([
        'one',
        'two',
        'first',
        'second',
      ]);
    });

    it('renders tables', () => {
      renderMarkdown('| Index | Speed |\n| --- | --- |\n| HNSW | fast |');

      expect(screen.getByRole('table')).toBeInTheDocument();
      expect(screen.getByRole('columnheader', { name: 'Speed' })).toBeInTheDocument();
      expect(screen.getByRole('cell', { name: 'HNSW' })).toBeInTheDocument();
    });

    it('renders inline code apart from code blocks', () => {
      renderMarkdown('Use `CREATE INDEX` here');

      const code = screen.getByText('CREATE INDEX');
      expect(code.tagName).toBe('CODE');
      expect(code.closest('pre')).toBeNull();
    });

    it('keeps the text of a half-written answer readable while it streams', () => {
      renderMarkdown('Here is code:\n\n```sql\nSELECT 1');

      expect(screen.getByText('SELECT 1')).toBeInTheDocument();
    });
  });

  describe('code blocks', () => {
    it('shows the language and the code exactly as written', () => {
      renderMarkdown('```sql\nSELECT *\n  FROM docs;\n```');

      expect(screen.getByText('sql')).toBeInTheDocument();
      const code = screen.getByText(/SELECT/, { selector: 'code' });
      expect(code.textContent).toBe('SELECT *\n  FROM docs;');
      expect(code.closest('pre')).not.toBeNull();
    });

    it('does not read citations inside code', () => {
      renderMarkdown('```js\nconst a = items[1];\n```');

      expect(screen.getByText('const a = items[1];')).toBeInTheDocument();
      expect(screen.queryByLabelText(/Source 1/)).not.toBeInTheDocument();
    });

    it('closes a block whose last fence has a citation glued to it, as models tend to write', () => {
      const { container } = renderMarkdown(
        'Run:\n\n```sql\nCREATE INDEX x;\n``` [1]\n\n* **Fast:** a few ms [1]\n* **Big:** more memory [2]',
      );

      expect(screen.getByText('CREATE INDEX x;', { selector: 'code' })).toBeInTheDocument();
      expect(container.querySelectorAll('pre')).toHaveLength(1);
      expect(screen.getAllByRole('listitem')).toHaveLength(2);
      expect(screen.getByText('Fast:').tagName).toBe('STRONG');
      expect(screen.getAllByLabelText(/Source 1/)).toHaveLength(2);
    });

    it('copies the code and says so', async () => {
      const writeText = vi.fn().mockResolvedValue(undefined);
      const user = userEvent.setup();
      Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
      renderMarkdown('```sh\nnpm test\n```');

      await user.click(screen.getByRole('button', { name: 'Copy code' }));

      expect(writeText).toHaveBeenCalledWith('npm test');
      expect(await screen.findByText('Copied')).toBeInTheDocument();
    });

    it('does not claim to have copied when the browser refuses', async () => {
      const writeText = vi.fn().mockRejectedValue(new Error('denied'));
      const user = userEvent.setup();
      Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
      renderMarkdown('```sh\nnpm test\n```');

      await user.click(screen.getByRole('button', { name: 'Copy code' }));

      expect(writeText).toHaveBeenCalled();
      expect(screen.queryByText('Copied')).not.toBeInTheDocument();
    });
  });

  describe('citations', () => {
    it('turns a known source number into a marker that names its source', () => {
      renderMarkdown('HNSW is a graph index [1].');

      const marker = screen.getByLabelText('Source 1: handbook.pdf, page 4');
      expect(marker).toHaveTextContent('[1]');
      expect(marker.tagName).toBe('BUTTON');
    });

    it('handles several in a row, and a source without a page', () => {
      renderMarkdown('Both agree [1][2].');

      expect(screen.getByLabelText('Source 1: handbook.pdf, page 4')).toBeInTheDocument();
      expect(screen.getByLabelText('Source 2: notes.txt')).toBeInTheDocument();
    });

    it('understands a comma-separated list', () => {
      renderMarkdown('Both agree [1, 2].');

      expect(screen.getByLabelText(/Source 1/)).toBeInTheDocument();
      expect(screen.getByLabelText(/Source 2/)).toBeInTheDocument();
    });

    it('leaves the text around a marker in place', () => {
      const { container } = renderMarkdown('Before [1] after.');

      expect(container.textContent).toBe('Before [1] after.');
    });

    it('does not decorate a number the answer has no source for', () => {
      renderMarkdown('Made up [7] reference.');

      expect(screen.queryByLabelText(/Source/)).not.toBeInTheDocument();
      expect(screen.getByText(/Made up \[7\] reference\./)).toBeInTheDocument();
    });

    it('does not decorate anything when there are no sources', () => {
      renderMarkdown('Looks like a citation [1].', []);

      expect(screen.queryByLabelText(/Source/)).not.toBeInTheDocument();
    });

    it('works inside lists and bold text', () => {
      renderMarkdown('- First point [1]\n- **Second point [2]**');

      const items = screen.getAllByRole('listitem');
      expect(within(items[0]!).getByLabelText(/Source 1/)).toBeInTheDocument();
      expect(within(items[1]!).getByLabelText(/Source 2/)).toBeInTheDocument();
    });

    it('leaves array-style text alone', () => {
      renderMarkdown('Take values[0] and [1x] and [a].');

      expect(screen.queryByLabelText(/Source/)).not.toBeInTheDocument();
    });
  });

  describe('untrusted content', () => {
    it('shows raw HTML as text instead of running it', () => {
      const { container } = renderMarkdown('<script>alert(1)</script><b>loud</b>');

      expect(container.querySelector('script')).toBeNull();
      expect(container.querySelector('b')).toBeNull();
    });

    it('does not load images', () => {
      const { container } = renderMarkdown('![tracker](https://evil.example/pixel.png)');

      expect(container.querySelector('img')).toBeNull();
    });

    it('opens links in a new tab without leaking the opener', () => {
      renderMarkdown('[docs](https://example.com/guide)');

      const link = screen.getByRole('link', { name: 'docs' });
      expect(link).toHaveAttribute('href', 'https://example.com/guide');
      expect(link).toHaveAttribute('target', '_blank');
      expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    });

    it('does not keep a javascript: address', () => {
      renderMarkdown('[click](javascript:alert(1))');

      const link = screen.queryByRole('link', { name: 'click' });
      expect(link?.getAttribute('href') ?? '').not.toContain('javascript:');
    });
  });
});
