import { describe, expect, it, vi } from 'vitest';
import { jsonResponse, stubFetch } from '../test/fetch';
import { api, ApiError, onUnauthorized } from './api';

describe('api client', () => {
  it('calls the API under /api with the session cookie and returns the JSON body', async () => {
    const fetchMock = stubFetch().mockResolvedValue(jsonResponse(200, { hello: 'world' }));

    const result = await api<{ hello: string }>('/things');

    expect(result).toEqual({ hello: 'world' });
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/things',
      expect.objectContaining({ method: 'GET', credentials: 'same-origin' }),
    );
  });

  it('sends the body as JSON with a matching content type', async () => {
    const fetchMock = stubFetch().mockResolvedValue(jsonResponse(200, {}));

    await api('/things', { method: 'POST', body: { name: 'a' } });

    const init = fetchMock.mock.calls[0]![1]!;
    expect(init.body).toBe('{"name":"a"}');
    expect(init.headers).toEqual({ 'Content-Type': 'application/json' });
  });

  it('returns undefined for an empty 204 response', async () => {
    stubFetch().mockResolvedValue(jsonResponse(204));

    expect(await api('/auth/logout', { method: 'POST' })).toBeUndefined();
  });

  it('turns the API error contract into an ApiError', async () => {
    stubFetch().mockResolvedValue(
      jsonResponse(400, {
        error: {
          code: 'validation_error',
          message: 'Request validation failed',
          details: { email: ['Enter a valid email address'] },
        },
      }),
    );

    const error = await api('/auth/register').catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      status: 400,
      code: 'validation_error',
      message: 'Request validation failed',
      details: { email: ['Enter a valid email address'] },
    });
  });

  it('copes with a non-JSON error page from a proxy', async () => {
    stubFetch().mockResolvedValue(new Response('<html>Bad Gateway</html>', { status: 502 }));

    const error = await api('/health').catch((e: unknown) => e);

    expect(error).toMatchObject({ status: 502, code: 'unexpected_response' });
    expect((error as ApiError).isUnavailable).toBe(true);
  });

  it('reports a lost connection as an unavailable ApiError', async () => {
    stubFetch().mockRejectedValue(new TypeError('Failed to fetch'));

    const error = await api('/health').catch((e: unknown) => e);

    expect(error).toMatchObject({ status: 0, code: 'network_error' });
    expect((error as ApiError).isUnavailable).toBe(true);
  });

  it('does not treat client errors as unavailability', async () => {
    stubFetch().mockResolvedValue(
      jsonResponse(401, { error: { code: 'unauthenticated', message: 'Sign in to continue' } }),
    );

    const error = await api('/auth/me').catch((e: unknown) => e);

    expect((error as ApiError).isUnavailable).toBe(false);
  });

  it('lets an aborted request propagate as an abort, not as an API error', async () => {
    stubFetch().mockRejectedValue(new DOMException('Aborted', 'AbortError'));

    await expect(api('/things')).rejects.toMatchObject({ name: 'AbortError' });
  });

  describe('an expired session', () => {
    const unauthenticated = { error: { code: 'unauthenticated', message: 'Sign in to continue' } };

    it('is reported once for a request to a protected endpoint, which still fails as usual', async () => {
      stubFetch().mockResolvedValue(jsonResponse(401, unauthenticated));
      const handler = vi.fn();
      const stop = onUnauthorized(handler);

      await expect(api('/chats')).rejects.toMatchObject({ status: 401 });

      expect(handler).toHaveBeenCalledTimes(1);
      stop();
    });

    it.each(['/auth/login', '/auth/me', '/auth/logout'])(
      'is not reported for %s, where a 401 is an ordinary answer',
      async (path) => {
        stubFetch().mockResolvedValue(jsonResponse(401, unauthenticated));
        const handler = vi.fn();
        const stop = onUnauthorized(handler);

        await expect(api(path)).rejects.toBeInstanceOf(ApiError);

        expect(handler).not.toHaveBeenCalled();
        stop();
      },
    );

    it('is not reported for other errors', async () => {
      stubFetch().mockResolvedValue(
        jsonResponse(404, { error: { code: 'not_found', message: 'x' } }),
      );
      const handler = vi.fn();
      const stop = onUnauthorized(handler);

      await expect(api('/chats/x')).rejects.toBeInstanceOf(ApiError);

      expect(handler).not.toHaveBeenCalled();
      stop();
    });

    it('stops being reported once the listener is removed', async () => {
      stubFetch().mockResolvedValue(jsonResponse(401, unauthenticated));
      const handler = vi.fn();
      onUnauthorized(handler)();

      await expect(api('/chats')).rejects.toBeInstanceOf(ApiError);

      expect(handler).not.toHaveBeenCalled();
    });
  });
});
