import { EyeIcon, EyeOffIcon, Loader2Icon } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ApiError } from '@/lib/api';
import { useAuth } from './auth-context';

export type AuthMode = 'login' | 'register';

const COPY = {
  login: { submit: 'Sign in', pending: 'Signing in…', passwordAutoComplete: 'current-password' },
  register: {
    submit: 'Create account',
    pending: 'Creating account…',
    passwordAutoComplete: 'new-password',
  },
} as const;

const MIN_PASSWORD_LENGTH = 8;

export function AuthForm({ mode }: { mode: AuthMode }) {
  const { login, register } = useAuth();
  const copy = COPY[mode];

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [passwordShown, setPasswordShown] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      await (mode === 'login' ? login : register)({ email: email.trim(), password });
    } catch (cause) {
      setError(
        cause instanceof ApiError
          ? cause
          : new ApiError(0, 'unexpected_error', 'Something went wrong. Please try again.'),
      );
    } finally {
      setPending(false);
    }
  }

  const fieldErrors = error?.code === 'validation_error' ? error.details : undefined;
  const emailError = fieldErrors?.email?.[0];
  const passwordError = fieldErrors?.password?.[0];
  const formError = error && !fieldErrors ? error.message : undefined;

  return (
    <form onSubmit={handleSubmit} className="grid gap-4">
      {formError && (
        <Alert variant="destructive">
          <AlertDescription>{formError}</AlertDescription>
        </Alert>
      )}

      <div className="grid gap-2">
        <Label htmlFor="email">Email</Label>
        <Input
          id="email"
          type="email"
          autoComplete="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          aria-invalid={emailError ? true : undefined}
          aria-describedby={emailError ? 'email-error' : undefined}
        />
        {emailError && (
          <p id="email-error" className="text-sm text-destructive">
            {emailError}
          </p>
        )}
      </div>

      <div className="grid gap-2">
        <Label htmlFor="password">Password</Label>
        <div className="relative">
          <Input
            id="password"
            type={passwordShown ? 'text' : 'password'}
            autoComplete={copy.passwordAutoComplete}
            required
            minLength={mode === 'register' ? MIN_PASSWORD_LENGTH : undefined}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            aria-invalid={passwordError ? true : undefined}
            aria-describedby={passwordError ? 'password-error' : undefined}
            className="pr-10"
          />
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Show password"
            aria-pressed={passwordShown}
            onClick={() => setPasswordShown((shown) => !shown)}
            className="absolute top-1/2 right-1 -translate-y-1/2"
          >
            {passwordShown ? <EyeOffIcon aria-hidden /> : <EyeIcon aria-hidden />}
          </Button>
        </div>
        {mode === 'register' && !passwordError && (
          <p className="text-sm text-muted-foreground">
            At least {MIN_PASSWORD_LENGTH} characters.
          </p>
        )}
        {passwordError && (
          <p id="password-error" className="text-sm text-destructive">
            {passwordError}
          </p>
        )}
      </div>

      <Button type="submit" disabled={pending}>
        {pending && <Loader2Icon className="animate-spin" aria-hidden />}
        {pending ? copy.pending : copy.submit}
      </Button>
    </form>
  );
}
