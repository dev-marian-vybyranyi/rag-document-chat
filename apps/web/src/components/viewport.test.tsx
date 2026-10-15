import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import { AuthLayout } from '@/features/auth/AuthLayout';
import { ThemeProvider } from '@/features/theme/ThemeProvider';
import { AppShell } from './AppShell';
import { FullPageMessage } from './FullPageMessage';

function classesOfRoot(element: React.ReactElement): string[] {
  const { container } = render(<MemoryRouter>{element}</MemoryRouter>);
  return (container.firstElementChild as HTMLElement).className.split(' ');
}

describe('full-height layouts', () => {
  it.each([
    ['the app', <AppShell sidebar={null}>x</AppShell>, 'h-dvh', 'h-screen'],
    ['a message on its own', <FullPageMessage>x</FullPageMessage>, 'min-h-dvh', 'min-h-screen'],
    [
      'the sign-in card',
      <ThemeProvider>
        <AuthLayout title="t" description="d" footer={{ text: 't', linkLabel: 'l', to: '/' }}>
          x
        </AuthLayout>
      </ThemeProvider>,
      'min-h-dvh',
      'min-h-screen',
    ],
  ])(
    'sizes %s to the visible part of a phone screen, not the one behind the address bar',
    (_name, element, wanted, unwanted) => {
      const classes = classesOfRoot(element);

      expect(classes).toContain(wanted);
      expect(classes).not.toContain(unwanted);
    },
  );
});
