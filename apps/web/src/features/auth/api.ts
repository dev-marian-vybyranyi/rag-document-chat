import { api } from '../../lib/api';

export interface User {
  id: string;
  email: string;
}

export interface Credentials {
  email: string;
  password: string;
}

interface UserResponse {
  user: User;
}

export const authApi = {
  me: (signal?: AbortSignal) => api<UserResponse>('/auth/me', { signal }).then((r) => r.user),
  register: (credentials: Credentials) =>
    api<UserResponse>('/auth/register', { method: 'POST', body: credentials }).then((r) => r.user),
  login: (credentials: Credentials) =>
    api<UserResponse>('/auth/login', { method: 'POST', body: credentials }).then((r) => r.user),
  logout: () => api<void>('/auth/logout', { method: 'POST' }),
};
