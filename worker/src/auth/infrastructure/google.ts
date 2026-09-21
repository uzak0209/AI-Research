import { z } from 'zod';
import { googleSubject } from '../domain';
import type { GoogleIdp } from '../application/ports';

export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const GOOGLE_USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo';

const tokenResponseSchema = z.object({
  access_token: z.string().min(1).optional(),
  error: z.string().optional(),
  error_description: z.string().optional(),
});

const userSchema = z.object({
  sub: z.string().min(1),
});

export type GoogleLoginOk = { ok: true; subject: string };
export type GoogleLoginFail = { ok: false; status: 401 | 502; detail: string };

/**
 * code を Google の access に換え、OpenID `sub` だけ取る。
 * Google のトークンは呼び出し元に返さない。
 */
export async function exchangeGoogleCode(
  opts: {
    clientId: string;
    clientSecret: string;
    code: string;
    redirectUri: string;
    codeVerifier: string;
  },
  fetchImpl: typeof fetch = fetch,
): Promise<GoogleLoginOk | GoogleLoginFail> {
  const tokenRes = await fetchImpl(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: opts.clientId,
      client_secret: opts.clientSecret,
      code: opts.code,
      redirect_uri: opts.redirectUri,
      grant_type: 'authorization_code',
      code_verifier: opts.codeVerifier,
    }),
  });
  if (tokenRes.status >= 500) return { ok: false, status: 502, detail: 'google token' };
  let tokenJson: unknown;
  try {
    tokenJson = await tokenRes.json();
  } catch {
    return { ok: false, status: 502, detail: 'google token' };
  }
  const token = tokenResponseSchema.safeParse(tokenJson);
  if (!token.success || token.data.error || !token.data.access_token) {
    return { ok: false, status: 401, detail: 'google authorization failed' };
  }

  const userRes = await fetchImpl(GOOGLE_USERINFO_URL, {
    headers: { authorization: `Bearer ${token.data.access_token}` },
  });
  if (!userRes.ok) {
    return { ok: false, status: userRes.status >= 500 ? 502 : 401, detail: 'google userinfo' };
  }
  let userJson: unknown;
  try {
    userJson = await userRes.json();
  } catch {
    return { ok: false, status: 502, detail: 'google userinfo' };
  }
  const user = userSchema.safeParse(userJson);
  if (!user.success) return { ok: false, status: 502, detail: 'google userinfo' };

  return { ok: true, subject: googleSubject(user.data.sub) };
}

export function googleIdp(fetchImpl: typeof fetch = fetch): GoogleIdp {
  return {
    exchange: (opts) => exchangeGoogleCode(opts, fetchImpl),
  };
}
