import type { Env } from '../env';
import { requireAccess, requireRefresh } from './application/guard';
import { loginWithGoogle } from './application/login';
import { googleIdp } from './infrastructure/google';
import { joseTokens } from './infrastructure/jwt';
import { d1UsageStore } from '../usage/infrastructure/d1';

export function createAuth(env: Env) {
  const tokens = joseTokens();
  const guard = { signingKey: env.JWT_SIGNING_KEY, tokens };
  const users = d1UsageStore(env.DB);
  return {
    requireAccess: (request: Request) => requireAccess(guard, request),
    requireRefresh: (token: string) => requireRefresh(guard, token),
    loginGoogle: (input: {
      clientId: string;
      clientSecret: string;
      signingKey: string;
      code: string;
      redirectUri: string;
      codeVerifier: string;
    }) => loginWithGoogle({ idp: googleIdp(), tokens, users: { ensure: (s) => users.ensureUser(s) } }, input),
  };
}

export { googleSubject, isLoopbackRedirect } from './domain';
export {
  bearerFrom,
  signAccessToken,
  signRefreshToken,
  verifyToken,
} from './infrastructure/jwt';
export { exchangeGoogleCode, GOOGLE_TOKEN_URL, GOOGLE_USERINFO_URL } from './infrastructure/google';
export type { AuthFail, AuthOk } from './application/ports';
