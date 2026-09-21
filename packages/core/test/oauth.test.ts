import { describe, expect, it } from 'vitest';
import { createPkce, googleAuthorizeUrl, parseOAuthCallback } from '../src/oauth';

describe('PKCE / Google authorize', () => {
  it('verifier を URL に載せない。scope は openid のみ（メールを取らない）', () => {
    const pkce = createPkce();
    expect(pkce.verifier).toHaveLength(43);
    const url = googleAuthorizeUrl({
      clientId: 'abc',
      redirectUri: 'http://127.0.0.1:9/callback',
      state: 'st',
      challenge: pkce.challenge,
    });
    expect(url).toContain('accounts.google.com');
    expect(url).toContain('response_type=code');
    expect(url).toContain('code_challenge_method=S256');
    expect(url).toContain('scope=openid');
    expect(url).not.toContain(pkce.verifier);
    expect(url).not.toContain('email');
    expect(url).not.toContain('profile');
  });

  it('callback の error を成功にしない', () => {
    expect(parseOAuthCallback('http://127.0.0.1:9/callback?error=access_denied')).toEqual({
      ok: false,
      error: 'access_denied',
    });
  });
});
