import { Navigate, Outlet, useLocation } from 'react-router';
import { useAuth } from './auth-context';
import { LoadingScreen, UnavailableScreen } from './AuthStatusScreens';

interface RedirectState {
  from?: { pathname: string; search: string };
}

/** Layout route: renders the nested routes only for a signed-in user, otherwise sends them to /login. */
export function RequireAuth() {
  const { state } = useAuth();
  const location = useLocation();

  switch (state.status) {
    case 'loading':
      return <LoadingScreen />;
    case 'unavailable':
      return <UnavailableScreen />;
    case 'anonymous':
      // Remember where they were heading so signing in can take them back there.
      return <Navigate to="/login" replace state={{ from: location } satisfies RedirectState} />;
    case 'authenticated':
      return <Outlet />;
  }
}

/** Layout route for /login and /register: a signed-in user has no business there. */
export function RedirectIfAuthenticated() {
  const { state } = useAuth();
  const location = useLocation();

  switch (state.status) {
    case 'loading':
      return <LoadingScreen />;
    case 'unavailable':
      return <UnavailableScreen />;
    case 'authenticated': {
      const from = (location.state as RedirectState | null)?.from;
      return <Navigate to={from ? `${from.pathname}${from.search}` : '/'} replace />;
    }
    case 'anonymous':
      return <Outlet />;
  }
}
