import { Navigate, Outlet, useLocation } from 'react-router';
import { useAuth } from './auth-context';
import { LoadingScreen, UnavailableScreen } from './AuthStatusScreens';

interface RedirectState {
  from?: { pathname: string; search: string };
  expired?: boolean;
}

export function RequireAuth() {
  const { state } = useAuth();
  const location = useLocation();

  switch (state.status) {
    case 'loading':
      return <LoadingScreen />;
    case 'unavailable':
      return <UnavailableScreen />;
    case 'anonymous':
      return (
        <Navigate
          to="/login"
          replace
          state={{ from: location, expired: state.expired === true } satisfies RedirectState}
        />
      );
    case 'authenticated':
      return <Outlet />;
  }
}

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
