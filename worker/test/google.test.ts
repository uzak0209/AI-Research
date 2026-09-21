import { afterEach, describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { handleFetch } from '../src/index';
import { googleSubject, isLoopbackRedirect, GOOGLE_TOKEN_URL, GOOGLE_USERINFO_URL, verifyToken } from '../src/auth';

const googleEnv = {
  ...env,
  GOOGLE_OAUTH_CLIENT_ID: 'client-public',
  GOOGLE_OAUTH_CLIENT_SECRET: 'client-secret',
};

function post(body: unknown) {
  return handleFetch(
    new Request('https://api.test/auth/google', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    googleEnv,
  );
}

describe('isLoopbackRedirect', () => {
  it('127.0.0.1 だけ許す', () => {
    expect(isLoopbackRedirect('http://127.0.0.1:54321/callback')).toBe(true);
    expect(isLoopbackRedirect('http://localhost:54321/callback')).toBe(false);
    expect(isLoopbackRedirect('https://evil.example/http://127.0.0.1')).toBe(false);
  });
});

describe('GET /auth/google', () => {
  it('鍵が無ければ 501。client_secret は出さない', async () => {
    const res = await handleFetch(new Request('https://api.test/auth/google'), {
      ...env,
      GOOGLE_OAUTH_CLIENT_ID: undefined,
      GOOGLE_OAUTH_CLIENT_SECRET: undefined,
    });
    expect(res.status).toBe(501);
  });

  it('client_id だけ返す', async () => {
    const res = await handleFetch(new Request('https://api.test/auth/google'), googleEnv);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, string>;
    expect(body.client_id).toBe('client-public');
    expect(JSON.stringify(body)).not.toContain('client-secret');
  });
});

describe('POST /auth/google', () => {
  afterEach(() => vi.restoreAllMocks());

  it('redirect_uri がループバックでなければ 400', async () => {
    const res = await post({
      code: 'c',
      code_verifier: 'a'.repeat(43),
      redirect_uri: 'https://evil.example/cb',
    });
    expect(res.status).toBe(400);
  });

  it('Google が拒否したら 401。secret は出さない', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 }),
    );
    const res = await post({
      code: 'c',
      code_verifier: 'a'.repeat(43),
      redirect_uri: 'http://127.0.0.1:9/callback',
    });
    expect(res.status).toBe(401);
    const text = await res.text();
    expect(text).not.toContain('client-secret');
  });

  it('sub だけ残し、自前 JWT を返す。メールは持たない', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url === GOOGLE_TOKEN_URL) {
        return new Response(JSON.stringify({ access_token: 'ya29-not-ours' }), { status: 200 });
      }
      if (url === GOOGLE_USERINFO_URL) {
        return new Response(
          JSON.stringify({ sub: '118234567890', email: 'x@example.com', name: 'Someone' }),
          { status: 200 },
        );
      }
      return new Response('no', { status: 500 });
    });

    const res = await post({
      code: 'c',
      code_verifier: 'a'.repeat(43),
      redirect_uri: 'http://127.0.0.1:9/callback',
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { access_token: string; refresh_token: string };
    expect(body.refresh_token).toBeTruthy();
    expect(JSON.stringify(body)).not.toContain('ya29-not-ours');
    expect(JSON.stringify(body)).not.toContain('x@example.com');

    const payload = await verifyToken(env.JWT_SIGNING_KEY, body.access_token);
    expect(payload.sub).toBe(googleSubject('118234567890'));
    expect(payload.typ).toBe('access');

    const row = await env.DB.prepare('SELECT user_id, oauth_subject FROM users WHERE oauth_subject = ?')
      .bind('google:118234567890')
      .first<{ user_id: string; oauth_subject: string }>();
    expect(row?.oauth_subject).toBe('google:118234567890');
  });
});
