export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, string[]>,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  get isUnavailable(): boolean {
    return this.status === 0 || this.status >= 500;
  }
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  signal?: AbortSignal;
}

const BASE_URL = '/api';

let unauthorizedHandler: (() => void) | null = null;

export function onUnauthorized(handler: () => void): () => void {
  unauthorizedHandler = handler;
  return () => {
    if (unauthorizedHandler === handler) unauthorizedHandler = null;
  };
}

export function reportUnauthorized(): void {
  unauthorizedHandler?.();
}

export async function api<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, signal } = options;

  let response: Response;
  try {
    response = await fetch(`${BASE_URL}${path}`, {
      method,
      credentials: 'same-origin',
      headers:
        body === undefined || body instanceof FormData
          ? undefined
          : { 'Content-Type': 'application/json' },
      body: body === undefined || body instanceof FormData ? body : JSON.stringify(body),
      signal,
    });
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === 'AbortError') throw cause;
    throw new ApiError(0, 'network_error', 'Cannot reach the server. Check your connection.');
  }

  if (response.status === 204) return undefined as T;

  if (response.status === 401 && !path.startsWith('/auth/')) reportUnauthorized();
  if (!response.ok) throw await toApiError(response);
  return (await response.json()) as T;
}

async function toApiError(response: Response): Promise<ApiError> {
  try {
    const { error } = (await response.json()) as {
      error?: { code?: string; message?: string; details?: Record<string, string[]> };
    };
    if (error?.code && error.message) {
      return new ApiError(response.status, error.code, error.message, error.details);
    }
  } catch {
    // not JSON: fall through to the generic error
  }
  return new ApiError(
    response.status,
    'unexpected_response',
    `Request failed (${response.status})`,
  );
}
