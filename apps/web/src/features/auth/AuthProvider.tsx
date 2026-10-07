import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { ApiError, onUnauthorized } from '../../lib/api';
import { authApi, type Credentials } from './api';
import { AuthContext, type AuthContextValue, type AuthState } from './auth-context';

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({ status: 'loading' });
  const [reloadCount, setReloadCount] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    authApi
      .me(controller.signal)
      .then((user) => setState({ status: 'authenticated', user }))
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        const unauthenticated = error instanceof ApiError && error.status === 401;
        setState({ status: unauthenticated ? 'anonymous' : 'unavailable' });
      });
    return () => controller.abort();
  }, [reloadCount]);

  useEffect(
    () =>
      onUnauthorized(() =>
        setState((current) =>
          current.status === 'authenticated' ? { status: 'anonymous', expired: true } : current,
        ),
      ),
    [],
  );

  const login = useCallback(async (credentials: Credentials) => {
    const user = await authApi.login(credentials);
    setState({ status: 'authenticated', user });
  }, []);

  const register = useCallback(async (credentials: Credentials) => {
    const user = await authApi.register(credentials);
    setState({ status: 'authenticated', user });
  }, []);

  const logout = useCallback(async () => {
    await authApi.logout();
    setState({ status: 'anonymous' });
  }, []);

  const reload = useCallback(() => {
    setState({ status: 'loading' });
    setReloadCount((n) => n + 1);
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({ state, login, register, logout, reload }),
    [state, login, register, logout, reload],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
