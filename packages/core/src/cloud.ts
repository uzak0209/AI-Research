import type { AuthSession } from './session';

export class NotSignedInError extends Error {
  constructor() {
    super('not signed in');
    this.name = 'NotSignedInError';
  }
}

type TokenResponse = {
  access_token: string;
  token_type: string;
  expires_in: number;
};

/**
 * access を Authorization に載せる。401 なら refresh して一度だけやり直す。
 * レンダラから呼ばない。メイン / CLI だけ。
 */
export class CloudClient {
  constructor(
    private readonly endpoint: string,
    private readonly session: AuthSession,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async refreshAccess(): Promise<string> {
    const refresh = this.session.getRefreshToken();
    if (!refresh) throw new NotSignedInError();
    const res = await this.fetchImpl(new URL('/auth/refresh', this.endpoint), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refresh_token: refresh }),
    });
    if (!res.ok) {
      if (res.status === 401) this.session.clear();
      throw new Error(`refresh failed: ${res.status}`);
    }
    const body = (await res.json()) as TokenResponse;
    this.session.setAccessToken(body.access_token);
    return body.access_token;
  }

  async fetch(path: string, init: RequestInit = {}): Promise<Response> {
    let access = this.session.getAccessToken() ?? (await this.refreshAccess());
    const send = (token: string) => {
      const headers = new Headers(init.headers);
      headers.set('Authorization', `Bearer ${token}`);
      return this.fetchImpl(new URL(path, this.endpoint), { ...init, headers });
    };
    let res = await send(access);
    if (res.status === 401) {
      access = await this.refreshAccess();
      res = await send(access);
    }
    return res;
  }
}
