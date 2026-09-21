import { createServer } from 'node:http';
import {
  createPkce,
  googleAuthorizeUrl,
  parseOAuthCallback,
  randomOAuthState,
  type CloudClient,
} from '@ai-research/core';

const DONE_HTML = `<!doctype html><meta charset="utf-8"><title>AI-Research</title>
<p>ログインしました。このウィンドウを閉じてアプリに戻ってください。</p>`;
const FAIL_HTML = `<!doctype html><meta charset="utf-8"><title>AI-Research</title>
<p>ログインできませんでした。このウィンドウを閉じてください。</p>`;

/**
 * 127.0.0.1 で code を受け、BFF に渡す。トークンは CloudClient が session に書く。
 * レンダラには出さない（ADR-0001）。
 */
export async function runGoogleLogin(
  client: CloudClient,
  openExternal: (url: string) => Promise<void>,
): Promise<void> {
  const clientId = await client.googleClientId();
  const pkce = createPkce();
  const state = randomOAuthState();

  const { redirectUri, code } = await waitForCode(async (redirectUri) => {
    await openExternal(
      googleAuthorizeUrl({
        clientId,
        redirectUri,
        state,
        challenge: pkce.challenge,
      }),
    );
  });

  if (code.state !== state) throw new Error('oauth state mismatch');
  await client.loginGoogle({
    code: code.code,
    code_verifier: pkce.verifier,
    redirect_uri: redirectUri,
  });
}

function waitForCode(
  onReady: (redirectUri: string) => Promise<void>,
): Promise<{ redirectUri: string; code: { code: string; state: string } }> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = `http://127.0.0.1${req.url ?? '/'}`;
      let pathname = '/';
      try {
        pathname = new URL(url).pathname;
      } catch {
        res.writeHead(400).end();
        return;
      }
      if (pathname !== '/callback') {
        res.writeHead(404).end();
        return;
      }
      const parsed = parseOAuthCallback(url);
      if (!parsed.ok) {
        res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' });
        res.end(FAIL_HTML);
        server.close();
        reject(new Error(parsed.error));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(DONE_HTML);
      server.close();
      resolve({ redirectUri, code: { code: parsed.code, state: parsed.state } });
    });

    let redirectUri = '';
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = addr && typeof addr === 'object' ? addr.port : 0;
      redirectUri = `http://127.0.0.1:${port}/callback`;
      void onReady(redirectUri).catch((e) => {
        server.close();
        reject(e);
      });
    });

    const timer = setTimeout(() => {
      server.close();
      reject(new Error('oauth timeout'));
    }, 5 * 60 * 1000);
    server.on('close', () => clearTimeout(timer));
  });
}
