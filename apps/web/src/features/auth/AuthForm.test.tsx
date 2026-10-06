import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/lib/api';
import { AuthForm, type AuthMode } from './AuthForm';
import { AuthContext, type AuthContextValue } from './auth-context';

const validationError = (details: Record<string, string[]>) =>
  new ApiError(400, 'validation_error', 'Request validation failed', details);

function renderForm(mode: AuthMode, actions: Partial<AuthContextValue> = {}) {
  const login = vi.fn<AuthContextValue['login']>().mockResolvedValue();
  const register = vi.fn<AuthContextValue['register']>().mockResolvedValue();
  const value: AuthContextValue = {
    state: { status: 'anonymous' },
    login,
    register,
    logout: vi.fn(),
    reload: vi.fn(),
    ...actions,
  };
  render(
    <AuthContext.Provider value={value}>
      <AuthForm mode={mode} />
    </AuthContext.Provider>,
  );
  return { login: value.login as typeof login, register: value.register as typeof register };
}

async function fillAndSubmit(email: string, password: string, submitLabel: string) {
  const user = userEvent.setup();
  await user.type(screen.getByLabelText('Email'), email);
  await user.type(screen.getByLabelText('Password'), password);
  await user.click(screen.getByRole('button', { name: submitLabel }));
}

describe('AuthForm', () => {
  describe('sign-in mode', () => {
    it('asks for an email and a password', () => {
      renderForm('login');

      expect(screen.getByLabelText('Email')).toHaveAttribute('type', 'email');
      expect(screen.getByLabelText('Password')).toHaveAttribute('type', 'password');
      expect(screen.getByRole('button', { name: 'Sign in' })).toBeEnabled();
    });

    it('lets the browser offer saved passwords and does not impose a length rule', () => {
      renderForm('login');

      const password = screen.getByLabelText('Password');
      expect(password).toHaveAttribute('autocomplete', 'current-password');
      expect(password).not.toHaveAttribute('minlength');
      expect(screen.queryByText(/at least 8 characters/i)).not.toBeInTheDocument();
    });

    it('signs in with the typed credentials, trimming spaces around the email', async () => {
      const { login, register } = renderForm('login');

      await fillAndSubmit('  ada@example.com ', 'correct horse battery', 'Sign in');

      expect(login).toHaveBeenCalledExactlyOnceWith({
        email: 'ada@example.com',
        password: 'correct horse battery',
      });
      expect(register).not.toHaveBeenCalled();
    });
  });

  describe('register mode', () => {
    it('states the password rule up front and enforces it in the browser', () => {
      renderForm('register');

      const password = screen.getByLabelText('Password');
      expect(password).toHaveAttribute('minlength', '8');
      expect(password).toHaveAttribute('autocomplete', 'new-password');
      expect(screen.getByText('At least 8 characters.')).toBeInTheDocument();
    });

    it('creates the account instead of signing in', async () => {
      const { login, register } = renderForm('register');

      await fillAndSubmit('ada@example.com', 'correct horse battery', 'Create account');

      expect(register).toHaveBeenCalledExactlyOnceWith({
        email: 'ada@example.com',
        password: 'correct horse battery',
      });
      expect(login).not.toHaveBeenCalled();
    });
  });

  describe('input checks before sending', () => {
    it('does not submit an empty form', async () => {
      const { login } = renderForm('login');

      await userEvent.setup().click(screen.getByRole('button', { name: 'Sign in' }));

      expect(login).not.toHaveBeenCalled();
    });

    it('does not submit an address that is not an email', async () => {
      const { login } = renderForm('login');

      await fillAndSubmit('not-an-email', 'whatever', 'Sign in');

      expect(login).not.toHaveBeenCalled();
    });
  });

  describe('while the request is running', () => {
    it('disables the button and says what is happening, then recovers', async () => {
      let finish!: () => void;
      const pending = new Promise<void>((resolve) => (finish = resolve));
      renderForm('login', { login: vi.fn().mockReturnValue(pending) });

      await fillAndSubmit('ada@example.com', 'correct horse battery', 'Sign in');

      const button = screen.getByRole('button', { name: 'Signing in…' });
      expect(button).toBeDisabled();

      finish();
      expect(await screen.findByRole('button', { name: 'Sign in' })).toBeEnabled();
    });

    it('uses its own wording when creating an account', async () => {
      renderForm('register', { register: vi.fn().mockReturnValue(new Promise(() => {})) });

      await fillAndSubmit('ada@example.com', 'correct horse battery', 'Create account');

      expect(screen.getByRole('button', { name: 'Creating account…' })).toBeDisabled();
    });
  });

  describe('when the server refuses', () => {
    it('shows field problems next to the fields and marks them invalid', async () => {
      renderForm('register', {
        register: vi.fn().mockRejectedValue(
          validationError({
            email: ['Enter a valid email address'],
            password: ['Password must be at least 8 characters'],
          }),
        ),
      });

      await fillAndSubmit('ada@example.com', 'correct horse battery', 'Create account');

      const email = screen.getByLabelText('Email');
      const password = screen.getByLabelText('Password');
      expect(await screen.findByText('Enter a valid email address')).toBeInTheDocument();
      expect(screen.getByText('Password must be at least 8 characters')).toBeInTheDocument();
      expect(email).toHaveAttribute('aria-invalid', 'true');
      expect(password).toHaveAttribute('aria-invalid', 'true');
      expect(email).toHaveAccessibleDescription('Enter a valid email address');
      expect(password).toHaveAccessibleDescription('Password must be at least 8 characters');
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });

    it('replaces the password hint with the server message instead of showing both', async () => {
      renderForm('register', {
        register: vi
          .fn()
          .mockRejectedValue(validationError({ password: ['Password is too common'] })),
      });

      await fillAndSubmit('ada@example.com', 'correct horse battery', 'Create account');

      expect(await screen.findByText('Password is too common')).toBeInTheDocument();
      expect(screen.queryByText('At least 8 characters.')).not.toBeInTheDocument();
    });

    it.each([
      [
        'wrong credentials',
        new ApiError(401, 'invalid_credentials', 'Incorrect email or password'),
      ],
      [
        'a taken email',
        new ApiError(409, 'email_taken', 'An account with this email already exists'),
      ],
      [
        'rate limiting',
        new ApiError(429, 'rate_limited', 'Too many attempts. Please try again later.'),
      ],
      [
        'a lost connection',
        new ApiError(0, 'network_error', 'Cannot reach the server. Check your connection.'),
      ],
    ])('shows a general message for %s', async (_name, error) => {
      renderForm('login', { login: vi.fn().mockRejectedValue(error) });

      await fillAndSubmit('ada@example.com', 'correct horse battery', 'Sign in');

      expect(await screen.findByRole('alert')).toHaveTextContent(error.message);
      expect(screen.getByLabelText('Email')).not.toHaveAttribute('aria-invalid');
    });

    it('falls back to a generic message for an unexpected failure', async () => {
      renderForm('login', { login: vi.fn().mockRejectedValue(new Error('boom: internal detail')) });

      await fillAndSubmit('ada@example.com', 'correct horse battery', 'Sign in');

      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent('Something went wrong. Please try again.');
      expect(alert).not.toHaveTextContent('boom');
    });

    it('keeps what the user typed and lets them try again', async () => {
      const login = vi
        .fn<AuthContextValue['login']>()
        .mockRejectedValueOnce(
          new ApiError(401, 'invalid_credentials', 'Incorrect email or password'),
        )
        .mockResolvedValueOnce();
      renderForm('login', { login });
      const user = userEvent.setup();
      await fillAndSubmit('ada@example.com', 'wrong-password', 'Sign in');
      await screen.findByRole('alert');

      expect(screen.getByLabelText('Email')).toHaveValue('ada@example.com');
      expect(screen.getByLabelText('Password')).toHaveValue('wrong-password');
      expect(screen.getByRole('button', { name: 'Sign in' })).toBeEnabled();

      await user.click(screen.getByRole('button', { name: 'Sign in' }));

      expect(login).toHaveBeenCalledTimes(2);
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });
  });
});
