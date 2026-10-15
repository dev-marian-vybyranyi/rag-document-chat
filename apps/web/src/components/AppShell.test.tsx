import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Link, MemoryRouter, Route, Routes } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { AppShell } from './AppShell';

function renderShell() {
  render(
    <MemoryRouter>
      <AppShell
        sidebar={
          <>
            <button type="button">New chat</button>
            <a href="/documents">Documents</a>
          </>
        }
      >
        <button type="button">Page action</button>
      </AppShell>
    </MemoryRouter>,
  );
  return {
    toggle: screen.getByRole('button', { name: 'Show conversations' }),
    main: screen.getByRole('main'),
  };
}

function stubDesktop(matches: boolean) {
  vi.stubGlobal(
    'matchMedia',
    vi.fn().mockImplementation((query: string) => ({
      matches,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    })),
  );
}

describe('AppShell on a narrow screen', () => {
  it('moves focus into the conversations when they open', async () => {
    const user = userEvent.setup();
    const { toggle } = renderShell();

    await user.click(toggle);

    expect(screen.getByRole('button', { name: 'New chat' })).toHaveFocus();
  });

  it('keeps the page behind the conversations out of reach while they are open', async () => {
    const user = userEvent.setup();
    const { toggle, main } = renderShell();
    expect(main).not.toHaveAttribute('inert');

    await user.click(toggle);

    expect(main).toHaveAttribute('inert');
  });

  it('closes on Escape and puts focus back on the menu button', async () => {
    const user = userEvent.setup();
    const { toggle, main } = renderShell();
    await user.click(toggle);

    await user.keyboard('{Escape}');

    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(toggle).toHaveFocus();
    expect(main).not.toHaveAttribute('inert');
  });

  it('closes when the dimmed page behind it is clicked', async () => {
    const user = userEvent.setup();
    const { toggle } = renderShell();
    await user.click(toggle);

    await user.click(screen.getByTestId('sidebar-scrim'));

    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByTestId('sidebar-scrim')).not.toBeInTheDocument();
  });

  it('ignores Escape while the conversations are closed', async () => {
    const user = userEvent.setup();
    const { toggle } = renderShell();
    await user.click(screen.getByRole('button', { name: 'Page action' }));

    await user.keyboard('{Escape}');

    expect(toggle).not.toHaveFocus();
  });
});

describe('AppShell on a wide screen', () => {
  it('never blocks the page, because the conversations sit beside it', async () => {
    stubDesktop(true);
    const user = userEvent.setup();
    const { toggle, main } = renderShell();

    await user.click(toggle);

    expect(main).not.toHaveAttribute('inert');
    expect(screen.queryByTestId('sidebar-scrim')).not.toBeInTheDocument();
  });
});

function renderRoutedShell() {
  render(
    <MemoryRouter>
      <AppShell
        sidebar={
          <>
            <Link to="/other">Other page</Link>
            <Link to="/plain">Plain page</Link>
          </>
        }
      >
        <Routes>
          <Route path="/" element={<p>Home</p>} />
          <Route path="/plain" element={<p>Plain</p>} />
          <Route path="/other" element={<input aria-label="Page field" autoFocus />} />
        </Routes>
      </AppShell>
    </MemoryRouter>,
  );
  return screen.getByRole('main');
}

describe('AppShell keyboard and screen reader help', () => {
  it('starts with a link that skips the navigation and lands on the page', async () => {
    const user = userEvent.setup();
    const main = renderRoutedShell();

    await user.tab();
    expect(screen.getByRole('link', { name: 'Skip to main content' })).toHaveFocus();

    await user.keyboard('{Enter}');
    expect(main).toHaveFocus();
  });

  it('moves focus to the page after a link in the sidebar is followed', async () => {
    const user = userEvent.setup();
    const main = renderRoutedShell();

    await user.click(screen.getByRole('link', { name: 'Plain page' }));

    expect(main).toHaveFocus();
  });

  it('leaves focus where it is when the new page has already taken it', async () => {
    const user = userEvent.setup();
    renderRoutedShell();

    await user.click(screen.getByRole('link', { name: 'Other page' }));

    expect(screen.getByLabelText('Page field')).toHaveFocus();
  });

  it('does not take focus when the page first opens', () => {
    renderRoutedShell();

    expect(document.body).toHaveFocus();
  });
});
