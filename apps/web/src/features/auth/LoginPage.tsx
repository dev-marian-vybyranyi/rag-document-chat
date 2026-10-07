import { useLocation } from 'react-router';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { AuthForm } from './AuthForm';
import { AuthLayout } from './AuthLayout';

export function LoginPage() {
  const location = useLocation();
  const expired = (location.state as { expired?: boolean } | null)?.expired === true;

  return (
    <AuthLayout
      title="Sign in"
      description="Welcome back. Sign in to continue to your documents."
      footer={{ text: 'New here?', linkLabel: 'Create an account', to: '/register' }}
    >
      {expired && (
        <Alert className="mb-4">
          <AlertDescription>Your session has expired. Sign in again to continue.</AlertDescription>
        </Alert>
      )}
      <AuthForm mode="login" />
    </AuthLayout>
  );
}
