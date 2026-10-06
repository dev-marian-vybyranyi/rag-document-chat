import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { jsonResponse, stubFetch } from '../../test/fetch';
import { ApiError } from '../../lib/api';
import { AuthProvider } from './AuthProvider';
import { useAuth } from './auth-context';

const ada = { id: 'u1', email: 'ada@example.com' };
const credentials = { email: ada.email, password: 'correct horse battery' };
const unauthenticated = {
  error: { code: 'unauthenticated', message: 'Sign in to continue' },
};

function renderAuth() {
  return renderHook(() => useAuth(), { wrapper: AuthProvider });
}

async function failureOf(action: () => Promise<unknown>): Promise<unknown> {
  let failure: unknown;
  await act(async () => {
    try {
      await action();
    } catch (error) {
      failure = error;
    }
  });
  return failure;
}

describe('AuthProvider', () => {
  it('starts in the loading state while it asks who is signed in', () => {
    stubFetch().mockReturnValue(new Promise(() => {}));

    const { result } = renderAuth();

    expect(result.current.state).toEqual({ status: 'loading' });
  });

  it('recognises a signed-in user from the existing session', async () => {
    stubFetch().mockResolvedValue(jsonResponse(200, { user: ada }));

    const { result } = renderAuth();

    await waitFor(() =>
      expect(result.current.state).toEqual({ status: 'authenticated', user: ada }),
    );
  });

  it('is anonymous when the server answers 401', async () => {
    stubFetch().mockResolvedValue(jsonResponse(401, unauthenticated));

    const { result } = renderAuth();

    await waitFor(() => expect(result.current.state).toEqual({ status: 'anonymous' }));
  });

  it('is unavailable, not anonymous, when the server cannot be reached', async () => {
    stubFetch().mockResolvedValue(new Response('Bad Gateway', { status: 502 }));

    const { result } = renderAuth();

    await waitFor(() => expect(result.current.state).toEqual({ status: 'unavailable' }));
  });

  it('asks again on reload, e.g. after the server woke up', async () => {
    const fetchMock = stubFetch()
      .mockResolvedValueOnce(new Response('Bad Gateway', { status: 502 }))
      .mockResolvedValueOnce(jsonResponse(200, { user: ada }));
    const { result } = renderAuth();
    await waitFor(() => expect(result.current.state.status).toBe('unavailable'));

    act(() => result.current.reload());

    await waitFor(() => expect(result.current.state.status).toBe('authenticated'));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  describe('login', () => {
    it('signs the user in', async () => {
      stubFetch()
        .mockResolvedValueOnce(jsonResponse(401, unauthenticated))
        .mockResolvedValueOnce(jsonResponse(200, { user: ada }));
      const { result } = renderAuth();
      await waitFor(() => expect(result.current.state.status).toBe('anonymous'));

      await act(async () => {
        await result.current.login(credentials);
      });

      expect(result.current.state).toEqual({ status: 'authenticated', user: ada });
    });

    it('rejects with the ApiError and stays anonymous on wrong credentials', async () => {
      stubFetch()
        .mockResolvedValueOnce(jsonResponse(401, unauthenticated))
        .mockResolvedValueOnce(
          jsonResponse(401, {
            error: { code: 'invalid_credentials', message: 'Incorrect email or password' },
          }),
        );
      const { result } = renderAuth();
      await waitFor(() => expect(result.current.state.status).toBe('anonymous'));

      const failure = await failureOf(() => result.current.login(credentials));

      expect(failure).toBeInstanceOf(ApiError);
      expect(failure).toMatchObject({ code: 'invalid_credentials' });
      expect(result.current.state).toEqual({ status: 'anonymous' });
    });
  });

  it('registers and signs in the new user in one step', async () => {
    stubFetch()
      .mockResolvedValueOnce(jsonResponse(401, unauthenticated))
      .mockResolvedValueOnce(jsonResponse(201, { user: ada }));
    const { result } = renderAuth();
    await waitFor(() => expect(result.current.state.status).toBe('anonymous'));

    await act(async () => {
      await result.current.register(credentials);
    });

    expect(result.current.state).toEqual({ status: 'authenticated', user: ada });
  });

  describe('logout', () => {
    it('signs the user out', async () => {
      stubFetch()
        .mockResolvedValueOnce(jsonResponse(200, { user: ada }))
        .mockResolvedValueOnce(jsonResponse(204));
      const { result } = renderAuth();
      await waitFor(() => expect(result.current.state.status).toBe('authenticated'));

      await act(async () => {
        await result.current.logout();
      });

      expect(result.current.state).toEqual({ status: 'anonymous' });
    });

    it('keeps the user signed in when the request fails, so it can be retried', async () => {
      stubFetch()
        .mockResolvedValueOnce(jsonResponse(200, { user: ada }))
        .mockRejectedValueOnce(new TypeError('Failed to fetch'));
      const { result } = renderAuth();
      await waitFor(() => expect(result.current.state.status).toBe('authenticated'));

      await failureOf(() => result.current.logout());

      expect(result.current.state).toEqual({ status: 'authenticated', user: ada });
    });
  });

  it('refuses to be used outside the provider', () => {
    expect(() => renderHook(() => useAuth())).toThrow('useAuth must be used inside <AuthProvider>');
  });
});
