import { createContext, useContext } from 'react';
import type { Credentials, User } from './api';

export type AuthState =
  | { status: 'loading' }
  | { status: 'anonymous' }
  | { status: 'unavailable' }
  | { status: 'authenticated'; user: User };

export interface AuthContextValue {
  state: AuthState;
  login: (credentials: Credentials) => Promise<void>;
  register: (credentials: Credentials) => Promise<void>;
  logout: () => Promise<void>;
  reload: () => void;
}

export const AuthContext = createContext<AuthContextValue | null>(null);

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth must be used inside <AuthProvider>');
  return value;
}
