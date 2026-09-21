import type { GoogleIdp, TokenIssuer, UserDirectory } from './ports';

export type GoogleLoginInput = {
  clientId: string;
  clientSecret: string;
  signingKey: string;
  code: string;
  redirectUri: string;
  codeVerifier: string;
};

export async function loginWithGoogle(
  deps: { idp: GoogleIdp; tokens: TokenIssuer; users: UserDirectory },
  input: GoogleLoginInput,
): Promise<
  | { ok: true; access_token: string; refresh_token: string }
  | { ok: false; status: 401 | 502; detail: string }
> {
  const google = await deps.idp.exchange({
    clientId: input.clientId,
    clientSecret: input.clientSecret,
    code: input.code,
    redirectUri: input.redirectUri,
    codeVerifier: input.codeVerifier,
  });
  if (!google.ok) return google;

  await deps.users.ensure(google.subject);
  const [access_token, refresh_token] = await Promise.all([
    deps.tokens.signAccess(input.signingKey, google.subject),
    deps.tokens.signRefresh(input.signingKey, google.subject),
  ]);
  return { ok: true, access_token, refresh_token };
}
