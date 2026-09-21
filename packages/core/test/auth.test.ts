import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CloudClient, NotSignedInError } from '../src/cloud';
import { electronBox, testBox } from '../src/secret-box';
import { AuthSession } from '../src/session';
import { REFRESH_KEY, createSettingsStore } from '../src/settings';

function session() {
  const db = new Database(':memory:');
  const store = createSettingsStore(db);
  return { store, auth: new AuthSession(store, testBox()) };
}

describe('AuthSession', () => {
  it('refresh は encrypted で残り、access は settings に出ない', () => {
    const { auth, store } = session();
    auth.setRefreshToken('refresh-plain');
    auth.setAccessToken('access-plain');

    const row = store.get(REFRESH_KEY);
    expect(row?.encrypted).toBe(true);
    expect(row?.value).not.toContain('refresh-plain');
    expect(store.get('auth.access_token')).toBeNull();
    expect(auth.getAccessToken()).toBe('access-plain');
    expect(auth.getRefreshToken()).toBe('refresh-plain');
  });

  it('平文で残っていた refresh は読まない', () => {
    const { auth, store } = session();
    store.set(REFRESH_KEY, 'leaked', false);
    expect(() => auth.getRefreshToken()).toThrow(/平文/);
  });

  it('clear で両方消える', () => {
    const { auth, store } = session();
    auth.setRefreshToken('r');
    auth.setAccessToken('a');
    auth.clear();
    expect(auth.getAccessToken()).toBeNull();
    expect(store.get(REFRESH_KEY)).toBeNull();
  });

  it('保護領域が使えないと refresh を書かない', () => {
    const db = new Database(':memory:');
    const box = {
      isAvailable: () => false,
      encrypt: () => Buffer.from('x'),
      decrypt: () => '',
    };
    const auth = new AuthSession(createSettingsStore(db), box);
    expect(() => auth.setRefreshToken('r')).toThrow(/保護領域/);
  });
});

describe('electronBox', () => {
  it('safeStorage に委譲する', () => {
    const api = {
      isEncryptionAvailable: () => true,
      encryptString: (s: string) => Buffer.from(`enc:${s}`),
      decryptString: (b: Buffer) => b.toString().slice(4),
    };
    const box = electronBox(api);
    const enc = box.encrypt('secret');
    expect(enc.toString()).toBe('enc:secret');
    expect(box.decrypt(enc)).toBe('secret');
  });
});

describe('CloudClient', () => {
  afterEach(() => vi.restoreAllMocks());

  it('未ログインなら refresh しない', async () => {
    const { auth } = session();
    const client = new CloudClient('https://api.test', auth);
    await expect(client.fetch('/runs')).rejects.toBeInstanceOf(NotSignedInError);
  });

  it('access が無ければ refresh して Bearer を付ける', async () => {
    const { auth } = session();
    auth.setRefreshToken('refresh-1');
    const fetchImpl = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/auth/refresh')) {
        return new Response(JSON.stringify({ access_token: 'new-access', token_type: 'bearer', expires_in: 900 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      const headers = new Headers(init?.headers);
      expect(headers.get('Authorization')).toBe('Bearer new-access');
      return new Response(JSON.stringify({ error: 'not_implemented' }), { status: 501 });
    });
    const client = new CloudClient('https://api.test', auth, fetchImpl as unknown as typeof fetch);
    const res = await client.fetch('/runs');
    expect(res.status).toBe(501);
    expect(auth.getAccessToken()).toBe('new-access');
  });

  it('401 なら refresh して一度だけやり直す', async () => {
    const { auth } = session();
    auth.setRefreshToken('refresh-1');
    auth.setAccessToken('stale');
    let runs = 0;
    const fetchImpl = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.endsWith('/auth/refresh')) {
        return new Response(JSON.stringify({ access_token: 'fresh', token_type: 'bearer', expires_in: 900 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      runs++;
      if (runs === 1) return new Response('nope', { status: 401 });
      return new Response('ok', { status: 200 });
    });
    const client = new CloudClient('https://api.test', auth, fetchImpl as unknown as typeof fetch);
    const res = await client.fetch('/runs');
    expect(res.status).toBe(200);
    expect(runs).toBe(2);
    expect(auth.getAccessToken()).toBe('fresh');
  });

  it('trends は POST /bff/trends に topic だけ送る', async () => {
    const { auth } = session();
    auth.setAccessToken('access-1');
    const fetchImpl = vi.fn(async (_input: string | URL, init?: RequestInit) => {
      expect(init?.method).toBe('POST');
      expect(init?.body).toBe(JSON.stringify({ topic: 'DPDK' }));
      const headers = new Headers(init?.headers);
      expect(headers.get('Authorization')).toBe('Bearer access-1');
      return new Response(JSON.stringify({ classification: 'C1', summary: null, papers: [] }), {
        status: 200,
      });
    });
    const client = new CloudClient('https://api.test', auth, fetchImpl as unknown as typeof fetch);
    const res = await client.trends('DPDK');
    expect(res.status).toBe(200);
    expect(String(fetchImpl.mock.calls[0]?.[0])).toContain('/bff/trends');
  });

  it('bibliography は POST /bff/bibliography に hint だけ送る', async () => {
    const { auth } = session();
    auth.setAccessToken('access-1');
    const hint = { doi: '10.1234/foo', title: 'A study of DPDK' };
    const fetchImpl = vi.fn(async (_input: string | URL, init?: RequestInit) => {
      expect(init?.method).toBe('POST');
      expect(init?.body).toBe(JSON.stringify(hint));
      const headers = new Headers(init?.headers);
      expect(headers.get('Authorization')).toBe('Bearer access-1');
      return new Response(
        JSON.stringify({
          classification: 'C1',
          model: 'jev-1.13.0',
          record: { title: 'A study of DPDK', authors: null, year: null, doi: '10.1234/foo', url: null, venue: null, abstract: null, item_type: 'article' },
        }),
        { status: 200 },
      );
    });
    const client = new CloudClient('https://api.test', auth, fetchImpl as unknown as typeof fetch);
    const res = await client.bibliography(hint);
    expect(res.status).toBe(200);
    expect(String(fetchImpl.mock.calls[0]?.[0])).toContain('/bff/bibliography');
  });

  it('loginGoogle は refresh を session に残し、Google の access は持たない', async () => {
    const { auth } = session();
    const fetchImpl = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          access_token: 'ours-access',
          refresh_token: 'ours-refresh',
          token_type: 'bearer',
          expires_in: 900,
        }),
        { status: 200 },
      );
    });
    const client = new CloudClient('https://api.test', auth, fetchImpl as unknown as typeof fetch);
    await client.loginGoogle({
      code: 'c',
      code_verifier: 'v'.repeat(43),
      redirect_uri: 'http://127.0.0.1:9/callback',
    });
    expect(auth.getAccessToken()).toBe('ours-access');
    expect(auth.getRefreshToken()).toBe('ours-refresh');
    expect(String(fetchImpl.mock.calls[0]?.[0])).toContain('/auth/google');
    expect(fetchImpl.mock.calls[0]?.[1]?.headers).not.toHaveProperty('Authorization');
  });

  it('pullRuns は GET /runs に project_id と after を付ける', async () => {
    const { auth } = session();
    auth.setAccessToken('access-1');
    const fetchImpl = vi.fn(async (input: string | URL) => {
      const url = String(input);
      expect(url).toContain('/runs?');
      expect(url).toContain('project_id=proj-1');
      expect(url).toContain('after=run-a');
      return new Response(JSON.stringify({ project_id: 'proj-1', runs: [] }), { status: 200 });
    });
    const client = new CloudClient('https://api.test', auth, fetchImpl as unknown as typeof fetch);
    const body = await client.pullRuns('proj-1', 'run-a');
    expect(body.project_id).toBe('proj-1');
  });

  it('pullRuns は非 200 で throw する', async () => {
    const { auth } = session();
    auth.setAccessToken('access-1');
    const fetchImpl = vi.fn(async () => new Response('nope', { status: 403 }));
    const client = new CloudClient('https://api.test', auth, fetchImpl as unknown as typeof fetch);
    await expect(client.pullRuns('proj-1')).rejects.toThrow(/403/);
  });

  it('putProject は PUT /projects/{id} に title と summary を送る', async () => {
    const { auth } = session();
    auth.setAccessToken('access-1');
    const fetchImpl = vi.fn(async (input: string | URL, init?: RequestInit) => {
      expect(String(input)).toContain('/projects/proj-1');
      expect(init?.method).toBe('PUT');
      expect(init?.body).toBe(JSON.stringify({ title: 'T', summary: 'S' }));
      return new Response(JSON.stringify({ project_id: 'proj-1', title: 'T', summary: 'S' }), {
        status: 200,
      });
    });
    const client = new CloudClient('https://api.test', auth, fetchImpl as unknown as typeof fetch);
    const body = await client.putProject('proj-1', { title: 'T', summary: 'S' });
    expect(body.summary).toBe('S');
  });
});
