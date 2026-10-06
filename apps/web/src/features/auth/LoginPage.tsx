import { AuthForm } from './AuthForm';
import { AuthLayout } from './AuthLayout';

export function LoginPage() {
  return (
    <AuthLayout
      title="Sign in"
      description="Welcome back. Sign in to continue to your documents."
      footer={{ text: 'New here?', linkLabel: 'Create an account', to: '/register' }}
    >
      <AuthForm mode="login" />
    </AuthLayout>
  );
}
