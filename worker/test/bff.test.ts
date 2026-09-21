import { env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { signAccessToken } from '../src/auth/jwt';
import { handleFetch } from '../src/index';
import { ORCA_CHAT_URL } from '../src/orca';
import { trendPrompt } from '../src/trend';
import { utcDate } from '../src/date';

const PROJECT_USER = 'u1';

async function seedUser() {
  await env.DB.prepare('INSERT OR IGNORE INTO users (user_id, oauth_subject) VALUES (?, ?)').bind(
    PROJECT_USER,
    'sub-1',
  ).run();
}

async function clearUsage() {
  await env.DB.prepare('DELETE FROM llm_usage').run();
}

async function authed(path: string, init: RequestInit = {}, bindings: typeof env = env) {
  const token = await signAccessToken(env.JWT_SIGNING_KEY, 'sub-1');
  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${token}`);
  if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json');
  return handleFetch(new Request(`https://api.test${path}`, { ...init, headers }), bindings);
}

function orcaBody(content: string, model = 'openai/gpt-4o-mini') {
  return {
    model,
    choices: [{ message: { role: 'assistant', content } }],
    usage: { prompt_tokens: 11, completion_tokens: 19, total_tokens: 30, cost_usd: 0.0004 },
  };
}

function mockUpstream(opts: {
  papers?: unknown[];
  openalexStatus?: number;
  orca?: unknown;
  orcaStatus?: number;
  orcaHeaders?: HeadersInit;
}) {
  const calls: { url: string; init?: RequestInit }[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.includes('openalex.org')) {
      const status = opts.openalexStatus ?? 200;
      return new Response(JSON.stringify({ results: opts.papers ?? [] }), { status });
    }
    if (url.startsWith(ORCA_CHAT_URL) || url.includes('orcarouter.ai')) {
      const status = opts.orcaStatus ?? 200;
      return new Response(JSON.stringify(opts.orca ?? orcaBody('trend summary')), {
        status,
        headers: opts.orcaHeaders,
      });
    }
    return new Response('unexpected fetch', { status: 500 });
  });
  return calls;
}

beforeEach(async () => {
  await seedUser();
  await clearUsage();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('POST /bff/trends（C1）', () => {
  it('Bearer 無しなら 401。自由プロキシにしない（ADR-0002）', async () => {
    const res = await handleFetch(
      new Request('https://api.test/bff/trends', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ topic: 'DPDK' }),
      }),
      env,
    );
    expect(res.status).toBe(401);
  });

  it('鍵が無いなら 501。成功したふりをしない（C-07）', async () => {
    const res = await authed(
      '/bff/trends',
      { method: 'POST', body: JSON.stringify({ topic: 'DPDK' }) },
      { ...env, ORCAROUTER_API_KEY: undefined, ORCAROUTER_API_KEY_INTERACTIVE: undefined },
    );
    expect(res.status).toBe(501);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('not_implemented');
  });

  it('公開論文が 0 件なら summary は null。Orca を呼ばない（C-07）', async () => {
    const calls = mockUpstream({ papers: [] });
    const res = await authed('/bff/trends', {
      method: 'POST',
      body: JSON.stringify({ topic: 'DPDK' }),
    });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      classification: 'C1',
      summary: null,
      papers: [],
    });
    expect(calls.some((c) => c.url.includes('orcarouter'))).toBe(false);
  });

  it('OpenAlex が落ちたら 502。捏造しない', async () => {
    mockUpstream({ openalexStatus: 503 });
    const res = await authed('/bff/trends', {
      method: 'POST',
      body: JSON.stringify({ topic: 'DPDK' }),
    });
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string; detail?: string };
    expect(body.error).toBe('source_failed');
    expect(body.detail).toBe('openalex status=503');
    expect(JSON.stringify(body)).not.toContain('test-orca-key');
  });

  it('Orca が落ちたら 502。usage は増やさない', async () => {
    mockUpstream({
      papers: [{ id: 'https://openalex.org/W1', display_name: 'DPDK at 100Gbps', publication_date: '2026-06-16' }],
      orcaStatus: 503,
    });
    const res = await authed('/bff/trends', {
      method: 'POST',
      body: JSON.stringify({ topic: 'DPDK' }),
    });
    expect(res.status).toBe(502);
    const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM llm_usage').first<{ n: number }>();
    expect(n?.n).toBe(0);
  });

  it('公開論文を Orca に渡し、本文は usage に残さない', async () => {
    const calls = mockUpstream({
      papers: [
        {
          id: 'https://openalex.org/W1',
          doi: 'https://doi.org/10.1/a',
          display_name: 'DPDK architecture for 100Gbps',
          publication_date: '2026-06-16',
          abstract_inverted_index: { dpdk: [0], dataplane: [1] },
        },
      ],
      orca: orcaBody('100Gbps 向けの DPDK 設計が増えている'),
    });

    const res = await authed('/bff/trends', {
      method: 'POST',
      body: JSON.stringify({ topic: 'DPDK' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      classification: string;
      summary: string;
      model: string;
      papers: { title: string }[];
    };
    expect(body.classification).toBe('C1');
    expect(body.model).toBe('openai/gpt-4o-mini');
    expect(body.summary).toContain('DPDK');
    expect(body.papers[0]?.title).toContain('DPDK');

    const oa = calls.find((c) => c.url.includes('openalex.org'));
    expect(oa?.url).toContain('search=DPDK');
    expect(oa?.url).toContain('api_key=test-openalex-key');
    expect(oa?.url).not.toContain('title_and_abstract.search');

    const orca = calls.find((c) => c.url.includes('orcarouter.ai'));
    expect(orca).toBeTruthy();
    const headers = new Headers(orca?.init?.headers);
    expect(headers.get('authorization')).toBe('Bearer test-orca-key');
    expect(headers.get('x-orcarouter-include-cost')).toBe('true');
    const sent = JSON.parse(String(orca?.init?.body)) as {
      model: string;
      temperature: number;
      extra_body?: { route: string; models: string[] };
      messages: { content: string }[];
    };
    expect(sent.model).toBe('openai/gpt-4o-mini');
    expect(sent.temperature).toBe(0);
    expect(sent.extra_body).toEqual({
      route: 'fallback',
      models: ['openai/gpt-4o-mini', 'google/gemini-2.5-flash', 'anthropic/claude-haiku-4.5'],
    });
    const user = sent.messages.find((m) => m.content.includes('Topic: DPDK'));
    expect(user?.content).toContain('DPDK architecture for 100Gbps');
    expect(user?.content).not.toContain('unpublished');
    expect(user?.content).not.toContain('manuscript');

    const usage = await env.DB.prepare(
      `SELECT classification, endpoint, calls, tokens, model, resolved_model,
              cost_usd, latency_ms_sum, fallback_calls
         FROM llm_usage WHERE user_id = ?`,
    )
      .bind(PROJECT_USER)
      .first<{
        classification: string;
        endpoint: string;
        calls: number;
        tokens: number;
        model: string;
        resolved_model: string;
        cost_usd: number;
        latency_ms_sum: number;
        fallback_calls: number;
      }>();
    expect(usage).toMatchObject({
      classification: 'C1',
      endpoint: '/bff/trends',
      calls: 1,
      tokens: 30,
      // 要求した宛先と応答したモデルを別々に残す（ADR-0005 §10）
      model: 'openai/gpt-4o-mini',
      resolved_model: 'openai/gpt-4o-mini',
      cost_usd: 0.0004,
      fallback_calls: 0,
    });
    // 実時間なので値は固定できない。合計として積まれていることだけ見る
    expect(usage?.latency_ms_sum).toBeGreaterThanOrEqual(0);
    expect(JSON.stringify(usage)).not.toContain('100Gbps 向け');
  });

  it('INTERACTIVE キーがあれば ORCAROUTER_API_KEY なしでも呼べる', async () => {
    const calls = mockUpstream({
      papers: [{ id: 'W1', display_name: 'x' }],
      orca: orcaBody('ok'),
    });
    const res = await authed(
      '/bff/trends',
      { method: 'POST', body: JSON.stringify({ topic: 'DPDK' }) },
      { ...env, ORCAROUTER_API_KEY: undefined, ORCAROUTER_API_KEY_INTERACTIVE: 'interactive-key' },
    );
    expect(res.status).toBe(200);
    const orca = calls.find((c) => c.url.includes('orcarouter.ai'));
    expect(new Headers(orca?.init?.headers).get('authorization')).toBe('Bearer interactive-key');
  });

  it('fallback で当たったモデルを usage に残す', async () => {
    mockUpstream({
      papers: [{ id: 'W1', display_name: 'x' }],
      orca: orcaBody('ok', 'openai/gpt-4o-mini'),
      orcaHeaders: { 'X-Orca-Fallback-Model': 'google/gemini-2.5-flash' },
    });
    const res = await authed('/bff/trends', {
      method: 'POST',
      body: JSON.stringify({ topic: 'DPDK' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { model: string };
    expect(body.model).toBe('google/gemini-2.5-flash');

    // 要求は gpt-4o-mini、応答は gemini。宛先ごとに比べられるよう別列で残す
    const usage = await env.DB.prepare(
      'SELECT model, resolved_model, fallback_calls FROM llm_usage WHERE user_id = ?',
    )
      .bind(PROJECT_USER)
      .first<{ model: string; resolved_model: string; fallback_calls: number }>();
    expect(usage).toMatchObject({
      model: 'openai/gpt-4o-mini',
      resolved_model: 'google/gemini-2.5-flash',
      fallback_calls: 1,
    });
  });

  it('上限に達していたら Orca の前に 429（NFR-04）', async () => {
    await env.DB.prepare(
      `INSERT INTO llm_usage (user_id, usage_date, endpoint, classification, model, calls, tokens)
       VALUES (?, ?, '/bff/trends', 'C1', 'openai/gpt-4o-mini', 20, 0)`,
    )
      .bind(PROJECT_USER, utcDate())
      .run();

    const calls = mockUpstream({
      papers: [{ id: 'W1', display_name: 'x' }],
    });
    const res = await authed('/bff/trends', {
      method: 'POST',
      body: JSON.stringify({ topic: 'DPDK' }),
    });
    expect(res.status).toBe(429);
    expect(calls.some((c) => c.url.includes('orcarouter'))).toBe(false);
  });

  it('C2 はまだ 501', async () => {
    const res = await authed('/bff/themes', { method: 'POST' });
    expect(res.status).toBe(501);
  });
});

describe('trendPrompt', () => {
  it('公開の題と要旨だけを載せ、件数を切る', () => {
    const papers = Array.from({ length: 20 }, (_, i) => ({
      external_id: `W${i}`,
      title: `paper ${i}`,
      abstract: 'abs',
      url: `https://doi.org/${i}`,
      published_at: '2026-01-01',
    }));
    const prompt = trendPrompt('DPDK', papers);
    expect(prompt).toContain('Topic: DPDK');
    expect(prompt).toContain('paper 0');
    expect(prompt).not.toContain('paper 19');
    expect(prompt).not.toContain('manuscript');
  });
});
