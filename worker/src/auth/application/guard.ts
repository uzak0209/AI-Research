import type { AuthFail, AuthGuardDeps, AuthOk } from './ports';

export async function requireAccess(deps: AuthGuardDeps, request: Request): Promise<AuthOk | AuthFail> {
  const secret = deps.signingKey;
  if (!secret) {
    return {
      ok: false,
      status: 501,
      body: { error: 'not_implemented', detail: 'JWT_SIGNING_KEY が未設定' },
    };
  }
  const token = deps.tokens.bearerFrom(request);
  if (!token) {
    return { ok: false, status: 401, body: { error: 'unauthorized' } };
  }
  try {
    const payload = await deps.tokens.verify(secret, token);
    if (payload.typ !== 'access' || !payload.sub) {
      return { ok: false, status: 401, body: { error: 'unauthorized' } };
    }
    return { ok: true, payload };
  } catch {
    return { ok: false, status: 401, body: { error: 'unauthorized' } };
  }
}

export async function requireRefresh(deps: AuthGuardDeps, token: string): Promise<AuthOk | AuthFail> {
  const secret = deps.signingKey;
  if (!secret) {
    return {
      ok: false,
      status: 501,
      body: { error: 'not_implemented', detail: 'JWT_SIGNING_KEY が未設定' },
    };
  }
  try {
    const payload = await deps.tokens.verify(secret, token);
    if (payload.typ !== 'refresh' || !payload.sub) {
      return { ok: false, status: 401, body: { error: 'unauthorized' } };
    }
    return { ok: true, payload };
  } catch {
    return { ok: false, status: 401, body: { error: 'unauthorized' } };
  }
}
