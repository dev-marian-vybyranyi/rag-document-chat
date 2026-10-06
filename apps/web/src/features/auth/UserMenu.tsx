import { useState } from 'react';
import { Button } from '@/components/ui/button';
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
    <div className="flex items-center gap-3 text-sm">
      {failed && <span className="text-destructive">Could not sign out. Try again.</span>}
      <span className="text-muted-foreground">{state.user.email}</span>
      <Button variant="outline" size="sm" onClick={handleLogout}>
        Sign out
      </Button>
    </div>
  );
}
