import { AuthForm } from './AuthForm';
import { AuthLayout } from './AuthLayout';

export function RegisterPage() {
  return (
    <AuthLayout
      title="Create your account"
      description="Upload documents and ask questions about them."
      footer={{ text: 'Already have an account?', linkLabel: 'Sign in', to: '/login' }}
    >
      <AuthForm mode="register" />
    </AuthLayout>
  );
}
