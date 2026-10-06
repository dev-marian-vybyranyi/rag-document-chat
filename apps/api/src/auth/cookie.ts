import type { Response } from 'express';

export const SESSION_COOKIE = 'sid';

function cookieOptions(secure: boolean) {
  return { httpOnly: true, sameSite: 'lax' as const, secure, path: '/' };
}

export function setSessionCookie(res: Response, token: string, expiresAt: Date, secure: boolean) {
  res.cookie(SESSION_COOKIE, token, { ...cookieOptions(secure), expires: expiresAt });
}

export function clearSessionCookie(res: Response, secure: boolean) {
  res.clearCookie(SESSION_COOKIE, cookieOptions(secure));
}
