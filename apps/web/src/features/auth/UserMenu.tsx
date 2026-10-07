import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { ThemeToggle } from '../theme/ThemeToggle';
import { useAuth } from './auth-context';

export function UserMenu() {
  const { state, logout } = useAuth();
  const [failed, setFailed] = useState(false);

  if (state.status !== 'authenticated') return null;

  async function handleLogout() {
    setFailed(false);
    try {
      await logout();
    } catch {
      setFailed(true);
    }
  }

  return (
    <div className="flex items-center gap-1 text-sm sm:gap-3">
      <ThemeToggle />
      {failed && <span className="text-destructive">Could not sign out. Try again.</span>}
      <span className="hidden text-muted-foreground sm:inline">{state.user.email}</span>
      <Button variant="outline" size="sm" onClick={handleLogout}>
        Sign out
      </Button>
    </div>
  );
}
