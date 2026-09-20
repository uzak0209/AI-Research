import type { JWTPayload } from 'jose';
import { bearerFrom, verifyToken } from './jwt';
import type { Env } from '../env';

export type AuthFail = {
  ok: false;
  status: 401 | 501;
  body: { error: string; detail?: string };
};

export type AuthOk = { ok: true; payload: JWTPayload };

export async function requireAccess(env: Env, request: Request): Promise<AuthOk | AuthFail> {
  const secret = env.JWT_SIGNING_KEY;
  if (!secret) {
    return {
      ok: false,
      status: 501,
      body: { error: 'not_implemented', detail: 'JWT_SIGNING_KEY が未設定' },
    };
  }
  const token = bearerFrom(request);
  if (!token) {
    return { ok: false, status: 401, body: { error: 'unauthorized' } };
  }
  try {
    const payload = await verifyToken(secret, token);
    if (payload.typ !== 'access' || !payload.sub) {
      return { ok: false, status: 401, body: { error: 'unauthorized' } };
    }
    return { ok: true, payload };
  } catch {
    return { ok: false, status: 401, body: { error: 'unauthorized' } };
  }
}

export async function requireRefresh(env: Env, token: string): Promise<AuthOk | AuthFail> {
  const secret = env.JWT_SIGNING_KEY;
  if (!secret) {
    return {
      ok: false,
      status: 501,
      body: { error: 'not_implemented', detail: 'JWT_SIGNING_KEY が未設定' },
    };
  }
  try {
    const payload = await verifyToken(secret, token);
    if (payload.typ !== 'refresh' || !payload.sub) {
      return { ok: false, status: 401, body: { error: 'unauthorized' } };
    }
    return { ok: true, payload };
  } catch {
    return { ok: false, status: 401, body: { error: 'unauthorized' } };
  }
}
