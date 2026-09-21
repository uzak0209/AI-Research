export type AccessClaims = { typ?: unknown; sub?: string };

export type AuthFail = {
  ok: false;
  status: 401 | 501;
  body: { error: string; detail?: string };
};

export type AuthOk = { ok: true; payload: AccessClaims };

export type TokenVerifier = {
  verify(secret: string, token: string): Promise<AccessClaims>;
  bearerFrom(request: Request): string | null;
};

export type TokenIssuer = {
  signAccess(secret: string, sub: string): Promise<string>;
  signRefresh(secret: string, sub: string): Promise<string>;
};

export type GoogleIdp = {
  exchange(opts: {
    clientId: string;
    clientSecret: string;
    code: string;
    redirectUri: string;
    codeVerifier: string;
  }): Promise<{ ok: true; subject: string } | { ok: false; status: 401 | 502; detail: string }>;
};

export type UserDirectory = {
  ensure(oauthSubject: string): Promise<string>;
};

export type AuthGuardDeps = {
  signingKey?: string;
  tokens: TokenVerifier;
};
